# Epic: Team Race

Two crews, two rafts, one course. Up to 4 players per raft race each other to the finish, in one of two modes the host picks: **Ghost race** (rafts pass through each other) or **Bump race** (rafts collide and can shove each other into hazards).

| Field  | Value                                                                                       |
| ------ | ------------------------------------------------------------------------------------------- |
| Status | Ready for refinement: all decisions made (section 8)                                        |
| Owner  | Alexander (product owner)                                                                   |
| Size   | Ghost race: 1–2 days. Bump race: 5–8 days on top (incl. course tuning). Total about 2 weeks |
| Theme  | Multiplayer: more reasons to come back to a room after the first race                       |

## 1. Why

Today every player in a room sits on the same raft. A group of 8 is one big crew working together. Groups that know each other also want to play against each other: "my 4 vs your 4". The game has no mode for that.

Two kinds of groups want two kinds of competition:

- **Ghost race:** a clean race against the clock and the course. Nobody can ruin your run. Good for mixed-skill groups and for learning a course.
- **Bump race:** chaos. Ram the other raft, fart it into a spinner, block the open lane. Good for friends who want to mess with each other.

**Goal:** a room can split into two teams, the host picks Ghost or Bump, each team steers its own raft, and the game shows clearly who is ahead and who won.

**Success looks like:**

- A group of 4–8 friends finishes a team race in either mode online without help or reloading.
- After a team race, the room starts a rematch in most sessions (a sign the mode is fun).
- Both modes get played. If one is almost never picked, we learn which kind of competition players want.
- No regression in the existing co-op mode: `bot.test.ts` and all server tests still pass.

## 2. Who it is for

| Persona       | What they want                                                 |
| ------------- | -------------------------------------------------------------- |
| The host      | Sets up a room, picks the mode, splits friends into two teams. |
| A team player | Sees their own raft and the rival raft, knows who is ahead.    |
| A late joiner | Joins mid-race, watches, picks a team for the next race.       |
| A solo player | Plays offline: their crew (humans + bots) against a bot raft.  |

## 3. Scope

### Shared by both modes

Lobby with two teams, team pick, start rule, rival on the progress bar, result screen, rematch, players leaving, offline play against bots.

### Ghost race

Each team rides its own raft in its own simulation. The rival raft is drawn see-through and cannot be touched. Hazards run on the same schedule for both teams, so the race is fair. The simulation itself does not change.

### Bump race

Both rafts share one physics world. Rafts collide, a fart blast pushes the rival raft, and a team can shove the other raft into a hazard. The simulation learns to hold two rafts, each with its own crew, wipeouts and respawn.

### Out of scope (this epic)

- More than two teams.
- Split screen on one machine.
- Ranked matchmaking, leaderboards, accounts.
- New courses built for two rafts (existing courses are reused in both modes and tuned where two rafts do not fit, see risks).
- Items or power-ups.

## 4. User stories

Stories are ordered by delivery. Each one is small enough to ship and test on its own. **TR** stories are shared, **GR** stories are Ghost race, **BR** stories are Bump race.

### TR-1: Create a team race room

As a **host**, I want to choose "Team race" and a mode when I create a room, so that my friends can race against each other the way we like.

```gherkin
Given I am on the create-room screen
When I pick "Team race", then "Ghost" or "Bump", and press Create
Then I get a room code
And the room screen shows two team columns, Red and Blue, and the mode
And the room keeps the course and difficulty I picked

Given I am the host in a team room before the race
When I switch the mode between Ghost and Bump
Then everyone in the room sees the new mode
```

### TR-2: Pick a team

As a **player** in a team room, I want to pick Red or Blue, so that I ride with my friends.

```gherkin
Given I am seated in a team room before the race
When I press "Join Blue"
Then my name moves to the Blue column for everyone in the room
And a team that already has 4 players shows as full and cannot be picked

Given I join a team room
Then I am put on the team with fewer players (Red on a tie)
```

### TR-3: Start a team race

As a **host**, I want to start the race only when both teams have a rider, so that nobody races alone by mistake.

