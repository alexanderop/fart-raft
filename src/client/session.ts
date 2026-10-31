import { BTN, buttonDown, gamepads, gamepadSource, type Gamepads } from "../input/gamepad.ts";
import { keyboardSource, WASD_OR_ARROWS } from "../input/keyboard.ts";
import { createSeatDriver } from "../input/seats.ts";
import { mergeSources, readSeats } from "../input/sources.ts";
import { touchSource } from "../input/touch.ts";
import type { Connection } from "../net/client.ts";
import { botSource } from "../input/bot.ts";
import {
  contactOf,
  FRAME_TICKS,
  followedRaft,
  isTeamMode,
  placeOf,
  startBlocker,
  type Roster,
} from "../net/protocol.ts";
import { crewZones, MAX_LOCAL, STEP } from "../sim/constants.ts";
import { createSim, snapshot, step } from "../sim/sim.ts";
import type { Crew, LevelData, SimEvent, View } from "../sim/types.ts";
import { viewOf, viewsOf } from "../sim/view.ts";
import { crewSize, type GameConfig, type LocalPlayer } from "./ui/menu.ts";
import { botCrewLook } from "./teams.ts";
import { defaultLook, type Look } from "../look.ts";

/**
 * What the renderer draws this frame: two views of the raft we follow to blend between, and what
 * happened since the last frame. `curr.rivals` holds every other raft, in raft order without ours.
 */
export type FrameView = {
  prev: View;
  curr: View;
  alpha: number;
  /** The raft `prev` and `curr` follow: an index into `Snapshot.crews` (co-op: always 0). */
  raft: number;
  /** Our raft's events and the race-wide `go`: felt (HUD, audio, shake, rumble). */
  events: SimEvent[];
  /** Every other raft's events: only seen (fart puffs, the rival's riders), never felt. */
  rivalEvents: SimEvent[];
};

/** Every raft's crew, by raft index: the inverse of `viewOf`. */
export const crewsOf = (view: View, raft: number): Crew[] => view.rivals.toSpliced(raft, 0, view);

/** Splits a tick's events into raft `raft`'s (plus `go`) and everyone else's. */
function sortEvents(
  events: readonly SimEvent[],
  raft: number,
  ours: SimEvent[],
  rivals: SimEvent[],
) {
  for (const e of events) (e.type === "go" || e.raft === raft ? ours : rivals).push(e);
}

/**
 * Where the game state comes from. A local session steps the sim in this tab, an online one
 * receives snapshots from the server. client/race.ts renders either the same way, from our raft's
 * View; the crew size comes from it (`riders.length`), so it can change between races.
 */
export type Session = {
  /** One name tag per rider. */
  seatLabels(): readonly string[];
  /** One look per rider on every raft, by raft index: animal, color and costume. */
  looks(): readonly (readonly Look[])[];
  /** Once per fixed client tick (60 Hz). */
  tick(): void;
  /** Starts a fresh race, or returns why it cannot (a team room with an empty team). */
  restart(): string | null;
  /** `loopAlpha` is how far the client loop is into its next tick, only a local sim has use for it. */
  frame(loopAlpha: number): FrameView;
  /** Frees what the session holds: the local sim's Rapier world, or the online connection. */
  dispose(): void;
};

/** The camera's forward direction on the water (sim radians): keys walk riders relative to it. */
type Heading = () => number;

/** Haptics for what just happened: a short buzz for your fart, a big one for a hit. */
function rumbleFor(
  pads: Gamepads,
  events: readonly SimEvent[],
  padOfSeat: (seat: number) => number | undefined,
  allPads: () => readonly number[],
): void {
  for (const e of events) {
    if (e.type === "fart") {
      const pad = padOfSeat(e.seat);
      if (pad !== undefined) pads.rumble(pad, "fart");
    } else if (e.type === "hit") {
      for (const pad of allPads()) pads.rumble(pad, "hit");
    }
  }
}

/**
 * `physics` is `initPhysics()`, started early so Rapier loads while the menu is up. `players[i]`
 * names and dresses human seat `i`; bots ride in their seat's default look. A team race
 * (`config.race` ghost or bump) adds raft 1: a full crew of bots racing ours, raft 0.
 */
