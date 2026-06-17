#!/usr/bin/env node
// Determinism harness for the pokeemerald wasm build.
//
// Goal: validate the core assumption behind GBA-link-cable netplay — that the
// wasm core is a pure function of (initial memory, per-frame key input). If two
// independent instances fed identical inputs stay bit-identical in work RAM for
// the whole run, then lockstep netcode (exchange one input word per frame) is
// viable: every peer can reproduce every other peer's game state exactly.
//
// This deliberately does NOT use a browser. It instantiates the wasm the same
// way web/app.js does (same pure-function imports), which also makes it the
// foundation for the link prototype: JS drives WasmRunFrame() and owns memory.
//
// Usage:
//   node tools/wasm_determinism.mjs [--frames N] [--instances K]
//                                   [--emit golden.json] [--compare golden.json]
//                                   [--wasm path]
//
//   --frames N      total emulated frames to run (default 2000)
//   --instances K   number of in-process instances to cross-check (default 2)
//   --emit FILE     write a golden hash-per-checkpoint file (cross-process check)
//   --compare FILE  compare this run against a previously emitted golden file
//   --wasm PATH     wasm module path (default build/wasm/pokeemerald.wasm)
//   --diverge-at N  negative control: perturb instance 1's input at frame N;
//                   the run MUST then report divergence (proves the test works)
//
// Exit code 0 = deterministic, 1 = divergence detected / mismatch.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// --- GBA memory map (within the wasm linear memory) ---------------------------
const REG = 0x04000000;
const KEYINPUT = 0x04000130;
const KEY_MASK = 0x03ff;
const PAL = 0x05000000;
const VRAM = 0x06000000;
const OAM = 0x07000000;

// NOTE on where state lives: this is a wasm32 recompile, not a GBA-address
// emulator. wasm-ld places all C globals (gMain, gTasks, gSprites, the game's
// gHeap malloc arena, the save blocks, ...) in the LOW data/bss section of
// linear memory — NOT at GBA hardware addresses 0x02000000/0x03000000. The
// EWRAM_DATA/COMMON_DATA section attributes don't relocate under wasm. So the
// complete mutable game state is exactly [0, __data_end), which includes the
// static heap. Hashing that range == fingerprinting the whole simulation.
//
// Hardware-mapped regions (VRAM/PAL/OAM/IO) ARE at their GBA addresses inside
// the 256 MiB linear memory and are display/IO surfaces, derived from the
// state above — we hash them separately as a secondary signal.
const HW_REGIONS = {
  PAL: { base: 0x05000000, size: 0x400 },
  VRAM: { base: 0x06000000, size: 0x18000 },
  OAM: { base: 0x07000000, size: 0x400 },
};

const buttons = {
  a: 1 << 0, b: 1 << 1, select: 1 << 2, start: 1 << 3,
  right: 1 << 4, left: 1 << 5, up: 1 << 6, down: 1 << 7,
  r: 1 << 8, l: 1 << 9,
};

