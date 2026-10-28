import { botSource } from "../input/bot.ts";
import {
  BTN,
  buttonDown,
  gamepads,
  gamepadSource,
  isFarting,
  type Gamepads,
} from "../input/gamepad.ts";
import { keyboardSource, PLAYER_KEYS, WASD_OR_ARROWS } from "../input/keyboard.ts";
import { touchSource } from "../input/touch.ts";
import {
  createSeats,
  EMPTY_PLAN,
  mergeSources,
  planSeats,
  readSeats,
  type InputSource,
  type SeatKind,
  type SeatPlan,
} from "../input/sources.ts";
import type { Connection } from "../net/client.ts";
import { FRAME_TICKS, riderOf, type Roster } from "../net/protocol.ts";
import { crewZones, STEP, type Zone } from "../sim/constants.ts";
import { createSim, snapshot, step } from "../sim/sim.ts";
import type { LevelData, SimEvent, Snapshot } from "../sim/types.ts";
import { CONTROLS, crewSize, type GameConfig } from "./ui/menu.ts";

/** What the renderer draws this frame: two snapshots to blend between, and what happened since the last frame. */
export type FrameView = { prev: Snapshot; curr: Snapshot; alpha: number; events: SimEvent[] };

/**
 * Where the game state comes from. A local session steps the sim in this tab, an online one
 * receives snapshots from the server. main.ts renders either the same way; the crew size comes
 * from the snapshot (`riders.length`), so it can change between races.
 */
export type Session = {
  /** One name tag per rider. */
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
 * Who drives each seat in a local game. Humans take pads first (connection order), the rest
 * play on keyboard clusters, bots fill what is left, and a pad that presses fart while idle
 * can take over a bot seat mid-race (rule in `planSeats`). Each seat is just an InputSource.
 */
function createSeatDriver(
  cfg: GameConfig,
  zones: readonly Zone[],
  observe: () => Snapshot,
  lvl: LevelData,
  heading: Heading,
  pads: Gamepads,
) {
  const kinds: SeatKind[] = zones.map((_, i) => (i < cfg.humans ? "human" : "bot"));
  const wantsIn = new Set<number>();
  let plan: SeatPlan = EMPTY_PLAN;
  let planKey = "";
  let bots: (InputSource | undefined)[] = [];
  let sources: InputSource[] = createSeats(zones.length);
  let labels: string[] = [];

  const seatOfPad = new Map<number, number>();
  const bot = (i: number) => (bots[i] ??= botSource(i, zones, lvl, observe));

  function rebuild() {
    sources = zones.map((_, i) => {
      const pad = [...plan.pads].find(([, seat]) => seat === i)?.[0];
      if (pad !== undefined) return gamepadSource(pads, () => pad, heading);
      const cluster = plan.keys.get(i);
      if (cluster === undefined) return bot(i);
      const keys = cfg.humans === 1 ? WASD_OR_ARROWS : PLAYER_KEYS[cluster]!;
      const kb = keyboardSource(keys, heading);
      // A lone human may be on a phone: the touch stick and button drive the same seat.
      return cfg.humans === 1 ? mergeSources(kb, touchSource(heading)) : kb;
    });
    labels = zones.map((_, i) => {
      const onPad = [...plan.pads.values()].includes(i);
      const cluster = plan.keys.get(i);
      if (cfg.humans === 1 && i === 0) return onPad ? "You 🎮" : "You";
      if (onPad) return `P${i + 1} · 🎮`;
      return cluster === undefined ? "Bot" : `P${i + 1} · ${CONTROLS[cluster]}`;
    });
  }

  return {
    /** Once per tick, before reading seats: look at the pads and re-plan if they changed. */
    update() {
      pads.poll();
      const connected = pads.connected();
      for (const pad of wantsIn) if (!connected.includes(pad)) wantsIn.delete(pad);
      for (const pad of connected) {
        const state = pads.state(pad);
        if (state && !plan.pads.has(pad) && isFarting(state)) wantsIn.add(pad);
      }
      const next = planSeats(kinds, connected, wantsIn, plan);
      const key = JSON.stringify([[...next.pads], [...next.keys]]);
      plan = next;
      seatOfPad.clear();
      for (const [pad, seat] of plan.pads) seatOfPad.set(pad, seat);
      if (key !== planKey || sources.length === 0) {
        planKey = key;
        rebuild();
      }
    },
    sources: () => sources,
    labels: () => labels,
    /** The pad on this seat, if any. */
    padOf: (seat: number): number | undefined => {
      for (const [pad, s] of seatOfPad) if (s === seat) return pad;
      return undefined;
    },
    claimedPads: (): readonly number[] => [...seatOfPad.keys()],
    /** New race: bots start over, pad and keyboard assignments stay. */
    reset() {
      bots = [];
      rebuild();
    },
  };
}

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

/** `physics` is `initPhysics()`, started early so Rapier loads while the menu is up. */
export async function localSession(
  level: LevelData,
  config: GameConfig,
  heading: Heading,
  physics: Promise<void>,
): Promise<Session> {
  await physics;
  const crew = crewZones(crewSize(config));

  let sim = createSim(level, crew);
  let prev = snapshot(sim);
  let curr = prev;
  let pending: SimEvent[] = [];
  // Bots read the latest snapshot, the same data a server broadcasts.
  const driver = createSeatDriver(config, crew, () => curr, level, heading, gamepads);
  driver.update();
  let startWasDown = false;

  function restart() {
    sim.world.free();
    sim = createSim(level, crew);
    prev = curr = snapshot(sim);
    driver.reset();
  }

  return {
    seatLabels: driver.labels,
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
  };
}

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
  let rider = riderOf(conn.roster(), conn.seat);
  conn.onRoster((roster) => {
    labels = labelsOf(roster);
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
  };
}
