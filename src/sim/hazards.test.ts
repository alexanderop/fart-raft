import { beforeAll, describe, expect, it } from "vite-plus/test";
import canyon from "../../courses/canyon.json";
import {
  BUMPER_KNOCK,
  BUMPER_PULSE,
  COUNTDOWN_TICKS,
  crewZones,
  INVULNERABLE_TICKS,
  KNOCK_SPEED,
  KNOCK_SPIN,
  MAX_CREW,
  TICK_RATE,
} from "./constants.ts";
import { bumperRadius, hazardBox, logCenter } from "./hazards/shape.ts";
import { isIsland, islandOutline, islandRadius } from "./island.ts";
import { parseLevel } from "./level.ts";
import { levelWalls } from "./channel.ts";
import { createSim, initPhysics, snapshot, step } from "./sim.ts";
import {
  IDLE_INPUT,
  type HazardDef,
  type LevelData,
  type SeatInput,
  type SimEvent,
} from "./types.ts";

const FULL = crewZones(MAX_CREW);
const fart: SeatInput = { move: { x: 0, y: 0 }, fart: true };
const rearFart: SeatInput[] = [fart, fart, IDLE_INPUT, IDLE_INPUT];
const idle: SeatInput[] = FULL.map(() => IDLE_INPUT);

/** A free pond, the raft at the origin facing +x, one hazard and a far-away finish. */
const pond = (hazard: HazardDef): LevelData => ({
  name: "hazard-pond",
  spawn: { x: 0, y: 0, rot: 0 },
  channel: null,
  walls: [],
  checkpoints: [{ x: 500, y: 0, rot: 0, hx: 0.5, hy: 5 }],
  hazards: [hazard],
});

/** A bar across the raft's way, 8.7 m ahead of its bow. It does not spin. */
const bar: HazardDef = {
  id: "bar",
  kind: "spinner",
  speed: 0,
  x: 12,
  y: 0,
  rot: Math.PI / 2,
  hx: 8,
  hy: 0.4,
};

/** A pumpkin bumper in the same place, a hair wider than the bar is thick. */
const bumper: HazardDef = {
  id: "bumper",
  kind: "bumper",
  speed: 1,
  x: 12,
  y: 0,
  rot: 0,
  hx: 1.5,
  hy: 1.5,
};

type Hit = { tick: number; event: Extract<SimEvent, { type: "lifeLost" }> };

/**
 * Drive the raft with the rear riders farting until the first hit, then follow it for `after`
 * more ticks. Returns the hit and the raft's velocity, spin and position right after it.
 */
function firstHit(level: LevelData, inputs: SeatInput[] = rearFart, after = 0) {
  const sim = createSim(level, FULL);
  let hit: Hit | undefined;
  for (let t = 0; t < COUNTDOWN_TICKS + 15 * TICK_RATE && !hit; t++) {
    for (const event of step(sim, inputs)) if (event.type === "lifeLost") hit = { tick: t, event };
  }
  if (!hit) throw new Error("the raft was never hit");
  const velocity = sim.raft.body.linvel();
  const spin = sim.raft.body.angvel();
  const raft = snapshot(sim).raft;
  const trail: { x: number; y: number }[] = [];
  for (let t = 0; t < after; t++) {
    step(sim, idle);
    trail.push(sim.raft.body.linvel());
  }
  return { sim, hit, velocity, spin, raft, trail };
}

beforeAll(() => initPhysics());