// --- wasm imports: identical semantics to web/app.js importsFor() -------------
// Every import is a pure, deterministic function. There is no clock, no RNG, no
// entropy crossing the boundary. That is the whole reason determinism is even
// on the table.
function importsFor(module, mem) {
  const u8 = () => new Uint8Array(mem.buffer);
  const u16 = () => new Uint16Array(mem.buffer);

  const copy = (src, dst, count, size, fill) => {
    const m = u8();
    for (let i = 0; i < count; i++) {
      const from = fill ? src : src + i * size;
      m.set(m.subarray(from, from + size), dst + i * size);
    }
  };
  const lz77 = (src, dst) => {
    const m = u8();
    const size = m[src + 1] | (m[src + 2] << 8) | (m[src + 3] << 16);
    let s = src + 4, d = dst; const end = dst + size;
    while (d < end) {
      const flags = m[s++];
      for (let bit = 7; bit >= 0 && d < end; bit--) {
        if (flags & (1 << bit)) {
          const pair = (m[s] << 8) | m[s + 1]; s += 2;
          let length = (pair >> 12) + 3; const disp = (pair & 0xfff) + 1;
          while (length-- && d < end) { m[d] = m[d - disp]; d++; }
        } else m[d++] = m[s++];
      }
    }
  };
  const rl = (src, dst) => {
    const m = u8();
    const size = m[src + 1] | (m[src + 2] << 8) | (m[src + 3] << 16);
    let s = src + 4, d = dst; const end = dst + size;
    while (d < end) {
      const flag = m[s++];
      if (flag & 0x80) { let c = (flag & 0x7f) + 3; const v = m[s++]; while (c-- && d < end) m[d++] = v; }
      else { let c = (flag & 0x7f) + 1; while (c-- && d < end) m[d++] = m[s++]; }
    }
  };
  const readCString = (ptr) => { const m = u8(); let o = ''; while (m[ptr]) o += String.fromCharCode(m[ptr++]); return o; };
  const readS16 = (ptr) => (u16()[ptr >> 1] << 16) >> 16;
  const readS32 = (ptr) => { const h = u16(); return (h[ptr >> 1] | (h[(ptr + 2) >> 1] << 16)) | 0; };
  const writeS16 = (ptr, v) => { u16()[ptr >> 1] = v & 0xffff; };
  const writeS32 = (ptr, v) => { const h = u16(); h[ptr >> 1] = v & 0xffff; h[(ptr + 2) >> 1] = (v >> 16) & 0xffff; };
  const affineTerms = (xScale, yScale, rotation) => {
    const angle = rotation * Math.PI * 2 / 256;
    const sin = Math.sin(angle) * 256, cos = Math.cos(angle) * 256;
    return { pa: cos * xScale / 256, pb: -sin * yScale / 256, pc: sin * xScale / 256, pd: cos * yScale / 256 };
  };
  const bgAffineSet = (src, dest, count) => {
    for (let i = 0; i < count; i++) {
      const s = src + i * 20, d = dest + i * 16;
      const texX = readS32(s), texY = readS32(s + 4);
      const scrX = readS16(s + 8), scrY = readS16(s + 10);
      const { pa, pb, pc, pd } = affineTerms(readS16(s + 12), readS16(s + 14), u16()[(s + 16) >> 1]);
      const a = pa | 0, b = pb | 0, c = pc | 0, e = pd | 0;
      writeS16(d, a); writeS16(d + 2, b); writeS16(d + 4, c); writeS16(d + 6, e);
      writeS32(d + 8, (texX - scrX * a - scrY * b) | 0);
      writeS32(d + 12, (texY - scrX * c - scrY * e) | 0);
    }
  };
  const objAffineSet = (src, dest, count, offset) => {
    for (let i = 0; i < count; i++) {
      const s = src + i * 6, d = dest + i * offset * 4;
      const { pa, pb, pc, pd } = affineTerms(readS16(s), readS16(s + 2), u16()[(s + 4) >> 1]);
      writeS16(d, pa | 0); writeS16(d + offset, pb | 0); writeS16(d + offset * 2, pc | 0); writeS16(d + offset * 3, pd | 0);
    }
  };

  const env = {};
  for (const item of WebAssembly.Module.imports(module)) {
    if (item.kind !== 'function') continue;
    env[item.name] = (...args) => {
      switch (item.name) {
        case 'CpuSet': return copy(args[0], args[1], args[2] & 0x1fffff, (args[2] >>> 26) & 1 ? 4 : 2, (args[2] >>> 24) & 1);
        case 'CpuFastSet': return copy(args[0], args[1], args[2] & 0x1fffff, 4, (args[2] >>> 24) & 1);
        case 'LZ77UnCompWram':
        case 'LZ77UnCompVram': return lz77(args[0], args[1]);
        case 'RLUnCompWram':
        case 'RLUnCompVram': return rl(args[0], args[1]);
        case 'BgAffineSet': return bgAffineSet(args[0], args[1], args[2]);
        case 'ObjAffineSet': return objAffineSet(args[0], args[1], args[2], args[3]);
        case 'Div': return args[1] ? (args[0] / args[1]) | 0 : 0;
        case 'Sqrt': return Math.sqrt(args[0]) | 0;
        case 'strcmp': return readCString(args[0]).localeCompare(readCString(args[1]));
        default: return 0;
      }
    };
  }
  return { env };
}

