# Team Race: decision trail

Goal: build epics/team-race.md end to end on branch `team-race`. Two crews, two rafts, Ghost or Bump, online and offline.

Done predicate: every story's acceptance criteria hold, the DoD tests exist and pass, `pnpm check` is green, co-op is unchanged (228 baseline tests still pass), and both modes play in a real browser (local vs bots, and online 2 tabs).

Baseline: 12 test files, 228 tests, 138 s (`vp test run`, before any change).

## Decisions

| #   | Decision                                                                                                                                                                         | Why                                                                                                                                                                                 | Rejected                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One Rapier world holds N rafts. Ghost = raft colliders skip each other (collision groups). Bump = they collide.                                                                  | Rule 2 (same hazard, same tick) holds by construction. One sim per room, so the "two sims double CPU" risk disappears. Ghost and Bump share every line except the collision filter. | Two sims per room for Ghost (epic's suggestion): doubles CPU, needs a sync proof for rule 2, and Bump would need the multi-raft sim anyway. |
| 2   | `Snapshot = { tick, difficulty, contact, hazards, crews: Crew[] }` on the wire, `View = Crew & {tick, difficulty, contact, hazards, rivals}` for one raft, `viewOf(snap, raft)`. | Today's Snapshot is exactly a View minus rivals, so ~57 client and bot reads keep their shape. The raft focus is chosen once at the session boundary.                               | Nested per-raft fields in every consumer: churn with no reader benefit.                                                                     |
| 3   | `step(sim, inputs)` keeps a flat input array, raft by raft.                                                                                                                      | Every existing `step` caller stays valid.                                                                                                                                           | `SeatInput[][]`: touches 40+ test calls for no gain.                                                                                        |
| 4   | Raft-specific events carry `raft`.                                                                                                                                               | Client filters own events for HUD, audio, shake; particles draw all.                                                                                                                | Per-raft event lists.                                                                                                                       |
| 5   | Room mode is `"coop" \| "ghost" \| "bump"`; the sim only knows `contact`.                                                                                                        | Co-op and Ghost are identical in the sim.                                                                                                                                           |                                                                                                                                             |
| 6   | Architect/arena skipped for the data shape.                                                                                                                                      | Three shapes compared inline above; the codebase constrains it (existing Snapshot consumers, Drift type).                                                                           |                                                                                                                                             |

## Units

1. Sim: multi-raft world, contact modes, rival blast, fair respawn, winner. Migrate callers.
2. Protocol + server: room mode, teams, SetTeam/SetMode, start rule, per-team crews.
3. Client: rival raft render + tag + ghost opacity, progress markers, result screen, lobby teams UI, offline team race menu.
4. Bots: rival-aware bots, bot-vs-bot races in both modes on every course, course tuning.
5. Docs (CLAUDE.md) and browser verification.

## Log

- Unit 1 (sim) landed: e512839, 6f8e762. Verified by the coordinator: `pnpm check` green, 249 tests (228 + 21 in `team.test.ts`). Co-op unchanged: 12 bot races hash identically on the old and new commit (agent's lever). Deviations accepted: Bump respawn moves upstream (a sideways spot can't fit a 14 m channel with a centered rival); rival blast is distance-only; `TEAM_SPACING` 6.2 m.
