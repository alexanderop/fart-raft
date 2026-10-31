import { describe, expect, it } from "vite-plus/test";
import { defaultLook } from "../look.ts";
import type { Roster } from "../net/protocol.ts";
import { rivalTag } from "./teams.ts";

const look = defaultLook(0);
const seat = (name: string, team: 0 | 1, away = false) => ({ name, look, team, away });
const rider = (name: string, s: number | null, raft: number) => ({ name, seat: s, look, raft });

/** Ann and Bo on Red (raft 0), Cy and Di on Blue (raft 1). */
const roster = (away: readonly string[]): Pick<Roster, "crew" | "seats"> => {
  const names = ["Ann", "Bo", "Cy", "Di"];
  return {
    seats: names.map((n, i) => seat(n, i < 2 ? 0 : 1, away.includes(n))),
    crew: names.map((n, i) => rider(n, i, i < 2 ? 0 : 1)),
  };
};

describe("given a team race's rival tag", () => {
  describe("when the rival crew is all connected", () => {
    it("should say Rival", () => {
      expect(rivalTag(roster([]), 1)).toBe("Rival");
    });
  });

  describe("when rival riders are away", () => {
    it("should count only that raft's away riders", () => {
      expect(rivalTag(roster(["Cy"]), 1)).toBe("Rival · 1 reconnecting…");
      expect(rivalTag(roster(["Ann", "Cy", "Di"]), 1)).toBe("Rival · 2 reconnecting…");
    });
  });

  describe("when a rival rider's player has left", () => {
    it("should not count the idle rider as reconnecting", () => {
      const r = roster([]);
      r.crew[2] = rider("Cy", null, 1);
      r.seats[2] = null;
      expect(rivalTag(r, 1)).toBe("Rival");
    });
  });
});
