#!/usr/bin/env node
// M6 hardening test for the room relay (web/relay.mjs). Pure relay logic — no
// wasm needed. Exercises the abuse/lifecycle guards by standing up a relay with
// deliberately tight limits and confirming each one fires:
//   1. oversized frame      -> connection dropped
//   2. message-rate exceeded -> connection dropped
//   3. join timeout          -> unfilled room reaped (roomClosed)
//   4. idle reap             -> filled-but-silent room reaped (roomClosed)
//
// Run: node tools/wasm_relay_hardening.mjs

import { startRelayServer } from '../web/relay.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Open a socket, optionally join a room, and collect messages + close reason.
function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs = [];
    const ev = { ws, msgs, closed: false };
    ws.onopen = () => resolve(ev);
    ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
    ws.onclose = () => { ev.closed = true; };
    ws.onerror = () => { ev.closed = true; };
    setTimeout(() => reject(new Error('open timeout')), 2000);
  });
}

const join = (ev, room, max = 2) => ev.ws.send(JSON.stringify({ type: 'join', room, max }));
const got = (ev, type) => ev.msgs.some((m) => m.type === type);

let pass = true;
const check = (ok, msg) => { console.log(`${ok ? '✅' : '❌'} ${msg}`); if (!ok) pass = false; };

async function scenario(name, limits, fn) {
  const { server, relay, port } = await startRelayServer(0, { ...limits, log: () => {} });
  try { await fn(`ws://127.0.0.1:${port}`); }
  finally { relay.stop(); server.close(); }
}

async function main() {
  // 1. Oversized frame -> dropped.
  await scenario('oversize', { maxMessageBytes: 64 }, async (url) => {
    const a = await open(url);
    join(a, 'r');
    await wait(50);
    a.ws.send(JSON.stringify({ type: 'xfer', seq: 0, word: 1, pad: 'x'.repeat(500) }));
    await wait(100);
    check(a.closed, 'oversized frame dropped the connection');
  });

  // 2. Message rate exceeded -> dropped.
  await scenario('rate', { messageRatePerSec: 5 }, async (url) => {
    const a = await open(url);
    join(a, 'r');
    for (let i = 0; i < 50; i++) a.ws.send(JSON.stringify({ type: 'xfer', seq: i, word: i }));
    await wait(150);
    check(a.closed, 'exceeding the message rate dropped the connection');
  });

  // 3. Join timeout -> unfilled room reaped.
  await scenario('jointimeout', { joinTimeoutMs: 120, sweepMs: 40 }, async (url) => {
    const a = await open(url);
    join(a, 'r', 2); // only one of two peers ever joins
    await wait(350);
    check(got(a, 'roomClosed'), 'unfilled room reaped after join timeout');
  });

  // 4. Idle reap -> filled-but-silent room reaped.
  await scenario('idle', { roomIdleMs: 120, sweepMs: 40 }, async (url) => {
    const a = await open(url);
    const b = await open(url);
    join(a, 'r', 2); join(b, 'r', 2);
    await wait(60);
    check(got(a, 'ready'), 'room filled (ready) before going idle');
    await wait(350); // no traffic -> should be reaped
    check(got(a, 'roomClosed') && got(b, 'roomClosed'), 'idle room reaped after TTL');
  });

  console.log(`\n${pass ? '✅' : '❌'} relay hardening ${pass ? 'verified' : 'FAILED'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
