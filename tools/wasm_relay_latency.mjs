#!/usr/bin/env node
// M6: prove lockstep netplay is latency-tolerant. Pokemon is turn-based, so
// input-delay lockstep should be "forgiving" — latency changes wall-clock time
// but NOT the deterministic game-frame schedule. This runs the M2 block
// round-trip and the M3 desync clean run through a relay with injected
// forwarding latency and confirms both still complete correctly.
//
// It also demonstrates the key invariant: establishment still happens at the
// same game frame (7) regardless of latency — lockstep is paced in frames, not
// milliseconds, so the only cost of latency is slower wall-clock progress.
//
// Run: node tools/wasm_relay_latency.mjs [--latency MS] [--wasm PATH]

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startRelayServer } from '../web/relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function runPeer(url, room, wasm, mode, lines) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [
      resolve(here, 'wasm_relay_client.mjs'),
      '--url', url, '--room', room, '--wasm', wasm, '--mode', mode,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (s) => s.toString().split('\n').filter(Boolean).forEach((l) => { lines.push(l); console.log(l); }));
    child.stderr.on('data', (s) => process.stderr.write(s));
    child.on('exit', (code) => resolveP(code ?? 1));
  });
}

async function scenario(name, mode, url, wasm, expectMs) {
  const room = `lat-${name}-${process.pid}`;
  console.log(`\n--- ${name} (mode ${mode}, ~${expectMs}ms each way) ---`);
  const start = Date.now();
  const lines = [];
  const [a, b] = await Promise.all([
    runPeer(url, room, wasm, mode, lines),
    runPeer(url, room, wasm, mode, lines),
  ]);
  const wall = Date.now() - start;
  const establishedAtFrame7 = lines.some((l) => /CONN_ESTABLISHED at frame 7/.test(l));
  const ok = a === 0 && b === 0 && establishedAtFrame7;
  console.log(`${name}: exits ${a},${b}; established@frame7=${establishedAtFrame7}; wall=${wall}ms`);
  return ok;
}

async function main() {
  const args = process.argv.slice(2);
  let wasm = 'build/wasm/pokeemerald.wasm';
  let latency = 15;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wasm') wasm = args[++i];
    else if (args[i] === '--latency') latency = Number(args[++i]);
    else { console.error(`unknown arg: ${args[i]}`); process.exit(2); }
  }

  const { server, relay, port } = await startRelayServer(0, { forwardDelayMs: latency, log: () => {} });
  const url = `ws://127.0.0.1:${port}`;
  console.log(`latency test: relay on ${url}, injecting ${latency}ms each way`);

  const blockOk = await scenario('block-roundtrip', 'block', url, wasm, latency);
  const desyncOk = await scenario('desync-clean', 'desync', url, wasm, latency);

  relay.stop();
  server.close();
  const ok = blockOk && desyncOk;
  console.log(`\n${ok ? '✅' : '❌'} latency tolerance ${ok ? 'verified' : 'FAILED'} ` +
    `— lockstep + desync complete under ${latency}ms latency, establishment still at frame 7`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
