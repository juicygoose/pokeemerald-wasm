// Minimal WebSocket room relay for wasm netplay (M2 of docs/netplay-next-steps).
//
// Groups 2-4 peers into a room and forwards one small JSON message per peer per
// event (serial transfer, frame boundary, control). It is deliberately dumb: it
// never inspects or rewrites the serial words, it only fans them out to the
// other peers in the room. All lockstep logic lives in the clients
// (tools/wasm_relay_transport.mjs); the relay is just the wire.
//
// No npm dependency: this is a hand-rolled RFC 6455 server over Node's built-in
// http 'upgrade' event (the matching client side uses Node's global WebSocket).
//
// Wire protocol (JSON text frames):
//   client -> relay  {type:'join', room, max?}      join/create a room
//   relay  -> client {type:'joined', playerId, playerCount, max}
//   relay  -> client {type:'ready'}                 sent to all once room is full
//   client -> relay  {type:'xfer', seq, word}       a staged serial word
//   client -> relay  {type:'frameEnd', frame}       end of a frame's transfers
//   client -> relay  {type:'hash', key, hash}       M3 desync checkpoint hash
//   client -> relay  {type:'finishAck'}             M3 end-of-run ack
//   client -> relay  {type:'bye'}                   leave
//   relay  -> client (gameplay msgs are forwarded verbatim with `from` added)
//   relay  -> client {type:'peerGone', playerId}    a peer disconnected

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// --- RFC 6455 framing ---------------------------------------------------------
function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

// Encode a server->client text frame (unmasked).
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text opcode
  return Buffer.concat([header, payload]);
}

// Pull complete frames out of a growing buffer. Returns {messages, rest, closed,
// oversize}. Handles text (0x1), close (0x8), ping (0x9), pong (0xA); assumes
// unfragmented frames (our messages are tiny), but tolerates 16/64-bit lengths.
// `maxBytes` caps a single frame's payload — a frame larger than that flags
// `oversize` (the caller drops the abusive peer) instead of buffering it.
function drainFrames(buf, maxBytes = Infinity) {
  const messages = [];
  let closed = false;
  let oversize = false;
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    if (len > maxBytes) { oversize = true; break; }
    let maskKey;
    if (masked) { if (p + 4 > buf.length) break; maskKey = buf.subarray(p, p + 4); p += 4; }
    if (p + len > buf.length) break; // wait for more bytes
    const payload = buf.subarray(p, p + len);
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= maskKey[i & 3];
    off = p + len;
    if (opcode === 0x8) { closed = true; break; }
    else if (opcode === 0x1) messages.push(payload.toString('utf8'));
    // opcode 0x9 (ping) / 0xA (pong) / continuation: ignored for our traffic
  }
  return { messages, rest: buf.subarray(off), closed, oversize };
}

