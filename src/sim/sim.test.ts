import { beforeAll, describe, expect, it } from "vite-plus/test";
import canyon from "../../courses/canyon.json";
import pond from "../../courses/pond.json";
import { nearestS, pointAt, sampleChannel } from "./channel.ts";
import {
  COUNTDOWN_TICKS,
  crewZones,
  FART_TICKS,
  INVULNERABLE_TICKS,
  LIVES,
  MAX_CREW,
  RIDER_RING,
  TICK_RATE,
  type Zone,
} from "./constants.ts";
import { createSim, initPhysics, snapshot, step } from "./sim.ts";
import { parseLevel } from "./level.ts";
import { IDLE_INPUT, type LevelData, type SeatInput, type SimEvent } from "./types.ts";

const level = parseLevel(pond);
const FULL = crewZones(MAX_CREW);
const STAND = { x: 0, y: 0 };
const fart: SeatInput = { move: STAND, fart: true };
const rearFart: SeatInput[] = [fart, fart, IDLE_INPUT, IDLE_INPUT];

const wobble = (t: number): SeatInput[] =>
  FULL.map((_, i) => ({
    move: { x: Math.cos(t / 20 + i), y: Math.sin(t / 30 + i * 2) },
    fart: (t + i * 7) % 40 < 25,
  }));

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

const walkLeft = (t: number): SeatInput[] =>
  FULL.map(() => ({ move: { x: Math.cos(t / 50), y: 1 }, fart: false }));

function run(ticks: number, inputs: (tick: number) => SeatInput[], zones: readonly Zone[] = FULL) {
  const sim = createSim(level, zones);
  const events: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) events.push(...step(sim, inputs(t)));
  return { sim, events, snap: snapshot(sim) };
}

beforeAll(() => initPhysics());

