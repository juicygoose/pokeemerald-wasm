#!/usr/bin/env node
// M3 verification: desync detection over the WebSocket relay.
//
// Two peers establish the link (as in M2) and then drive it in strict lockstep,
// sampling the SHARED serial-transcript hash every N frames over a side channel
// and comparing. The transcript (a rolling FNV-1a of every applied RECV vector)
// is bit-identical on both peers exactly while they stay in lockstep, so it is
// the natural checksum for catching divergence — strictly stronger than M2's
// per-frame transfer-count tripwire (it catches wrong word *values*, not just
// count drift).
//
// Runs two scenarios and passes iff BOTH behave as required:
//   1. clean      — peers stay in sync; the detector must stay quiet (exit 0).
//   2. negative   — one peer injects a transcript fault (--corrupt-at); the
//                   detector MUST fire on both peers (exit 3), proving teeth.
//
// Run: node tools/wasm_link_desync.mjs [--wasm PATH]

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startRelayServer } from '../web/relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function runPeer(label, url, room, wasm, extra) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [
      resolve(here, 'wasm_relay_client.mjs'),
      '--url', url, '--room', room, '--wasm', wasm, '--mode', 'desync', ...extra,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (s) => s.toString().split('\n').filter(Boolean).forEach((l) => console.log(l)));
    child.stderr.on('data', (s) => process.stderr.write(`[peer ${label} stderr] ${s}`));
    child.on('exit', (code) => resolveP(code ?? 1));
  });
}

async function scenario(name, url, wasm, extra) {
  const room = `desync-${name}-${process.pid}`;
  console.log(`\n--- scenario: ${name} (room ${room}) ---`);
  const [a, b] = await Promise.all([
    runPeer('A', url, room, wasm, extra),
    runPeer('B', url, room, wasm, extra),
  ]);
  console.log(`scenario ${name}: peer exits ${a}, ${b}`);
  return [a, b];
}

async function main() {
  const args = process.argv.slice(2);
  let wasm = 'build/wasm/pokeemerald.wasm';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wasm') wasm = args[++i];
    else { console.error(`unknown arg: ${args[i]}`); process.exit(2); }
  }

  const { server, port } = await startRelayServer(0, { log: (m) => console.log(`[relay] ${m}`) });
  const url = `ws://127.0.0.1:${port}`;
  console.log(`desync netplay test: relay on ${url}`);

  // 1. Clean run: detector must stay quiet (both peers exit 0).
  const [c0, c1] = await scenario('clean', url, wasm, []);
  const cleanOk = c0 === 0 && c1 === 0;

  // 2. Negative control: slave corrupts its transcript at a checkpoint frame
  // (160 is a multiple of the 16-frame cadence). The alarm MUST fire (exit 3).
  const [n0, n1] = await scenario('negative', url, wasm, ['--corrupt-at', '160']);
  const negativeOk = n0 === 3 && n1 === 3;

  server.close();
  const ok = cleanOk && negativeOk;
  console.log(`\nclean run ${cleanOk ? '✅ stayed in sync' : '❌ unexpected result'}`);
  console.log(`negative control ${negativeOk ? '✅ desync alarm fired on both peers' : '❌ alarm did NOT fire as required'}`);
  console.log(`\n${ok ? '✅' : '❌'} M3 desync detection ${ok ? 'verified' : 'FAILED'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
