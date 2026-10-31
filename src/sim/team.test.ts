import { beforeAll, describe, expect, it } from "vite-plus/test";
import canyon from "../../courses/canyon.json";
import { COUNTDOWN_TICKS, crewZones, RAFT_HULL, TEAM_SPACING } from "./constants.ts";
import { parseLevel } from "./level.ts";
import { createSim, initPhysics, snapshot, step, type Sim } from "./sim.ts";
import {
  IDLE_INPUT,
  type Contact,
  type Crew,
  type HazardDef,
  type LevelData,
  type Phase,
  type SeatInput,
  type SimEvent,
} from "./types.ts";
import { winnerOf } from "./view.ts";

const FOUR = crewZones(4);
const TWO_CREWS = [FOUR, FOUR];
const fart: SeatInput = { move: { x: 0, y: 0 }, fart: true };
const idle: SeatInput[] = FOUR.map(() => IDLE_INPUT);
/** Seats 0 and 2 ride the left side, 1 and 3 the right; farting pushes toward the other side. */
const pushRight: SeatInput[] = [fart, IDLE_INPUT, fart, IDLE_INPUT];
const pushLeft: SeatInput[] = [IDLE_INPUT, fart, IDLE_INPUT, fart];
const pushForward: SeatInput[] = [fart, fart, IDLE_INPUT, IDLE_INPUT];

/** Still open water, start at the origin facing +x, finish line `finish` m ahead. */
const water = (hazards: HazardDef[] = [], finish = 500): LevelData => ({
  name: "team-water",
  spawn: { x: 0, y: 0, rot: 0 },
  channel: null,
  walls: [],
  checkpoints: [{ x: finish, y: 0, rot: 0, hx: 0.5, hy: 20 }],
  hazards,
});

/** A bar across both lanes, 8.7 m ahead of the bows. It does not spin. */
const bar: HazardDef = {
  id: "bar",
  kind: "spinner",
  speed: 0,
  x: 12,
  y: 0,
  rot: Math.PI / 2,
  hx: 12,
  hy: 0.4,
};

const at = (sim: Sim, raft: number) => sim.racers[raft]!.raft.body.translation();
const gap = (sim: Sim) => Math.hypot(at(sim, 0).x - at(sim, 1).x, at(sim, 0).y - at(sim, 1).y);
const rivalBumps = (events: SimEvent[]) =>
  events.filter((e) => e.type === "bump" && e.rival).map((e) => (e.type === "bump" ? e.raft : -1));

/** Two rafts side by side; each tick, raft 0 and raft 1 get the inputs `drive` returns. */
function race(
  contact: Contact,
  ticks: number,
  drive: (t: number) => [SeatInput[], SeatInput[]],
  level = water(),
) {
  const sim = createSim(level, TWO_CREWS, { difficulty: "wild", contact });
  const events: SimEvent[] = [];
  let closest = Infinity;
  for (let t = 0; t < ticks; t++) {
    events.push(...step(sim, drive(t).flat()));
    closest = Math.min(closest, gap(sim));
  }
  return { sim, events, closest, snap: snapshot(sim) };
}

const towardEachOther = (): [SeatInput[], SeatInput[]] => [pushRight, pushLeft];

beforeAll(() => initPhysics());

describe("given two rafts at the start", () => {
  it("should put them side by side across the start, raft 0 on the left, hulls apart", () => {
    const { snap } = race("bump", 1, () => [idle, idle]);
    const [red, blue] = snap.crews.map((c) => c.raft);
    expect(red!.x).toBeCloseTo(0);
    expect(blue!.x).toBeCloseTo(0);
    expect(red!.y - blue!.y).toBeCloseTo(TEAM_SPACING);
    expect(red!.y + blue!.y).toBeCloseTo(0);
    expect(TEAM_SPACING).toBeGreaterThan(2 * RAFT_HULL);
  });

  it("should start both on the same tick", () => {
    const { snap } = race("ghost", COUNTDOWN_TICKS + 1, () => [idle, idle]);
    const starts = snap.crews.map((c) => (c.phase.kind === "racing" ? c.phase.startTick : -1));
    expect(starts[0]).toBeGreaterThanOrEqual(0);
    expect(starts[1]).toBe(starts[0]);
  });
});

