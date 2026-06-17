#!/usr/bin/env node
// M5 spike: can the game's OWN in-game Cable Club flow drive the link, instead
// of the programmatic OpenLink bring-up the M1-M4 prototypes use?
//
// The M1-M4 stack silences the main callback (SetMainCallback2(0)) and calls
// OpenLink() itself. M5's goal is the opposite: walk to a Cable Club, talk to
// the attendant, and let the GAME call OpenLink — the JS side only supplies the
// serial bus. This spike answers, headlessly, "how much shim surface does that
// need beyond OpenLink?" and how far the real flow gets without a browser.
//
// Findings demonstrated here (single instance, no relay needed):
//   1. A one-line WASM-only bring-up shim (WasmStartNewGame) reaches a running
//      overworld headlessly, skipping the title/Birch menus that need
//      interactive navigation a headless harness can't drive.
//   2. The game's own Cable Club entry (TryTradeLinkup, the `special` the
//      attendant script invokes) runs under the REAL overworld loop
//      (CB2_Overworld -> RunTasks -> Task_LinkupStart) and the game sets
//      LINKTYPE_TRADE_SETUP and calls OpenLinkTimed ITSELF — i.e. the game
//      drives the link, exactly as M5 wants. No transport changes are needed:
//      the M1 SioBus already carries whatever the game stages on the wire.
//   3. The boundary: triggering linkup requires a clean Cable Club field state.
//      Forced mid-intro (in the truck), the game's Task_LinkupStart opens the
//      link and then faults in AddWindow because the field isn't in a state to
//      open the cable-club window. Reaching that clean state headlessly means
//      playing the whole intro (exit truck -> ... -> a Pokemon Center Cable
//      Club), which can't be scripted blindly. The productive path to a full
//      link trade/battle is the BROWSER (M4's online session + real
//      navigation); the headless harness's role is transport/link-layer checks.
//
// Run: node tools/wasm_cable_club_spike.mjs [--wasm PATH]

import { resolve } from 'node:path';
import { compileModule, instantiate } from './wasm_gba_runtime.mjs';

const LINKTYPE_TRADE_SETUP = 0x1133;

function parseArgs() {
  const a = process.argv.slice(2);
  let wasm = 'build/wasm/pokeemerald.wasm';
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--wasm') wasm = a[++i];
    else { console.error(`unknown arg: ${a[i]}`); process.exit(2); }
  }
  return { wasm };
}

async function main() {
  const { wasm } = parseArgs();
  const { module } = await compileModule(resolve(wasm));
  const rt = await instantiate(module);

  const gLinkType = rt.addrOf('gLinkType');
  const gLinkCallback = rt.addrOf('gLinkCallback');
  const order = rt.addrOf('gSelectedOrderFromParty');
  const obj = rt.addrOf('gObjectEvents');

  let pass = true;
  const check = (ok, msg) => { console.log(`${ok ? '✅' : '❌'} ${msg}`); if (!ok) pass = false; };

  // --- Fact 1: reach a running overworld headlessly -------------------------
  for (let i = 0; i < 5; i++) { rt.setKeys(0); rt.runFrame(); }
  rt.exports.WasmStartNewGame();
  for (let f = 0; f < 90; f++) { rt.setKeys(0); rt.runFrame(); }

  const playerActive = (rt.rd8(obj) & 1) === 1;
  const mapType = rt.exports.GetCurrentMapType();
  check(playerActive && mapType !== 0,
    `overworld reached headlessly via WasmStartNewGame (player object active, mapType=${mapType})`);

  // --- Fact 2: the game's own Cable Club flow drives the link ---------------
  check(rt.rd32(gLinkCallback) === 0, 'link not yet open before the Cable Club flow runs');

  rt.wr8(order, 1); rt.wr8(order + 1, 2);   // the party slots the trade menu would pick
  rt.exports.TryTradeLinkup();              // the `special` the attendant script calls
  check((rt.rd16(gLinkType) & 0xffff) === LINKTYPE_TRADE_SETUP,
    `game set LINKTYPE_TRADE_SETUP (0x${rt.rd16(gLinkType).toString(16)}) — its own Cable Club entry ran`);

  // Step one frame: CB2_Overworld -> RunTasks -> Task_LinkupStart, which calls
  // OpenLinkTimed (the game opening the link itself) and then AddWindow.
  let boundary = null;
  try {
    rt.setKeys(0); rt.runFrame();
  } catch (e) {
    boundary = e;
  }
  const gameOpenedLink = rt.rd32(gLinkCallback) !== 0;
  check(gameOpenedLink,
    'game called OpenLinkTimed itself (gLinkCallback set by game code, not by JS)');

  // --- Fact 3: the documented boundary -------------------------------------
  if (boundary) {
    const where = String(boundary.stack || boundary).split('\n').slice(1, 3).map((s) => s.trim()).join(' <- ');
    console.log(`ℹ️  boundary (expected): forced mid-intro, Task_LinkupStart faults after opening the link`);
    console.log(`    ${where}`);
    console.log(`    => a full trade/battle needs a clean Cable Club field state; drive it in the browser (M4).`);
  } else {
    console.log('ℹ️  no fault this frame (field state was clean enough to open the cable-club window)');
  }

  console.log(`\n${pass ? '✅' : '❌'} M5 spike ${pass ? 'verified' : 'FAILED'}: the game's own Cable Club flow drives the link; transport needs no changes.`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
