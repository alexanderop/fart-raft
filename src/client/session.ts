import { botSource } from "../input/bot.ts";
import { keyboardSource, PLAYER_KEYS, WASD_OR_ARROWS } from "../input/keyboard.ts";
import { createSeats, readSeats, type InputSource } from "../input/sources.ts";
import { connect } from "../net/client.ts";
import { FRAME_TICKS } from "../net/protocol.ts";
import { crewZones, STEP, type Zone } from "../sim/constants.ts";
import { createSim, snapshot, step } from "../sim/sim.ts";
import type { LevelData, SimEvent, Snapshot } from "../sim/types.ts";
import { CONTROLS, crewSize, type GameConfig } from "./ui/menu.ts";

/** What the renderer draws this frame: two snapshots to blend between, and what happened since the last frame. */
export type FrameView = { prev: Snapshot; curr: Snapshot; alpha: number; events: SimEvent[] };

/**
 * Where the game state comes from. A local session steps the sim in this tab, an online one
 * receives snapshots from the server. main.ts renders either the same way.
 */
export type Session = {
  crew: readonly Zone[];
  seatLabels(): readonly string[];
  /** Once per fixed client tick (60 Hz). */
  tick(): void;
  restart(): void;
  /** `loopAlpha` is how far the client loop is into its next tick, only a local sim has use for it. */
  frame(loopAlpha: number): FrameView;
};

/** The camera's forward direction on the water (sim radians): keys walk riders relative to it. */
type Heading = () => number;

/**
 * Fill seats from the menu choice. Humans take the first seats, bots the rest. Each one is
 * just an InputSource.
 */
function fillSeats(
  cfg: GameConfig,
  seats: readonly Zone[],
  observe: () => Snapshot,
  lvl: LevelData,
  heading: Heading,
): InputSource[] {
  const sources = createSeats(seats.length);
  for (let i = 0; i < seats.length; i++) {
    sources[i] =
      i >= cfg.humans
        ? botSource(i, seats, lvl, observe)
        : keyboardSource(cfg.humans === 1 ? WASD_OR_ARROWS : PLAYER_KEYS[i]!, heading);
  }
  return sources;
}

/** `physics` is `initPhysics()`, started early so Rapier loads while the menu is up. */
export async function localSession(
  level: LevelData,
  config: GameConfig,
  heading: Heading,
  physics: Promise<void>,
): Promise<Session> {
  await physics;
  const crew = crewZones(crewSize(config));
  const labels = crew.map((_, i) =>
    i >= config.humans ? "Bot" : config.humans === 1 ? "You" : `P${i + 1} · ${CONTROLS[i]}`,
  );

  let sim = createSim(level, crew);
  let prev = snapshot(sim);
  let curr = prev;
  let pending: SimEvent[] = [];
  // Bots read the latest snapshot, the same data a server broadcasts.
  let seats = fillSeats(config, crew, () => curr, level, heading);

  return {
    crew,
    seatLabels: () => labels,
    tick() {
      prev = curr;
      pending.push(...step(sim, readSeats(seats)));
      curr = snapshot(sim);
    },
    restart() {
      sim.world.free();
      sim = createSim(level, crew);
      prev = curr = snapshot(sim);
      seats = fillSeats(config, crew, () => curr, level, heading);
    },
    frame(alpha) {
      const events = pending;
      pending = [];
      return { prev, curr, alpha, events };
    },
  };
}

/** Wire frames come every FRAME_TICKS sim ticks, so a snapshot is blended in over that long. */
const FRAME_MS = FRAME_TICKS * STEP * 1000;

type Received = {
  prev: Snapshot;
  curr: Snapshot;
  at: number;
  events: SimEvent[];
  labels: string[];
};

/**
 * Join the server at `url` and take the first free seat. Resolves once the first frame is in,
 * so there is always something to draw. `onLost` fires if the seat is lost afterwards.
 */
export async function onlineSession(
  url: string,
  heading: Heading,
  onLost: (reason: string) => void,
): Promise<Session> {
  const conn = await connect(url);
  conn.onClose(onLost);
  const keys = keyboardSource(WASD_OR_ARROWS, heading);

  const received = await new Promise<Received>((resolve) => {
    let state: Received | undefined;
    conn.onFrame((frame) => {
      const labels = frame.seats.map((kind, i) =>
        i === conn.seat ? "You" : kind === "human" ? `P${i + 1}` : "Bot",
      );
      if (state) {
        state.prev = state.curr;
        state.curr = frame.snapshot;
        state.at = performance.now();
        state.events.push(...frame.events);
        state.labels = labels;
        return;
      }
      state = {
        prev: frame.snapshot,
        curr: frame.snapshot,
        at: performance.now(),
        events: [...frame.events],
        labels,
      };
      resolve(state);
    });
  });

  return {
    crew: crewZones(conn.crew),
    seatLabels: () => received.labels,
    tick: () => conn.send(keys.read()),
    restart: () => conn.restart(),
    frame() {
      const alpha = Math.min(1, Math.max(0, (performance.now() - received.at) / FRAME_MS));
      return {
        prev: received.prev,
        curr: received.curr,
        alpha,
        events: received.events.splice(0),
      };
    },
  };
}
