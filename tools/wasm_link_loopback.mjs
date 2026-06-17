#!/usr/bin/env node
// 2-player GBA link-cable loopback over a JS-emulated SIO multiplayer bus.
//
// Proves the game's own link layer (src/link.c) runs under the wasm build with
// NO game-code changes: we just emulate the serial multiplayer hardware in JS.
// Two wasm instances negotiate a link, agree on player count + IDs, reach
// LINK_STATE_CONN_ESTABLISHED, and exchange a data block — exactly the
// machinery a real trade / link battle rides on.
//
// How the SIO multiplayer bus works (and what we emulate):
//   - Each console stages one 16-bit word in REG_SIOMLT_SEND.
//   - The master triggers a transfer (sets SIO_START in REG_SIOCNT). On real
//     hardware the serial interrupt then fires on ALL consoles at once; each
//     reads the 4-slot REG_SIOMLT_RECV (slot i = player i's staged word) and
//     stages its next word. The master repeats ~CMD_LENGTH+1 times per frame,
//     timed by Timer3.
//   - We reproduce this: snapshot every instance's SIOMLT_SEND, broadcast the
//     same 4-word vector into every instance's RECV slots, set each instance's
//     player id/terminal bits, and call the exported SerialCB() on each. We
//     emulate Timer3 by calling the exported Timer3Intr() to start the next
//     transfer until the per-frame command batch drains.
//
// Run: node tools/wasm_link_loopback.mjs [--frames N] [--wasm PATH] [--verbose]

import { resolve } from 'node:path';
import { compileModule, instantiate } from './wasm_gba_runtime.mjs';

// --- SIO / timer registers (GBA addresses inside linear memory) ---------------
const SIOCNT   = 0x04000128; // u16 serial control
const SIOMLT_SEND = 0x0400012a; // u16 this console's outgoing word
const SIOMULTI = 0x04000120; // u16[4] received words (slots 0..3)
const TM3CNT_H = 0x0400010e; // u16 timer 3 control

const SIO_MULTI_SI = 0x0004;
const SIO_MULTI_SD = 0x0008;
const SIO_ID_MASK  = 0x0030;   // bits 4-5 player id
const SIO_ID_SHIFT = 4;
const SIO_ERROR    = 0x0040;
const SIO_START    = 0x0080;
const TIMER_ENABLE = 0x0080;

// --- struct Link field offsets (from include/link.h) --------------------------
const L = { isMaster: 0x00, state: 0x01, localId: 0x02, playerCount: 0x03,
            serialIntrCounter: 0x0d, hardwareError: 0x10, badChecksum: 0x11,
            queueFull: 0x12, lag: 0x13 };

// --- gLinkStatus bits ---------------------------------------------------------
const connEstablished = (s) => (s >>> 6) & 1;
const playerCountOf   = (s) => (s >>> 2) & 7;

const LINK_STATE_START1 = 1;
const ABSENT = 0xffff; // RECV slot value for an unconnected player

