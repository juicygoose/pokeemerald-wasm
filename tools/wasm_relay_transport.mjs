// RelayTransport + role drivers for relayed wasm netplay (M2).
//
// Plugs into the M1 SioBus Transport seam, but instead of LocalTransport's
// in-process shuffle, each peer is its own process and serial words cross a
// WebSocket relay (web/relay.mjs). Strict lockstep, no game-code changes.
//
// Cadence asymmetry (the only thing that differs by role):
//   - The MASTER owns the transfer clock. Its SioBus.driveFrame reads the
//     master node's SIO_START / Timer3 bits (exactly as the loopback did) and
//     calls exchange() per transfer; each exchange blocks on the peer's word.
//   - The SLAVE has no such clock under emulation, so it is reactive: it does
//     one exchange for every 'xfer' the master emits, and ends the frame when
//     the master's 'frameEnd' marker arrives.
//
// The word exchange itself is symmetric: for transfer `seq`, each side posts its
// own staged word and consumes the peer's, both keyed by `seq`, then builds the
// 4-slot RECV vector. Determinism (proven) does the rest: identical RECV vectors
// + identical key input => identical state on both peers.

import { ABSENT } from './wasm_sio_bus.mjs';

// Connect to the relay and resolve once the room is full ('ready'), returning
// the live WebSocket plus this peer's assigned playerId / playerCount.
export function connectPeer(url, room, { max = 2 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let info = null;
    ws.onerror = (e) => reject(e.error || new Error('relay socket error'));
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room, max }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'joined') info = m;
      else if (m.type === 'full') reject(new Error('room is full'));
      else if (m.type === 'ready') resolve({ ws, playerId: info.playerId, playerCount: m.playerCount });
    };
  });
}

export class RelayTransport {
  constructor(ws, { localId, peerId }) {
    this.ws = ws;
    this.localId = localId;
    this.peerId = peerId;
    this.seq = 0;             // monotonic transfer counter (shared numbering)
    this.localWord = ABSENT;
    this.peerWords = new Map(); // seq -> peer's word, filled by incoming 'xfer'
    this.pendingWord = new Map(); // seq -> resolver awaiting peerWords[seq]
    this.events = [];         // ordered {kind:'xfer',seq} / {kind:'frameEnd'} (slave driver)
    this.eventWaiters = [];
    this.disconnected = false;
    this._syncSeen = false;
    this._syncWaiter = null;
    // M3 desync detection: a per-checkpoint hash side channel. Each peer posts
    // its rolling transcript hash for checkpoint `key`; when both peers' hashes
    // for the same key are in hand they are compared. A mismatch records
    // `desync` (and never clears) so the drivers can surface a clear alarm.
    this.localHashes = new Map();  // key -> our hash, until the peer's arrives
    this.peerHashes = new Map();   // key -> peer's hash, until ours arrives
    this.desync = null;            // {key, local, peer} on first mismatch
    this._finishAcked = false;
    this._finishAckWaiter = null;
    ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));
    ws.onclose = () => this._fail('relay closed');
    ws.onerror = () => this._fail('relay error');
  }

  _onMessage(m) {
    if (m.type === 'xfer') {
      this.peerWords.set(m.seq, m.word);
      const r = this.pendingWord.get(m.seq);
      if (r) { this.pendingWord.delete(m.seq); r(m.word); }
      this._pushEvent({ kind: 'xfer', seq: m.seq });
    } else if (m.type === 'frameEnd') {
      this._pushEvent({ kind: 'frameEnd', frame: m.frame, seq: m.seq });
    } else if (m.type === 'finish') {
      this._pushEvent({ kind: 'finish' });
    } else if (m.type === 'sync') {
      this._syncSeen = true;
      if (this._syncWaiter) { const w = this._syncWaiter; this._syncWaiter = null; w(); }
    } else if (m.type === 'hash') {
      this.peerHashes.set(m.key, m.hash >>> 0);
      this._compare(m.key);
    } else if (m.type === 'finishAck') {
      this._finishAcked = true;
      if (this._finishAckWaiter) { const w = this._finishAckWaiter; this._finishAckWaiter = null; w(); }
    } else if (m.type === 'peerGone') {
      this._fail('peer disconnected');
    }
  }

  // --- M3 desync detector ---------------------------------------------------
  // Post this peer's transcript hash for checkpoint `key` and compare against
  // the peer's once it arrives (ordering is irrelevant: whichever side lands
  // second triggers the compare).
  checkpointHash(key, hash) {
    hash = hash >>> 0;
    this.localHashes.set(key, hash);
    this._post({ type: 'hash', key, hash });
    this._compare(key);
  }

  _compare(key) {
    if (!this.localHashes.has(key) || !this.peerHashes.has(key)) return;
    const local = this.localHashes.get(key);
    const peer = this.peerHashes.get(key);
    this.localHashes.delete(key);
    this.peerHashes.delete(key);
    if (local !== peer && !this.desync) this.desync = { key, local, peer };
  }

  // End-of-run handshake so a clean run can prove EVERY checkpoint was compared:
  // the master awaits the slave's ack, and WebSocket per-peer ordering guarantees
  // all of the slave's hash messages (sent before its ack) have already arrived.
  finishAck() { this._post({ type: 'finishAck' }); }
  awaitFinishAck() {
    if (this._finishAcked || this.disconnected) return Promise.resolve();
    return new Promise((res) => { this._finishAckWaiter = res; });
  }

  // Startup barrier: ensures both peers' transports are attached and listening
  // before the master emits any transfers (otherwise early frames could race
  // ahead of the slave attaching its message handler).
  barrier() {
    this._post({ type: 'sync' });
    if (this._syncSeen) return Promise.resolve();
    return new Promise((res) => { this._syncWaiter = res; });
  }

  _fail(reason) {
    if (this.disconnected) return;
    this.disconnected = true;
    const err = new Error(`relay transport: ${reason}`);
    for (const r of this.pendingWord.values()) r(Promise.reject(err));
    this.pendingWord.clear();
    if (this._finishAckWaiter) { const w = this._finishAckWaiter; this._finishAckWaiter = null; w(); }
    this._pushEvent({ kind: 'error', error: err });
  }

  _pushEvent(ev) {
    const w = this.eventWaiters.shift();
    if (w) w(ev); else this.events.push(ev);
  }

  _post(obj) {
    if (!this.disconnected) this.ws.send(JSON.stringify(obj));
  }

  // --- Transport interface (called by SioBus.exchange) ----------------------
  send(playerId, word) {
    this.localWord = word & 0xffff;
    this._post({ type: 'xfer', seq: this.seq, word: this.localWord });
  }

  async recv() {
    const peerWord = await this._awaitPeer(this.seq);
    const recv = [ABSENT, ABSENT, ABSENT, ABSENT];
    recv[this.localId] = this.localWord;
    recv[this.peerId] = peerWord;
    this.seq++;
    return recv;
  }

  _awaitPeer(seq) {
    if (this.peerWords.has(seq)) {
      const w = this.peerWords.get(seq);
      this.peerWords.delete(seq);
      return Promise.resolve(w);
    }
    if (this.disconnected) return Promise.reject(new Error('relay transport: disconnected'));
    return new Promise((res) => this.pendingWord.set(seq, res));
  }

  // --- Slave driver support -------------------------------------------------
  // Mark the end of a frame's transfers (master -> slave control marker). The
  // transfer counter (seq) rides along so the slave can detect any drift in the
  // number of transfers it replayed for the frame.
  frameEnd(frame) { this._post({ type: 'frameEnd', frame, seq: this.seq }); }

  // Master -> slave: no more frames are coming; the slave can stop stepping.
  finish() { this._post({ type: 'finish' }); }

  nextEvent() {
    if (this.events.length) return Promise.resolve(this.events.shift());
    return new Promise((res) => this.eventWaiters.push(res));
  }
}

