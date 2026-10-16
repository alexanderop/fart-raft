# Fart Raft

A browser clone of [Fart Together](https://store.steampowered.com/app/5117550/Fart_Together/): 2–4 players sit on one raft, and each player's farts push it at their seat. Off-center pushes turn the raft. The skill is coordination. Get through obstacle courses with checkpoints against the clock.

Plan: **single player / couch co-op first, online multiplayer later.** Every architecture rule below exists so multiplayer becomes a swap of input sources, not a rewrite.

## Commands

```bash
pnpm dev        # vp dev → http://localhost:5173
pnpm check      # vp check (fmt + lint + type-aware typecheck) + sim-only tsc + vp test run
pnpm build      # vp build
pnpm fmt        # vp fmt
pnpm blender    # open assets-src/fart-raft.blend with the MCP server auto-started (localhost:9876)
pnpm kit        # headless Blender: build_kit.py → export_kit.py → public/models/kit.glb
```

Toolchain is **Vite+** (`vite-plus`, `vp`): lint/fmt/test config all live in `vite.config.ts`. Import test APIs from `vite-plus/test`, not `vitest` (enforced by `vite-plus/prefer-vite-plus-imports`). The pre-commit hook runs `vp staged`.

## Stack

- **Three.js** renders 3D. **Rapier 2D** (`@dimforge/rapier2d-compat`) simulates on the water plane. 2D physics, 3D visuals.
- **Blender** (+ Blender MCP) for models and course layout, exported to `.glb` + `.json`.
- Later: Node server running the same `src/sim/`, Colyseus or plain `ws`.

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

1. **Inputs are data.** The sim only sees `SeatInput { thrust, aim }` per seat per tick. It never reads the keyboard.
2. **Fixed timestep.** The sim steps at 60 Hz (`STEP`), rendering interpolates with `alpha`. Never pass a variable `dt` into the sim.
3. **`src/sim/` is headless.** It must run unchanged in Node (tests prove it today, the server later).

Rule 3 is enforced by tooling, not just this doc:

- `tsconfig.sim.json` type-checks `src/sim` with no DOM lib → `document`/`window` fail to compile.
- The lint override in `vite.config.ts` blocks `three` and `client/`, `input/`, `net/` imports from `src/sim/**`.
- `sim.test.ts` asserts determinism (same inputs → identical snapshot) and headless runs.

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
                raft.ts, flow.ts, level.ts (buildLevel + parseLevel validator), hazards/
  input/        keyboard.ts (WASD / Arrows bindings), sources.ts (InputSource, seats)
  client/       loop.ts, render/ (scene, coords), fx/ (particles, cameraShake), ui/ (hud)
  net/          later: protocol.ts, client.ts
  main.ts       wiring only
courses/        LevelData JSON. pond.json is the hand-written test course
assets-src/     fart-raft.blend, start_mcp.py, build_kit.py (procedural asset kit), export_kit.py
public/models/  kit.glb: every visual asset, one top-level node per asset (see "Asset kit")
```

## Conventions

- **Coordinates:** sim is 2D, `+x` = raft forward, `+y` = left. Three is Y-up: sim `(x, y)` → three `(x, 0, -y)`, sim `rot` → `rotation.y`. All conversion goes through `client/render/coords.ts`.
- **Seats:** the crew layout is data: `createSim(level, crewSeats(n))` for 1–4 riders. Every layout is balanced (1 = rear center, 2 = rear pair, 3 = rear pair + front center, 4 = `SEATS`: `0` rear-left, `1` rear-right, `2` front-left, `3` front-right). A lone rider gets `SOLO_BOOST`.
- **Players:** the start menu (`client/ui/menu.ts`) picks humans (0–4) and whether bots fill empty seats; `?players=N&bots=0|1` skips it. Humans take the first seats (P1 WASD, P2 Arrows, P3 IJL, P4 Numpad 8/4/6; a single human gets WASD or Arrows), bots the rest.
- **Bots** (`input/bot.ts`) are plain `InputSource`s that read the latest `Snapshot`, nothing else, so the server can run them unchanged. `bot.test.ts` races every crew size headless and must finish.
- **Feel knobs** live in `sim/constants.ts` (`FART_FORCE`, damping, gas drain/regen). Tune on an empty pond before building courses.
- **Course JSON** is always loaded through `parseLevel()`, never cast. New hazard kinds go in `HazardDef["kind"]`, `KINDS`, and the validator's `HAZARD_KINDS`.
- Tests: BDD nesting (`describe('given …')` → `describe('when …')` → `it('should …')`), and run the real `step()` rather than mocking Rapier.

## Asset kit

Look target: Fart Together's key art (bright blue channels, bamboo rims, pink/peach clay plateaus, puffy low-poly trees, animal riders on an inflatable ring). `build_kit.py` builds every asset from code, so edit the script, not the `.blend`, then `pnpm kit`.

`kit.glb` node contract (meters, origin at base center on the water plane, forward +x) used by `client/render/kit.ts` / `terrain.ts`:

- `raft` (≈3.0 × 2.4) with children `rider_0..3` (capybara, blue hippo, purple hippo, croc, in seat order)
- `rim` bamboo tube, 2 m along x, tiled along banks · `rock` 2×2 footprint, scaled to `hx, hy` · `spinner` 2 m log, radius 1, scaled `(hx, hy, hy)`
- `gate_post`, `gate_sign`, `finish_sign` · decor: `tree_a`, `tree_b`, `bush`, `bamboo`, `reeds`, `fern`, `grass`, `lily`

Terrain (plateaus, water, sky) is generated in the client from `LevelData`, not modeled.

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

- Vite+ project. Sim, fixed loop, 2-seat keyboard (WASD + Arrows: up = fart, left/right = aim nozzle ±60°), R to restart
- Pond test course: walls, rocks, spinner, 3 checkpoints, timer, gas bars, fart particles, camera shake
- Fart Together look: kit.glb (raft, animals, rims, rocks, spinner, gates, decor), water shader, sky, clay plateaus, seeded decor scatter
- Animation: riders turn their butts toward the exhaust, idle/cheer/bump reactions, raft bob/bank, chase camera, wind sway, wake/ripples, gate bulbs + confetti, animated HUD
- Start menu: 0–4 players, optional bots in empty seats, Esc back to menu
- Bot `InputSource` (snapshot-driven, headless, stuck recovery); bots finish the pond with every crew size
- 12 tests: sim (countdown, thrust, turning, solo crew, determinism, headless, level validation) + bot races for crews 1–4
- GitHub Pages deploy on push to `main`: https://alexanderop.github.io/fart-raft/

Next, in order:

1. Tune feel (`FART_FORCE`, damping, gas) on the pond
2. Blender: course export script (LevelData JSON from `col_*` / `checkpoint_NN` names), first real course
3. Audio (fart and bump sounds from `SimEvent`s), gamepad input
4. Multiplayer: `server/` running `src/sim`, clients send `SeatInput`, server broadcasts `Snapshot` + `SimEvent[]` ~20 Hz, clients interpolate. No client prediction at first (shared raft hides ~100 ms).
