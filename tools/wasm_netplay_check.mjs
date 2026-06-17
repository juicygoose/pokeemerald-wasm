#!/usr/bin/env node
// Headless smoke test for the browser online driver (web/netplay.mjs), M4.
//
// Two real browser tabs can't be opened in CI, but web/netplay.mjs is written
// to be environment-agnostic: inject `rt`, `url`, and `present` and it runs the
// same establish -> block round-trip -> desync-checkpoint flow it runs in a tab.
// This drives two peers through that module over the in-process relay and passes
// iff the master reports a completed round-trip and the slave received the block.
//
// Run: node tools/wasm_netplay_check.mjs [--wasm PATH]

import { resolve } from 'node:path';
import { compileModule, instantiate } from './wasm_gba_runtime.mjs';
import { startRelayServer } from '../web/relay.mjs';
import { runOnlineSession } from '../web/netplay.mjs';

function rtAdapter(rt) {
  // wasm_gba_runtime already exposes exactly the surface netplay.mjs needs.
  return rt;
}

async function peer(module, url, room, statuses, label) {
  const rt = await instantiate(module);
  let last = '';
  await runOnlineSession({
    rt: rtAdapter(rt),
    room,
    url,
    getKeys: () => 0,
    onStatus: (s) => { last = s; console.log(`[${label}] ${s}`); },
    present: async () => {},
    shouldStop: () => false,
  });
  statuses[label] = last;
}

async function main() {
  const args = process.argv.slice(2);
  let wasm = 'build/wasm/pokeemerald.wasm';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wasm') wasm = args[++i];
    else { console.error(`unknown arg: ${args[i]}`); process.exit(2); }
  }

  const { module } = await compileModule(resolve(wasm));
  const { server, port } = await startRelayServer(0, { log: (m) => console.log(`[relay] ${m}`) });
  const url = `ws://127.0.0.1:${port}`;
  const room = `netplay-check-${process.pid}`;
  console.log(`browser-driver netplay check: relay ${url}, room ${room}`);

  const statuses = {};
  await Promise.all([
    peer(module, url, room, statuses, 'A'),
    peer(module, url, room, statuses, 'B'),
  ]);

  server.close();
  const all = Object.values(statuses).join('\n');
  const masterOk = /round-trip complete/.test(all);
  const slaveOk = /received master's 64-byte block intact/.test(all);
  const ok = masterOk && slaveOk;
  console.log(`\n${ok ? '✅' : '❌'} browser online driver ${ok ? 'verified' : 'FAILED'} ` +
    `(master round-trip: ${masterOk}, slave received block: ${slaveOk})`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
