// Browser online (netplay) session driver — M4 of docs/netplay-next-steps.md.
//
// Reuses the exact same SIO stack the headless prototypes use (no game-code
// changes): SioBus + RelayTransport + the master/slave step drivers from
// tools/. The only browser-specific parts are (a) an `rt` adapter over the live
// wasm instance, supplied by the caller, and (b) `present()`, an async callback
// the caller uses to render a frame and yield to the browser between steps so
// the tab stays responsive while we step the link in strict lockstep.
//
// What it does, mirroring tools/wasm_relay_client.mjs in-browser: connect to the
// room relay, bring the link up programmatically, reach CONN_ESTABLISHED, and
// round-trip a 64-byte block — while sampling the shared transcript hash every
// HASH_EVERY frames (M3) so any divergence between the two tabs is caught.

import {
  LinkNode, SioBus, bootLinkInstance, connEstablished, playerCountOf,
} from '../tools/wasm_sio_bus.mjs';
import {
  RelayTransport, connectPeer, masterStepFrame, slaveStepFrame,
} from '../tools/wasm_relay_transport.mjs';

const PAYLOAD = new Uint8Array(64);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 7 + 3) & 0xff;

// Same fixed schedule as the headless client so strict lockstep stays aligned.
const CAP_ESTABLISH = 400;
const DRAIN_A = 80;
const DRAIN_B = 20;
const SEND_WINDOW = 250;
const HASH_EVERY = 16; // M3 desync checkpoint cadence (frames)

const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');

// A WebSocket URL for the relay on the same origin that served the page.
export function relayUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

// Run one online session to completion (or until `shouldStop()` flips). All UI
// touchpoints are injected so this module stays DOM-free and reusable.
export async function runOnlineSession({ rt, room, url, name, getKeys, onStatus, present, shouldStop }) {
  url ||= relayUrl();
  let ws;
  try {
    onStatus(`connecting to relay…`);
    ({ ws } = await connectPeerInfo(url, room));
  } catch (e) {
    onStatus(`❌ could not join room "${room}": ${e.message || e}`);
    return;
  }

  const { playerId, playerCount } = ws.__joinInfo;
  const transport = new RelayTransport(ws, { localId: playerId, peerId: 1 - playerId });
  const role = playerId === 0 ? 'master' : 'slave';
  onStatus(`joined "${room}" as ${role} (player ${playerId}/${playerCount}); bringing link up…`);

  // Bring the link up on the live instance (the same shim the loopback uses).
  // Distinct per-role names mirror the headless client (caller may override).
  bootLinkInstance(rt, { name: name ?? (role === 'master' ? [0xc6, 0xb6] : [0xcd, 0xbb]) });
  const node = new LinkNode(rt, playerId);
  const bus = new SioBus([node], transport);
  await transport.barrier();

  const established = () => connEstablished(node.linkStatus) && playerCountOf(node.linkStatus) === 2;

  try {
    // --- Phase 1: reach CONN_ESTABLISHED -----------------------------------
    let frame = 0;
    let establishedAt = -1;
    for (let f = 0; f < CAP_ESTABLISH && !shouldStop(); f++) {
      if (role === 'master') await masterStepFrame(bus, transport, { keys: getKeys(), frame: frame++ });
      else await slaveStepFrame(bus, transport, { keys: getKeys() });
      await present();
      if (established()) { establishedAt = f; break; }
    }
    if (shouldStop()) { onStatus('disconnected.'); return; }
    if (establishedAt < 0) { onStatus('❌ never reached CONN_ESTABLISHED'); return; }
    onStatus(`✅ CONN_ESTABLISHED (frame ${establishedAt}, id ${rt.exports.GetMultiplayerId()}, ${rt.exports.GetLinkPlayerCount()} players) — exchanging block…`);

    // --- Phase 2: block round-trip + M3 desync checkpoints -----------------
    if (role === 'master') await runMaster(bus, transport, rt, frame, getKeys, present, onStatus, shouldStop);
    else await runSlave(bus, transport, rt, getKeys, present, onStatus, shouldStop);
  } catch (e) {
    if (transport.desync) {
      const { key, local, peer } = transport.desync;
      onStatus(`❌ DESYNC at checkpoint ${key}: ${hex(local)} != ${hex(peer)}`);
    } else {
      onStatus(`❌ link error: ${e.message || e}`);
    }
  } finally {
    cleanup(ws);
  }
}

// Resolve once the room is ready, stashing the join info on the socket so the
// caller can construct the transport synchronously right after.
function connectPeerInfo(url, room) {
  return connectPeer(url, room).then((info) => {
    info.ws.__joinInfo = { playerId: info.playerId, playerCount: info.playerCount };
    return info;
  });
}

function checkpoint(transport, bus, cp) {
  if (cp % HASH_EVERY === 0) transport.checkpointHash(cp, bus.transcript);
}

async function runMaster(bus, transport, rt, startFrame, getKeys, present, onStatus, shouldStop) {
  let frame = startFrame;
  let cp = 0;
  const step = async () => {
    await masterStepFrame(bus, transport, { keys: getKeys(), frame: frame++ });
    checkpoint(transport, bus, cp++);
    await present();
    if (transport.desync) throw new Error('desync');
  };

  for (let f = 0; f < DRAIN_A && !rt.exports.IsLinkTaskFinished() && !shouldStop(); f++) await step();
  rt.exports.ResetBlockReceivedFlags();
  for (let f = 0; f < DRAIN_B && !shouldStop(); f++) await step();
  rt.exports.ResetBlockReceivedFlags();

  const sendBuf = rt.addrOf('gBlockSendBuffer');
  for (let i = 0; i < PAYLOAD.length; i++) rt.wr8(sendBuf + i, PAYLOAD[i]);
  rt.exports.ResetBlockReceivedFlags();
  rt.exports.SendBlock(0, sendBuf, PAYLOAD.length);
  onStatus(`sent 64-byte block; carrying it for ${SEND_WINDOW} frames…`);
  for (let f = 0; f < SEND_WINDOW && !shouldStop(); f++) await step();

  transport.finish();
  if (!transport.desync && !shouldStop()) await transport.awaitFinishAck();
  if (shouldStop()) onStatus('disconnected.');
  else onStatus(`✅ block round-trip complete — in sync across ${Math.ceil(cp / HASH_EVERY)} checkpoints`);
}

async function runSlave(bus, transport, rt, getKeys, present, onStatus, shouldStop) {
  let receivedAt = -1;
  let cp = 0;
  let frame = 0;
  for (;;) {
    const { finished } = await slaveStepFrame(bus, transport, { keys: getKeys() });
    if (!finished) { checkpoint(transport, bus, cp++); }
    frame++;
    await present();
    if (transport.desync) throw new Error('desync');
    if (receivedAt === -1 && (rt.exports.GetBlockReceivedStatus() & 1)) {
      const got = rt.bytes(rt.addrOf('gBlockRecvBuffer'), PAYLOAD.length);
      if (got.every((b, i) => b === PAYLOAD[i])) receivedAt = frame;
      else rt.exports.ResetBlockReceivedFlag(0);
    }
    if (finished || shouldStop()) break;
  }
  transport.finishAck();
  if (shouldStop()) onStatus('disconnected.');
  else if (receivedAt === -1) onStatus('❌ master block not received intact');
  else onStatus(`✅ received master's 64-byte block intact (frame ${receivedAt}) — in sync across ${Math.ceil(cp / HASH_EVERY)} checkpoints`);
}

function cleanup(ws) {
  try { ws.send(JSON.stringify({ type: 'bye' })); ws.close(); } catch {}
}