export async function localSession(
  level: LevelData,
  config: GameConfig,
  players: readonly LocalPlayer[],
  heading: Heading,
  physics: Promise<void>,
): Promise<Session> {
  await physics;
  const crew = crewZones(crewSize(config));
  const rivalCrew = crewZones(MAX_LOCAL);
  const rafts = isTeamMode(config.race) ? [crew, rivalCrew] : [crew];
  const looks = [
    crew.map((_, i) => (i < config.humans ? (players[i]?.look ?? defaultLook(i)) : defaultLook(i))),
    ...rafts.slice(1).map((zones, r) => zones.map((_, i) => botCrewLook(r + 1, i))),
  ];
  const options = { difficulty: config.difficulty, contact: contactOf(config.race) };

  let sim = createSim(level, rafts, options);
  // One View per raft per tick: a crew's bots share a crossing plan through the View they read.
  let views = viewsOf(snapshot(sim));
  let prev = views[0]!;
  let curr = prev;
  let pending: SimEvent[] = [];
  let pendingRivals: SimEvent[] = [];
  // Bots read the latest snapshot, the same data a server broadcasts.
  const driver = createSeatDriver(
    config.humans,
    crew,
    () => curr,
    level,
    heading,
    gamepads,
    players.map((p) => p.name),
  );
  /** The other rafts' crews: bots, each reading its own raft's view. */
  const rivalBots = () =>
    rafts
      .slice(1)
      .flatMap((zones, r) => zones.map((_, i) => botSource(i, zones, level, () => views[r + 1]!)));
  let rivals = rivalBots();
  driver.update();
  let startWasDown = false;

  function restart() {
    sim.world.free();
    sim = createSim(level, rafts, options);
    views = viewsOf(snapshot(sim));
    prev = curr = views[0]!;
    driver.reset();
    rivals = rivalBots();
    return null;
  }

  return {
    seatLabels: driver.labels,
    looks: () => looks,
    tick() {
      driver.update();
      // Start on any seated pad restarts, like R.
      const startDown = driver.claimedPads().some((i) => {
        const state = gamepads.state(i);
        return state !== undefined && buttonDown(state, BTN.start);
      });
      if (startDown && !startWasDown) restart();
      startWasDown = startDown;
      prev = curr;
      const inputs = [...readSeats(driver.sources()), ...readSeats(rivals)];
      sortEvents(step(sim, inputs), 0, pending, pendingRivals);
      views = viewsOf(snapshot(sim));
      curr = views[0]!;
    },
    restart,
    frame(alpha) {
      const events = pending;
      const rivalEvents = pendingRivals;
      pending = [];
      pendingRivals = [];
      rumbleFor(gamepads, events, driver.padOf, driver.claimedPads);
      return { prev, curr, alpha, raft: 0, events, rivalEvents };
    },
    dispose() {
      sim.world.free();
    },
  };
}

/** Each raft's riders' looks, by raft index. */
const looksOf = (roster: Roster): Look[][] => {
  const out: Look[][] = [];
  for (const c of roster.crew) (out[c.raft] ??= []).push(c.look);
  return Array.from(out, (looks) => looks ?? []);
};

/** Wire frames come every FRAME_TICKS sim ticks, so a snapshot is blended in over that long. */
const FRAME_MS = FRAME_TICKS * STEP * 1000;

type Received = {
  prev: View;
  curr: View;
  raft: number;
  at: number;
  events: SimEvent[];
  rivalEvents: SimEvent[];
};

/**
 * Race on a seat already joined in the lobby. Resolves once the first frame is in, which is when
 * the host starts the race (or at once when joining mid-race), so there is always something to
 * draw. `onLost` fires if the seat is lost afterwards.
 */
export async function onlineSession(
  conn: Connection,
  heading: Heading,
  onLost: (reason: string) => void,
): Promise<Session> {
  conn.onClose(onLost);
  // Online there is one seat: keyboard, touch and the first pad all drive it.
  const source = mergeSources(
    mergeSources(keyboardSource(WASD_OR_ARROWS, heading), touchSource(heading)),
    gamepadSource(gamepads, () => gamepads.connected()[0], heading),
  );
  // The race's crew can differ from the lobby seats: label our raft's riders, and find ours, by `crew`.
  let roster = conn.roster();
  const labelsOf = (raft: number) =>
    roster.crew.filter((c) => c.raft === raft).map((c) => (c.seat === conn.seat ? "You" : c.name));
  let looks = looksOf(roster);
  let rider = placeOf(roster, conn.seat)?.rider ?? -1;
  const stopRoster = conn.onRoster((next) => {
    roster = next;
    looks = looksOf(next);
    rider = placeOf(next, conn.seat)?.rider ?? -1;
  });

  const received = await new Promise<Received>((resolve) => {
    let state: Received | undefined;
    conn.onFrame((frame) => {
      const raft = followedRaft(roster, conn.seat, frame.snapshot.crews.length);
      const view = viewOf(frame.snapshot, raft);
      if (state) {
        // A restart with a different crew or raft is a new raft: cut instead of blending riders across.
        const cut = raft !== state.raft || view.riders.length !== state.curr.riders.length;
        state.prev = cut ? view : state.curr;
        state.curr = view;
        state.raft = raft;
        state.at = performance.now();
        sortEvents(frame.events, raft, state.events, state.rivalEvents);
        return;
      }
      state = { prev: view, curr: view, raft, at: performance.now(), events: [], rivalEvents: [] };
      sortEvents(frame.events, raft, state.events, state.rivalEvents);
      resolve(state);
    });
  });

  return {
    seatLabels: () => labelsOf(received.raft),
    looks: () => looks,
    tick() {
      gamepads.poll();
      conn.send(source.read());
    },
    restart() {
      const blocked = startBlocker(roster);
      if (blocked === null) conn.restart();
      return blocked;
    },
    frame() {
      const alpha = Math.min(1, Math.max(0, (performance.now() - received.at) / FRAME_MS));
      const events = received.events.splice(0);
      const rivalEvents = received.rivalEvents.splice(0);
      const pad = gamepads.connected()[0];
      rumbleFor(
        gamepads,
        events,
        (seat) => (seat === rider ? pad : undefined),
        () => (pad === undefined ? [] : [pad]),
      );
      const { prev, curr, raft } = received;
      return { prev, curr, alpha, raft, events, rivalEvents };
    },
    dispose() {
      stopRoster();
      conn.close();
    },
  };
}
