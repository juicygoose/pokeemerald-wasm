# Netplay feasibility: determinism validation

This documents a prototype that validates the core assumption behind adding
GBA-link-cable multiplayer (trade / link battle / Union Room) to the wasm build.

## Why determinism is the question

The GBA link cable is a **synchronous lockstep bus**: every frame, each console
writes one 16-bit command word and reads back every other console's words. The
game's own link state machine (`src/link.c`, driven from `WasmRunFrame` via
`UpdateLinkAndCallCallbacks`) already speaks this protocol — it's just stubbed
off for the web build (`IsWirelessAdapterConnected()` returns `FALSE` under
`#if WASM`, `InitUnionRoom()` is a no-op, etc.).

Networking a lockstep bus is the easy, reliable model — *if and only if* every
peer computes bit-identical game state from the same inputs. If two clients ever
diverge, the link desyncs. So before building any relay/transport, we must prove
the wasm core is a **pure function of `(initial memory, per-frame key input)`**.

## What makes determinism plausible here

This is a wasm32 **recompile**, not a cycle-accurate emulator, which removes the
usual sources of nondeterminism:

- **No entropy crosses the wasm boundary.** Every import in `web/app.js`
  (`importsFor`) is a pure function: `CpuSet`, `LZ77/RL` decompression,
  `BgAffineSet/ObjAffineSet`, `Div`, `Sqrt`, `strcmp`. There is no `Date.now()`,
  no `Math.random()`, no RTC, no timer read. The only per-frame input is the
  `KEYINPUT` register.
- **RTC is never initialised** under `#if WASM` (`RtcInit()` is skipped in
  `AgbMain`), and the RTC-based RNG seed (`SeedRngWithRtc`) is compiled out:
  it's guarded by `#ifdef BUGFIX`, and `BUGFIX` is **not** defined (only `UBFIX`
  is, via `MODERN`). So the RNG (`gRngValue`) is not seeded from a wall clock.
- The only floats reaching game *logic* are `Div` (integer division) and `Sqrt`
  (`Math.sqrt`, IEEE-754 correctly rounded) — identical across platforms.
  `Math.sin/cos` are used only for affine **rendering** matrices written to OAM,
  which never feed back into game logic, so they cannot cause state divergence.

## The prototype

`tools/wasm_determinism.mjs` — a headless Node harness (no browser). It
instantiates the wasm directly using the same pure-function imports as
`web/app.js`, drives it frame-by-frame via the `KEYINPUT` register, and hashes
the full game state each frame.

**Where state lives (important):** `wasm-ld` places all C globals (`gMain`,
`gTasks`, `gSprites`, the save blocks, and the game's `gHeap` malloc arena) in
the **low** data/bss section of linear memory — *not* at GBA hardware addresses
`0x02000000`/`0x03000000`. The `EWRAM_DATA`/`COMMON_DATA` section attributes do
not relocate under wasm. The complete mutable state is therefore `[0,
__data_end)` (~7.2 MiB), which the harness hashes as the state fingerprint.
(VRAM/PAL/OAM live at their GBA addresses and are hashed separately as a
secondary video signal.)

### Results

```
# positive: 3 independent instances, identical input script
node tools/wasm_determinism.mjs --frames 1500 --instances 3 --emit golden.json
  → 1500 distinct state hashes over the run (sim genuinely advances every frame)
  → ✅ 3 instances stayed bit-identical for all 1500 frames

# cross-process: fresh process + fresh compile reproduces the golden run
node tools/wasm_determinism.mjs --frames 1500 --instances 1 --compare golden.json
  → ✅ CROSS-PROCESS match

# negative control: perturb instance 1's input on one frame; detector MUST flag it
node tools/wasm_determinism.mjs --frames 300 --instances 2 --diverge-at 150
  → ❌ IN-PROCESS DIVERGENCE at frame 150  (exit 1, as intended)
```

The positive result is **non-vacuous**: the state hash differs on all 1500
frames (intro/title/menus churn RNG and logic constantly), yet all instances
stay identical. The negative control proves the harness actually detects
divergence — a green result is meaningful.

## Conclusion & caveats

Lockstep netplay is viable: the core is deterministic under identical inputs,
in-process, and cross-process on this machine.

Remaining things to confirm as we build:
- **Cross-machine / cross-browser**: state determinism should hold (logic uses
  only integer `Div` and IEEE `Sqrt`), but this should be re-checked on a real
  second machine/browser. Video may differ by a pixel via `sin/cos`; that's
  irrelevant to link sync.
- **Save-dependent paths**: this run boots with empty flash and exercises the
  intro. A full link-trade/battle session from a loaded save should be added to
  the determinism script once we wire the SIO shim.
- **Seed agreement**: link sessions seed RNG from shared link data
  (`SeedRng(gMain.vblankCounter2)` in `link.c`, contest passes `gRngValue` over
  the wire) — both peers must agree, which the lockstep exchange provides.

## Next step (not in this prototype)

Re-enable the link layer for wasm by exposing the per-frame command exchange to
JS: each frame, read this peer's `gSendCmd`, send it over a WebSocket relay,
collect the other peers' words, write them into `gRecvCmds` around
`WasmRunFrame()`, and advance all peers in lockstep (with a small input-delay
buffer). First milestone: 2-player link trade + link battle.
