#!/usr/bin/env node
// 2-player GBA link-cable loopback over a JS-emulated SIO multiplayer bus.
//
// Proves the game's own link layer (src/link.c) runs under the wasm build with
// NO game-code changes: we just emulate the serial multiplayer hardware in JS.
// Two wasm instances negotiate a link, agree on player count + IDs, reach
// LINK_STATE_CONN_ESTABLISHED, and exchange a data block — exactly the
// machinery a real trade / link battle rides on.
//
// The SIO bus itself now lives in tools/wasm_sio_bus.mjs (M1): this script is
// just its LocalTransport driver + the verification. The same SioBus/Transport
// seam will back the WebSocket relay (M2) and the browser session (M4).
//
// Run: node tools/wasm_link_loopback.mjs [--frames N] [--wasm PATH] [--verbose]

import { resolve } from 'node:path';
import { compileModule, instantiate } from './wasm_gba_runtime.mjs';
import {
  LinkNode, SioBus, LocalTransport, bootLinkInstance, stepFrame,
  L, connEstablished, playerCountOf,
} from './wasm_sio_bus.mjs';

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
  const bus = new SioBus(nodes, new LocalTransport(nodes.length));

  // Boot both instances as link nodes (EOS-terminated names, silenced CB2,
  // OpenLink). The state machine then advances on its own each frame.
  const names = [[0xc6, 0xb6], [0xcd, 0xbb]]; // arbitrary 2-glyph names per node
  rts.forEach((rt, i) => bootLinkInstance(rt, { name: names[i] }));

  console.log(`link loopback: 2 instances, up to ${frames} frames`);
  let establishedAt = -1;

  for (let f = 0; f < frames; f++) {
    const transfers = await stepFrame(bus);

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

  const step = () => stepFrame(bus);
  const recvdPlayers = (rt) => rt.rd8(rt.addrOf('gReceivedRemoteLinkPlayers'));

  // --- Phase 2: the game's own LinkPlayer-data exchange ------------------------
  // On establishment, gLinkCallback runs LinkCB_RequestPlayerDataExchange, which
  // round-trips each side's LinkPlayer block (validated by a "GameFreak inc."
  // magic + checksum). gReceivedRemoteLinkPlayers flips to 1 only when both
  // blocks arrive intact — so this is itself a verified block round-trip.
  let exchangeAt = -1;
  for (let f = 0; f < 300; f++) {
    await step();
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
  for (let f = 0; f < 60 && !(rts[0].exports.IsLinkTaskFinished() && rts[1].exports.IsLinkTaskFinished()); f++) await step();
  for (const rt of rts) rt.exports.ResetBlockReceivedFlags();
  for (let f = 0; f < 20; f++) await step();
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
    await step();
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