// Per-frame routine shared bring-up shims (mirror tools/wasm_sio_bus.mjs's
// stepFrame, but split so master and slave can drive transfers differently).
function advanceFrame(bus, keys) {
  for (const node of bus.nodes) node.maintainTerminals();
  for (const node of bus.nodes) { node.rt.setKeys(keys); node.rt.runFrame(); }
  for (const node of bus.nodes) node.rt.exports.CheckShouldAdvanceLinkState();
  for (const node of bus.nodes) {
    if (node.state === 1 /* LINK_STATE_START1 */) {
      node.rt.wr8(node.rt.addrOf('gShouldAdvanceLinkState'), 1);
    }
  }
}

// MASTER: advance the local node, then drive transfers off its own SIO clock,
// then tell the slave the frame's transfers are done. Returns {transfers}.
export async function masterStepFrame(bus, transport, { keys = 0, frame = 0 } = {}) {
  advanceFrame(bus, keys);
  const transfers = await bus.driveFrame();
  transport.frameEnd(frame);
  return { transfers, finished: false };
}

// SLAVE: advance the local node, then service the master's transfer stream until
// its frameEnd marker, doing one exchange per master 'xfer'. `afterTransfer` (if
// given) runs right after each exchange — letting callers inspect a received
// block the instant it completes, before a later transfer in the same frame can
// overwrite the recv slot with the next keep-alive block. Returns
// {transfers, finished}; `finished` is true once the master signals it is done.
export async function slaveStepFrame(bus, transport, { keys = 0, afterTransfer = null } = {}) {
  advanceFrame(bus, keys);
  let transfers = 0;
  for (;;) {
    const ev = await transport.nextEvent();
    if (ev.kind === 'finish') { for (const node of bus.nodes) node.clearLag(); return { transfers, finished: true }; }
    if (ev.kind === 'frameEnd') {
      if (ev.seq !== transport.seq) {
        throw new Error(`lockstep desync: slave at seq ${transport.seq}, master ended frame at seq ${ev.seq}`);
      }
      break;
    }
    if (ev.kind === 'error') throw ev.error;
    // ev.kind === 'xfer': the master initiated transfer ev.seq; reciprocate.
    await bus.exchange();
    transfers++;
    if (afterTransfer) afterTransfer();
  }
  for (const node of bus.nodes) node.clearLag();
  return { transfers, finished: false };
}
