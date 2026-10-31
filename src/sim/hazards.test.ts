import { beforeAll, describe, expect, it } from "vite-plus/test";
import canyon from "../../courses/canyon.json";
import {
  BUMPER_KNOCK,
  BUMPER_PULSE,
  COUNTDOWN_TICKS,
  crewZones,
  DIFFICULTY,
  DOUBLEGATE_PERIOD,
  hazardRate,
  DROPGATE_PERIOD,
  HAMMER_ARM,
  INVULNERABLE_TICKS,
  MACE_HIT_LIFT,
  RESPAWN_TICKS,
  KNOCK_SPEED,
  KNOCK_SPIN,
  PISTON_HOLD,
  PISTON_REST,
  TICK_RATE,
  WALK_SPEED,
  walkSpeed,
} from "./constants.ts";
import { bumperRadius } from "./hazards/bumper.ts";
import { doublegateShut } from "./hazards/doublegate.ts";
import { dropgateDown, dropgateLift, dropgateShake } from "./hazards/dropgate.ts";
import { hammerDown, hammerLift, hammerPivot } from "./hazards/hammer.ts";
import { hazardBoxes } from "./hazards/index.ts";
import { logCenter } from "./hazards/log.ts";
import { maceBob, maceLow } from "./hazards/mace.ts";
import { mineCenter } from "./hazards/mine.ts";
import { pistonCenter, pistonOut } from "./hazards/piston.ts";
import { hazardTime } from "./hazards/shape.ts";
import { isIsland, islandOutline, islandRadius } from "./island.ts";
import { parseLevel } from "./level.ts";
import { levelWalls } from "./channel.ts";
import { createSim, initPhysics, snapshot, step } from "./sim.ts";
import { viewOf } from "./view.ts";
import {
  IDLE_INPUT,
  type Difficulty,
  type HazardDef,
  type LevelData,
  type SeatInput,
  type SimEvent,
} from "./types.ts";

const FULL = crewZones(4);
/** The hazard tests below pin today's full-speed tuning; "given a difficulty" covers chill. */
const WILD = { difficulty: "wild" } as const;
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

/** A spiked-ball bumper in the same place, a hair wider than the bar is thick. */
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

type Hit = { tick: number; event: Extract<SimEvent, { type: "hit" }> };

/**
 * Drive the raft with the rear riders farting until the first hit, then follow it for `after`
 * more ticks. Returns the hit and the raft's velocity, spin and position right after it.
 */
function firstHit(level: LevelData, inputs: SeatInput[] = rearFart, after = 0) {
  const sim = createSim(level, [FULL], WILD);
  let hit: Hit | undefined;
  for (let t = 0; t < COUNTDOWN_TICKS + 15 * TICK_RATE && !hit; t++) {
    for (const event of step(sim, inputs)) if (event.type === "hit") hit = { tick: t, event };
  }
  if (!hit) throw new Error("the raft was never hit");
  const velocity = sim.racers[0]!.raft.body.linvel();
  const spin = sim.racers[0]!.raft.body.angvel();
  const raft = viewOf(snapshot(sim), 0).raft;
  const trail: { x: number; y: number }[] = [];
  for (let t = 0; t < after; t++) {
    step(sim, idle);
    trail.push(sim.racers[0]!.raft.body.linvel());
  }
  return { sim, hit, velocity, spin, raft, trail };
}

beforeAll(() => initPhysics());