class LinkNode {
  constructor(rt, index) {
    this.rt = rt;
    this.index = index;             // 0 = master, 1 = slave
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
}

function snapshot(nodes) {
  const m = nodes[0];
  return {
    state: m.state,
    isMaster: nodes.map((n) => n.lf(L.isMaster)),
    localId: nodes.map((n) => n.lf(L.localId)),
    playerCount: nodes.map((n) => n.lf(L.playerCount)),
    ctr: nodes.map((n) => n.lf(L.serialIntrCounter) << 24 >> 24),
    lag: nodes.map((n) => n.lf(L.lag)),
    conn: nodes.map((n) => connEstablished(n.linkStatus)),
    statusPlayers: nodes.map((n) => playerCountOf(n.linkStatus)),
  };
}

// One serial multiplayer transfer across all instances.
function busTransfer(nodes) {
  const n = nodes.length;
  const sends = nodes.map((node) => node.stagedSend());
  const recv = [sends[0] ?? ABSENT, sends[1] ?? ABSENT, sends[2] ?? ABSENT, sends[3] ?? ABSENT];
  for (let i = 0; i < 4; i++) if (i >= n) recv[i] = ABSENT;
  for (const node of nodes) {
    node.deliverRecv(recv);
    node.maintainTerminals();   // sets id + clears error before SerialCB reads them
    node.clearStart();
    node.rt.exports.SerialCB();
  }
}

// Drain a frame's worth of transfers: the master kicks transfers via SIO_START
// (handshake/vsync) or Timer3 (established), re-arming after each incomplete
// command until the batch is done.
function driveTransfers(nodes, maxIters = 64) {
  const master = nodes[0];
  let transfers = 0;
  for (let it = 0; it < maxIters; it++) {
    if (master.startPending()) {
      busTransfer(nodes);
      transfers++;
    } else if (master.timerEnabled()) {
      master.rt.exports.Timer3Intr(); // StopTimer + StartTransfer -> sets SIO_START
    } else {
      break;
    }
  }
  // Zero-latency loopback genuinely cannot lag; clear the master/slave lag flags
  // the timing-based detector would otherwise raise (and which would wedge the
  // master's vsync transfer gate). This is the only accommodation we make.
  for (const node of nodes) node.setLf(L.lag, 0);
  return transfers;
}

async function main() {
  const args = process.argv.slice(2);
  let frames = 400, wasmPath = 'build/wasm/pokeemerald.wasm', verbose = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--frames') frames = Number(args[++i]);
    else if (args[i] === '--wasm') wasmPath = args[++i];
    else if (args[i] === '--verbose') verbose = true;
    else { console.error(`unknown arg: ${args[i]}`); process.exit(2); }
  }

  const { module } = await compileModule(resolve(wasmPath));
  const rts = [await instantiate(module), await instantiate(module)];
  const nodes = rts.map((rt, i) => new LinkNode(rt, i));

  // Isolated link harness: silence the main callback so the intro can't perturb
  // the link, then open a cable link on both instances. LinkMain1/2 already run
  // every WasmRunFrame via HandleLinkConnection, so the state machine advances
  // on its own; we only supply the bus + the master-promotion nudge.
  for (let i = 0; i < rts.length; i++) {
    const rt = rts[i];
    // Boot leaves the save block zeroed; the player name is therefore not
    // EOS-terminated, so InitLocalLinkPlayer's StringCopy would overrun. Give
    // each instance a short EOS-terminated name (offset 0 of SaveBlock2).
    const sb2 = rt.rd32(rt.addrOf('gSaveBlock2Ptr'));
    const name = i === 0 ? [0xc6, 0xb6] : [0xcd, 0xbb]; // arbitrary 2 glyphs
    name.forEach((b, k) => rt.wr8(sb2 + k, b));
    rt.wr8(sb2 + name.length, 0xff); // EOS
    rt.exports.SetMainCallback2(0);
    rt.exports.OpenLink();
  }

  console.log(`link loopback: 2 instances, up to ${frames} frames`);
  let establishedAt = -1;

  for (let f = 0; f < frames; f++) {
    for (const node of nodes) node.maintainTerminals();
    for (const rt of rts) { rt.setKeys(0); rt.runFrame(); }
    // Master promotion: normally called by cable-club game code each frame.
    for (const rt of rts) rt.exports.CheckShouldAdvanceLinkState();
    // Nudge START1 -> HANDSHAKE (the trigger task can't run with CB2 silenced).
    for (const node of nodes) {
      if (node.state === LINK_STATE_START1) node.rt.wr8(node.rt.addrOf('gShouldAdvanceLinkState'), 1);
    }
    const transfers = driveTransfers(nodes);

    const s = snapshot(nodes);
    if (verbose || f < 12 || (establishedAt === -1 && s.conn.some((c) => c))) {
      console.log(`f${String(f).padStart(3)} st=${s.state} master=${s.isMaster.join('')} id=${s.localId.join('')} pc=${s.playerCount.join('')} ctr=${s.ctr.join('/')} conn=${s.conn.join('')} xfers=${transfers}`);
    }
    if (establishedAt === -1 && s.conn[0] && s.conn[1] && s.statusPlayers[0] === 2 && s.statusPlayers[1] === 2) {
      establishedAt = f;
      break;
    }
  }