describe("given the pond course", () => {
  it("should hold the raft still during the countdown", () => {
    const { snap, events } = run(COUNTDOWN_TICKS - 1, () => rearFart);
    expect(snap.raft.x).toBeCloseTo(level.spawn.x);
    expect(events.some((e) => e.type === "fart")).toBe(false);
  });

  describe("when both rear riders fart facing forward", () => {
    it("should move the raft forward and spend gas", () => {
      const { snap, events } = run(COUNTDOWN_TICKS + 60, () => rearFart);
      expect(events.some((e) => e.type === "go")).toBe(true);
      expect(snap.raft.x).toBeGreaterThan(level.spawn.x + 1);
      expect(Math.abs(snap.raft.rot)).toBeLessThan(0.01);
      expect(snap.gas[0]).toBeLessThan(snap.gas[2]!);
    });
  });

  describe("when a rider taps the fart key once", () => {
    it("should puff one short burst", () => {
      const { events } = run(COUNTDOWN_TICKS + 60, (t) =>
        t === COUNTDOWN_TICKS ? rearFart : [IDLE_INPUT],
      );
      expect(events.filter((e) => e.type === "fart" && e.seat === 0)).toHaveLength(FART_TICKS);
    });
  });

  describe("when only the rear-left rider farts", () => {
    it("should push the raft away from it, toward the front right, without spinning", () => {
      const leftOnly = [fart, IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
      const { snap } = run(COUNTDOWN_TICKS + 60, () => leftOnly);
      expect(snap.raft.x).toBeGreaterThan(level.spawn.x + 0.3);
      expect(snap.raft.y).toBeLessThan(level.spawn.y - 0.3);
      expect(Math.abs(snap.raft.rot)).toBeLessThan(0.01);
    });
  });

  describe("when every rider pushes the stick the same way for a long time", () => {
    it("should keep each rider on its own quarter of the ring", () => {
      const { snap } = run(600, walkLeft);
      snap.riders.forEach((r, i) => {
        const zone = FULL[i]!;
        const off = wrap(Math.atan2(r.y, r.x) - zone.center);
        expect(Math.abs(off)).toBeLessThanOrEqual(zone.half);
        expect(Math.hypot(r.x, r.y)).toBeCloseTo(RIDER_RING);
      });
    });

    it("should keep every rider facing the raft's center, butt out", () => {
      const { snap } = run(120, walkLeft);
      for (const r of snap.riders) expect(wrap(r.face - Math.atan2(-r.y, -r.x))).toBeCloseTo(0);
    });
  });

  describe("given a solo crew", () => {
    const SOLO = crewZones(1);
    describe("when the one rider farts from the back", () => {
      it("should move the raft forward without turning", () => {
        const { snap } = run(COUNTDOWN_TICKS + 60, () => [fart], SOLO);
        expect(snap.raft.x).toBeGreaterThan(level.spawn.x + 0.5);
        expect(Math.abs(snap.raft.y - level.spawn.y)).toBeLessThan(0.01);
        expect(snap.gas).toHaveLength(1);
      });
    });

    describe("when the rider slides round to the left side and farts", () => {
      it("should push the raft to the right", () => {
        // Countdown: hold the stick left, which slides the rider round the ring to the left.
        const { snap } = run(
          COUNTDOWN_TICKS + 60,
          (t) => [{ move: { x: 0, y: 1 }, fart: t >= COUNTDOWN_TICKS }],
          SOLO,
        );
        expect(snap.riders[0]!.y).toBeGreaterThan(RIDER_RING * 0.99);
        expect(snap.raft.y).toBeLessThan(level.spawn.y - 0.5);
      });
    });
  });

  // Multiplayer depends on this: the same inputs must give the same world.
  it("should be deterministic for the same inputs", () => {
    const a = run(900, wobble).snap;
    const b = run(900, wobble).snap;
    expect(a).toEqual(b);
  });

  it("should run headless for 10 seconds without DOM", () => {
    expect(typeof globalThis.document).toBe("undefined");
    const { snap } = run(600, () => rearFart);
    expect(snap.tick).toBe(600);
  });
});

describe("given a broken course export", () => {
  it("should reject an unknown hazard kind", () => {
    const broken = { ...pond, hazards: [{ ...pond.hazards[0], kind: "shark" }] };
    expect(() => parseLevel(broken)).toThrow(/bad hazards/);
  });

  it("should reject a channel with a single control point", () => {
    const broken = { ...canyon, channel: { ...canyon.channel, points: [{ x: 0, y: 0 }] } };
    expect(() => parseLevel(broken)).toThrow(/bad channel/);
  });
});

describe("given the canyon course", () => {
  const canyonLevel = parseLevel(canyon);

  describe("when nobody farts", () => {
    it("should drift downstream with the current once the race starts", () => {
      const sim = createSim(canyonLevel, FULL);
      const route = sampleChannel(canyonLevel.channel!);
      const idle = FULL.map(() => IDLE_INPUT);
      for (let t = 0; t < COUNTDOWN_TICKS; t++) step(sim, idle);
      const start = nearestS(route, snapshot(sim).raft);
      for (let t = 0; t < 5 * 60; t++) step(sim, idle);
      expect(nearestS(route, snapshot(sim).raft) - start).toBeGreaterThan(6);
    });
  });

  describe("when the rear riders fart the raft straight into the first bend", () => {
    it("should keep the raft inside the banks", () => {
      const sim = createSim(canyonLevel, FULL);
      for (let t = 0; t < COUNTDOWN_TICKS + 12 * 60; t++) step(sim, rearFart);
      const { raft } = snapshot(sim);
      const route = sampleChannel(canyonLevel.channel!);
      const s = nearestS(route, raft);
      const center = pointAt(route, s);
      expect(Math.hypot(raft.x - center.x, raft.y - center.y)).toBeLessThan(6);
      expect(s).toBeGreaterThan(20);
    });
  });
});

// A free pond with one fixed bar (a spinner that does not spin) across the raft's way, 8.7 m
// ahead of its bow. Farting forward drives the raft into it, and the bar never gets out of the way.
const barLevel: LevelData = {
  name: "bar",
  spawn: { x: 0, y: 0, rot: 0 },
  channel: null,
  walls: [],
  checkpoints: [{ x: 500, y: 0, rot: 0, hx: 0.5, hy: 5 }],
  hazards: [
    { id: "bar", kind: "spinner", speed: 0, x: 12, y: 0, rot: Math.PI / 2, hx: 8, hy: 0.4 },
  ],
};

// A straight channel only just wider than the raft, spiked on both banks: the raft cannot get
// away from the spikes, however hard each hit throws it.
const jamLevel: LevelData = {
  name: "jam",
  spawn: { x: 0, y: 0, rot: 0 },
  channel: {
    halfWidth: 2.9,
    points: [
      { x: -6, y: 0 },
      { x: 400, y: 0 },
    ],
    spikes: [
      { side: "left", from: 0, to: 1000 },
      { side: "right", from: 0, to: 1000 },
    ],
  },
  walls: [],
  checkpoints: [{ x: 390, y: 0, rot: 0, hx: 0.5, hy: 3 }],
  hazards: [],
};

type Logged = { tick: number; event: SimEvent };

/** Step a level with the rear riders farting, noting the tick of every event. */
function ram(course: LevelData, ticks: number) {
  const sim = createSim(course, FULL);
  const log: Logged[] = [];
  for (let t = 0; t < ticks; t++)
    for (const event of step(sim, rearFart)) log.push({ tick: t, event });
  return { sim, log, snap: snapshot(sim) };
}

const lost = (log: Logged[]) =>
  log.flatMap((l) => (l.event.type === "lifeLost" ? [{ tick: l.tick, lives: l.event.lives }] : []));
const count = (log: Logged[], type: SimEvent["type"]) =>
  log.filter((l) => l.event.type === type).length;

describe("given a crew with lives", () => {
  it("should start the race with every life", () => {
    expect(run(1, () => rearFart).snap.lives).toBe(LIVES);
  });

  describe("when the raft rams a hazard bar", () => {
    let rammed: ReturnType<typeof ram>;
    beforeAll(() => {
      rammed = ram(barLevel, COUNTDOWN_TICKS + 6 * TICK_RATE);
    });

    it("should lose a life and say so", () => {
      expect(lost(rammed.log)[0]?.lives).toBe(LIVES - 1);
      expect(rammed.snap.lives).toBeLessThan(LIVES);
    });

    it("should be thrown back by the hit", () => {
      expect(lost(rammed.log)).toHaveLength(1); // the knock sends the raft away from the bar
      expect(rammed.snap.raft.x).toBeLessThan(barLevel.hazards[0]!.x - 4);
    });
  });

  describe("when the raft is jammed between spiked banks", () => {
    let pressed: ReturnType<typeof ram>;
    beforeAll(() => {
      pressed = ram(jamLevel, COUNTDOWN_TICKS + 20 * TICK_RATE);
    });

    it("should stay safe for the whole grace window after each hit", () => {
      const [first, second] = lost(pressed.log);
      expect(second!.tick - first!.tick).toBeGreaterThanOrEqual(INVULNERABLE_TICKS);
    });

    it("should lose one life per grace window until none are left", () => {
      const hits = lost(pressed.log);
      expect(hits.map((h) => h.lives)).toEqual([2, 1, 0]);
      hits.slice(1).forEach((h, i) => {
        expect(h.tick - hits[i]!.tick).toBeGreaterThanOrEqual(INVULNERABLE_TICKS);
      });
    });

    it("should end the race in the dead phase", () => {
      expect(pressed.snap.lives).toBe(0);
      expect(pressed.snap.phase.kind).toBe("dead");
      expect(count(pressed.log, "died")).toBe(1);
      expect(count(pressed.log, "finished")).toBe(0);
    });

    it("should ignore every input once dead", () => {
      const before = snapshot(pressed.sim);
      const events: SimEvent[] = [];
      const walkAndFart = FULL.map(() => ({ move: { x: 0, y: 1 }, fart: true }));
      for (let t = 0; t < 120; t++) events.push(...step(pressed.sim, walkAndFart));
      const after = snapshot(pressed.sim);
      expect(events.some((e) => e.type === "fart")).toBe(false);
      expect(after.riders).toEqual(before.riders);
      expect(after.gas).toEqual(before.gas);
      expect(after.phase.kind).toBe("dead");
      expect(after.lives).toBe(0);
    });
  });

  describe("when the raft bumps a plain bank", () => {
    it("should keep every life", () => {
      // Front riders push the raft backward into the pond's plain back wall.
      const frontFart: SeatInput[] = [IDLE_INPUT, IDLE_INPUT, fart, fart];
      const sim = createSim(level, FULL);
      const events: SimEvent[] = [];
      for (let t = 0; t < COUNTDOWN_TICKS + 6 * TICK_RATE; t++)
        events.push(...step(sim, frontFart));
      expect(events.some((e) => e.type === "bump")).toBe(true);
      expect(events.some((e) => e.type === "lifeLost")).toBe(false);
      expect(snapshot(sim).lives).toBe(LIVES);
    });
  });

  describe("when the raft rams a spiked bank", () => {
    it("should lose a life", () => {
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
      const { log } = ram(spiked, COUNTDOWN_TICKS + 20 * TICK_RATE);
      expect(count(log, "lifeLost")).toBeGreaterThanOrEqual(1);
    });
  });

  describe("when the countdown has not finished", () => {
    it("should not cost a life", () => {
      expect(ram(barLevel, COUNTDOWN_TICKS - 1).snap.lives).toBe(LIVES);
    });
  });
});