describe.each(["ghost", "bump"] as const)("given a %s race on the canyon", (contact) => {
  describe("when two crews race next to a lone crew", () => {
    it("should show both rafts every hazard in the same pose on every tick", () => {
      const level = parseLevel(canyon);
      const two = createSim(level, TWO_CREWS, { difficulty: "wild", contact });
      const one = createSim(level, [FOUR], { difficulty: "wild", contact });
      const wobble = (t: number): SeatInput[] =>
        FOUR.map((_, i) => ({
          move: { x: Math.cos(t / 20 + i), y: Math.sin(t / 30 + i * 2) },
          fart: (t + i * 7) % 40 < 25,
        }));
      for (let t = 0; t < COUNTDOWN_TICKS + 600; t++) {
        step(two, [...wobble(t), ...pushForward]);
        step(one, wobble(t));
        expect(snapshot(two).hazards).toEqual(snapshot(one).hazards);
      }
      two.world.free();
      one.world.free();
    });
  });
});

describe("given a ghost race", () => {
  describe("when the two rafts are driven into each other", () => {
    it("should let them pass through each other without a bump", () => {
      const { sim, events } = race("ghost", COUNTDOWN_TICKS + 180, towardEachOther);
      expect(at(sim, 0).y).toBeLessThan(at(sim, 1).y);
      expect(rivalBumps(events)).toEqual([]);
    });

    it("should move each raft exactly as if it raced alone", () => {
      const { sim } = race("ghost", COUNTDOWN_TICKS + 180, towardEachOther);
      const alone = createSim(
        { ...water(), spawn: { x: 0, y: TEAM_SPACING / 2, rot: 0 } },
        [FOUR],
        { difficulty: "wild" },
      );
      for (let t = 0; t < COUNTDOWN_TICKS + 180; t++) step(alone, pushRight);
      expect(snapshot(sim).crews[0]!.raft).toEqual(snapshot(alone).crews[0]!.raft);
    });
  });

  describe("when a rider farts at the rival from close by", () => {
    it("should leave the rival where it is", () => {
      const { sim } = race("ghost", COUNTDOWN_TICKS + 60, () => [pushLeft, idle]);
      expect(at(sim, 1).y).toBeCloseTo(-TEAM_SPACING / 2, 6);
    });
  });
});