```gherkin
Given both teams have at least 1 player
When the host presses Start
Then both rafts appear at the start line, side by side, and the countdown begins for everyone

Given one team has no players
Then the Start button is disabled with the text "Both teams need a rider"
```

### TR-4: Follow my raft, track the rival

As a **team player**, I want my camera on my own raft and the rival's position always visible, so that I know who is ahead.

```gherkin
Given a team race is running in either mode
Then my camera follows my own raft
And the rival raft is drawn in its team color with a "Rival" tag above it
And the top progress bar shows a marker for each team
```

### TR-5: Win and lose

As a **team player**, I want a clear result at the end, so that we know who won.

```gherkin
Given a team race is running
When the first raft crosses the finish line
Then everyone sees "<Team> wins!" and the time gap to the other raft
And the losing raft can keep racing to finish its own time

Given both rafts finish
Then the result shows both times and both wipeout counts
```

### TR-6: Rematch

As **any seated player**, I want to restart after a race, so that we can play again straight away.

```gherkin
Given a team race has finished
When any seated player presses Restart
Then a new team race starts in the same mode with the teams as they are now
And players who joined mid-race ride from this race on
And the new race starts from zero: no score, wins or times carry over

Given a team race is running
When any seated player presses R (Restart)
Then the race ends without a winner and a new one starts the same way
```

### TR-7: Players leaving mid-race

As a **team player**, I want the race to continue if someone leaves, so that one dropped connection does not end it.

```gherkin
Given a team race is running
When a player on Red leaves
Then their rider stays on the raft and stops moving, like in co-op today
And when the last player of a team leaves, that team's raft stays idle until the race ends
```

### TR-8: Play against bots offline

As a **solo player**, I want to race my crew against a bot raft in either mode, so that I can play without friends online.

```gherkin
Given I am in the start menu
When I pick "Team race", a mode and 1–4 humans
Then my crew (humans, filled with bots if I choose) races a raft of 4 bots
```

### GR-1: Ghost rival

As a **team player** in a Ghost race, I want the rival raft to be see-through and untouchable, so that nobody can ruin my run.

```gherkin
Given a Ghost race is running
Then the rival raft is drawn at about 40% opacity
And my raft passes through the rival raft without a collision or a wipeout
And both rafts meet every hazard on exactly the same schedule
```

### BR-1: Rafts collide

As a **team player** in a Bump race, I want our raft to bump into the rival raft, so that position on the water matters.

```gherkin
Given a Bump race is running
When the two rafts touch
Then both rafts bounce off each other
And neither crew wipes out from the bump itself
And both players hear a bump sound and the camera shakes a little
```

### BR-2: Fart the rival

As a **team player** in a Bump race, I want my fart to push the rival raft when it is close behind me, so that I can sabotage them.

```gherkin
Given a Bump race is running
And the rival raft is within fart range of my rider
When I fart
Then the rival raft gets a push away from my rider
And the push is weaker than the push on my own raft
```

### BR-3: Shoved into a hazard

As a **team player** in a Bump race, I want a hazard hit to count the same however we got there, so that sabotage pays off.

```gherkin
Given a Bump race is running
When the rival pushes my raft into a hazard or spikes
Then my crew wipes out and respawns at our last gate, as in co-op
And the wipeout counts for my team
```

### BR-4: Fair respawn

As a **team player** in a Bump race, I want to respawn without landing on the rival, so that a wipeout is not followed by a second one.

```gherkin
Given my crew wiped out in a Bump race
When we respawn at a gate where the rival raft is
Then our raft appears next to it, not on top of it
And for the grace period after a respawn our raft passes through the rival raft
```

### BR-5: Bots in a Bump race

As a **solo player**, I want bots to handle a rival raft, so that a Bump race against bots is playable.

```gherkin
Given a Bump race with a bot raft
Then bots steer around the rival raft when it blocks their lane
And a bot raft finishes every course with at most 3 wipeouts more than in co-op
```

### BR-6: Every course fits two rafts

As a **host**, I want to pick Bump race on any course, so that the mode choice never limits the course choice.

