import { beforeAll, describe, expect, it } from "vite-plus/test";
import canyon from "../../courses/canyon.json";
import pond from "../../courses/pond.json";
import { nearestS, pointAt, sampleChannel } from "./channel";
import { COUNTDOWN_TICKS, crewSeats, SEATS, type Seat } from "./constants";
import { createSim, initPhysics, snapshot, step } from "./sim";
import { parseLevel } from "./level";
import { IDLE_INPUT, type SeatInput, type SimEvent } from "./types";

const level = parseLevel(pond);
const rearThrust: SeatInput[] = [
  { thrust: true, aim: 0 },
  { thrust: true, aim: 0 },
  IDLE_INPUT,
  IDLE_INPUT,
];

const wobble = (t: number): SeatInput[] =>
  Array.from({ length: SEATS.length }, (_, i) => ({
    thrust: (t + i * 7) % 40 < 25,
    aim: Math.sin(t / 30 + i) * 0.8,
  }));

function run(ticks: number, inputs: (tick: number) => SeatInput[], seats: readonly Seat[] = SEATS) {
  const sim = createSim(level, seats);
  const events: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) events.push(...step(sim, inputs(t)));
  return { sim, events, snap: snapshot(sim) };
}

beforeAll(() => initPhysics());

describe("given the pond course", () => {
  it("should hold the raft still during the countdown", () => {
    const { snap, events } = run(COUNTDOWN_TICKS - 1, () => rearThrust);
    expect(snap.raft.x).toBeCloseTo(level.spawn.x);
    expect(events.some((e) => e.type === "fart")).toBe(false);
  });

  describe("when both rear seats fart straight back", () => {
    it("should move the raft forward and drain gas", () => {
      const { snap, events } = run(COUNTDOWN_TICKS + 60, () => rearThrust);
      expect(events.some((e) => e.type === "go")).toBe(true);
      expect(snap.raft.x).toBeGreaterThan(level.spawn.x + 1);
      expect(Math.abs(snap.raft.rot)).toBeLessThan(0.01);
      expect(snap.gas[0]).toBeLessThan(snap.gas[2]!);
    });
  });

  describe("when only the rear-left seat farts", () => {
    it("should turn the raft clockwise", () => {
      const leftOnly = [rearThrust[0]!, IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
      const { snap } = run(COUNTDOWN_TICKS + 60, () => leftOnly);
      expect(snap.raft.rot).toBeLessThan(-0.05);
    });
  });

  describe("given a solo crew", () => {
    const SOLO_SEATS = crewSeats(1);
    describe("when the one rider farts straight back", () => {
      it("should move the raft forward without turning", () => {
        const { snap } = run(COUNTDOWN_TICKS + 60, () => [{ thrust: true, aim: 0 }], SOLO_SEATS);
        expect(snap.raft.x).toBeGreaterThan(level.spawn.x + 0.5);
        expect(Math.abs(snap.raft.rot)).toBeLessThan(0.01);
        expect(snap.gas).toHaveLength(1);
      });
    });

    describe("when the rider aims the nozzle left", () => {
      it("should turn the raft", () => {
        const { snap } = run(COUNTDOWN_TICKS + 60, () => [{ thrust: true, aim: 0.6 }], SOLO_SEATS);
        expect(Math.abs(snap.raft.rot)).toBeGreaterThan(0.05);
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
    const { snap } = run(600, () => rearThrust);
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

  describe("when the full crew farts straight ahead into the first bend", () => {
    it("should keep the raft inside the banks", () => {
      const allThrust = SEATS.map(() => ({ thrust: true, aim: 0 }));
      const sim = createSim(canyonLevel, SEATS);
      for (let t = 0; t < COUNTDOWN_TICKS + 8 * 60; t++) step(sim, allThrust);
      const { raft } = snapshot(sim);
      const route = sampleChannel(canyonLevel.channel!);
      const s = nearestS(route, raft);
      const center = pointAt(route, s);
      expect(Math.hypot(raft.x - center.x, raft.y - center.y)).toBeLessThan(6);
      expect(s).toBeGreaterThan(20);
    });
  });
});
