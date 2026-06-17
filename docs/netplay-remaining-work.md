# Netplay — remaining work

Status as of the M6 hardening pass: M1–M4 are done, M5 is spiked (the in-game
Cable Club provably drives the link itself), and M6 hardening is done. See
[`netplay-next-steps.md`](./netplay-next-steps.md) for the full milestone record
and the reproduce commands. This file is the forward-looking, actionable list.

The transport stack is finished and proven (in-process, cross-process, and
in-browser; desync-detected; latency-tolerant; reconnect-capable). **Everything
left is game-driving or productionization, not transport.**

---

## 1. Finish M5 — a full link trade + battle in the browser  ⭐ main remaining feature

The headless harness can't navigate the new-game intro to reach a real Cable
Club (proven in the M5 spike), so the end-to-end trade/battle is a browser task.
Two players, each from a loaded save, walk to a Pokémon Center Cable Club, talk
to the attendant, and the game drives the link while the JS shim supplies the
bus.

Sub-tasks (roughly in order):

1. **Run the SIO shim alongside the real game loop.** Today `web/netplay.mjs`
   silences `CB2` and calls `OpenLink` programmatically. Instead, leave
   `CB2_Overworld` running and route the per-frame serial exchange around the
   normal `WasmRunFrame()`:
   - Each frame, after the game stages `REG_SIOMLT_SEND`, push it to the
     transport, await the peer, deliver `REG_SIOMLT_RECV`, and let the game's
     own `SerialCB` fire (the bus already does all of this — it just needs to be
     driven once per `WasmRunFrame` instead of replacing the loop).
   - Files: `web/netplay.mjs` (new "live-loop" driver), `web/app.js` (online
     mode already suspends the single-player tick — reuse that).
2. **Reach a Cable Club from a save.** Save upload already exists
   (`web/app.js`). Each player loads a save positioned in/near a Pokémon Center
   2F, walks to the attendant, and selects Trade/Battle. No code may be needed
   here beyond the live-loop driver — the game scripts handle it.
3. **Trigger via the attendant, not `TryTradeLinkup`.** Drop the programmatic
   bring-up; let the `special TryTradeLinkup`/`TryBattleLinkup` fire from the
   map script (`data/scripts/cable_club.inc` → `src/cable_club.c`). The shim
   only provides the wire. (The M5 spike confirmed the game opens the link
   itself this way.)
4. **Hand off to the trade / battle callbacks.** After linkup the game switches
   to `CB2_StartCreateTradeMenu` (`src/trade.c`) or the battle controllers; the
   bus keeps running underneath unchanged. Watch for the `LinkCB_SendHeldKeys`
   steady state (`src/link.c`) — that's the established-link traffic, already
   carried by the bus.
5. **Verify:** two browser tabs (or two machines) complete a **link trade** and
   a **link battle** end to end, with the M3 desync detector wired in (call
   `transport.checkpointHash(frame, bus.transcript)` each frame) to catch any
   divergence.

Acceptance: a recorded two-tab session showing a trade and a battle completing,
desync detector quiet throughout.

---

## 2. Headless trade/battle determinism scenario  (deferred M6 item)

Once a Cable Club is reachable, add a save-loaded trade/battle scenario to
`tools/wasm_determinism.mjs` so the cross-machine guarantee is continuously
checked over real link traffic — not just the overworld walk.

Two ways to unblock the headless overworld-with-party state that this needs:

- **Save fixture:** check in a tiny valid `.sav` positioned at a Cable Club with
  a 1–2 mon party, and load it in the harness (mirrors the browser save-load
  path). Simplest, but adds a binary fixture.
- **WASM bring-up helper:** extend the `WasmStartNewGame` shim family with a
  `WasmEnterCableClub(species, level)` that warps the player into a Cable Club
  room with a test party (via `CreateMon` + a `SetWarpDestination`/`WarpIntoMap`
  to a Pokémon Center 2F). Keeps everything in-tree, no binary fixture.

Acceptance: `--scenario trade` runs two linked instances through a trade and
stays bit-identical (and `--diverge-at` still trips).

---

## 3. Browser reconnect  (M6 transport feature → UI)

The transport already supports auto-resume (`RelayTransport`'s `reconnect`
option) and the relay holds slots with a grace window. Wire it into the browser:

- Pass a `reconnect: { url, room }` config when the online session builds its
  transport; enable `reconnectGraceMs` on the served relay (`web/server.mjs`).
- Surface "reconnecting…" / "reconnected" / "peer lost" states in the connect
  UI (`web/index.html`, `#netplay-status`).
- Verify: pull the network briefly mid-session in one tab; the session resumes
  and the desync detector stays quiet.

---

## 4. Multi-peer (3–4 player) link

The relay already groups up to `max` peers; the bus and transport currently
assume two. Generalize for 3–4-player cable link (e.g. multi battles, the
4-player minigames):

- `RelayTransport`: build the full 4-slot `RECV` from all peers' words for a
  transfer (currently `localId`/`peerId` only), keyed by `seq` per player.
- `SioBus`/`LinkNode`: already model 4 slots; confirm terminal/id bits for
  `playerCount > 2`.
- Pick a transfer-clock owner (player 0 master) — unchanged.
- Verify: 3–4 headless peers reach `CONN_ESTABLISHED` with the right player
  count and round-trip a block.

---

## 5. Productionizing the relay  (before any public deployment)

The current relay is a dev convenience sharing the game server's port
(`web/server.mjs`). For a real deployment:

- **`wss://` / TLS** termination (behind a proxy or native).
- **Room codes:** collision-resistant generation + optional private rooms; today
  any string is a room.
- **Auth / origin checks** on upgrade if the relay is exposed beyond the static
  site's origin.
- **Capacity:** the abuse limits exist (rate, size, TTLs); add global caps
  (max rooms, max connections) and metrics/logging.
- **Horizontal scale** (optional): rooms are in-process; a shared backend
  (e.g. Redis pub/sub) would allow multiple relay instances.

---

## Explicitly still out of scope

- **Wireless adapter / Union Room (RFU).** The `librfu` async protocol is much
  more complex than the cable bus; cable trade + battle covers the core
  experience. Revisit after M5 ships.
- **Anti-cheat.** Peer-to-peer lockstep trusts clients — fine for a friendly
  site, not competitive integrity.

---

## Suggested order

1 (browser trade/battle) is the headline feature and unblocks a real demo. 3
(browser reconnect) is small and high-value once 1 lands. 2 (headless trade
determinism) is good insurance and pairs naturally with the helper from 1. 4
(multi-peer) and 5 (productionizing) are independent and can follow.
