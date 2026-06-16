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

// Work RAM: this is where ALL mutable game-logic state lives. If these regions
// match frame-for-frame, the entire game simulation is identical.
const REGIONS = {
  EWRAM: { base: 0x02000000, size: 0x40000 }, // 256 KiB external work RAM
  IWRAM: { base: 0x03000000, size: 0x08000 }, //  32 KiB internal work RAM
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

function hex(n) { return (n >>> 0).toString(16).padStart(8, '0'); }

// --- one instance -------------------------------------------------------------
async function createInstance(module) {
  // The module declares and exports its own memory, so imports read it lazily
  // via a getter rather than us supplying a Memory object.
  let inst;
  const memProxy = { get buffer() { return inst.exports.memory.buffer; } };
  inst = await WebAssembly.instantiate(module, importsFor(module, memProxy));
  const u16 = () => new Uint16Array(inst.exports.memory.buffer);

  inst.exports.AgbMain();

  return {
    exports: inst.exports,
    setKeys(keyMask) { u16()[KEYINPUT >> 1] = KEY_MASK ^ (keyMask & KEY_MASK); },
    runFrame() { inst.exports.WasmRunFrame(); },
    regionHash(name) {
      const { base, size } = REGIONS[name];
      return fnv1a(new Uint8Array(inst.exports.memory.buffer, base, size));
    },
    stateHash() {
      // Combined work-RAM hash = full game-logic state fingerprint.
      let h = 0;
      for (const name of Object.keys(REGIONS)) h = (Math.imul(h ^ this.regionHash(name), 16777619)) >>> 0;
      return h >>> 0;
    },
  };
}

// --- input script -------------------------------------------------------------
// A deterministic schedule of held buttons by frame. Exercises title/intro,
// which churn the RNG and a lot of game logic — enough to expose nondeterminism.
function scriptedKeyMask(frame) {
  // Mash A then START in alternating bursts to advance intro screens.
  const phase = Math.floor(frame / 30) % 4;
  if (phase === 0) return buttons.a;
  if (phase === 2) return buttons.start;
  return 0;
}

function parseArgs(argv) {
  const o = { frames: 2000, instances: 2, wasm: 'build/wasm/pokeemerald.wasm', emit: null, compare: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--frames') o.frames = Number(argv[++i]);
    else if (a === '--instances') o.instances = Number(argv[++i]);
    else if (a === '--wasm') o.wasm = argv[++i];
    else if (a === '--emit') o.emit = argv[++i];
    else if (a === '--compare') o.compare = argv[++i];
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
  console.log(`frames: ${opts.frames}, instances: ${opts.instances}`);
  console.log('booting instances (AgbMain)...');

  const instances = [];
  for (let i = 0; i < opts.instances; i++) instances.push(await createInstance(module));

  // Sanity: post-boot state must already match across instances.
  const bootHashes = instances.map((x) => x.stateHash());
  console.log(`post-boot stateHash: ${bootHashes.map(hex).join(' ')}`);

  const checkpoints = [];        // [{ frame, hash, ewram, iwram }]
  const checkpointEvery = Math.max(1, Math.floor(opts.frames / 40));
  let firstDivergeFrame = -1;
  let firstDivergeDetail = null;

  for (let frame = 0; frame < opts.frames; frame++) {
    const keyMask = scriptedKeyMask(frame);
    for (const x of instances) { x.setKeys(keyMask); x.runFrame(); }

    // Cross-check every frame (cheap relative to a frame of game logic).
    const h0 = instances[0].stateHash();
    for (let i = 1; i < instances.length; i++) {
      if (instances[i].stateHash() !== h0 && firstDivergeFrame === -1) {
        firstDivergeFrame = frame;
        firstDivergeDetail = {
          instance: i,
          ewram: [instances[0].regionHash('EWRAM'), instances[i].regionHash('EWRAM')],
          iwram: [instances[0].regionHash('IWRAM'), instances[i].regionHash('IWRAM')],
        };
      }
    }

    if (frame % checkpointEvery === 0 || frame === opts.frames - 1) {
      checkpoints.push({
        frame,
        hash: h0,
        ewram: instances[0].regionHash('EWRAM'),
        iwram: instances[0].regionHash('IWRAM'),
      });
    }
  }

  console.log('\n--- checkpoints (frame: combined / EWRAM / IWRAM) ---');
  for (const c of checkpoints) {
    console.log(`${String(c.frame).padStart(5)}: ${hex(c.hash)} / ${hex(c.ewram)} / ${hex(c.iwram)}`);
  }

  let ok = true;

  if (firstDivergeFrame !== -1) {
    ok = false;
    console.log(`\n❌ IN-PROCESS DIVERGENCE at frame ${firstDivergeFrame}`);
    console.log(`   instance 0 vs ${firstDivergeDetail.instance}`);
    console.log(`   EWRAM ${firstDivergeDetail.ewram.map(hex).join(' vs ')}`);
    console.log(`   IWRAM ${firstDivergeDetail.iwram.map(hex).join(' vs ')}`);
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