// --- Room bookkeeping ---------------------------------------------------------
class Peer {
  constructor(socket, ratePerSec) {
    this.socket = socket;
    this.room = null;
    this.playerId = -1;
    this.alive = true;
    this.gone = false;     // dropped but slot held during the reconnect grace
    this.byed = false;     // clean leave (never held for reconnect)
    this.resumed = false;  // this ghost was replaced by a reconnecting socket
    this.outbox = [];      // messages buffered for a gone peer, replayed on resume
    this.graceTimer = null;
    // Token bucket for per-connection message rate limiting (1s burst).
    this.tokens = ratePerSec;
    this.maxTokens = ratePerSec;
    this.lastRefill = Date.now();
  }
  send(obj) {
    if (this.alive) this.socket.write(encodeFrame(JSON.stringify(obj)));
  }
  // Returns false once the peer exceeds its sustained message rate.
  allow() {
    const now = Date.now();
    this.tokens = Math.min(this.maxTokens, this.tokens + (now - this.lastRefill) / 1000 * this.maxTokens);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// Hardening defaults are generous: lockstep play is many tiny messages, so the
// caps only bite on genuinely abusive traffic. All are overridable for tests.
const DEFAULTS = {
  maxMessageBytes: 2048,    // a serial-word/control JSON is well under this
  messageRatePerSec: 20000, // headless runs burst hard; real play is far lower
  roomIdleMs: 60000,        // reap rooms with no traffic for this long
  joinTimeoutMs: 30000,     // reap rooms that never fill within this long
  sweepMs: 10000,           // how often the reaper runs
  forwardDelayMs: 0,        // simulated forwarding latency (tests only)
};

export class Relay {
  constructor(opts = {}) {
    const { log = () => {}, ...limits } = opts;
    this.rooms = new Map();     // roomId -> Peer[]
    this.roomMeta = new Map();  // roomId -> { created, lastActivity, max }
    this.log = log;
    this.limits = { ...DEFAULTS, ...limits };
    this._sweeper = null;
  }

  // Attach to a Node http.Server: relay takes over 'upgrade' requests.
  attach(httpServer) {
    httpServer.on('upgrade', (req, socket) => this._handleUpgrade(req, socket));
    this._startSweeper();
    return this;
  }

  // Periodically reap rooms that never filled (join timeout) or went idle. The
  // timer is unref'd so it never keeps a process (or test) alive on its own.
  _startSweeper() {
    if (this._sweeper) return;
    this._sweeper = setInterval(() => this._sweep(), this.limits.sweepMs);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  stop() { if (this._sweeper) { clearInterval(this._sweeper); this._sweeper = null; } }

  _sweep() {
    const now = Date.now();
    for (const [room, meta] of [...this.roomMeta]) {
      const members = this.rooms.get(room) || [];
      const full = members.length >= meta.max;
      const idle = now - meta.lastActivity > this.limits.roomIdleMs;
      const stale = !full && now - meta.created > this.limits.joinTimeoutMs;
      if (idle || stale) {
        this.log(`room ${room}: reaped (${stale ? 'join timeout' : 'idle'})`);
        this._closeRoom(room, stale ? 'join timeout' : 'idle');
      }
    }
  }

  _closeRoom(room, reason) {
    const members = this.rooms.get(room) || [];
    for (const p of members) { p.send({ type: 'roomClosed', reason }); p.alive = false; try { p.socket.end(); } catch {} }
    this.rooms.delete(room);
    this.roomMeta.delete(room);
  }

  _touch(room) { const m = this.roomMeta.get(room); if (m) m.lastActivity = Date.now(); }

  // Send to a peer, honoring forwardDelayMs (tests). Delaying ALL messages to a
  // peer uniformly — forwards AND relay-generated control like peerGone — keeps
  // causal order: a 'finish' sent just before the sender closed still arrives
  // before the peerGone that close triggers, exactly as TCP would deliver them.
  _deliver(peer, obj) {
    const d = this.limits.forwardDelayMs;
    if (d > 0) setTimeout(() => { if (peer.alive || peer.gone) peer.send(obj); }, d);
    else peer.send(obj);
  }

  _handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    const peer = new Peer(socket, this.limits.messageRatePerSec);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest, closed, oversize } = drainFrames(buf, this.limits.maxMessageBytes);
      buf = rest;
      if (oversize) { this.log('dropping peer: oversized frame'); this._onClose(peer); try { socket.destroy(); } catch {} return; }
      for (const m of messages) this._onMessage(peer, m);
      if (closed) socket.end();
    });
    socket.on('close', () => this._onClose(peer));
    socket.on('error', () => this._onClose(peer));
  }

  _onMessage(peer, raw) {
    if (!peer.alive) return;
    if (!peer.allow()) {
      this.log(`room ${peer.room}: dropping peer ${peer.playerId} (message rate exceeded)`);
      this._onClose(peer);
      try { peer.socket.destroy(); } catch {}
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'join') return this._join(peer, msg);
    if (peer.room == null) return;
    this._touch(peer.room);
    if (msg.type === 'bye') return this._dropPeer(peer, { byed: true });
    // Forward gameplay messages (xfer/frameEnd/anything else) to the other peers
    // (live peers now; a peer dropped within its reconnect grace buffers them).
    const members = this.rooms.get(peer.room) || [];
    for (const o of members) {
      if (o === peer) continue;
      const payload = { ...msg, from: peer.playerId };
      if (o.alive) this._deliver(o, payload);
      else if (o.gone) o.outbox.push(payload);
    }
  }

  _join(peer, { room, max = 2, resume }) {
    if (peer.room != null) return;
    let members = this.rooms.get(room);

    // Reconnect: take over a slot whose peer dropped within the grace window,
    // keeping its playerId and replaying everything buffered while it was gone.
    if (this.limits.reconnectGraceMs > 0 && typeof resume === 'number' && members) {
      const ghost = members.find((p) => p.gone && p.playerId === resume);
      if (ghost) {
        if (ghost.graceTimer) { clearTimeout(ghost.graceTimer); ghost.graceTimer = null; }
        ghost.resumed = true;
        peer.room = room;
        peer.playerId = ghost.playerId;
        members[members.indexOf(ghost)] = peer;
        this._touch(room);
        peer.send({ type: 'resumed', playerId: peer.playerId, max });
        for (const m of ghost.outbox) this._deliver(peer, m); // replay missed messages in order
        this.log(`room ${room}: peer ${peer.playerId} resumed (${ghost.outbox.length} buffered)`);
        ghost.outbox = [];
        // Tell the other peers so they can re-post any in-flight message that was
        // lost while this peer was down (its own re-post covers the other side).
        for (const o of members) if (o !== peer && o.alive) this._deliver(o, { type: 'peerResumed', playerId: peer.playerId });
        return;
      }
    }

    if (!members) { members = []; this.rooms.set(room, members); this.roomMeta.set(room, { created: Date.now(), lastActivity: Date.now(), max }); }
    if (members.length >= max) { peer.send({ type: 'full' }); peer.socket.end(); return; }
    peer.room = room;
    peer.playerId = members.length; // arrival order -> player id (0 = master)
    members.push(peer);
    this._touch(room);
    peer.send({ type: 'joined', playerId: peer.playerId, playerCount: members.length, max });
    this.log(`room ${room}: peer joined as player ${peer.playerId} (${members.length}/${max})`);
    if (members.length === max) {
      for (const p of members) p.send({ type: 'ready', playerCount: max });
      this.log(`room ${room}: ready with ${max} players`);
    }
  }

  // Socket dropped. If reconnect grace is enabled and this wasn't a clean 'bye',
  // hold the slot (buffering forwards) so the peer can resume; otherwise remove.
  _onClose(peer) {
    if (!peer.alive || peer.gone) return;
    if (this.limits.reconnectGraceMs > 0 && !peer.byed && peer.room != null) {
      const members = this.rooms.get(peer.room);
      if (members && members.includes(peer)) {
        peer.alive = false;
        peer.gone = true;
        peer.outbox = [];
        this.log(`room ${peer.room}: peer ${peer.playerId} dropped — holding slot ${this.limits.reconnectGraceMs}ms`);
        peer.graceTimer = setTimeout(() => this._dropPeer(peer), this.limits.reconnectGraceMs);
        if (peer.graceTimer.unref) peer.graceTimer.unref();
        return;
      }
    }
    this._dropPeer(peer);
  }

  // Remove a peer for good and tell the room. A ghost already replaced by a
  // resumed socket (idx < 0) is a no-op — we must not signal peerGone for it.
  _dropPeer(peer, { byed = false } = {}) {
    if (byed) peer.byed = true;
    if (peer.graceTimer) { clearTimeout(peer.graceTimer); peer.graceTimer = null; }
    peer.alive = false;
    peer.gone = false;
    if (peer.room == null) return;
    const members = this.rooms.get(peer.room);
    if (members) {
      const idx = members.indexOf(peer);
      if (idx < 0) { if (byed) try { peer.socket.end(); } catch {} return; } // already resumed/replaced
      members.splice(idx, 1);
      for (const p of members) if (p.alive) this._deliver(p, { type: 'peerGone', playerId: peer.playerId });
      if (members.length === 0) { this.rooms.delete(peer.room); this.roomMeta.delete(peer.room); }
    }
    if (byed) try { peer.socket.end(); } catch {}
    this.log(`room ${peer.room}: peer ${peer.playerId} left`);
  }
}

// Convenience: start a standalone relay-only server (no static files).
export function startRelayServer(port = 0, opts = {}) {
  return new Promise((resolveP) => {
    import('node:http').then(({ createServer }) => {
      const server = createServer((_req, res) => res.writeHead(426).end('upgrade required'));
      const relay = new Relay(opts).attach(server);
      server.listen(port, function () {
        resolveP({ server, relay, port: this.address().port });
      });
    });
  });
}