describe("given a bump race", () => {
  describe("when the two rafts are driven into each other", () => {
    const ticks = COUNTDOWN_TICKS + 180;
    let raced: ReturnType<typeof race>;
    beforeAll(() => {
      raced = race("bump", ticks, (t) =>
        t < COUNTDOWN_TICKS + 12 ? towardEachOther() : [idle, idle],
      );
    });

    it("should keep the hulls from passing through each other", () => {
      expect(raced.closest).toBeGreaterThan(2 * RAFT_HULL - 0.1);
      expect(at(raced.sim, 0).y).toBeGreaterThan(at(raced.sim, 1).y);
    });

    it("should bounce them apart", () => {
      const sim = createSim(water(), TWO_CREWS, { difficulty: "wild", contact: "bump" });
      const closing = () =>
        sim.racers[1]!.raft.body.linvel().y - sim.racers[0]!.raft.body.linvel().y;
      let before = 0;
      for (let t = 0; t < ticks; t++) {
        before = closing();
        if (rivalBumps(step(sim, [...pushRight, ...pushLeft])).length) break;
      }
      expect(before).toBeGreaterThan(3);
      expect(closing()).toBeLessThan(-1);
    });

    it("should tell both crews about the bump", () => {
      const bumped = rivalBumps(raced.events);
      expect(bumped).toContain(0);
      expect(bumped).toContain(1);
    });

    it("should wipe neither crew out", () => {
      expect(raced.events.some((e) => e.type === "hit")).toBe(false);
      expect(raced.snap.crews.map((c) => c.deaths)).toEqual([0, 0]);
    });
  });

  describe("when a rider farts at the rival from close by", () => {
    it("should push the rival away from the rider", () => {
      const { sim } = race("bump", COUNTDOWN_TICKS + 30, () => [pushLeft, idle]);
      expect(at(sim, 1).y).toBeLessThan(-TEAM_SPACING / 2 - 0.2);
    });

    it("should push the rival less than the farter's own raft", () => {
      const { sim } = race("bump", COUNTDOWN_TICKS + 30, () => [pushLeft, idle]);
      const own = at(sim, 0).y - TEAM_SPACING / 2;
      const rival = -TEAM_SPACING / 2 - at(sim, 1).y;
      expect(rival).toBeGreaterThan(0);
      expect(rival).toBeLessThan(own);
    });
  });

  describe("when the rival is out of fart range", () => {
    it("should leave the rival where it is", () => {
      const sim = createSim(water(), TWO_CREWS, { difficulty: "wild", contact: "bump" });
      sim.racers[1]!.raft.body.setTranslation({ x: 0, y: -15 }, true);
      for (let t = 0; t < COUNTDOWN_TICKS + 30; t++) step(sim, [...pushLeft, ...idle]);
      expect(at(sim, 0).y).toBeGreaterThan(TEAM_SPACING / 2 + 0.2);
      expect(at(sim, 1).y).toBeCloseTo(-15, 6);
    });
  });

  describe("when a crew wipes out and the rival sits on its respawn spot", () => {
    let sim: Sim;
    let respawn: Extract<SimEvent, { type: "respawn" }> | undefined;
    const afterRespawn: SimEvent[] = [];
    beforeAll(() => {
      sim = createSim(water([bar]), TWO_CREWS, { difficulty: "wild", contact: "bump" });
      for (let t = 0; t < COUNTDOWN_TICKS + 600 && !respawn; t++) {
        const tumbling = sim.racers[0]!.health.respawnIn > 0;
        if (tumbling) {
          sim.racers[1]!.raft.body.setTranslation({ x: 0, y: TEAM_SPACING / 2 }, true);
          sim.racers[1]!.raft.body.setLinvel({ x: 0, y: 0 }, true);
        }
        for (const e of step(sim, [...(tumbling ? idle : pushForward), ...idle]))
          if (e.type === "respawn") respawn = e;
      }
      // Drive back into the rival straight away: the grace lets it through.
      for (let t = 0; t < 60; t++) afterRespawn.push(...step(sim, [...pushForward, ...idle]));
    });

    it("should respawn beside the rival, not on it", () => {
      expect(respawn?.raft).toBe(0);
      const rival = sim.racers[1]!.raft.body.translation();
      expect(Math.hypot(respawn!.x - rival.x, respawn!.y - rival.y)).toBeGreaterThanOrEqual(
        2 * RAFT_HULL,
      );
    });

    it("should pass through the rival during its grace", () => {
      expect(rivalBumps(afterRespawn)).toEqual([]);
      expect(at(sim, 0).x).toBeGreaterThan(at(sim, 1).x - RAFT_HULL);
    });
  });
});

describe("given two rafts racing to a close finish line", () => {
  describe("when both crews drive the same way", () => {
    it("should finish both on the same tick: a draw", () => {
      const { snap, events } = race(
        "ghost",
        COUNTDOWN_TICKS + 600,
        () => [pushForward, pushForward],
        water([], 20),
      );
      const finished = events.flatMap((e) => (e.type === "finished" ? [e.raft] : []));
      expect(finished.toSorted((a, b) => a - b)).toEqual([0, 1]);
      expect(winnerOf(snap.crews)).toBe("draw");
    });
  });

  describe("when only one crew drives", () => {
    it("should make it the winner", () => {
      const { snap } = race(
        "ghost",
        COUNTDOWN_TICKS + 600,
        () => [idle, pushForward],
        water([], 20),
      );
      expect(winnerOf(snap.crews)).toBe(1);
    });
  });
});

const crew = (phase: Phase): Crew => ({
  raft: { x: 0, y: 0, rot: 0 },
  riders: [],
  gas: [],
  deaths: 0,
  respawnIn: 0,
  invulnerable: 0,
  phase,
});

describe("given the crews of a race", () => {
  const racing = crew({ kind: "racing", startTick: 180, nextCheckpoint: 2 });
  const done = (timeMs: number) => crew({ kind: "finished", timeMs });

  it("should have no winner while nobody has finished", () => {
    expect(winnerOf([racing, racing])).toBeNull();
  });

  it("should crown the first raft across the finish", () => {
    expect(winnerOf([racing, done(61_000)])).toBe(1);
    expect(winnerOf([done(60_983), done(61_000)])).toBe(0);
  });

  it("should call the same finish time a draw", () => {
    expect(winnerOf([done(61_000), done(61_000)])).toBe("draw");
  });
});
