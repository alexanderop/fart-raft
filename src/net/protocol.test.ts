import { Schema } from "effect";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import pond from "../../courses/pond.json";
import { crewZones, MAX_CREW } from "../sim/constants.ts";
import { parseLevel } from "../sim/level.ts";
import { createSim, initPhysics, snapshot, step } from "../sim/sim.ts";
import type { SeatInput, SimEvent, Snapshot } from "../sim/types.ts";
import { ServerMsg, SimEvent as SimEventSchema, Snapshot as SnapshotSchema } from "./protocol.ts";

const overTheWire = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S["Type"]) =>
  Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value))));

describe("given a sim that has raced for four seconds", () => {
  const events: SimEvent[] = [];
  let snap: Snapshot;
  beforeAll(async () => {
    await initPhysics();
    const sim = createSim(parseLevel(pond), crewZones(MAX_CREW));
    const farting: SeatInput = { move: { x: 0.25, y: -0.5 }, fart: true };
    for (let t = 0; t < 240; t++) {
      events.push(...step(sim, [farting, farting, farting, farting]));
    }
    snap = snapshot(sim);
    sim.world.free();
  });

  describe("when its snapshot goes through JSON", () => {
    it("should decode to an equal snapshot", () => {
      expect(snap.tick).toBe(240);
      expect(snap.phase.kind).toBe("racing");
      expect(overTheWire(SnapshotSchema, snap)).toEqual(snap);
    });
  });

  describe("when its events go through JSON", () => {
    it("should keep the fart events intact", () => {
      expect(events.filter((e) => e.type === "fart").length).toBeGreaterThan(0);
      expect(events.map((e) => overTheWire(SimEventSchema, e))).toEqual(events);
    });
  });

  describe("when a frame goes through JSON", () => {
    it("should decode to the same frame", () => {
      const frame = {
        _tag: "Frame" as const,
        snapshot: snap,
        events,
      };
      expect(overTheWire(ServerMsg, frame)).toEqual(frame);
    });
  });
});

describe("given a snapshot with a bad field", () => {
  describe("when it is decoded", () => {
    it("should fail instead of passing it through", () => {
      expect(() => Schema.decodeUnknownSync(SnapshotSchema)({ tick: "1" })).toThrow();
    });
  });
});