describe("given a raft that rams a hazard", () => {
  describe("when the hit wipes the crew out", () => {
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

    it("should leave the raft safe while it tumbles and right after it respawns", () => {
      const { sim } = rammed;
      const events: SimEvent[] = [];
      for (let t = 0; t < RESPAWN_TICKS + INVULNERABLE_TICKS - 5; t++)
        events.push(...step(sim, rearFart));
      expect(events.filter((e) => e.type === "hit")).toHaveLength(0);
      expect(events.filter((e) => e.type === "respawn")).toHaveLength(1);
      expect(viewOf(snapshot(sim), 0).invulnerable).toBeGreaterThan(0);
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

  describe("when the raft respawns", () => {
    it("should count the tumble down, then the grace ticks, in the snapshot", () => {
      const { sim, hit } = firstHit(pond(bar));
      expect(hit.event.deaths).toBe(1);
      expect(viewOf(snapshot(sim), 0).respawnIn).toBe(RESPAWN_TICKS);
      for (let t = 0; t < RESPAWN_TICKS; t++) step(sim, idle);
      expect(viewOf(snapshot(sim), 0).respawnIn).toBe(0);
      expect(viewOf(snapshot(sim), 0).invulnerable).toBe(INVULNERABLE_TICKS);
      step(sim, idle);
      expect(viewOf(snapshot(sim), 0).invulnerable).toBe(INVULNERABLE_TICKS - 1);
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
      const sim = createSim(pond(log), [FULL], WILD);
      const at: { x: number; y: number; rot: number }[] = [];
      for (let t = 0; t < 8 * TICK_RATE; t++) {
        step(sim, idle);
        at.push(viewOf(snapshot(sim), 0).hazards[0]!);
      }
      const secs = (s: number) => at[Math.round(s * TICK_RATE) - 1]!;
      expect(secs(Math.PI / 2).x).toBeCloseTo(log.x - 10, 1); // −sin(rot) · run: run = +range
      expect(secs(1.5 * Math.PI).x).toBeCloseTo(log.x + 10, 1);
      expect(Math.max(...at.map((p) => Math.abs(p.y)))).toBeLessThan(1e-3); // never sideways to its travel
      expect(new Set(at.map((p) => p.rot)).size).toBe(1); // never turns
    });

    it("should be where the shared schedule says", () => {
      const sim = createSim(pond(log), [FULL], WILD);
      for (let t = 0; t < 200; t++) step(sim, idle);
      const { x, y } = viewOf(snapshot(sim), 0).hazards[0]!;
      const expected = logCenter(log, 200 / TICK_RATE);
      expect(x).toBeCloseTo(expected.x, 2);
      expect(y).toBeCloseTo(expected.y, 2);
    });
  });

  describe("when it rolls into a raft that is waiting in its way", () => {
    it("should wipe the crew out and throw the raft away from the log", () => {
      // Phased so the log is at the far side of its run when the race starts, then rolls in.
      const sim = createSim(pond({ ...log, x: 6, range: 8, phase: -3 }), [FULL], WILD);
      const lost: SimEvent[] = [];
      for (let t = 0; t < COUNTDOWN_TICKS + 12 * TICK_RATE; t++)
        lost.push(...step(sim, idle).filter((e) => e.type === "hit"));
      expect(lost.length).toBeGreaterThanOrEqual(1);
      const first = lost[0]!;
      expect(first.type === "hit" && Math.abs(first.dirX)).toBeGreaterThan(0.7); // thrown along its travel
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

describe("given a spiked-ball bumper", () => {
  describe("when time passes", () => {
    it("should swell and shrink between its radius and the pulse limit", () => {
      const radii = Array.from({ length: 200 }, (_, k) => bumperRadius(bumper, k * 0.05));
      expect(Math.min(...radii)).toBeCloseTo(bumper.hx, 1);
      expect(Math.max(...radii)).toBeCloseTo(bumper.hx * (1 + BUMPER_PULSE), 1);
    });

    it("should be bounded by the box the bots keep clear of", () => {
      const [box] = hazardBoxes(bumper, 0);
      expect(box!.hx).toBeCloseTo(bumper.hx * (1 + BUMPER_PULSE));
      expect(box!.hy).toBe(box!.hx);
    });

    it("should stay where it floats", () => {
      const sim = createSim(pond(bumper), [FULL], WILD);
      for (let t = 0; t < 120; t++) step(sim, idle);
      const { x, y } = viewOf(snapshot(sim), 0).hazards[0]!;
      expect([x, y]).toEqual([bumper.x, bumper.y]);
    });
  });

  describe("when the raft rams it", () => {
    it("should wipe the crew out and fling the raft back harder than a bar does", () => {
      const asBar = firstHit(pond(bar), rearFart, 20);
      const asBumper = firstHit(pond(bumper), rearFart, 20);
      expect(asBumper.hit.event.deaths).toBe(1);
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
    const sim = createSim(level, [FULL], WILD);
    for (let t = 0; t < COUNTDOWN_TICKS + 8 * TICK_RATE; t++) step(sim, rearFart);
    const { raft } = viewOf(snapshot(sim), 0);
    // The octagon's flat side is at x = 14 − 3; the raft's hull is 2.9 m. It touches near 8.1.
    expect(raft.x).toBeGreaterThan(7);
    expect(raft.x).toBeLessThan(8.5);
  });
});

describe("given a hammer", () => {
  // Pivot on the far left, the smash zone straight ahead of the raft: (12, 0), 2.4 × 3 m.
  const hammer: HazardDef = {
    id: "hammer",
    kind: "hammer",
    speed: 1.5,
    x: 12,
    y: 0,
    rot: -Math.PI / 2,
    hx: 1.2,
    hy: 1.5,
  };
  const period = (2 * Math.PI) / hammer.speed;

  describe("when time passes", () => {
    it("should hang up high, slam down once a cycle, and lift again", () => {
      const lifts = Array.from({ length: 200 }, (_, k) => hammerLift(hammer, (k / 200) * period));
      expect(Math.max(...lifts)).toBeGreaterThan(Math.PI / 2); // rears back past upright
      expect(Math.min(...lifts)).toBe(0);
      const down = lifts.map((_, k) => hammerDown(hammer, (k / 200) * period));
      const slams = down.filter((d, k) => d && !down[k - 1]).length;
      expect(slams).toBe(1);
      expect(down.filter(Boolean).length / down.length).toBeGreaterThan(0.15);
      expect(down.filter(Boolean).length / down.length).toBeLessThan(0.3);
    });

    it("should fill its smash zone only while down", () => {
      const up = hazardBoxes(hammer, 0)[0]!;
      expect(Math.hypot(up.x - hammer.x, up.y - hammer.y)).toBeGreaterThan(1000);
      const downAt = 0.7 * period;
      expect(hammerDown(hammer, downAt)).toBe(true);
      expect(hazardBoxes(hammer, downAt)[0]).toMatchObject({ x: 12, y: 0, hx: 1.2, hy: 1.5 });
    });

    it("should hang from a pivot HAMMER_ARM m back along its arm", () => {
      const pivot = hammerPivot(hammer);
      expect(Math.hypot(pivot.x - hammer.x, pivot.y - hammer.y)).toBeCloseTo(HAMMER_ARM);
      expect(pivot.y).toBeGreaterThan(hammer.y); // rot points from the pivot to the zone
    });
  });

  describe("when the raft waits under it", () => {
    it("should be safe while the hammer is up and wiped out when it slams", () => {
      // The raft sits on the smash zone from the start; nobody farts.
      const sim = createSim({ ...pond(hammer), spawn: { x: 12, y: 0, rot: 0 } }, [FULL], WILD);
      const hits: number[] = [];
      for (let t = 0; t < COUNTDOWN_TICKS + 2 * period * TICK_RATE; t++)
        for (const e of step(sim, idle)) if (e.type === "hit") hits.push((t + 1) / TICK_RATE);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      // Every hit lands while the shared schedule says the hammer is down (after tick t the
      // hazards have moved t + 1 steps).
      for (const at of hits) expect(hammerDown(hammer, at)).toBe(true);
    });
  });
});

describe("given a piston", () => {
  // Rests at (12, 6) in a bank to the left and punches 6 m to the right, across the raft's way.
  const piston: HazardDef = {
    id: "piston",
    kind: "piston",
    speed: 2,
    range: 6,
    x: 12,
    y: 6,
    rot: -Math.PI / 2,
    hx: 1.2,
    hy: 1.6,
  };

  describe("when time passes", () => {
    it("should rest, punch all the way out, hold, and come back", () => {
      const period = (2 * Math.PI) / piston.speed;
      const outs = Array.from({ length: 400 }, (_, k) => pistonOut(piston, (k / 400) * period));
      expect(outs[0]).toBe(0);
      expect(Math.max(...outs)).toBe(1);
      expect(outs.filter((o) => o === 1).length / outs.length).toBeCloseTo(PISTON_HOLD, 1);
      expect(outs.filter((o) => o === 0).length / outs.length).toBeCloseTo(PISTON_REST, 1);
    });

    it("should be where the shared schedule says", () => {
      const sim = createSim(pond(piston), [FULL], WILD);
      for (let t = 0; t < 150; t++) step(sim, idle);
      const { x, y } = viewOf(snapshot(sim), 0).hazards[0]!;
      const expected = pistonCenter(piston, 150 / TICK_RATE);
      expect(x).toBeCloseTo(expected.x, 2);
      expect(y).toBeCloseTo(expected.y, 2);
      expect(y).toBeLessThanOrEqual(6);
    });
  });

  describe("when it punches into a raft", () => {
    it("should wipe the crew out and throw the raft away along its punch", () => {
      // Slowed and phased to punch for the first time just after the countdown.
      const late = { ...piston, speed: 1, phase: -0.47 };
      const { hit } = firstHit({ ...pond(late), spawn: { x: 12, y: -2, rot: 0 } }, idle);
      expect(hit.event.dirY).toBeLessThan(-0.5);
    });
  });
});

describe("given a cross", () => {
  const cross: HazardDef = { ...bar, id: "cross", kind: "cross", speed: 0, hx: 4 };

  it("should fill two bars square to each other", () => {
    const [a, b] = hazardBoxes(cross, 0);
    expect(b!.rot - a!.rot).toBeCloseTo(Math.PI / 2);
  });

  it("should wipe out a raft that rams either bar", () => {
    // The raft rams the bar along its own axis: only the second, square bar is in its way.
    expect(firstHit(pond({ ...cross, rot: 0 })).hit.event.dirX).toBeLessThan(-0.9);
  });
});

/** The k-th of 400 instants through a default drop gate's cycle, s. */
const gateTime = (k: number) => (k / 400) * DROPGATE_PERIOD;

describe("given a drop gate", () => {
  // A bar across the raft's way at x = 12, from y = -7 to 7.
  const dropgate: HazardDef = {
    id: "dropgate",
    kind: "dropgate",
    speed: 0,
    x: 12,
    y: 0,
    rot: Math.PI / 2,
    hx: 7,
    hy: 0.6,
  };
  const period = DROPGATE_PERIOD;

  describe("when time passes", () => {
    it("should hang up high, shake, slam down once a cycle, and rise again", () => {
      const lifts = Array.from({ length: 400 }, (_, k) => dropgateLift(dropgate, gateTime(k)));
      expect(lifts[0]).toBe(1);
      expect(Math.min(...lifts)).toBe(0);
      const down = lifts.map((_, k) => dropgateDown(dropgate, gateTime(k)));
      expect(down.filter((d, k) => d && !down[k - 1]).length).toBe(1);
      expect(down.filter(Boolean).length / down.length).toBeLessThan(0.3);
      // It shakes only just before it slams.
      const firstDown = down.indexOf(true);
      const shakes = lifts.map((_, k) => dropgateShake(dropgate, gateTime(k)) > 0);
      expect(shakes.indexOf(true)).toBeGreaterThan(firstDown - 50);
      expect(shakes.indexOf(true)).toBeLessThan(firstDown);
    });

    it("should take its own period, rest and rise times", () => {
      const slow = { ...dropgate, period: 10, down: 2, rise: 3 };
      const down = Array.from({ length: 1000 }, (_, k) => dropgateLift(slow, k / 100) === 0);
      expect(down.filter(Boolean).length).toBeGreaterThanOrEqual(199);
      expect(down.filter(Boolean).length).toBeLessThanOrEqual(201);
    });

    it("should fill the channel only while down", () => {
      const up = hazardBoxes(dropgate, 0)[0]!;
      expect(Math.hypot(up.x - dropgate.x, up.y - dropgate.y)).toBeGreaterThan(1000);
      const downAt = period * 0.75;
      expect(dropgateDown(dropgate, downAt)).toBe(true);
      expect(hazardBoxes(dropgate, downAt)[0]).toMatchObject({ x: 12, y: 0, hx: 7, hy: 0.6 });
    });
  });

  describe("when the raft waits under it", () => {
    it("should be safe while the bar is up and wiped out when it slams", () => {
      const sim = createSim({ ...pond(dropgate), spawn: { x: 12, y: 0, rot: 0 } }, [FULL], WILD);
      const hits: number[] = [];
      for (let t = 0; t < COUNTDOWN_TICKS + 2 * period * TICK_RATE; t++)
        for (const e of step(sim, idle)) if (e.type === "hit") hits.push((t + 1) / TICK_RATE);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      for (const at of hits) expect(dropgateDown(dropgate, at)).toBe(true);
    });
  });

  describe("when the raft drives under it while it is up", () => {
    it("should let the raft pass", () => {
      // Phased so the bar stays up for the whole run: it next slams long after the raft is through.
      const late = { ...dropgate, period: 30, phase: 0.6 };
      const sim = createSim(pond(late), [FULL], WILD);
      const events: SimEvent[] = [];
      for (let t = 0; t < COUNTDOWN_TICKS + 6 * TICK_RATE; t++) events.push(...step(sim, rearFart));
      expect(events.filter((e) => e.type === "hit")).toHaveLength(0);
      expect(viewOf(snapshot(sim), 0).raft.x).toBeGreaterThan(dropgate.x + 4);
    });
  });
});

describe("given a double gate", () => {
  // Two doors hinged at (12, ±7), meeting at (12, 0) when shut, across the raft's way.
  const doublegate: HazardDef = {
    id: "doublegate",
    kind: "doublegate",
    speed: 0,
    x: 12,
    y: 0,
    rot: Math.PI / 2,
    hx: 7,
    hy: 0.45,
  };

  describe("when time passes", () => {
    it("should start open, swing shut once a cycle, and open again", () => {
      const shut = Array.from({ length: 600 }, (_, k) =>
        doublegateShut(doublegate, (k / 600) * DOUBLEGATE_PERIOD),
      );
      expect(shut[0]).toBe(0);
      expect(Math.max(...shut)).toBe(1);
      const closings = shut.filter((v, k) => v === 1 && shut[k - 1] !== 1).length;
      expect(closings).toBe(1);
      expect(shut.filter((v) => v === 0).length / shut.length).toBeGreaterThan(0.5);
    });

    it("should meet in the middle when shut and lie along the banks, upstream, when open", () => {
      const shutAt = DOUBLEGATE_PERIOD - 1.5;
      expect(doublegateShut(doublegate, shutAt)).toBe(1);
      const [left, right] = hazardBoxes(doublegate, shutAt);
      expect(left!.x).toBeCloseTo(12);
      expect(left!.y + left!.hx).toBeCloseTo(7);
      expect(right!.y - right!.hx).toBeCloseTo(-7);
      for (const door of hazardBoxes(doublegate, 0)) {
        expect(Math.abs(door.y)).toBeCloseTo(7); // flat along its bank
        expect(door.x).toBeCloseTo(12 - 3.5); // reaching upstream from the hinge
      }
    });
  });

  describe("when the raft drives through while it is open", () => {
    it("should let the raft pass", () => {
      // It next swings shut 37 s in, long after the raft is through.
      const late = { ...doublegate, period: 40 };
      const sim = createSim(pond(late), [FULL], WILD);
      const events: SimEvent[] = [];
      for (let t = 0; t < COUNTDOWN_TICKS + 6 * TICK_RATE; t++) events.push(...step(sim, rearFart));
      expect(events.filter((e) => e.type === "hit")).toHaveLength(0);
      expect(viewOf(snapshot(sim), 0).raft.x).toBeGreaterThan(doublegate.x + 4);
    });
  });

  describe("when the raft rams it while it is shut", () => {
    it("should wipe the crew out and throw the raft back", () => {
      // Shut from the start for half a minute: 10 s into a 40 s cycle that stays shut 30 s.
      const shut = { ...doublegate, period: 40, down: 30, phase: Math.PI / 2 };
      expect(doublegateShut(shut, 0)).toBe(1);
      const { hit, raft } = firstHit(pond(shut));
      expect(hit.event.dirX).toBeLessThan(-0.9);
      expect(raft.x).toBeLessThan(doublegate.x);
    });
  });
});

describe("given a mace", () => {
  // Hung over (12, 0), its 1.3 m bob swings 5.5 m either side across the raft's way.
  const mace: HazardDef = {
    id: "mace",
    kind: "mace",
    speed: 1.3,
    x: 12,
    y: 0,
    rot: Math.PI / 2,
    hx: 1.3,
    hy: 1.3,
    range: 5.5,
  };

  describe("when time passes", () => {
    it("should hang low through the middle of each swing and high at either end", () => {
      const period = (2 * Math.PI) / mace.speed;
      const bobs = Array.from({ length: 600 }, (_, k) => maceBob(mace, (k / 600) * period));
      expect(Math.max(...bobs.map((b) => b.y))).toBeCloseTo(5.5);
      expect(Math.min(...bobs.map((b) => b.y))).toBeCloseTo(-5.5);
      for (const bob of bobs) {
        expect(bob.x).toBeCloseTo(12);
        if (Math.abs(bob.y) > 4) expect(bob.lift).toBeGreaterThan(MACE_HIT_LIFT);
        if (Math.abs(bob.y) < 1) expect(bob.lift).toBeLessThan(MACE_HIT_LIFT);
      }
      const low = bobs.filter((b) => b.lift < MACE_HIT_LIFT).length / bobs.length;
      expect(low).toBeGreaterThan(0.2);
      expect(low).toBeLessThan(0.5);
    });
  });

  describe("when the raft drives into the bob while it is low", () => {
    it("should wipe the crew out and throw the raft back", () => {
      // Frozen at the bottom of its swing, right in the raft's way.
      const low = { ...mace, speed: 0 };
      expect(maceLow(low, 0)).toBe(true);
      const { hit, raft } = firstHit(pond(low));
      expect(hit.event.dirX).toBeLessThan(-0.9);
      expect(raft.x).toBeLessThan(mace.x);
    });
  });

  describe("when the raft drives under the bob while it is high", () => {
    it("should let the raft pass", () => {
      // Frozen at the end of its swing, hung over the raft's way: the riders pass beneath it.
      const high = { ...mace, speed: 0, y: -5.5, phase: Math.PI / 2 };
      expect(maceBob(high, 0).y).toBeCloseTo(0);
      expect(maceLow(high, 0)).toBe(false);
      const sim = createSim(pond(high), [FULL], WILD);
      const events: SimEvent[] = [];
      for (let t = 0; t < COUNTDOWN_TICKS + 6 * TICK_RATE; t++) events.push(...step(sim, rearFart));
      expect(events.filter((e) => e.type === "hit")).toHaveLength(0);
      expect(viewOf(snapshot(sim), 0).raft.x).toBeGreaterThan(mace.x + 4);
    });
  });
});

describe("given a mine", () => {
  const mine: HazardDef = {
    id: "mine",
    kind: "mine",
    speed: 0,
    x: 12,
    y: 0,
    rot: 0,
    hx: 0.9,
    hy: 0.9,
  };
  // Drifts 3 m either side of (12, 6), across the raft's way.
  const drifting: HazardDef = { ...mine, y: 6, rot: Math.PI / 2, range: 3, speed: 0.8, phase: 1 };

  describe("when the raft rams it", () => {
    it("should wipe the crew out and throw the raft back", () => {
      const { hit } = firstHit(pond(mine));
      expect(hit.event.dirX).toBeLessThan(-0.9);
    });
  });

  describe("when it drifts", () => {
    it("should be a pure function of time, along its axis and within its range", () => {
      const period = (2 * Math.PI) / drifting.speed;
      for (const t of [0, 1.3, 4.7, 11]) {
        const p = mineCenter(drifting, t);
        expect(mineCenter(drifting, t)).toEqual(p);
        expect(mineCenter(drifting, t + period).y).toBeCloseTo(p.y, 6);
        expect(p.x).toBeCloseTo(12, 6);
        expect(Math.abs(p.y - 6)).toBeLessThanOrEqual(3 + 1e-9);
      }
      expect(mineCenter(mine, 5)).toEqual({ x: 12, y: 0 });
    });

    it("should be where the shared schedule says, inside the box the bots keep clear of", () => {
      const sim = createSim(pond(drifting), [FULL], WILD);
      for (let t = 0; t < 150; t++) step(sim, idle);
      const { x, y } = viewOf(snapshot(sim), 0).hazards[0]!;
      const expected = mineCenter(drifting, 150 / TICK_RATE);
      expect(x).toBeCloseTo(expected.x, 2);
      expect(y).toBeCloseTo(expected.y, 2);
      expect(hazardBoxes(drifting, 150 / TICK_RATE)[0]).toMatchObject({ hx: 0.9, hy: 0.9 });
    });
  });

  describe("when the course JSON describes one", () => {
    it("should parse, and reject a drop gate with a period that is not positive", () => {
      const level = { ...pond(drifting), hazards: [drifting, { ...mine, kind: "dropgate" }] };
      expect(parseLevel(level).hazards).toHaveLength(2);
      const bad = { ...level, hazards: [{ ...mine, kind: "dropgate", period: 0 }] };
      expect(() => parseLevel(bad)).toThrow(/hazards/);
    });
  });
});

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Run a pond with `hazard` for `ticks` while the crew wobbles about, and return the snapshot. */
const runFor = (hazard: HazardDef, ticks: number, difficulty?: Difficulty) => {
  const sim = createSim(pond(hazard), [FULL], difficulty && { difficulty });
  for (let t = 0; t < ticks; t++)
    step(
      sim,
      FULL.map((_, i) => ({
        move: { x: Math.cos(t / 20 + i), y: Math.sin(t / 30) },
        fart: (t + i * 7) % 40 < 25,
      })),
    );
  const snap = viewOf(snapshot(sim), 0);
  sim.world.free();
  return snap;
};

/** How far (radians) rider 0 walks round the ring in half a second. */
const walked = (d: Difficulty, crew: number) => {
  const zones = crewZones(crew);
  const sim = createSim(pond(bar), [zones], { difficulty: d });
  const start = viewOf(snapshot(sim), 0).riders[0]!;
  // Stick toward +y: rider 0 (rear, or rear-left) slides along the ring.
  for (let t = 0; t < 30; t++)
    step(
      sim,
      zones.map(() => ({ move: { x: 0, y: 1 }, fart: false })),
    );
  const end = viewOf(snapshot(sim), 0).riders[0]!;
  sim.world.free();
  return Math.abs(wrapAngle(Math.atan2(end.y, end.x) - Math.atan2(start.y, start.x)));
};

describe("given a difficulty", () => {
  const spinner: HazardDef = { ...bar, id: "spin", kind: "spinner", speed: 2, x: 30 };
  describe("when none is picked", () => {
    it("should play chill", () => {
      expect(runFor(spinner, 1).difficulty).toBe("chill");
    });
  });

  describe("when the same tick is reached in chill and in wild", () => {
    const ticks = 60; // under half a turn either way, so the wrapped angle is the whole turn
    const turned = (def: HazardDef, d: Difficulty) =>
      wrapAngle(runFor(def, ticks, d).hazards[0]!.rot - def.rot);

    it("should have turned the chill spinner by its own, slower hazard rate of the wild one", () => {
      expect(turned(spinner, "wild")).toBeCloseTo(spinner.speed * (ticks / TICK_RATE));
      expect(turned(spinner, "chill") / turned(spinner, "wild")).toBeCloseTo(
        hazardRate("chill", "spinner"),
      );
      expect(hazardRate("chill", "spinner")).toBe(0.5);
      expect(hazardRate("chill", "spinner")).toBeLessThan(DIFFICULTY.chill.hazardRate);
      expect(hazardRate("wild", "spinner")).toBe(1);
    });

    it("should slow a chill cross like a spinner", () => {
      const cross: HazardDef = { ...spinner, id: "cross", kind: "cross" };
      expect(turned(cross, "chill") / turned(cross, "wild")).toBeCloseTo(
        hazardRate("chill", "spinner"),
      );
    });

    it("should keep every other chill hazard on the difficulty's hazard rate", () => {
      expect(hazardRate("chill", "log")).toBe(DIFFICULTY.chill.hazardRate);
      expect(DIFFICULTY.chill.hazardRate).toBeLessThan(1);
    });

    it.each(["chill", "wild"] as const)(
      "should turn a %s spinner body exactly where hazardTime says it is",
      (d) => {
        const snap = runFor(spinner, ticks, d);
        const [box] = hazardBoxes(spinner, hazardTime(d, snap.tick, "spinner"));
        expect(wrapAngle(snap.hazards[0]!.rot - box!.rot)).toBeCloseTo(0, 4);
      },
    );

    it.each(["chill", "wild"] as const)(
      "should put a %s log body exactly where hazardTime says it is",
      (d) => {
        const log: HazardDef = {
          ...bar,
          id: "log",
          kind: "log",
          speed: 1,
          range: 6,
          x: 30,
          hx: 2.4,
          hy: 1,
        };
        const snap = runFor(log, 200, d);
        const [box] = hazardBoxes(log, hazardTime(d, snap.tick, "log"));
        expect(snap.hazards[0]!.x).toBeCloseTo(box!.x, 4);
        expect(snap.hazards[0]!.y).toBeCloseTo(box!.y, 4);
      },
    );
  });

  describe.each(["chill", "wild"] as const)("when a %s race is run twice", (d) => {
    it("should end in the identical snapshot", () => {
      const wobbly: LevelData = { ...pond(spinner), hazards: [spinner, { ...bumper, x: 18 }] };
      const once = () => {
        const sim = createSim(wobbly, [FULL], { difficulty: d });
        for (let t = 0; t < COUNTDOWN_TICKS + 4 * TICK_RATE; t++) step(sim, rearFart);
        const snap = viewOf(snapshot(sim), 0);
        sim.world.free();
        return snap;
      };
      expect(once()).toEqual(once());
    });
  });

  describe("when a rider walks the ring for half a second", () => {
    it("should go at WALK_SPEED in wild and faster in chill, fastest alone", () => {
      expect(walkSpeed("wild", 1)).toBe(WALK_SPEED);
      expect(walkSpeed("wild", 4)).toBe(WALK_SPEED);
      expect(walkSpeed("chill", 4)).toBeGreaterThan(WALK_SPEED);
      expect(walkSpeed("chill", 1)).toBeGreaterThan(walkSpeed("chill", 4));
      expect(walked("chill", 1)).toBeGreaterThan(1.5 * walked("wild", 1));
    });
  });

  describe("when a chill crew wipes out", () => {
    it("should respawn sooner and stay safe longer than a wild one", () => {
      const sim = createSim(pond(bar), [FULL]);
      let hit = false;
      for (let t = 0; t < COUNTDOWN_TICKS + 15 * TICK_RATE && !hit; t++)
        hit = step(sim, rearFart).some((e) => e.type === "hit");
      expect(hit).toBe(true);
      const { respawnTicks, invulnerableTicks } = DIFFICULTY.chill;
      expect(respawnTicks).toBeLessThan(RESPAWN_TICKS);
      expect(invulnerableTicks).toBeGreaterThan(INVULNERABLE_TICKS);
      expect(viewOf(snapshot(sim), 0).respawnIn).toBe(respawnTicks);
      for (let t = 0; t < respawnTicks; t++) step(sim, idle);
      expect(viewOf(snapshot(sim), 0).invulnerable).toBe(invulnerableTicks);
      // Farting straight back into the bar through the whole grace window never wipes it out.
      const events: SimEvent[] = [];
      for (let t = 0; t < invulnerableTicks - 1; t++) events.push(...step(sim, rearFart));
      expect(events.filter((e) => e.type === "hit")).toHaveLength(0);
      sim.world.free();
    });
  });
});
