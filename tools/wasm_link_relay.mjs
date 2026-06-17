#!/usr/bin/env node
// M2 verification: reproduce the loopback's link establishment + 64-byte block
// round-trip, but across two OS processes talking only through the WebSocket
// relay (web/relay.mjs) — proving the SioBus Transport seam works over real
// sockets, not just the in-process LocalTransport.
//
// Starts the relay in-process on an ephemeral port, spawns a master and a slave
// (tools/wasm_relay_client.mjs) as separate node processes, and passes iff both
// exit 0 (the slave's 0 means it received the master's block intact).
//
// Run: node tools/wasm_link_relay.mjs [--wasm PATH]

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startRelayServer } from '../web/relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function runPeer(label, url, room, wasm) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [
      resolve(here, 'wasm_relay_client.mjs'),
      '--url', url, '--room', room, '--wasm', wasm,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const prefix = (s) => s.toString().split('\n').filter(Boolean).forEach((l) => console.log(l));
    child.stdout.on('data', prefix);
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

  const { server, port } = await startRelayServer(0, { log: (m) => console.log(`[relay] ${m}`) });
  const url = `ws://127.0.0.1:${port}`;
  const room = `relay-test-${process.pid}`;
  console.log(`relay netplay test: relay on ${url}, room ${room}`);

  // Peers are symmetric; the relay assigns player 0 (SIO master) by arrival
  // order and each client derives its role. The barrier makes ordering robust.
  const [codeA, codeB] = await Promise.all([
    runPeer('A', url, room, wasm),
    runPeer('B', url, room, wasm),
  ]);

  server.close();
  const ok = codeA === 0 && codeB === 0;
  console.log(`\n${ok ? '✅' : '❌'} relay round-trip ${ok ? 'verified' : 'FAILED'} (peer exits ${codeA}, ${codeB})`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
