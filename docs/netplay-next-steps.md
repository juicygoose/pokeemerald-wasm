# Netplay implementation roadmap

Feasibility is settled (see [`netplay-feasibility.md`](./netplay-feasibility.md)):
the wasm core is deterministic under identical inputs, and the game's unmodified
link layer reaches `CONN_ESTABLISHED` and round-trips blocks over a JS-emulated
serial bus. What remains is engineering, staged so each step is independently
verifiable.

## Status

| Milestone | State |
|---|---|
| M1 — Reusable SIO bus module | ✅ done |
| M2 — WebSocket relay transport | ✅ done |
| M3 — Desync detection | ✅ done |
| M4 — Browser integration | ✅ done |
| M5 — Drive from the in-game Cable Club | 🔶 spike done — thesis proven; full trade/battle is a browser task |
| M6 — Hardening | ⬜ |

The link cable now works in-process (M1), across two OS processes over real
WebSockets (M2), and **in the browser** (M4) — all with no game-code changes —
with a lockstep desync detector (M3) catching any divergence between peers. Run
them with the commands in [Reproduce the prototypes](#reproduce-the-prototypes).

## Guiding constraints

- **No game-logic changes.** Keep all multiplayer in JS + WASM-only shims, as
  the loopback prototype does. The C link layer is already correct.
- **Lockstep, not rollback.** Pokémon is turn-based; input-delay lockstep is
  enough and far simpler. Determinism (already proven) is what makes it safe.
- **The serial word is the only thing on the wire.** Each frame a peer sends one
  16-bit `REG_SIOMLT_SEND` value and receives the others'. Everything else
  (trade, battle, party data) is the game reconstructing state from those words.

## Milestones

### M1 — Extract the SIO bus into a reusable module ✅ done
Pull the bus emulation out of `tools/wasm_link_loopback.mjs` into a shared
module with a transport interface:

```
class SioBus {
  exchange() -> Promise<word[4]>  // stage local SIOMLT_SEND, swap, deliver RECV,
                                  // call SerialCB on all local nodes
  driveFrame() -> Promise<count>  // master-paced batch of exchanges per frame
}
interface Transport { send(playerId, word); recv() -> Promise<word[4]>; }
```

Done in `tools/wasm_sio_bus.mjs`: `LinkNode` (per-console register/struct
accessors), `SioBus` (transfer + per-frame cadence), `LocalTransport` (the
loopback's synchronous word shuffle), plus `bootLinkInstance` / `stepFrame`
shims. `tools/wasm_link_loopback.mjs` is now just the LocalTransport driver +
verification. **Verified:** loopback still reaches `CONN_ESTABLISHED` (frame 7),
completes the player-data exchange, and round-trips a 64-byte user block. The
same `Transport` seam is what M2's relay and M4's browser session plug into.

> Build note: a clean `make wasm` previously failed in preproc because the
> per-map `*.inc` files are only prerequisites of the *native* `maps.o`, not the
> wasm one. `map_data_rules.mk` now declares those prerequisites for
> `$(WASM_OBJ_DIR)/maps.o` and `map_events.o`, so `make wasm` generates them
> itself — making the reproduction steps below work from a fresh checkout.

### M2 — WebSocket relay transport ✅ done
- `web/relay.mjs`: a dependency-free RFC 6455 room relay (hand-rolled over
  Node's `http` upgrade; the client uses Node's global `WebSocket`). It groups
  peers into a room, assigns player ids by arrival order, and forwards each
  `{type:'xfer'|'frameEnd'|...}` message to the other peers verbatim. Wired into
  `web/server.mjs` so it shares the dev server's port.
- `tools/wasm_relay_transport.mjs`: `RelayTransport` (the M1 `Transport`,
  send/recv keyed by a monotonic transfer `seq`) plus role drivers. Player 0 is
  the SIO master and owns the transfer clock (its `SioBus.driveFrame` reads the
  master node's `SIO_START`/`Timer3`); the slave is reactive, doing one exchange
  per master `xfer` and ending the frame on the master's `frameEnd` marker. The
  `frameEnd` carries the master's `seq` so the slave asserts it replayed the
  same number of transfers — a built-in lockstep-desync tripwire (seeds M3).
- `tools/wasm_relay_client.mjs` (one peer) + `tools/wasm_link_relay.mjs`
  (orchestrator: starts the relay, spawns a master + slave as separate
  processes). The master is authoritative for timing — it drains to a clean
  idle boundary, sends the block, then signals `finish`; the slave steps
  reactively and watches for the block throughout.
- **Verified:** `node tools/wasm_link_relay.mjs` — two OS processes, talking
  only over WebSockets, reach `CONN_ESTABLISHED` (frame 7, same as the loopback)
  and the master's 64-byte block arrives intact at the slave. Strict lockstep
  (0 input-delay); the latency/input-delay buffer is left to M6 tuning.

### M3 — Desync detection ✅ done
Every K frames each peer samples a checksum over a side channel and compares; on
mismatch it raises a clear "desync" error instead of silently diverging.

What's checksummed is the **serial transcript**, not the full `stateHash()`. The
two peers are different players (different names, link ids, `isMaster`), so their
full game states legitimately differ — a full-state compare would always
"mismatch". The shared truth is instead the wire: every transfer's 4-slot RECV
vector (slot i = player i's word) is bit-identical on every peer, so a rolling
FNV-1a of every applied RECV word (`SioBus.transcript`,
[`tools/wasm_sio_bus.mjs`](../tools/wasm_sio_bus.mjs)) is identical across peers
exactly while they stay in lockstep. This catches wrong word *values*, strictly
stronger than M2's per-frame transfer-*count* tripwire.

- `RelayTransport.checkpointHash(key, hash)` posts a `{type:'hash'}` over the
  relay (forwarded verbatim — no relay change) and compares against the peer's
  for the same `key`; the first mismatch records `transport.desync` and the
  drivers surface it. A `finishAck` handshake lets a clean run prove every
  checkpoint was compared (per-peer socket ordering guarantees all hashes
  arrived before the ack).
- `tools/wasm_relay_client.mjs --mode desync` drives the established link in
  strict lockstep and samples every 16 frames; `--corrupt-at F` is the negative
  control (the slave flips one bit of its transcript hash at checkpoint `F`).
- **Verified:** `node tools/wasm_link_desync.mjs` runs two scenarios — a clean
  run stays in sync across all 19 checkpoints (detector quiet), and the negative
  control fires the desync alarm on **both** peers at checkpoint 160. The
  determinism harness's `--diverge-at` independently demonstrates the same
  detector logic against real state divergence in-process.

### M4 — Browser integration ✅ done
The browser now runs the *same* SIO stack the headless tooling does — no second
implementation. The key realization: `tools/wasm_sio_bus.mjs` and
`tools/wasm_relay_transport.mjs` use only browser-safe globals (`WebSocket`,
`JSON`, `Math`), and `web/app.js` is already an ES module, so the browser imports
them directly (the dev server serves the repo root; `.mjs` now maps to a JS MIME
type in `web/server.mjs`).

- `web/netplay.mjs`: an environment-agnostic online-session driver. It takes an
  injected `rt` (the live wasm instance), a `present()` callback (render + yield
  to the browser between steps), and a room code, then runs the relay client's
  exact flow — connect, bring the link up, reach `CONN_ESTABLISHED`, round-trip a
  64-byte block — sampling `bus.transcript` every 16 frames for **M3 desync
  detection in the tab**.
- `web/app.js`: an `rt` adapter over the running instance (the same shape
  `wasm_gba_runtime.mjs` returns), plus an "online" mode that suspends the
  single-player tick (by bumping `bootId`) and lets the session drive rendering.
  Single-player is untouched until you connect; disconnecting reboots it.
- `web/index.html` / `style.css`: a minimal connect panel (room code + a
  Connect/Disconnect button) and a dedicated status line.
- **Verify:** open two tabs, type the same room code in both, click Connect —
  both reach `CONN_ESTABLISHED` and the block round-trips, mirroring the
  loopback in-browser. Two real tabs can't run in CI, so the same browser driver
  is exercised headlessly by `tools/wasm_netplay_check.mjs` (two peers through
  `web/netplay.mjs` over the in-process relay): establishment at frame 7, block
  intact, 17 desync checkpoints in sync.

### M5 — Drive from the in-game Cable Club 🔶 spike done
Goal: replace the programmatic `OpenLink` bring-up with the real flow — walk to
a Cable Club, talk to the attendant, let the game call `OpenLink` itself; the
shim just provides the bus.

**Spike (`tools/wasm_cable_club_spike.mjs`) — what it proved:**
1. **The transport needs no changes.** Everything M1–M4 built (SioBus, relay,
   desync) is agnostic to who opens the link.
2. **The game drives the link itself.** Calling `TryTradeLinkup` (the very
   `special` the attendant script invokes — see `data/scripts/cable_club.inc` →
   `src/cable_club.c:610`) under the real overworld loop (`CB2_Overworld` →
   `RunTasks` → `Task_LinkupStart`) makes the game set `LINKTYPE_TRADE_SETUP`
   and call `OpenLinkTimed` on its own (verified: `gLinkCallback` is set by game
   code, not JS). This is exactly M5's thesis.
3. **The real shim surface beyond `OpenLink` is *running the full game loop*,
   not new transport code.** M1–M4 silenced the main callback; M5 must let
   `CB2_Overworld` and the whole field/menu stack run. The cable-club flow is
   input-driven (A-button confirms, `GetFieldMessageBoxMode`, windows) and uses
   `OpenLinkTimed` + `GetLinkPlayerDataExchangeStatusTimed` + a trainer-card
   block exchange + `LinkCB_SendHeldKeys` steady state — all carried by the
   existing bus.

**New headless infra:** `WasmStartNewGame` (a one-line WASM-only shim in
`src/main.c`, gated `#if WASM`, like `WasmRunFrame`) jumps straight into a fresh
game's overworld, skipping the title/Birch menus that need interactive
navigation. It exists only because JS can't synthesize the C function pointer
`SetMainCallback2(CB2_NewGame)` needs.

**The boundary / why the rest is a browser task:** triggering linkup needs a
*clean Cable Club field state*. Forced mid-intro (the new-game truck), the
game's `Task_LinkupStart` opens the link and then faults in `AddWindow` — the
field isn't ready to open the cable-club window. Reaching a real Cable Club
headlessly means playing the entire intro (exit truck → Littleroot → … → a
Pokémon Center Cable Club in another town, with a party), which can't be
scripted blindly (confirmed: naive input never even leaves the truck). So:

- **Full link trade + battle is driven in the browser** using M4's online
  session plus real navigation (two players, each from a loaded save, walk to
  the attendant). The headless harness stays for transport/link-layer checks.
- Remaining M5 work (browser): swap the prototype's programmatic bring-up for
  the attendant flow, route the per-frame `REG_SIOMLT_SEND`/`SerialCB` shim
  through `WasmRunFrame` while `CB2_Overworld` runs, and hand off to the trade
  (`CB2_StartCreateTradeMenu`) / battle callbacks. **Verify:** two players
  complete a link trade and a link battle end to end.

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
| Cable Club flow needs more shim surface than `OpenLink` | ~~Medium~~ Retired | M5 spike proved the game drives `OpenLink` itself under the normal loop; the only "extra surface" is running the full game loop (no new transport code) |
| Relay abuse / room squatting | Low | Room TTLs, max peers, rate limits in M6 |

## Reproduce the prototypes

```
make wasm
node tools/wasm_determinism.mjs --frames 1500 --instances 3   # determinism
node tools/wasm_link_loopback.mjs                             # M1 in-process bus
node tools/wasm_link_relay.mjs                                # M2 cross-process relay
node tools/wasm_link_desync.mjs                               # M3 desync detection
node tools/wasm_netplay_check.mjs                             # M4 browser driver (headless)
node web/server.mjs   # then open http://localhost:8000 in two tabs, same room  # M4 in-browser
node tools/wasm_cable_club_spike.mjs                          # M5 spike (game-driven link)
```
