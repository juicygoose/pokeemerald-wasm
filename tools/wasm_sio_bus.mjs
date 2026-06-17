// Reusable GBA serial-multiplayer (SIO) bus for the wasm netplay stack.
//
// This is M1 of docs/netplay-next-steps.md: the SIO bus that the link-cable
// loopback prototyped is pulled out into a transport-agnostic module so the same
// code can drive an in-process loopback today and a WebSocket relay (M2) /
// browser session (M4) tomorrow — all without touching game code.
//
// The model (what real multiplayer-mode serial hardware does, emulated in JS):
//   - Each console stages one 16-bit word in REG_SIOMLT_SEND.
//   - A transfer broadcasts all consoles' staged words into every console's
//     4-slot REG_SIOMLT_RECV (slot i = player i's word; ABSENT for absent
//     players), sets each console's id/terminal bits, and fires the serial
//     interrupt (the game's exported SerialCB) on every console at once.
//   - The master paces transfers: SIO_START (handshake/vsync) kicks one
//     immediately; once established, Timer3 re-arms the next until the per-frame
//     command batch drains.
//
// The seam that makes this reusable is the Transport: it moves serial words
// between peers. `send()` contributes a peer's staged word; `recv()` resolves to
// the full 4-slot vector once every peer's word for the transfer has arrived.
// In one process all peers are local (LocalTransport, a synchronous shuffle);
// across the network a RelayTransport posts each word and awaits the others.

// --- SIO / timer registers (GBA addresses inside the wasm linear memory) ------
export const SIOCNT = 0x04000128; // u16 serial control
export const SIOMLT_SEND = 0x0400012a; // u16 this console's outgoing word
export const SIOMULTI = 0x04000120; // u16[4] received words (slots 0..3)
export const TM3CNT_H = 0x0400010e; // u16 timer 3 control

export const SIO_MULTI_SI = 0x0004;
export const SIO_MULTI_SD = 0x0008;
export const SIO_ID_MASK = 0x0030; // bits 4-5 player id
export const SIO_ID_SHIFT = 4;
export const SIO_ERROR = 0x0040;
export const SIO_START = 0x0080;
export const TIMER_ENABLE = 0x0080;

// --- struct Link field offsets (from include/link.h) --------------------------
export const L = {
  isMaster: 0x00, state: 0x01, localId: 0x02, playerCount: 0x03,
  serialIntrCounter: 0x0d, hardwareError: 0x10, badChecksum: 0x11,
  queueFull: 0x12, lag: 0x13,
};

// --- gLinkStatus bit accessors ------------------------------------------------
export const connEstablished = (s) => (s >>> 6) & 1;
export const playerCountOf = (s) => (s >>> 2) & 7;

export const LINK_STATE_START1 = 1;
export const ABSENT = 0xffff; // RECV slot value for an unconnected player

// FNV-1a fold of a transfer's 4-slot RECV vector into a rolling hash. The RECV
// vector is the SHARED truth of a serial transfer (slot i = player i's word,
// ABSENT for absent slots) and is bit-identical on every peer — so a rolling
// hash of every applied RECV word is identical across peers exactly while they
// stay in lockstep, and the first transfer where the wire disagrees flips it.
export const FNV_OFFSET = 2166136261;
export function foldRecv(hash, recv) {
  for (let i = 0; i < 4; i++) {
    const w = recv[i] & 0xffff;
    hash = Math.imul(hash ^ (w & 0xff), 16777619);
    hash = Math.imul(hash ^ (w >>> 8), 16777619);
  }
  return hash >>> 0;
}

// A single console on the bus: thin accessors over one wasm runtime's memory.
export class LinkNode {
  constructor(rt, index) {
    this.rt = rt;
    this.index = index; // player id: 0 = master, 1.. = slaves
    this.linkBase = rt.addrOf('gLink');
  }
  // struct Link accessors
  lf(off) { return this.rt.rd8(this.linkBase + off); }
  setLf(off, v) { this.rt.wr8(this.linkBase + off, v); }
  get state() { return this.lf(L.state); }
  get linkStatus() { return this.rt.rd32(this.rt.addrOf('gLinkStatus')); }

  // Drive the "hardware" terminal + id bits the game reads but never writes.
  // Master: SD set, SI clear, id 0. Slave: SD+SI set, id = index.
  maintainTerminals() {
    let cnt = this.rt.rd16(SIOCNT);
    cnt &= ~(SIO_MULTI_SI | SIO_MULTI_SD | SIO_ID_MASK | SIO_ERROR);
    cnt |= SIO_MULTI_SD;
    if (this.index !== 0) cnt |= SIO_MULTI_SI;
    cnt |= (this.index << SIO_ID_SHIFT) & SIO_ID_MASK;
    this.rt.wr16(SIOCNT, cnt);
  }
  startPending() { return (this.rt.rd16(SIOCNT) & SIO_START) !== 0; }
  clearStart() { this.rt.wr16(SIOCNT, this.rt.rd16(SIOCNT) & ~SIO_START); }
  timerEnabled() { return (this.rt.rd16(TM3CNT_H) & TIMER_ENABLE) !== 0; }