// --- FNV-1a over a byte range -------------------------------------------------
function fnv1a(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// FNV-1a over 32-bit words (4x fewer iterations; same fingerprinting power).
function fnv1aWords(words) {
  let h = 2166136261;
  for (let i = 0; i < words.length; i++) {
    h = Math.imul(h ^ (words[i] & 0xffff), 16777619);
    h = Math.imul(h ^ (words[i] >>> 16), 16777619);
  }
  return h >>> 0;
}

function hex(n) { return (n >>> 0).toString(16).padStart(8, '0'); }

// --- one instance -------------------------------------------------------------
async function createInstance(module, scenario = 'title') {
  // The module declares and exports its own memory, so imports read it lazily
  // via a getter rather than us supplying a Memory object.
  let inst;
  const memProxy = { get buffer() { return inst.exports.memory.buffer; } };
  inst = await WebAssembly.instantiate(module, importsFor(module, memProxy));
  const u16 = () => new Uint16Array(inst.exports.memory.buffer);

  inst.exports.AgbMain();
  // The 'overworld' scenario jumps straight into a fresh game's overworld via
  // the WASM bring-up shim (see src/main.c), exercising map load + field tasks +
  // the RNG far more than the title/intro the default scenario churns — a much
  // stronger continuous determinism check for the netplay guarantee.
  if (scenario === 'overworld') inst.exports.WasmStartNewGame();

  // [0, __data_end) is the entire static data + bss + game heap = full state.
  const dataEnd = inst.exports.__data_end.value >>> 0;

  return {
    exports: inst.exports,
    dataEnd,
    setKeys(keyMask) { u16()[KEYINPUT >> 1] = KEY_MASK ^ (keyMask & KEY_MASK); },
    runFrame() { inst.exports.WasmRunFrame(); },
    // Full game-state fingerprint: every C global + the malloc arena.
    stateHash() {
      return fnv1aWords(new Uint32Array(inst.exports.memory.buffer, 0, dataEnd >> 2));
    },
    hwHash(name) {
      const { base, size } = HW_REGIONS[name];
      return fnv1a(new Uint8Array(inst.exports.memory.buffer, base, size));
    },
    videoHash() {
      let h = 0;
      for (const name of Object.keys(HW_REGIONS)) h = Math.imul(h ^ this.hwHash(name), 16777619) >>> 0;
      return h >>> 0;
    },
  };
}

// --- input script -------------------------------------------------------------
// A deterministic schedule of held buttons by frame, per scenario. Both churn
// the RNG and a lot of game logic — enough to expose nondeterminism.
function scriptedKeyMask(frame, scenario = 'title') {
  if (scenario === 'overworld') {
    // Advance the new-game truck/Mom dialogue with periodic A taps.
    return (frame % 24 < 2) ? buttons.a : 0;
  }
  // title/intro: mash A then START in alternating bursts to advance screens.
  const phase = Math.floor(frame / 30) % 4;
  if (phase === 0) return buttons.a;
  if (phase === 2) return buttons.start;
  return 0;
}

function parseArgs(argv) {
  const o = { frames: 2000, instances: 2, wasm: 'build/wasm/pokeemerald.wasm', emit: null, compare: null, divergeAt: -1, scenario: 'title' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--frames') o.frames = Number(argv[++i]);
    else if (a === '--instances') o.instances = Number(argv[++i]);
    else if (a === '--wasm') o.wasm = argv[++i];
    else if (a === '--emit') o.emit = argv[++i];
    else if (a === '--compare') o.compare = argv[++i];
    else if (a === '--scenario') o.scenario = argv[++i]; // 'title' (default) | 'overworld'
    // Negative control: feed instance 1 a different button on this one frame.
    // The run MUST then report divergence — proves the detector has teeth.
    else if (a === '--diverge-at') o.divergeAt = Number(argv[++i]);
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const wasmPath = resolve(opts.wasm);
  const bytes = await readFile(wasmPath);
  const module = await WebAssembly.compile(bytes);

  console.log(`wasm: ${wasmPath} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`);
  console.log(`frames: ${opts.frames}, instances: ${opts.instances}, scenario: ${opts.scenario}`);
  console.log('booting instances (AgbMain)...');

  const instances = [];
  for (let i = 0; i < opts.instances; i++) instances.push(await createInstance(module, opts.scenario));

  console.log(`state region: [0, 0x${instances[0].dataEnd.toString(16)}) = ${(instances[0].dataEnd / 1048576).toFixed(1)} MiB`);

  // Sanity: post-boot state must already match across instances.
  const bootHashes = instances.map((x) => x.stateHash());
  console.log(`post-boot stateHash: ${bootHashes.map(hex).join(' ')}`);

  const checkpoints = [];        // [{ frame, hash, video }]
  const checkpointEvery = Math.max(1, Math.floor(opts.frames / 40));
  let firstDivergeFrame = -1;
  let firstDivergeDetail = null;
  const distinctStateHashes = new Set();
  const distinctVideoHashes = new Set();

  for (let frame = 0; frame < opts.frames; frame++) {
    const keyMask = scriptedKeyMask(frame, opts.scenario);
    for (let i = 0; i < instances.length; i++) {
      // Optional perturbation for the negative control.
      const k = (i === 1 && frame === opts.divergeAt) ? buttons.right : keyMask;
      instances[i].setKeys(k);
      instances[i].runFrame();
    }

    // Cross-check every frame (cheap relative to a frame of game logic).
    const h0 = instances[0].stateHash();
    const v0 = instances[0].videoHash();
    distinctStateHashes.add(h0);
    distinctVideoHashes.add(v0);
    for (let i = 1; i < instances.length; i++) {
      if (firstDivergeFrame === -1 && (instances[i].stateHash() !== h0 || instances[i].videoHash() !== v0)) {
        firstDivergeFrame = frame;
        firstDivergeDetail = {
          instance: i,
          state: [h0, instances[i].stateHash()],
          video: [v0, instances[i].videoHash()],
        };
      }
    }

    if (frame % checkpointEvery === 0 || frame === opts.frames - 1) {
      checkpoints.push({ frame, hash: h0, video: v0 });
    }
  }

  console.log('\n--- checkpoints (frame: stateHash / videoHash) ---');
  for (const c of checkpoints) {
    console.log(`${String(c.frame).padStart(5)}: ${hex(c.hash)} / ${hex(c.video)}`);
  }

  // Liveness: if state/video never change, the test is vacuous. They MUST vary.
  console.log(`\ndistinct state hashes over run: ${distinctStateHashes.size}, distinct video hashes: ${distinctVideoHashes.size}`);
  if (distinctStateHashes.size < 2) {
    console.log('⚠️  game state never changed — emulation may not be advancing; determinism result is not meaningful.');
  }

  let ok = true;

  if (firstDivergeFrame !== -1) {
    ok = false;
    console.log(`\n❌ IN-PROCESS DIVERGENCE at frame ${firstDivergeFrame} (instance 0 vs ${firstDivergeDetail.instance})`);
    console.log(`   state ${firstDivergeDetail.state.map(hex).join(' vs ')}`);
    console.log(`   video ${firstDivergeDetail.video.map(hex).join(' vs ')}`);
  } else if (opts.instances > 1) {
    console.log(`\n✅ ${opts.instances} instances stayed bit-identical for all ${opts.frames} frames`);
  }

  if (opts.compare) {
    const golden = JSON.parse(await readFile(resolve(opts.compare), 'utf8'));
    const mismatch = golden.checkpoints.find((g, i) => !checkpoints[i] || checkpoints[i].hash !== g.hash);
    if (mismatch) {
      ok = false;
      console.log(`\n❌ CROSS-PROCESS MISMATCH vs ${opts.compare} at frame ${mismatch.frame}`);
    } else {
      console.log(`\n✅ CROSS-PROCESS match vs ${opts.compare} (${golden.checkpoints.length} checkpoints)`);
    }
  }

  if (opts.emit) {
    await writeFile(resolve(opts.emit), JSON.stringify({ wasm: opts.wasm, frames: opts.frames, checkpoints }, null, 2));
    console.log(`\nwrote golden file: ${opts.emit}`);
  }

  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
