import { beforeAll, describe, expect, it } from "vite-plus/test";
import canyon from "../../courses/canyon.json";
import pond from "../../courses/pond.json";
import {
  channelWalls,
  flowSpeed,
  halfWidthAt,
  nearestS,
  pointAt,
  rapidsAt,
  sampleChannel,
} from "./channel.ts";
import {
  BOOST_SPEED,
  COUNTDOWN_TICKS,
  crewZones,
  CURRENT_SPEED,
  FART_TICKS,
  INVULNERABLE_TICKS,
  RAPIDS_SPEED,
  RESPAWN_BACK,
  RESPAWN_TICKS,
  MAX_CREW,
  POND_RAMP,
  RAFT_HULL,
  RIDER_RING,
  TICK_RATE,
  type Zone,
} from "./constants.ts";
import { createSim, initPhysics, snapshot, step } from "./sim.ts";
import { parseLevel } from "./level.ts";
import { IDLE_INPUT, type LevelData, type SeatInput, type SimEvent } from "./types.ts";

const level = parseLevel(pond);
const FULL = crewZones(4);
/** These tests pin today's full-speed tuning; chill is covered in hazards.test.ts. */
const WILD = { difficulty: "wild" } as const;
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
  const sim = createSim(level, zones, WILD);
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

  describe("given a crew bigger than four", () => {
    const EIGHT = crewZones(MAX_CREW);
    const BACK: SeatInput = { move: { x: -1, y: 0 }, fart: false };
    /**
     * Everyone slides to the back of their arc during the countdown; after GO, every rider behind
     * the middle farts once. How far straight ahead does the raft get?
     */
    const fullAhead = (zones: readonly Zone[]) => {
      const sim = createSim(level, zones, WILD);
      for (let t = 0; t < COUNTDOWN_TICKS + 90; t++) {
        const riders = snapshot(sim).riders;
        step(
          sim,
          zones.map((_, i) => ({ ...BACK, fart: t === COUNTDOWN_TICKS && riders[i]!.x < -0.1 })),
        );
      }
      return snapshot(sim).raft.x - level.spawn.x;
    };

    it.each([5, 6, 7, 8])("should split the ring into %i balanced arcs that tile it", (n) => {
      const zones = crewZones(n);
      expect(zones.reduce((sum, z) => sum + 2 * z.half, 0)).toBeCloseTo(2 * Math.PI);
      expect(zones.reduce((sum, z) => sum + Math.cos(z.center), 0)).toBeCloseTo(0);
      expect(zones.reduce((sum, z) => sum + Math.sin(z.center), 0)).toBeCloseTo(0);
    });

    describe.each([5, 6, 7, 8])("when a crew of %i gives its hardest push forward", (n) => {
      it("should push about as hard as a crew of four, not harder", () => {
        const ratio = fullAhead(crewZones(n)) / fullAhead(FULL);
        expect(ratio).toBeGreaterThan(0.85);
        expect(ratio).toBeLessThan(1.05);
      });
    });

    describe("when every rider of eight pushes the stick the same way for a long time", () => {
      it("should keep each rider on its own eighth of the ring", () => {
        const { snap } = run(
          600,
          (t) => EIGHT.map(() => ({ move: { x: Math.cos(t / 50), y: 1 }, fart: false })),
          EIGHT,
        );
        snap.riders.forEach((r, i) => {
          const zone = EIGHT[i]!;
          const off = wrap(Math.atan2(r.y, r.x) - zone.center);
          expect(Math.abs(off)).toBeLessThanOrEqual(zone.half);
          expect(Math.hypot(r.x, r.y)).toBeCloseTo(RIDER_RING);
        });
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
      const sim = createSim(canyonLevel, FULL, WILD);
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
      // Plain banks and no hazards: a hit would wipe the crew out and send it back to the start.
      const plain = {
        ...canyonLevel,
        hazards: [],
        channel: { ...canyonLevel.channel!, spikes: [] },
      };
      const sim = createSim(plain, FULL, WILD);
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
  const sim = createSim(course, FULL, WILD);
  const log: Logged[] = [];
  for (let t = 0; t < ticks; t++)
    for (const event of step(sim, rearFart)) log.push({ tick: t, event });
  return { sim, log, snap: snapshot(sim) };
}

const hits = (log: Logged[]) =>
  log.flatMap((l) => (l.event.type === "hit" ? [{ tick: l.tick, deaths: l.event.deaths }] : []));
const count = (log: Logged[], type: SimEvent["type"]) =>
  log.filter((l) => l.event.type === type).length;

describe("given a crew that can wipe out", () => {
  it("should start the race with no wipeouts", () => {
    expect(run(1, () => rearFart).snap.deaths).toBe(0);
  });

  describe("when the raft rams a hazard bar", () => {
    let rammed: ReturnType<typeof ram>;
    beforeAll(() => {
      rammed = ram(barLevel, COUNTDOWN_TICKS + 6 * TICK_RATE);
    });

    it("should count the wipeout and say so", () => {
      expect(hits(rammed.log)[0]?.deaths).toBe(1);
      expect(rammed.snap.deaths).toBeGreaterThanOrEqual(1);
    });

    it("should respawn at the start, dead still, after the tumble", () => {
      const hit = hits(rammed.log)[0]!;
      const back = rammed.log.find((l) => l.event.type === "respawn")!;
      expect(back.tick - hit.tick).toBe(RESPAWN_TICKS);
      expect(back.event).toMatchObject({ x: barLevel.spawn.x, y: barLevel.spawn.y });
    });

    it("should keep the race and its clock running", () => {
      expect(rammed.snap.phase.kind).toBe("racing");
    });
  });

  describe("when the crew is wiped out", () => {
    it("should ignore every input until it respawns", () => {
      const { sim, log } = ram(barLevel, COUNTDOWN_TICKS + 6 * TICK_RATE);
      sim.world.free();
      const hitTick = hits(log)[0]!.tick;
      // Replay up to the hit, then walk and fart through the tumble.
      const again = createSim(barLevel, FULL, WILD);
      for (let t = 0; t <= hitTick; t++) step(again, rearFart);
      const before = snapshot(again);
      const events: SimEvent[] = [];
      const walkAndFart = FULL.map(() => ({ move: { x: 0, y: 1 }, fart: true }));
      for (let t = 0; t < RESPAWN_TICKS - 1; t++) events.push(...step(again, walkAndFart));
      expect(events.some((e) => e.type === "fart")).toBe(false);
      expect(snapshot(again).riders).toEqual(before.riders);
      again.world.free();
    });
  });

  describe("when the raft is jammed between spiked banks", () => {
    let pressed: ReturnType<typeof ram>;
    beforeAll(() => {
      pressed = ram(jamLevel, COUNTDOWN_TICKS + 20 * TICK_RATE);
    });

    it("should wipe out again only after the tumble and the grace window", () => {
      const [first, second] = hits(pressed.log);
      expect(second!.tick - first!.tick).toBeGreaterThanOrEqual(RESPAWN_TICKS + INVULNERABLE_TICKS);
    });

    it("should count every wipeout and never end the race", () => {
      expect(hits(pressed.log).map((h) => h.deaths)).toEqual(
        hits(pressed.log).map((_, i) => i + 1),
      );
      expect(pressed.snap.phase.kind).toBe("racing");
      expect(count(pressed.log, "finished")).toBe(0);
    });
  });

  describe("when the raft has passed a gate", () => {
    it("should respawn just upstream of that gate", () => {
      const gated: LevelData = {
        ...barLevel,
        checkpoints: [{ x: 8, y: 0, rot: 0, hx: 0.5, hy: 6 }, ...barLevel.checkpoints],
      };
      const { log } = ram(gated, COUNTDOWN_TICKS + 6 * TICK_RATE);
      expect(count(log, "checkpoint")).toBe(1);
      const back = log.find((l) => l.event.type === "respawn");
      expect(back?.event).toMatchObject({ x: 8 - RESPAWN_BACK, y: 0 });
    });
  });

  describe("when the raft bumps a plain bank", () => {
    it("should not wipe out", () => {
      // Front riders push the raft backward into the pond's plain back wall.
      const frontFart: SeatInput[] = [IDLE_INPUT, IDLE_INPUT, fart, fart];
      const sim = createSim(level, FULL, WILD);
      const events: SimEvent[] = [];
      for (let t = 0; t < COUNTDOWN_TICKS + 6 * TICK_RATE; t++)
        events.push(...step(sim, frontFart));
      expect(events.some((e) => e.type === "bump")).toBe(true);
      expect(events.some((e) => e.type === "hit")).toBe(false);
      expect(snapshot(sim).deaths).toBe(0);
    });
  });

  describe("when the raft rams a spiked bank", () => {
    it("should wipe out", () => {
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
      expect(count(log, "hit")).toBeGreaterThanOrEqual(1);
    });
  });

  describe("when the countdown has not finished", () => {
    it("should not wipe out", () => {
      expect(ram(barLevel, COUNTDOWN_TICKS - 1).snap.deaths).toBe(0);
    });
  });
});

describe("given a straight channel with rapids", () => {
  // 200 m straight east, rapids from 60 m to 140 m.
  const straight: LevelData = {
    name: "rapids",
    spawn: { x: 0, y: 0, rot: 0 },
    channel: {
      halfWidth: 7,
      points: [
        { x: -6, y: 0 },
        { x: 200, y: 0 },
      ],
      spikes: [],
      rapids: [{ from: 66, to: 146 }],
    },
    walls: [],
    checkpoints: [{ x: 195, y: 0, rot: 0, hx: 0.5, hy: 6.7 }],
    hazards: [],
  };

  it("should ramp the water's speed up into the rapids and down after them", () => {
    const ch = straight.channel!;
    expect(rapidsAt(ch, 30)).toBe(0);
    expect(rapidsAt(ch, 66)).toBeCloseTo(0.5);
    expect(rapidsAt(ch, 100)).toBe(1);
    expect(flowSpeed(ch, 100)).toBe(RAPIDS_SPEED);
    expect(flowSpeed(ch, 180)).toBe(CURRENT_SPEED);
  });

  describe("when nobody farts", () => {
    it("should carry the raft through the rapids far faster than the calm water", () => {
      const sim = createSim(straight, FULL, WILD);
      const idle = FULL.map(() => IDLE_INPUT);
      const xAt: number[] = [];
      for (let t = 0; t < COUNTDOWN_TICKS + 40 * TICK_RATE; t++) {
        step(sim, idle);
        xAt.push(snapshot(sim).raft.x);
      }
      // Seconds the raft took over 10 m of calm water, and over 10 m of rapids.
      const time = (from: number) =>
        (xAt.findIndex((x) => x >= from + 10) - xAt.findIndex((x) => x >= from)) / TICK_RATE;
      expect(time(100)).toBeLessThan(time(20) / 2);
    });
  });

  it("should reject rapids that are not stretches", () => {
    const broken = { ...straight, channel: { ...straight.channel, rapids: [{ from: "here" }] } };
    expect(() => parseLevel(broken)).toThrow(/bad channel/);
  });
});

describe("given a straight channel that opens into a pond", () => {
  // 200 m straight east, half-width 7, a pond of half-width 18 from 60 m to 120 m.
  const ponded: LevelData = {
    name: "ponded",
    spawn: { x: 0, y: 0, rot: 0 },
    channel: {
      halfWidth: 7,
      points: [
        { x: -6, y: 0 },
        { x: 200, y: 0 },
      ],
      spikes: [],
      ponds: [{ from: 66, to: 126, halfWidth: 18 }],
    },
    walls: [],
    checkpoints: [{ x: 195, y: 0, rot: 0, hx: 0.5, hy: 6.7 }],
    hazards: [],
  };
  const ch = ponded.channel!;

  it("should widen from the channel to the pond over the ramp and narrow back after it", () => {
    expect(halfWidthAt(ch, 30)).toBe(7);
    expect(halfWidthAt(ch, 66)).toBe(7);
    expect(halfWidthAt(ch, 66 + POND_RAMP / 2)).toBeGreaterThan(7);
    expect(halfWidthAt(ch, 66 + POND_RAMP / 2)).toBeLessThan(18);
    expect(halfWidthAt(ch, 66 + POND_RAMP)).toBe(18);
    expect(halfWidthAt(ch, 96)).toBe(18);
    expect(halfWidthAt(ch, 126 - POND_RAMP / 2)).toBeCloseTo(halfWidthAt(ch, 66 + POND_RAMP / 2));
    expect(halfWidthAt(ch, 160)).toBe(7);
  });

  it("should leave a channel without ponds at its half-width and bank colliders", () => {
    const plain = { ...ch, ponds: undefined };
    expect(halfWidthAt(plain, 96)).toBe(7);
    expect(channelWalls({ ...ch, ponds: [] })).toEqual(channelWalls(plain));
  });

  it("should slow the water in the pond, the same flow through more room", () => {
    expect(flowSpeed(ch, 30)).toBe(CURRENT_SPEED);
    expect(flowSpeed(ch, 96)).toBeCloseTo((CURRENT_SPEED * 7) / 18);
  });

  describe("when nobody farts", () => {
    it("should drift through the pond slower than down the channel", () => {
      const sim = createSim(ponded, FULL, WILD);
      const idle = FULL.map(() => IDLE_INPUT);
      const xAt: number[] = [];
      for (let t = 0; t < COUNTDOWN_TICKS + 60 * TICK_RATE; t++) {
        step(sim, idle);
        xAt.push(snapshot(sim).raft.x);
      }
      const time = (from: number) =>
        (xAt.findIndex((x) => x >= from + 10) - xAt.findIndex((x) => x >= from)) / TICK_RATE;
      expect(time(90)).toBeGreaterThan(time(20) * 2);
    });
  });

  describe("when the crew farts the raft across the pond into its bank", () => {
    it("should reach past the channel's width but stop at the pond's bank", () => {
      const sim = createSim({ ...ponded, spawn: { x: 96, y: 0, rot: Math.PI / 2 } }, FULL, WILD);
      let far = 0;
      for (let t = 0; t < COUNTDOWN_TICKS + 8 * TICK_RATE; t++) {
        step(sim, rearFart);
        far = Math.max(far, snapshot(sim).raft.y);
      }
      expect(far).toBeGreaterThan(7 + 2);
      expect(far).toBeLessThanOrEqual(18 - RAFT_HULL + 0.05);
    });
  });

  it("should reject a pond no wider than its channel or running upstream", () => {
    const narrow = { ...ponded, channel: { ...ch, ponds: [{ from: 66, to: 126, halfWidth: 7 }] } };
    const backwards = {
      ...ponded,
      channel: { ...ch, ponds: [{ from: 126, to: 66, halfWidth: 18 }] },
    };
    expect(() => parseLevel(narrow)).toThrow(/bad channel/);
    expect(() => parseLevel(backwards)).toThrow(/bad channel/);
  });
});

describe("given a straight channel with a boost pad on its left lane", () => {
  // 120 m straight east, a 3 m pad pointing downstream 30 m in, 4 m left of center.
  const pad = { x: 30, y: 4, rot: 0, hx: 3, hy: 1.4 };
  const padded: LevelData = {
    name: "boost",
    spawn: { x: 0, y: 0, rot: 0 },
    channel: {
      halfWidth: 7,
      points: [
        { x: -6, y: 0 },
        { x: 120, y: 0 },
      ],
      spikes: [],
    },
    walls: [],
    checkpoints: [{ x: 115, y: 0, rot: 0, hx: 0.5, hy: 6.7 }],
    hazards: [],
    boosts: [pad],
  };

  /** Drift down the current from (0, lat): the fastest speed seen and the events. */
  function drift(lat: number) {
    const sim = createSim({ ...padded, spawn: { x: 0, y: lat, rot: 0 } }, FULL, WILD);
    const idle = FULL.map(() => IDLE_INPUT);
    const events: SimEvent[] = [];
    let top = 0;
    let topY = 0;
    for (let t = 0; t < COUNTDOWN_TICKS + 20 * TICK_RATE; t++) {
      events.push(...step(sim, idle));
      const v = sim.raft.body.linvel();
      top = Math.max(top, v.x);
      topY = Math.max(topY, Math.abs(v.y));
    }
    return { top, topY, events };
  }

  describe("when the raft drifts over the pad", () => {
    it("should speed up along the pad well past the current, once", () => {
      const { top, topY, events } = drift(pad.y);
      expect(top).toBeGreaterThan(CURRENT_SPEED + 5);
      expect(top).toBeLessThanOrEqual(BOOST_SPEED + 0.01);
      expect(topY).toBeLessThan(0.5);
      expect(events.filter((e) => e.type === "boost")).toHaveLength(1);
    });
  });

  describe("when the raft drifts down the other lane", () => {
    it("should keep to the current's speed with no boost", () => {
      const { top, events } = drift(-4);
      expect(top).toBeLessThan(CURRENT_SPEED + 0.1);
      expect(events.some((e) => e.type === "boost")).toBe(false);
    });
  });

  it("should reject a pad that is not a box", () => {
    expect(() => parseLevel({ ...padded, boosts: [{ x: 1 }] })).toThrow(/bad boosts/);
  });
});