  stagedSend() { return this.rt.rd16(SIOMLT_SEND); }
  deliverRecv(words) {
    for (let i = 0; i < 4; i++) this.rt.wr16(SIOMULTI + i * 2, words[i]);
  }
  // Zero-latency transports genuinely cannot lag; clear the flag the timing
  // detector would otherwise raise (it would wedge the master's vsync gate).
  clearLag() { this.setLf(L.lag, 0); }
}

// Transport: moves serial words between peers.
//   send(playerId, word)        contribute a staged word for this transfer
//   recv() -> Promise<word[4]>   resolves with the full RECV vector (ABSENT for
//                                absent slots) once all peers have contributed
//
// LocalTransport is the loopback case: every peer is in this process, so a
// transfer is a synchronous shuffle of the staged words into a 4-slot vector.
export class LocalTransport {
  constructor(playerCount) {
    this.playerCount = playerCount;
    this.slots = this._empty();
  }
  _empty() { return [ABSENT, ABSENT, ABSENT, ABSENT]; }
  send(playerId, word) {
    if (playerId >= 0 && playerId < this.playerCount && playerId < 4) {
      this.slots[playerId] = word & 0xffff;
    }
  }
  async recv() {
    const out = this.slots;
    this.slots = this._empty();
    return out;
  }
}

// The serial bus for one peer's local node(s). `nodes[0]` is treated as the
// transfer-pacing master (it owns the SIO_START / Timer3 cadence). For the
// loopback both consoles are local nodes here; for a relayed session a peer
// holds just its own node and the Transport supplies the remote words.
export class SioBus {
  constructor(nodes, transport) {
    this.nodes = nodes;
    this.transport = transport;
    this.master = nodes[0];
    // Rolling FNV-1a over every applied RECV vector: the lockstep checksum M3's
    // desync detector samples. Identical across peers iff the wire agrees.
    this.transcript = FNV_OFFSET;
  }

  // One serial multiplayer transfer across all peers.
  async exchange() {
    for (const node of this.nodes) this.transport.send(node.index, node.stagedSend());
    const recv = await this.transport.recv();
    this.transcript = foldRecv(this.transcript, recv);
    for (const node of this.nodes) {
      node.deliverRecv(recv);
      node.maintainTerminals(); // sets id + clears error before SerialCB reads them
      node.clearStart();
      node.rt.exports.SerialCB();
    }
    return recv;
  }

  // Drain a frame's worth of transfers. The master kicks transfers via SIO_START
  // (handshake/vsync) or Timer3 (established), re-arming after each incomplete
  // command until the batch is done.
  async driveFrame(maxIters = 64) {
    let transfers = 0;
    for (let it = 0; it < maxIters; it++) {
      if (this.master.startPending()) {
        await this.exchange();
        transfers++;
      } else if (this.master.timerEnabled()) {
        this.master.rt.exports.Timer3Intr(); // StopTimer + StartTransfer -> sets SIO_START
      } else {
        break;
      }
    }
    for (const node of this.nodes) node.clearLag();
    return transfers;
  }
}

// Bring one wasm instance up as a link node, with NO game-code changes — the
// same shim the loopback used: give the player an EOS-terminated name (boot
// leaves the save block zeroed, so InitLocalLinkPlayer's StringCopy would
// otherwise overrun), silence the main callback so the intro can't perturb the
// link, and open a cable link. HandleLinkConnection then advances the state
// machine on its own every WasmRunFrame; the bus only supplies the wire.
export function bootLinkInstance(rt, { name } = {}) {
  const glyphs = name ?? [0xc6, 0xb6];
  const sb2 = rt.rd32(rt.addrOf('gSaveBlock2Ptr'));
  glyphs.forEach((b, k) => rt.wr8(sb2 + k, b));
  rt.wr8(sb2 + glyphs.length, 0xff); // EOS
  rt.exports.SetMainCallback2(0);
  rt.exports.OpenLink();
}

// Advance every local node one frame and drive the resulting transfers. Mirrors
// the per-frame routine the loopback ran by hand: maintain terminals, run the
// frame, nudge the cable-club master-promotion the silenced CB2 can't, then let
// the bus drain transfers. Returns the number of transfers performed.
export async function stepFrame(bus, { keys = 0 } = {}) {
  for (const node of bus.nodes) node.maintainTerminals();
  for (const node of bus.nodes) { node.rt.setKeys(keys); node.rt.runFrame(); }
  // Master promotion: normally called by cable-club game code each frame.
  for (const node of bus.nodes) node.rt.exports.CheckShouldAdvanceLinkState();
  // Nudge START1 -> HANDSHAKE (the trigger task can't run with CB2 silenced).
  for (const node of bus.nodes) {
    if (node.state === LINK_STATE_START1) {
      node.rt.wr8(node.rt.addrOf('gShouldAdvanceLinkState'), 1);
    }
  }
  return bus.driveFrame();
}
