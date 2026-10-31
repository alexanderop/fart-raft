import { BTN, buttonDown, gamepads, gamepadSource, type Gamepads } from "../input/gamepad.ts";
import { keyboardSource, WASD_OR_ARROWS } from "../input/keyboard.ts";
import { createSeatDriver } from "../input/seats.ts";
import { mergeSources, readSeats } from "../input/sources.ts";
import { touchSource } from "../input/touch.ts";
import type { Connection } from "../net/client.ts";
import { FRAME_TICKS, riderOf, type Roster } from "../net/protocol.ts";
import { crewZones, STEP } from "../sim/constants.ts";
import { createSim, snapshot, step } from "../sim/sim.ts";
import type { LevelData, SimEvent, Snapshot } from "../sim/types.ts";
import { crewSize, type GameConfig, type LocalPlayer } from "./ui/menu.ts";
import { defaultLook, type Look } from "../look.ts";

/** What the renderer draws this frame: two snapshots to blend between, and what happened since the last frame. */
export type FrameView = { prev: Snapshot; curr: Snapshot; alpha: number; events: SimEvent[] };

/**
 * Where the game state comes from. A local session steps the sim in this tab, an online one
 * receives snapshots from the server. client/race.ts renders either the same way; the crew size comes
 * from the snapshot (`riders.length`), so it can change between races.
 */
export type Session = {
  /** One name tag per rider. */
  seatLabels(): readonly string[];
  /** One look per rider: animal, color and costume. */
  seatLooks(): readonly Look[];
  /** Once per fixed client tick (60 Hz). */
  tick(): void;
  restart(): void;
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
 * names and dresses human seat `i`; bots ride in their seat's default look.
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
  const looks = crew.map((_, i) =>
    i < config.humans ? (players[i]?.look ?? defaultLook(i)) : defaultLook(i),
  );

  let sim = createSim(level, crew, { difficulty: config.difficulty });
  let prev = snapshot(sim);
  let curr = prev;
  let pending: SimEvent[] = [];
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
  driver.update();
  let startWasDown = false;

  function restart() {
    sim.world.free();
    sim = createSim(level, crew, { difficulty: config.difficulty });
    prev = curr = snapshot(sim);
    driver.reset();
  }

  return {
    seatLabels: driver.labels,
    seatLooks: () => looks,
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
      pending.push(...step(sim, readSeats(driver.sources())));
      curr = snapshot(sim);
    },
    restart,
    frame(alpha) {
      const events = pending;
      pending = [];
      rumbleFor(gamepads, events, driver.padOf, driver.claimedPads);
      return { prev, curr, alpha, events };
    },
    dispose() {
      sim.world.free();
    },
  };
}

const looksOf = (roster: Roster) => roster.crew.map((c) => c.look);

/** Wire frames come every FRAME_TICKS sim ticks, so a snapshot is blended in over that long. */
const FRAME_MS = FRAME_TICKS * STEP * 1000;

type Received = {
  prev: Snapshot;
  curr: Snapshot;
  at: number;
  events: SimEvent[];
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
  // The race's crew can differ from the lobby seats: label riders, and find ours, by `crew`.
  const labelsOf = (roster: Roster) =>
    roster.crew.map((c) => (c.seat === conn.seat ? "You" : c.name));
  let labels = labelsOf(conn.roster());
  let looks = looksOf(conn.roster());
  let rider = riderOf(conn.roster(), conn.seat);
  const stopRoster = conn.onRoster((roster) => {
    labels = labelsOf(roster);
    looks = looksOf(roster);
    rider = riderOf(roster, conn.seat);
  });

  const received = await new Promise<Received>((resolve) => {
    let state: Received | undefined;
    conn.onFrame((frame) => {
      if (state) {
        // A restart with a different crew is a new raft: cut instead of blending riders across.
        const recrewed = frame.snapshot.riders.length !== state.curr.riders.length;
        state.prev = recrewed ? frame.snapshot : state.curr;
        state.curr = frame.snapshot;
        state.at = performance.now();
        state.events.push(...frame.events);
        return;
      }
      state = {
        prev: frame.snapshot,
        curr: frame.snapshot,
        at: performance.now(),
        events: [...frame.events],
      };
      resolve(state);
    });
  });

  return {
    seatLabels: () => labels,
    seatLooks: () => looks,
    tick() {
      gamepads.poll();
      conn.send(source.read());
    },
    restart: () => conn.restart(),
    frame() {
      const alpha = Math.min(1, Math.max(0, (performance.now() - received.at) / FRAME_MS));
      const events = received.events.splice(0);
      const pad = gamepads.connected()[0];
      rumbleFor(
        gamepads,
        events,
        (seat) => (seat === rider ? pad : undefined),
        () => (pad === undefined ? [] : [pad]),
      );
      return { prev: received.prev, curr: received.curr, alpha, events };
    },
    dispose() {
      stopRoster();
      conn.close();
    },
  };
}
