// Shared headless GBA-wasm runtime for Node tooling (determinism, link loopback).
//
// Instantiates build/wasm/pokeemerald.wasm with the same pure-function imports
// as web/app.js, and exposes thin helpers to read/write linear memory and call
// exported game functions. No browser, no canvas — just the core + memory.

import { readFile } from 'node:fs/promises';

export async function compileModule(path) {
  const bytes = await readFile(path);
  return { bytes, module: await WebAssembly.compile(bytes) };
}

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
  const readS16 = (p) => (u16()[p >> 1] << 16) >> 16;
  const readS32 = (p) => { const h = u16(); return (h[p >> 1] | (h[(p + 2) >> 1] << 16)) | 0; };
  const writeS16 = (p, v) => { u16()[p >> 1] = v & 0xffff; };
  const writeS32 = (p, v) => { const h = u16(); h[p >> 1] = v & 0xffff; h[(p + 2) >> 1] = (v >> 16) & 0xffff; };
  const affineTerms = (xs, ys, rot) => {
    const a = rot * Math.PI * 2 / 256, sin = Math.sin(a) * 256, cos = Math.cos(a) * 256;
    return { pa: cos * xs / 256, pb: -sin * ys / 256, pc: sin * xs / 256, pd: cos * ys / 256 };
  };
  const bgAffineSet = (src, dest, count) => {
    for (let i = 0; i < count; i++) {
      const s = src + i * 20, d = dest + i * 16;
      const texX = readS32(s), texY = readS32(s + 4), scrX = readS16(s + 8), scrY = readS16(s + 10);
      const { pa, pb, pc, pd } = affineTerms(readS16(s + 12), readS16(s + 14), u16()[(s + 16) >> 1]);
      const a = pa | 0, b = pb | 0, c = pc | 0, e = pd | 0;
      writeS16(d, a); writeS16(d + 2, b); writeS16(d + 4, c); writeS16(d + 6, e);
      writeS32(d + 8, (texX - scrX * a - scrY * b) | 0); writeS32(d + 12, (texY - scrX * c - scrY * e) | 0);
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
    env[item.name] = (...a) => {
      switch (item.name) {
        case 'CpuSet': return copy(a[0], a[1], a[2] & 0x1fffff, (a[2] >>> 26) & 1 ? 4 : 2, (a[2] >>> 24) & 1);
        case 'CpuFastSet': return copy(a[0], a[1], a[2] & 0x1fffff, 4, (a[2] >>> 24) & 1);
        case 'LZ77UnCompWram':
        case 'LZ77UnCompVram': return lz77(a[0], a[1]);
        case 'RLUnCompWram':
        case 'RLUnCompVram': return rl(a[0], a[1]);
        case 'BgAffineSet': return bgAffineSet(a[0], a[1], a[2]);
        case 'ObjAffineSet': return objAffineSet(a[0], a[1], a[2], a[3]);
        case 'Div': return a[1] ? (a[0] / a[1]) | 0 : 0;
        case 'Sqrt': return Math.sqrt(a[0]) | 0;
        case 'strcmp': return readCString(a[0]).localeCompare(readCString(a[1]));
        default: return 0;
      }
    };
  }
  return { env };
}

const KEYINPUT = 0x04000130;
const KEY_MASK = 0x03ff;

export async function instantiate(module) {
  let inst;
  const memProxy = { get buffer() { return inst.exports.memory.buffer; } };
  inst = await WebAssembly.instantiate(module, importsFor(module, memProxy));
  const ex = inst.exports;
  ex.AgbMain();

  const u8 = () => new Uint8Array(ex.memory.buffer);
  const u16 = () => new Uint16Array(ex.memory.buffer);
  const u32 = () => new Uint32Array(ex.memory.buffer);

  return {
    exports: ex,
    dataEnd: ex.__data_end.value >>> 0,
    // memory access
    rd8: (p) => u8()[p],
    rd16: (p) => u16()[p >> 1],
    rd32: (p) => u32()[p >> 2],
    wr8: (p, v) => { u8()[p] = v & 0xff; },
    wr16: (p, v) => { u16()[p >> 1] = v & 0xffff; },
    wr32: (p, v) => { u32()[p >> 2] = v >>> 0; },
    bytes: (p, n) => u8().slice(p, p + n),
    addrOf: (name) => ex[name].value >>> 0,
    // input + frame
    setKeys: (mask) => { u16()[KEYINPUT >> 1] = KEY_MASK ^ (mask & KEY_MASK); },
    runFrame: () => ex.WasmRunFrame(),
    // full-state fingerprint over [0, __data_end)
    stateHash() {
      const w = new Uint32Array(ex.memory.buffer, 0, (ex.__data_end.value >>> 0) >> 2);
      let h = 2166136261;
      for (let i = 0; i < w.length; i++) {
        h = Math.imul(h ^ (w[i] & 0xffff), 16777619);
        h = Math.imul(h ^ (w[i] >>> 16), 16777619);
      }
      return h >>> 0;
    },
  };
}