```gherkin
Given I create a team room
Then I can pick Bump race on every course, with no course greyed out

Given two bot rafts race a Bump race on any course, in Chill and in Wild
Then both rafts finish
And no hazard or gap blocks both rafts at once for the whole cycle
```

## 5. Rules that must always hold

These are the business rules the team checks in review and in tests.

1. A team has 1–4 riders. A room holds at most 8 players.
2. Both rafts see the same hazard at the same time, in both modes. Neither team can get an easier course.
3. A player can only steer their own team's raft (enforced by the seat token, as today).
4. Each race stands alone. Its winner is the first raft whose crew crosses the finish line; a tie on the same tick is a draw. There is no series or running score: R starts a fresh race.
5. In a Ghost race, the rafts never affect each other.
6. In a Bump race, touching the rival raft never wipes a crew out by itself. Only hazards and spikes do.
7. Co-op rooms behave exactly as before. Nothing changes unless the host picks "Team race".

## 6. Non-functional requirements

| Area        | Requirement                                                               |
| ----------- | ------------------------------------------------------------------------- |
| Performance | The server stays at 60 Hz with 50 team rooms in either mode.              |
| Network     | One frame per client at 20 Hz, as today. The rival raft adds < 1 KB.      |
| Mobile      | The rival raft, its tag and two progress markers work on a phone.         |
| Fairness    | Both rafts start on the same tick and the simulation stays deterministic. |

## 7. Dependencies and risks

| Risk                                                                 | Mode  | Impact | Mitigation                                                                                                    |
| -------------------------------------------------------------------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------- |
| Two sims per room doubles server CPU.                                | Ghost | Medium | Measure with 50 rooms before release.                                                                         |
| Two rafts (11.2 m together) barely fit the 14 m channel.             | Bump  | High   | Bump is on every course, so tune the tight spots (hazard timing, gaps) until two-raft bot races pass on each. |
| The simulation assumes one raft; changing it touches about 15 files. | Bump  | High   | Build Ghost first, so lobby, protocol and HUD work is done and tested.                                        |
| Bots do not plan around a moving rival raft.                         | Bump  | High   | BR-5 is its own story; offline Bump can ship after online Bump.                                               |
| Respawning onto the rival raft causes a second wipeout.              | Bump  | Medium | BR-4: sideways offset plus pass-through during grace.                                                         |
| Players do not understand which raft is the rival.                   | Both  | Low    | Team color, name tags and a "Rival" tag above it.                                                             |

## 8. Decisions

No open decisions.

- **Winner:** one race, one winner: the first raft across the finish. No series or score. Restart (R) starts a fresh race.
- **Courses:** both modes are playable on every course. Courses get tuned for two rafts where needed; no course is Ghost-only.

## 9. Definition of done

- All stories meet their acceptance criteria.
- New tests: a server test for a two-team room in each mode (create, pick team, start, finish, rematch), a sim test that both rafts see the same hazard poses on every tick, and a Bump test that a collision bounces both rafts without a wipeout.
- `bot.test.ts` races a bot raft against a bot raft in both modes on every course.
- `pnpm check` passes.
- A real 2 vs 2 online playtest of each mode on the deployed build finishes without a reload.
- `CLAUDE.md` describes both modes (lobby, protocol, room, sim) in the same style as co-op.

## 10. Release plan

Ghost ships first because it needs no simulation changes, and everything it builds (lobby, teams, protocol, HUD, result screen) is reused by Bump.

| Step | Content                                         | Ships when                      |
| ---- | ----------------------------------------------- | ------------------------------- |
| 1    | TR-1, TR-2, TR-3 (lobby, teams, start)          | Both teams can start a race     |
| 2    | GR-1, TR-4, TR-5 (Ghost race and result)        | First playable mode             |
| 3    | TR-6, TR-7, TR-8 (rematch, leaving, offline)    | Ghost race ready for a playtest |
| 4    | BR-1, BR-3, BR-4 (collisions, hazards, respawn) | Online Bump race playable       |
| 5    | BR-2 (fart the rival)                           | Sabotage in place               |
| 6    | BR-5 (bots in Bump)                             | Offline Bump race               |
| 7    | BR-6 (tune every course for two rafts)          | Bump race on every course       |
