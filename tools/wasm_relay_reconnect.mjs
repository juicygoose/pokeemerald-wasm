#!/usr/bin/env node
// M6: reconnect across a transient socket drop, without losing lockstep.
//
// Lockstep cannot tolerate a single lost or duplicated serial word, so this is
// the perfect job for the M3 desync detector: run two peers in desync mode (they
// exchange transcript hashes every 16 frames), force one peer's socket to drop
// mid-session, and require the run to finish with the detector STILL quiet. A
// clean exit (0,0) means the relay held the slot, buffered the gap, replayed it
// on resume, and the de-duplicated re-post of the in-flight word kept both peers'
// wire transcripts bit-identical across the break.
//
// Run: node tools/wasm_relay_reconnect.mjs [--wasm PATH]

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startRelayServer } from '../web/relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function runPeer(label, url, room, wasm, extra) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [
      resolve(here, 'wasm_relay_client.mjs'),
      '--url', url, '--room', room, '--wasm', wasm, '--mode', 'desync', '--reconnect', ...extra,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (s) => s.toString().split('\n').filter(Boolean).forEach((l) => console.log(l)));
    child.stderr.on('data', (s) => process.stderr.write(`[peer ${label} stderr] ${s}`));
    child.on('exit', (code) => resolveP(code ?? 1));
  });
}

async function main() {
  const args = process.argv.slice(2);
  let wasm = 'build/wasm/pokeemerald.wasm';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wasm') wasm = args[++i];
    else { console.error(`unknown arg: ${args[i]}`); process.exit(2); }
  }

  // Grace window must outlast the reconnect; keep it short so the test is quick.
  const { server, relay, port } = await startRelayServer(0, { reconnectGraceMs: 5000, log: (m) => console.log(`[relay] ${m}`) });
  const url = `ws://127.0.0.1:${port}`;
  const room = `reconnect-${process.pid}`;
  console.log(`reconnect test: relay on ${url}, room ${room} (grace 5000ms)`);

  // --drop-at is honored only by the slave (runSlaveDesync), so passing it to
  // both peers drops exactly one of them at checkpoint 100.
  const [a, b] = await Promise.all([
    runPeer('A', url, room, wasm, ['--drop-at', '100']),
    runPeer('B', url, room, wasm, ['--drop-at', '100']),
  ]);

  relay.stop();
  server.close();
  const ok = a === 0 && b === 0; // 0,0 = completed with the desync detector quiet
  console.log(`\n${ok ? '✅' : '❌'} reconnect ${ok ? 'verified' : 'FAILED'} ` +
    `(peer exits ${a}, ${b}) — lockstep survived a transient drop with no desync`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