  if (establishedAt === -1) {
    console.log('\n❌ link never reached CONN_ESTABLISHED with 2 players');
    process.exit(1);
  }

  const mp = [rts[0].exports.GetMultiplayerId(), rts[1].exports.GetMultiplayerId()];
  const pc = [rts[0].exports.GetLinkPlayerCount(), rts[1].exports.GetLinkPlayerCount()];
  console.log(`\n✅ CONN_ESTABLISHED at frame ${establishedAt}`);
  console.log(`   player count: ${pc.join(', ')}   multiplayer ids: ${mp.join(', ')}`);

  const step = () => {
    for (const node of nodes) node.maintainTerminals();
    for (const rt of rts) { rt.setKeys(0); rt.runFrame(); }
    for (const rt of rts) rt.exports.CheckShouldAdvanceLinkState();
    driveTransfers(nodes);
  };
  const recvdPlayers = (rt) => rt.rd8(rt.addrOf('gReceivedRemoteLinkPlayers'));

  // --- Phase 2: the game's own LinkPlayer-data exchange ------------------------
  // On establishment, gLinkCallback runs LinkCB_RequestPlayerDataExchange, which
  // round-trips each side's LinkPlayer block (validated by a "GameFreak inc."
  // magic + checksum). gReceivedRemoteLinkPlayers flips to 1 only when both
  // blocks arrive intact — so this is itself a verified block round-trip.
  let exchangeAt = -1;
  for (let f = 0; f < 300; f++) {
    step();
    if (recvdPlayers(rts[0]) && recvdPlayers(rts[1])) { exchangeAt = establishedAt + 1 + f; break; }
  }
  if (exchangeAt === -1) {
    console.log('\n❌ player-data exchange (gReceivedRemoteLinkPlayers) never completed');
    process.exit(1);
  }
  console.log(`✅ player-data block exchange verified (gReceivedRemoteLinkPlayers) at frame ${exchangeAt}`);

  // --- Phase 3: user block round-trip with a known payload ---------------------
  // Fully drain any in-flight player-data blocks first: wait for both link tasks
  // idle, clear received flags, run idle frames, clear again — so the receive
  // buffers/flags reflect only our payload, not the phase-2 exchange tail.
  for (let f = 0; f < 60 && !(rts[0].exports.IsLinkTaskFinished() && rts[1].exports.IsLinkTaskFinished()); f++) step();
  for (const rt of rts) rt.exports.ResetBlockReceivedFlags();
  for (let f = 0; f < 20; f++) step();
  for (const rt of rts) rt.exports.ResetBlockReceivedFlags();

  const payload = new Uint8Array(64);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 3) & 0xff;
  const sendBuf = rts[0].addrOf('gBlockSendBuffer');
  for (let i = 0; i < payload.length; i++) rts[0].wr8(sendBuf + i, payload[i]);

  for (const rt of rts) rt.exports.ResetBlockReceivedFlags();
  rts[0].exports.SendBlock(0, sendBuf, payload.length);

  let blockOk = false;
  let receivedAt = -1;
  for (let f = 0; f < 200 && !blockOk; f++) {
    step();
    // Slave receives the master's (player 0) block: bit 0 of its status. The
    // link also streams small standby keep-alive blocks, so a set flag isn't
    // necessarily OUR payload yet — match the distinctive 64-byte pattern, and
    // if it isn't ours, clear the flag and keep waiting.
    if (rts[1].exports.GetBlockReceivedStatus() & 1) {
      const recvBuf = rts[1].addrOf('gBlockRecvBuffer'); // [player][BLOCK_BUFFER_SIZE/2]
      const got = rts[1].bytes(recvBuf, payload.length);
      if (got.every((b, i) => b === payload[i])) { blockOk = true; receivedAt = f; }
      else rts[1].exports.ResetBlockReceivedFlag(0);
    }
  }

  if (!blockOk) {
    console.log('\n❌ user block was not received intact by the slave');
    process.exit(1);
  }
  console.log(`\n   master sent a 64-byte block; slave received it intact ${receivedAt} frames later`);
  console.log('\n✅ user block round-trip verified — the link transport works under wasm.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
