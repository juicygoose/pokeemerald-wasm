#!/usr/bin/env node
// One relayed netplay peer (M2): a single wasm instance that links to its peer
// over the WebSocket relay and runs the same establish -> player-data ->
// user-block round-trip the in-process loopback verifies — but across processes
// and sockets, with no shared memory. Two of these (a master and a slave) talk
// only through web/relay.mjs.
//
// Run (normally launched by tools/wasm_link_relay.mjs):
//   node tools/wasm_relay_client.mjs --url ws://… --room R
//
// The peers are symmetric: the relay assigns player ids by arrival order, and
// player 0 is the SIO master (it owns the transfer clock), player 1 the slave.
// So the link role is DERIVED from the assigned id, never passed in.
//
// Exit 0 = this peer's checks passed. For the slave, that includes receiving the
// master's 64-byte block intact; the master drives the clock and exits 0 once it
// has run the full schedule.

import { resolve } from 'node:path';
import { compileModule, instantiate } from './wasm_gba_runtime.mjs';
import { LinkNode, SioBus, bootLinkInstance, connEstablished, playerCountOf } from './wasm_sio_bus.mjs';
import { RelayTransport, connectPeer, masterStepFrame, slaveStepFrame } from './wasm_relay_transport.mjs';

const PAYLOAD = new Uint8Array(64);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 7 + 3) & 0xff;

// Fixed, identical schedule on both peers so strict lockstep stays aligned
// (each peer only sees its own state, so phase lengths must not depend on the
// peer's state in a way the two could disagree on).
const CAP_ESTABLISH = 400; // safety cap; both deterministically hit it together
const DRAIN_A = 80;        // let player-data exchange + in-flight blocks settle
const DRAIN_B = 20;        // post-reset settle
const SEND_WINDOW = 250;   // frames to carry the user block across

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { url: '', room: 'r', wasm: 'build/wasm/pokeemerald.wasm' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--url') o.url = a[++i];
    else if (a[i] === '--room') o.room = a[++i];
    else if (a[i] === '--wasm') o.wasm = a[++i];
    else { console.error(`unknown arg: ${a[i]}`); process.exit(2); }
  }
  return o;
}

async function main() {
  const opts = parseArgs();

  const { module } = await compileModule(resolve(opts.wasm));
  const rt = await instantiate(module);

  const { ws, playerId, playerCount } = await connectPeer(opts.url, opts.room);
  // Construct the transport synchronously (attaches the message handler before
  // any await yields to the event loop), then barrier so neither side races.
  const transport = new RelayTransport(ws, { localId: playerId, peerId: 1 - playerId });

  // Link role is derived from the assigned id: player 0 is the SIO master.
  const role = playerId === 0 ? 'master' : 'slave';
  const tag = role.toUpperCase();
  const log = (m) => console.log(`[${tag}] ${m}`);
  log(`joined as player ${playerId} of ${playerCount}`);

  const name = playerId === 0 ? [0xc6, 0xb6] : [0xcd, 0xbb];
  bootLinkInstance(rt, { name });

  const node = new LinkNode(rt, playerId);
  const bus = new SioBus([node], transport);

  await transport.barrier();

  // --- Phase 1: reach CONN_ESTABLISHED (both roles step in lockstep) --------
  // The master drives the clock; the slave is reactive but detects establishment
  // on its own state — deterministically the same frame, so they stay aligned.
  const established = () => connEstablished(node.linkStatus) && playerCountOf(node.linkStatus) === 2;
  let establishedAt = -1;
  for (let f = 0; f < CAP_ESTABLISH; f++) {
    if (role === 'master') await masterStepFrame(bus, transport, { frame: f });
    else await slaveStepFrame(bus, transport, {});
    if (established()) { establishedAt = f; break; }
  }
  if (establishedAt === -1) { log('❌ never reached CONN_ESTABLISHED'); cleanup(ws); process.exit(1); }
  log(`✅ CONN_ESTABLISHED at frame ${establishedAt} (id ${rt.exports.GetMultiplayerId()}, ${rt.exports.GetLinkPlayerCount()} players)`);

  const ok = role === 'master'
    ? await runMaster(bus, transport, rt, log, establishedAt)
    : await runSlave(bus, transport, rt, log);
  cleanup(ws);
  process.exit(ok ? 0 : 1);
}

// MASTER drives all timing: drain until the link task is idle (so no block is in
// flight), clear the block-received flags with a settle gap (the loopback's
// pattern — a stale player-data flag otherwise blocks fresh reception), send the
// user block, carry it for a window, then signal finish.
async function runMaster(bus, transport, rt, log, establishedAt) {
  let frame = establishedAt + 1;
  const step = async () => { await masterStepFrame(bus, transport, { frame: frame++ }); };

  for (let f = 0; f < DRAIN_A && !rt.exports.IsLinkTaskFinished(); f++) await step();
  if (rt.rd8(rt.addrOf('gReceivedRemoteLinkPlayers'))) log('✅ player-data exchange completed');
  rt.exports.ResetBlockReceivedFlags();
  for (let f = 0; f < DRAIN_B; f++) await step();
  rt.exports.ResetBlockReceivedFlags();

  const sendBuf = rt.addrOf('gBlockSendBuffer');
  for (let i = 0; i < PAYLOAD.length; i++) rt.wr8(sendBuf + i, PAYLOAD[i]);
  rt.exports.ResetBlockReceivedFlags();
  const sent = rt.exports.SendBlock(0, sendBuf, PAYLOAD.length);
  log(`sent 64-byte block (SendBlock=${sent}); carrying it for ${SEND_WINDOW} frames`);
  for (let f = 0; f < SEND_WINDOW; f++) await step();
  transport.finish();
  log('✅ schedule complete');
  return true;
}

// SLAVE is purely reactive: it steps whenever the master drives, watching every
// frame for the master's (player 0) block. The stale player-data flag is cleared
// by resetting on each non-matching frame until our payload lands.
async function runSlave(bus, transport, rt, log) {
  let receivedAt = -1;
  let frame = 0;
  for (;;) {
    const { finished } = await slaveStepFrame(bus, transport, {});
    frame++;
    if (receivedAt === -1 && (rt.exports.GetBlockReceivedStatus() & 1)) {
      const got = rt.bytes(rt.addrOf('gBlockRecvBuffer'), PAYLOAD.length);
      if (got.every((b, i) => b === PAYLOAD[i])) receivedAt = frame;
      else rt.exports.ResetBlockReceivedFlag(0);
    }
    if (finished) break;
  }
  if (receivedAt === -1) { log('❌ master block not received intact'); return false; }
  log(`✅ received master's 64-byte block intact (${receivedAt} frames in)`);
  return true;
}

function cleanup(ws) { try { ws.send(JSON.stringify({ type: 'bye' })); ws.close(); } catch {} }

main().catch((e) => { console.error(e); process.exit(1); });