describe("given a raft that rams a hazard", () => {
  describe("when the hit costs a life", () => {
    let rammed: ReturnType<typeof firstHit>;
    beforeAll(() => {
      rammed = firstHit(pond(bar));
    });

    it("should say which way the hit throws the raft: away from the hazard", () => {
      const { dirX, dirY } = rammed.hit.event;
      expect(Math.hypot(dirX, dirY)).toBeCloseTo(1);
      expect(dirX).toBeLessThan(-0.9); // the bar is ahead, so the raft is thrown back
    });

    it("should knock the raft back along that direction", () => {
      const { dirX, dirY } = rammed.hit.event;
      const along = rammed.velocity.x * dirX + rammed.velocity.y * dirY;
      expect(along).toBeGreaterThanOrEqual(KNOCK_SPEED);
    });

    it("should set the raft spinning", () => {
      expect(Math.abs(rammed.spin)).toBeGreaterThanOrEqual(KNOCK_SPIN - 1);
    });

    it("should be the same every time", () => {
      const again = firstHit(pond(bar));
      expect(again.hit).toEqual(rammed.hit);
      expect(again.velocity).toEqual(rammed.velocity);
      expect(again.spin).toBe(rammed.spin);
      expect(again.raft).toEqual(rammed.raft);
    });

    it("should leave the raft safe while it reels", () => {
      const { sim } = rammed;
      const events: SimEvent[] = [];
      for (let t = 0; t < INVULNERABLE_TICKS - 5; t++) events.push(...step(sim, rearFart));
      expect(events.some((e) => e.type === "lifeLost")).toBe(false);
      expect(snapshot(sim).invulnerable).toBeGreaterThan(0);
    });
  });

  describe("when it rams a spiked bank instead", () => {
    it("should be thrown off the bank the same way", () => {
      const canyonLevel = parseLevel(canyon);
      const spiked: LevelData = {
        ...canyonLevel,
        hazards: [],
        channel: {
          ...canyonLevel.channel!,
          spikes: [
            { side: "left", from: 0, to: 1000 },
            { side: "right", from: 0, to: 1000 },
          ],
        },
      };
      const { hit, velocity } = firstHit(spiked);
      const along = velocity.x * hit.event.dirX + velocity.y * hit.event.dirY;
      expect(along).toBeGreaterThanOrEqual(KNOCK_SPEED);
    });
  });

  describe("when the grace window ends and the raft is knocked again", () => {
    it("should count the invulnerability ticks down in the snapshot", () => {
      const { sim, hit } = firstHit(pond(bar));
      expect(hit.event.lives).toBe(2);
      expect(snapshot(sim).invulnerable).toBe(INVULNERABLE_TICKS);
      step(sim, idle);
      expect(snapshot(sim).invulnerable).toBe(INVULNERABLE_TICKS - 1);
    });
  });
});

describe("given a rolling log", () => {
  // Axis along y, rolling along x: it sweeps from x = 12 − 10 to x = 12 + 10 and back.
  const log: HazardDef = {
    id: "log",
    kind: "log",
    speed: 1,
    range: 10,
    x: 12,
    y: 0,
    rot: Math.PI / 2,
    hx: 2.4,
    hy: 1,
  };

  describe("when time passes", () => {
    it("should run back and forth across its axis on a fixed schedule", () => {
      const sim = createSim(pond(log), FULL);
      const at: { x: number; y: number; rot: number }[] = [];
      for (let t = 0; t < 8 * TICK_RATE; t++) {
        step(sim, idle);
        at.push(snapshot(sim).hazards[0]!);
      }
      const secs = (s: number) => at[Math.round(s * TICK_RATE) - 1]!;
      expect(secs(Math.PI / 2).x).toBeCloseTo(log.x - 10, 1); // −sin(rot) · run: run = +range
      expect(secs(1.5 * Math.PI).x).toBeCloseTo(log.x + 10, 1);
      expect(Math.max(...at.map((p) => Math.abs(p.y)))).toBeLessThan(1e-3); // never sideways to its travel
      expect(new Set(at.map((p) => p.rot)).size).toBe(1); // never turns
    });

    it("should be where the shared schedule says", () => {
      const sim = createSim(pond(log), FULL);
      for (let t = 0; t < 200; t++) step(sim, idle);
      const { x, y } = snapshot(sim).hazards[0]!;
      const expected = logCenter(log, 200 / TICK_RATE);
      expect(x).toBeCloseTo(expected.x, 2);
      expect(y).toBeCloseTo(expected.y, 2);
    });
  });

  describe("when it rolls into a raft that is waiting in its way", () => {
    it("should cost a life and throw the raft away from the log", () => {
      // Phased so the log is at the far side of its run when the race starts, then rolls in.
      const sim = createSim(pond({ ...log, x: 6, range: 8, phase: -3 }), FULL);
      const lost: SimEvent[] = [];
      for (let t = 0; t < COUNTDOWN_TICKS + 12 * TICK_RATE; t++)
        lost.push(...step(sim, idle).filter((e) => e.type === "lifeLost"));
      expect(lost.length).toBeGreaterThanOrEqual(1);
      const first = lost[0]!;
      expect(first.type === "lifeLost" && Math.abs(first.dirX)).toBeGreaterThan(0.7); // thrown along its travel
    });
  });

  describe("when the course JSON describes one", () => {
    it("should parse, and reject a range that is not a number", () => {
      const json = { ...pond(log), hazards: [log] };
      expect(parseLevel(json).hazards[0]!.range).toBe(10);
      expect(() => parseLevel({ ...json, hazards: [{ ...log, range: "far" }] })).toThrow();
    });
  });
});

