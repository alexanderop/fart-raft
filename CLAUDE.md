# Fart Raft

A browser clone of [Fart Together](https://store.steampowered.com/app/5117550/Fart_Together/): 2–4 players sit on one raft, and each player's farts push it at their seat. Off-center pushes turn the raft. The skill is coordination. Get through obstacle courses with checkpoints against the clock.

Plan: **single player / couch co-op first, online multiplayer later.** Every architecture rule below exists so multiplayer becomes a swap of input sources, not a rewrite.

## Commands

```bash
pnpm dev        # vp dev → http://localhost:5173
pnpm start      # vp build, then the server also serves dist/ (STATIC=dist): one URL for game + /rpc
pnpm share      # public https://*.trycloudflare.com tunnel to localhost:$PORT (default 3000), no account needed
pnpm dev:server # online server: node server/main.ts → ws://localhost:3000/rpc (PORT=… to change). Not `pnpm server`: pnpm reserves that name
pnpm check      # vp check (fmt + lint + type-aware typecheck) + sim-only tsc + server tsc + vp test run
pnpm build      # vp build
pnpm fmt        # vp fmt
pnpm blender    # open assets-src/fart-raft.blend with the MCP server auto-started (localhost:9876)
pnpm kit        # headless Blender: build_kit.py → export_kit.py → public/models/kit.glb
pnpm course     # scripts/canyon.ts → courses/canyon.json (the course the client plays)
pnpm graveyard  # scripts/graveyard.ts → courses/graveyard.json (wide pools, octagon islands, logs and bumpers)
```

Toolchain is **Vite+** (`vite-plus`, `vp`): lint/fmt/test config all live in `vite.config.ts`. Import test APIs from `vite-plus/test`, not `vitest` (enforced by `vite-plus/prefer-vite-plus-imports`). The pre-commit hook runs `vp staged`.

## Stack

- **Three.js** renders 3D. **Rapier 2D** (`@dimforge/rapier2d-compat`) simulates on the water plane. 2D physics, 3D visuals.
- **Blender** (+ Blender MCP) for models and course layout, exported to `.glb` + `.json`.
- **Effect v4** (`effect`, `@effect/platform-node`) for the online server and the RPC client. Effect lives only in `server/` and `src/net/` (lint blocks it in `src/sim`, `src/client`, `src/input`).

## Architecture

```
 Keyboard / Gamepad / Bot / Network        Blender
          │ SeatInput (Command)              │ course .json (LevelData) + .glb (visuals)
          ▼                                  ▼
 ┌──────────── src/sim/ (pure TS: no DOM, no Three) ────────────┐
 │ step(sim, inputs[]) → SimEvent[]   fixed 60 Hz               │
 │ raft + gas · hazards.update() · phase state machine          │
 └──────┬─────────────────────────────────────────┬─────────────┘
        │ snapshot(sim) → Snapshot (prev/curr)    │ SimEvent[]
        ▼                                         ▼
  client/render interpolates          client/fx + ui: particles, shake, HUD (later audio)
```

### The three rules

1. **Inputs are data.** The sim only sees `SeatInput { move, fart }` per seat per tick (`move` is a world-space stick vector). It never reads the keyboard or the camera.
2. **Fixed timestep.** The sim steps at 60 Hz (`STEP`), rendering interpolates with `alpha`. Never pass a variable `dt` into the sim.
3. **`src/sim/` is headless.** It must run unchanged in Node (tests prove it today, the server later).

Online play is the same sim behind a different `InputSource`: the server runs `src/sim` unchanged, clients send `SeatInput` over Effect RPC and receive `Frame { snapshot, events }` at 20 Hz. RPCs: `CreateRoom { course }` → 4-letter code, `Join { code, name }` stream (= the seat lease: `Welcome { seat, token }`, then `Roster` on every change, then frames once started), `SendInput` / `Start` (host only) / `Restart` (any seated player), each carrying `{ code, token }`, so a client can only steer its own seat. **No bots online:** Start and Restart make the race's crew exactly the humans seated at that moment, in seat order, so `crewZones(n)` with n = humans, up to `MAX_CREW` = 8 per room (a ninth `Join` fails with `RoomFull`). A player's rider index can differ from their lobby seat: `Roster.crew[r] = { name, seat }` says who drives rider `r` (`riderOf(roster, seat)`, -1 = spectating). A mid-race joiner is seated but only watches (banner, input ignored) until the next restart; a leaver's rider stays on the raft idle (`seat: null`) until then. The client reads the crew size from `snapshot.riders.length` each frame, so the scene's zone marks, riders and name tags follow a crew change on restart without a reload. Relative imports carry explicit `.ts` extensions (Node strips types but does not resolve extensionless paths); `import/extensions` enforces it.

Rule 3 is enforced by tooling, not just this doc:

- `tsconfig.sim.json` type-checks `src/sim` with no DOM lib → `document`/`window` fail to compile.
- The lint override in `vite.config.ts` blocks `three` and `client/`, `input/`, `net/` imports from `src/sim/**`.
- `sim.test.ts` asserts determinism (same inputs → identical snapshot) and headless runs.
- `src/net/protocol.ts` ends with a `Drift` type that fails the typecheck when its schemas and `src/sim/types.ts` stop matching.

### Game programming patterns in use (Nystrom)

| Pattern             | Where                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| Game Loop           | `client/loop.ts`: fixed step, max 5 steps/frame, 250 ms clamp, interpolation   |
| Command             | `SeatInput`, `input/sources.ts` (`InputSource`, `idleSource` null object)      |
| Update Method       | `sim/hazards/*`: each hazard has `update(dt)`                                  |
| State               | `sim/flow.ts`: `countdown → racing → finished` as union + switch               |
| Event Queue         | `step()` returns `SimEvent[]`; the client drains them once per frame           |
| Type Object (light) | `sim/hazards/index.ts` `KINDS`: data picks `kind` + tuning, code owns behavior |

**Deliberately not used** (add only when the problem shows up, measure first): Component/ECS (too few entity types), Singleton/Service Locator (pass deps explicitly), Spatial Partition (Rapier's broadphase), Object Pool (particles use a fixed `InstancedMesh` ring instead).

## Layout

```
src/
  sim/          pure simulation. types.ts, constants.ts (feel knobs), sim.ts (createSim/step/snapshot),
                raft.ts, flow.ts, level.ts (buildLevel + parseLevel validator), hazards/,
                channel.ts (centerline sampling, bank walls, arc-length lookups)
  input/        keyboard.ts (WASD / Arrows bindings), sources.ts (InputSource, seats)
  client/       loop.ts, render/ (scene, coords), fx/ (particles, cameraShake), ui/ (hud)
  net/          protocol.ts (wire schemas + RaftRpcs, shared by browser and server), client.ts (`connect()`: the only place the browser touches Effect)
  main.ts       wiring only; client/session.ts is the local-vs-online split
server/         lobby.ts (Lobby service: rooms by code, max 200, a room empty on two 30 s sweeps is closed), room.ts (one room: lobby phase, host = longest-seated human, `MAX_CREW` seats (empty or human, never bots), crew = humans at Start/Restart, 60 Hz loop on the Effect clock while a human is seated, frame every 3rd tick), app.ts (RPC over WebSocket at /rpc), main.ts (Node entry), tsconfig.json (Node types, no DOM)
courses/        LevelData JSON. canyon.json (scripts/canyon.ts) is the default course, graveyard.json (scripts/graveyard.ts) plays with `?course=graveyard`; pond.json is the hand-written test course
scripts/        Node build scripts (own tsconfig with Node types)
assets-src/     fart-raft.blend, start_mcp.py, build_kit.py (procedural asset kit), export_kit.py
public/models/  kit.glb: every visual asset, one top-level node per asset (see "Asset kit")
```

## Conventions

- **Coordinates:** sim is 2D, `+x` = raft forward, `+y` = left. Three is Y-up: sim `(x, y)` → three `(x, 0, -y)`, sim `rot` → `rotation.y`. All conversion goes through `client/render/coords.ts`.
- **Zones:** the raft is round (`RAFT_RADIUS`). Riders wade in the water around it (`RIDER_RING`), hands on the ring, always facing its center: butt out. A crew of n (1–`MAX_CREW` = 8) splits the ring into n equal arcs: `createSim(level, crewZones(n))` (1 = whole ring, 2 = left/right halves, 3 = thirds, 4 = quarters: `0` rear-left, `1` rear-right, `2` front-left, `3` front-right). 5–8 come from `ring(n)` in the same order: mirrored left/right pairs from the rear forward, even seats on the left, an odd crew's last seat dead ahead. Every crew rides the same raft: a bigger one for big crews could not pass the courses' gaps, and eight bodies still fit, each with ±10° of arc to slide. The stick slides a rider along its arc (`clampToZone`); a fart is a short burst (`FART_TICKS`, `FART_COOLDOWN`, `FART_COST`) that pushes the raft from the rider toward the center, so position is the only steering and the raft never spins from farts. The collider (`RAFT_HULL`) includes the riders. Rider poses are in `Snapshot.riders`. The client tints each arc in its seat color (`client/render/zones.ts`, 8 `SEAT_COLORS`). Each rider pushes `crewPower(n)` × `FART_FORCE`: 2 alone, 1 for 2–4, `(4/n)^(2/3)` beyond, so the strongest push a big crew can aim one way matches a crew of four's (`sim.test.ts` checks 5–8 within 85–105%).
- **Online lobby** (`client/ui/lobby.ts`): Play online → name, then join by code or create a game on a course. The room screen shows the big code, a copy/share invite link (`?room=CODE`, plus `&server=<ws-url>` when not the default `ws://<host>:3000/rpc`), who is in, and Start for the host. Opening an invite link lands on the join screen with the code filled in. Empty seats show as "Open seat". Friends can join mid-race: they spectate and ride from the next restart.
- **Players:** the start menu (`client/ui/menu.ts`) picks humans (0–`MAX_LOCAL` = 4, one keyboard cluster each) and whether bots fill empty seats; `?players=N&bots=0|1` skips it. Humans take the first seats (P1 WASD + Space, P2 Arrows + Enter/Right Shift, P3 IJKL + U/O, P4 Numpad 8456 + Numpad 0; a single human gets either cluster), bots the rest up to 4. Online rooms take up to 8 humans. Keys walk relative to the camera.
- **Bots** (`input/bot.ts`) are plain `InputSource`s that read the latest `Snapshot`, nothing else, so the server can run them unchanged. Each slides to the spot in its arc opposite the push the crew needs and farts when its push lines up. Hazards move on a fixed schedule, so `input/crossing.ts` plans each crossing ahead: it follows candidate lanes and paces (steady, crawl, stop, back off, then full speed) as paths through time past the hazards' pure motion functions in `sim/hazards/shape.ts` and takes the one with the most room; the crew's bots share one plan. `bot.test.ts` races crews of 1–4, 6 and 8 on every course headless and must finish with at most 3 wipeouts.
- **Feel knobs** live in `sim/constants.ts` (`FART_FORCE`, burst length/cooldown/cost, `WALK_SPEED`, damping, `CURRENT_SPEED`, gas regen). Tune on an empty pond before building courses.
- **Course JSON** is always loaded through `parseLevel()`, never cast. New hazard kinds go in `HazardDef["kind"]`, `KINDS`, and the validator's `HAZARD_KINDS`.
- **Channel courses:** a course is mostly one `channel` (centerline control points + `halfWidth` + spiked `spikes` spans by arc length). `sim/channel.ts` smooths it (Chaikin) and derives the bank colliders; terrain, bots, camera and the HUD progress bar all read the same samples. Edit `scripts/canyon.ts`, then `pnpm course`; gates and hazards are placed by arc length. The water flows downstream along the centerline at `CURRENT_SPEED` once the race starts (drag is relative to the water, `applyWaterDrag`), so an idle raft drifts; the water shader draws matching streaks from the ribbon's `aFlow` attribute. Hazards: `spinner` (bar spinning about its center), `sweeper` (bar hinged on a bank, swings `SWEEP_AMPLITUDE`), `log` (spiked log rolling across the channel: axis along `rot`, center runs `range` m either side of (x, y), `phase`), `bumper` (round pumpkin of radius `hx` that swells by `BUMPER_PULSE` and throws the raft harder, `BUMPER_KNOCK`), `cross` (two-bar spinner, for wide pools), `hammer` (mallet hinged on the bank `HAMMER_ARM` m back along `rot`, slams onto its smash zone once a cycle and only hurts while down) and `piston` (spiked block resting in a bank, punches `range` m out along `rot`). Motion lives in `sim/hazards/shape.ts` as pure functions of time (`hazardBoxes`, `hammerLift`, `pistonOut`, …), shared by sim, bots and renderer. `rapids` stretches on a channel run at `RAPIDS_SPEED` (`channel.ts` `flowSpeed`), and the water shader froths there. A thick wall (both half-extents ≥ `ISLAND_MIN_HALF`) is an island: an octagon in the sim and in the renderer (`sim/island.ts`). `scripts/course.ts` has the helpers `canyon.ts` and `graveyard.ts` share.
- **Wipeouts, not lives:** any hazard or spike hit wipes the crew out (`hit` event, `Snapshot.deaths` counts them). The raft tumbles for `RESPAWN_TICKS`, then reappears `RESPAWN_BACK` m upstream of the last gate passed (`respawn` event), dead still, tanks full, with `INVULNERABLE_TICKS` of grace the client blinks it for. The clock keeps running; the HUD shows a skull counter. The renderer and camera treat a jump over `TELEPORT` m as a cut (`coords.ts` `jumped`).
- **Camera:** low chase camera like Fart Together (`chaseCamera.ts`: `BACK`, `HEIGHT`, `LOOK_AHEAD`), FOV widens with speed. Fart jets are dense swelling lime plumes (`fx/particles.ts`).
- **Sounds:** `client/fx/audio.ts` synthesizes everything except farts, which are CC0 Freesound clips in `public/sounds/fart-NN.mp3` (credits in `public/sounds/CREDITS.md`, bump `FART_CLIPS` when adding one). Each fart picks a random clip, pitched per seat (`seatRate`, any seat index) with ±10% jitter; the old synth fart plays until the clips decode.
- Tests: BDD nesting (`describe('given …')` → `describe('when …')` → `it('should …')`), and run the real `step()` rather than mocking Rapier.

## Asset kit

Look target: Fart Together gameplay (high camera over narrow blue channels on peach plateaus floating in a pale sky, coral cliffs, lime bumper rails, magenta spike strips, golden bamboo gates with yellow-on-red signs, puffy round trees, animal riders on a green ring). `build_kit.py` builds every asset from code, so edit the script, not the `.blend`, then `pnpm kit`.

`kit.glb` node contract (meters, origin at base center on the water plane, forward +x) used by `client/render/kit.ts` / `terrain.ts`:

- `raft` (round, radius 2.1 = sim `RAFT_RADIUS`, deck top ≈ 0.39) with children `rider_0..3` (capybara, blue hippo, purple hippo, croc, in seat order), feet in the water; the client moves them around the ring. Seats 4–7 have no model of their own: `client/render/riders.ts` clones `rider_{i % 4}` (with its `_head` / `_arm_l` / `_arm_r` children, renamed to `rider_i_*`) and turns its colored materials to the seat color's hue
- `spinner` 2 m bar, scaled `(hx, hy, hy)` (a `cross` is two of them) · `hammer` modelled down: axle at the origin 1.2 up, arm along +x to a spiked drum 6 m out, raised about the axle by the client; `hammer_post` on the bank · `piston` head half 1 × 1, scaled `(hx, 1, hy)`, spikes on +x; `piston_rod` 1 m along −x, stretched to the bank · `sweeper` 2 m arm with its pivot at the origin, scaled `(hx, 1, 1)` · `log` half-length 2.4, radius 1 with spike tips, rolled about x by the client and scaled `(hx / 2.4, hy, hy)` · `bumper` radius 1 with spike tips, grin toward +x, scaled uniformly by the pulsing radius · `spike_strip` 2 m along x, spikes toward sim +y, tiled along spiked spans
- `gate_post` (8.5 m), `gate_bar` (2 m, scaled to the gate), `start_sign`, `gate_sign`, `finish_sign` · decor: `tree_round`, `bush`, `fern`, `grass`

Terrain (water ribbon, plateaus, cliffs, rails, mesas, islands from thick `walls`, sky) is generated in the client from `LevelData`, not modeled.

## Blender pipeline (course export planned)

Blender MCP setup (done on this machine):

- Blender 5.2 (`brew install --cask blender`). The `blender_mcp.py` addon is in `~/Library/Application Support/Blender/5.2/scripts/addons/` and enabled in the saved user prefs.
- MCP registered at local scope for this project: `claude mcp add blender -e DISABLE_TELEMETRY=true -- uvx mcp-for-blender`.
- `pnpm blender` opens the project file and `start_mcp.py` starts the socket server, so no N-panel click is needed. Claude Code must start _after_ Blender to see the `mcp__blender__*` tools; restart the session if they're missing.

Rules for MCP sessions: save the `.blend` first (`execute_blender_code` runs arbitrary Python), and keep requests small ("add 5 rocks along the left bank", not "build the course") to avoid timeouts. Use `look` to check results visually.

A Python export script writes two files per course:

- `public/models/<course>.glb`: visual meshes (client only).
- `courses/<course>.json`: `LevelData` from naming conventions:
  - `col_*` → `walls` (box: position, rotation, half-extents)
  - `spawn_raft` → `spawn`
  - `checkpoint_NN` → `checkpoints` in order. The last one is the finish.
  - `hazard_<kind>_NN` with custom props (`speed`, …) → `hazards`

The server never parses `.glb`; it only needs the JSON.

## Status

Done:

- Vite+ project. Sim, fixed loop, keyboard for up to 4 (slide around your arc of the ring, tap to fart a short burst), R to restart
- Pond test course (tests), the canyon (863 m, half-width 7: sweepers, spinners, log, bumper, two rapids, a hammer gauntlet, piston alley, 6 checkpoints) and the graveyard (wide pools, islands, logs, bumpers, a cross, rapids to the finish)
- Fart Together pace: faster raft (`FART_FORCE` 70, `CURRENT_SPEED` 3.5, `WALK_SPEED` 4, `GAS_REGEN` 45), wipeout → respawn at the last gate with a death counter, low chase camera, big fart jets
- Fart Together look, matched against gameplay frames: high chase camera that follows the stream, floating plateaus with cliffs and mesas, lime rails, spike strips, golden bamboo START/CHECKPOINT/FINISH gates, green ring raft
- HUD: top progress bar (arc length), `mm:ss.cc` timer pill, fart puff counter, floating name tags with gas bars
- Animation: riders wade around the ring facing in, reach onto it, waddle when moving, idle/cheer/bump reactions, raft bob/bank, wind sway, wake/ripples, gate glow + confetti
- Start menu: 0–4 players, optional bots in empty seats, Esc back to menu
- Bot `InputSource` (snapshot-driven, headless, stuck recovery, follows the channel centerline); bots finish both courses with every crew size
- 21 tests: sim (countdown, burst thrust, one tap = one burst, push away from the rider without spin, riders stay on their arc facing the center, solo crew, determinism, headless, level and channel validation, canyon banks hold the raft) + bot races for crews 1–4, 6 and 8 on every course, plus 5–8 rider crews (balanced arcs, push matches four, riders stay on their eighth)
- Online multiplayer (`?online=1` or the menu's Play online): lobby with room codes and invite links, many rooms per server, host starts the race, authoritative rooms whose crew is exactly the humans in them (no bots online), up to 8 riders on one raft, seat leased for the life of the `Join` stream and proven by a token; lobby, room and real-WebSocket tests
- GitHub Pages deploy on push to `main`: https://alexanderop.github.io/fart-raft/

Next, in order:

1. Playtest the new pace with humans; fade gate signs that block the low camera; a course picker in the menu (only `?course=` today)
2. Blender: course export script (LevelData JSON from `col_*` / `checkpoint_NN` names), first real course
3. Audio (fart and bump sounds from `SimEvent`s), gamepad input
4. Multiplayer polish: back-to-lobby after the finish, gamepad navigation in the online menus, a deployed server for the GitHub Pages build, client prediction if latency hurts.
