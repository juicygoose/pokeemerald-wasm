# Netplay implementation roadmap

Feasibility is settled (see [`netplay-feasibility.md`](./netplay-feasibility.md)):
the wasm core is deterministic under identical inputs, and the game's unmodified
link layer reaches `CONN_ESTABLISHED` and round-trips blocks over a JS-emulated
serial bus. What remains is engineering, staged so each step is independently
verifiable.

## Guiding constraints

- **No game-logic changes.** Keep all multiplayer in JS + WASM-only shims, as
  the loopback prototype does. The C link layer is already correct.
- **Lockstep, not rollback.** Pokémon is turn-based; input-delay lockstep is
  enough and far simpler. Determinism (already proven) is what makes it safe.
- **The serial word is the only thing on the wire.** Each frame a peer sends one
  16-bit `REG_SIOMLT_SEND` value and receives the others'. Everything else
  (trade, battle, party data) is the game reconstructing state from those words.

## Milestones

### M1 — Extract the SIO bus into a reusable module
Pull the bus emulation out of `tools/wasm_link_loopback.mjs` into a shared
module with a transport interface:

```
class SioBus {
  stageWord(playerId, word)      // from REG_SIOMLT_SEND
  exchange() -> word[4]          // deliver RECV slots + call SerialCB on all
}
interface Transport { send(word); recv() -> Promise<word[]>; }
```

The loopback becomes a `LocalTransport` (array shuffle). **Verify:** loopback
test still passes against the refactored module.

### M2 — WebSocket relay transport
- Tiny relay server (extend `web/server.mjs`, or a Cloudflare Worker +
  Durable Object per `wrangler.toml`) that groups 2–4 peers into a room and
  forwards one `{frame, playerId, word}` message per transfer.
- `RelayTransport` implements the interface; the master only advances a frame
  once all peers' words for that frame have arrived (input-delay buffer of N
  frames to absorb latency).
- **Verify:** run two Node clients against the relay and reproduce the M1
  block round-trip across processes/sockets.

### M3 — Desync detection
Every K frames, exchange a truncated `stateHash()` (already implemented) over a
side channel and compare. On mismatch, surface a clear "desync" error rather
than silently diverging. **Verify:** intentionally perturb one client's input
and confirm the desync alarm fires (the determinism harness's `--diverge-at`
already demonstrates the detector logic).

### M4 — Browser integration (`web/app.js`)
- Add the SIO shim around `WasmRunFrame()`: read this peer's
  `REG_SIOMLT_SEND`, push to the transport, await peers, deliver `RECV`, call
  `SerialCB`. Gate it on an "online" mode so single-player is unaffected.
- Minimal connect UI (host/join a room code).
- **Verify:** two browser tabs reach `CONN_ESTABLISHED` and exchange a block,
  mirroring the loopback in-browser.

### M5 — Drive from the in-game Cable Club
Replace the programmatic `OpenLink` bring-up with the real flow: walk to a
Cable Club table, talk to the attendant, and let the game call `OpenLink`
itself. The shim just provides the bus. **Verify:** two players, each from a
loaded save, complete a **link trade** and a **link battle** end to end.

### M6 — Hardening
- Latency tuning (input-delay vs. responsiveness), reconnect on transient
  socket drops, room lifecycle/cleanup.
- Add a save-loaded trade/battle scenario to `tools/wasm_determinism.mjs` so
  the cross-machine determinism guarantee is continuously checked.
- Optional: confirm state determinism on a genuinely different machine/browser
  (logic uses only integer `Div` + IEEE `Sqrt`, so it should hold).

## Explicitly out of scope (for now)

- **Wireless adapter / Union Room (RFU).** The `librfu` async protocol is much
  more complex than the cable bus; cable-mode trade + battle covers the core
  multiplayer experience. Revisit after M5.
- **Anti-cheat.** Peer-to-peer lockstep trusts clients. Fine for a friendly
  site; not a competitive-integrity solution.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cross-machine state divergence | Low | Logic is integer-only; add M6 cross-machine check |
| Latency makes lockstep feel sluggish | Medium | Input-delay buffer; turn-based game is forgiving |
| Cable Club flow needs more shim surface than `OpenLink` | Medium | M5 spike before committing UI work |
| Relay abuse / room squatting | Low | Room TTLs, max peers, rate limits in M6 |

## Reproduce the prototypes

```
make wasm
node tools/wasm_determinism.mjs --frames 1500 --instances 3   # determinism
node tools/wasm_link_loopback.mjs                             # link transport
```