describe("given a pumpkin bumper", () => {
  describe("when time passes", () => {
    it("should swell and shrink between its radius and the pulse limit", () => {
      const radii = Array.from({ length: 200 }, (_, k) => bumperRadius(bumper, k * 0.05));
      expect(Math.min(...radii)).toBeCloseTo(bumper.hx, 1);
      expect(Math.max(...radii)).toBeCloseTo(bumper.hx * (1 + BUMPER_PULSE), 1);
    });

    it("should be bounded by the box the bots keep clear of", () => {
      const box = hazardBox(bumper, 0);
      expect(box.hx).toBeCloseTo(bumper.hx * (1 + BUMPER_PULSE));
      expect(box.hy).toBe(box.hx);
    });

    it("should stay where it floats", () => {
      const sim = createSim(pond(bumper), FULL);
      for (let t = 0; t < 120; t++) step(sim, idle);
      const { x, y } = snapshot(sim).hazards[0]!;
      expect([x, y]).toEqual([bumper.x, bumper.y]);
    });
  });

  describe("when the raft rams it", () => {
    it("should cost a life and fling the raft back harder than a bar does", () => {
      const asBar = firstHit(pond(bar), rearFart, 20);
      const asBumper = firstHit(pond(bumper), rearFart, 20);
      expect(asBumper.hit.event.lives).toBe(2);
      const retreat = (r: ReturnType<typeof firstHit>) => Math.max(...r.trail.map((v) => -v.x));
      expect(retreat(asBumper)).toBeGreaterThan(retreat(asBar));
      expect(BUMPER_KNOCK).toBeGreaterThan(1);
    });
  });
});

describe("given an island", () => {
  const island = { x: 10, y: 0, rot: 0.3, hx: 3, hy: 3 };

  it("should be a wall that is thick on both sides, and a slab otherwise", () => {
    expect(isIsland(island)).toBe(true);
    expect(isIsland({ ...island, hy: 0.5 })).toBe(false);
  });

  it("should have eight corners on the same circle as the one the renderer draws", () => {
    const corners = islandOutline(island);
    expect(corners).toHaveLength(8);
    for (const c of corners)
      expect(Math.hypot(c.x - island.x, c.y - island.y)).toBeCloseTo(islandRadius(island));
  });

  it("should be the square the bots keep off, no bigger than its larger half-extent", () => {
    const level = pond(bar);
    const [wall] = levelWalls({ ...level, walls: [island] });
    expect([wall!.hx, wall!.hy]).toEqual([3, 3]);
  });

  it("should stop a raft by its flat side, not by a square's corner", () => {
    // Straight at a corner of the island's bounding square: an octagon lets the raft slip
    // closer than a square would.
    const level: LevelData = {
      ...pond(bar),
      hazards: [],
      walls: [{ ...island, x: 14, y: 0, rot: 0 }],
    };
    const sim = createSim(level, FULL);
    for (let t = 0; t < COUNTDOWN_TICKS + 8 * TICK_RATE; t++) step(sim, rearFart);
    const { raft } = snapshot(sim);
    // The octagon's flat side is at x = 14 − 3; the raft's hull is 2.9 m. It touches near 8.1.
    expect(raft.x).toBeGreaterThan(7);
    expect(raft.x).toBeLessThan(8.5);
  });
});
