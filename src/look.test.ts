import { describe, expect, it } from "vite-plus/test";
import {
  COSTUMES,
  defaultLook,
  GADGETS,
  HATS,
  LOOK_COLORS,
  lookBadge,
  OUTFITS,
  parseLook,
  randomLook,
} from "./look.ts";

describe("given a saved look", () => {
  describe("when it is garbled or from an older version", () => {
    it("should keep the valid fields and fall back to the seat's default for the rest", () => {
      const look = parseLook({ animal: "croc", color: 99, hat: "sombrero", outfit: "nurse" }, 2);
      expect(look).toEqual({ ...defaultLook(2), animal: "croc", outfit: "nurse" });
    });

    it("should give the seat default for anything that is not an object", () => {
      expect(parseLook("nurse", 1)).toEqual(defaultLook(1));
      expect(parseLook(null, 3)).toEqual(defaultLook(3));
    });
  });
});

describe("given the costume sets", () => {
  it("should only use hats, outfits and gadgets that exist", () => {
    for (const c of COSTUMES) {
      expect(HATS).toContain(c.hat);
      expect(OUTFITS).toContain(c.outfit);
      expect(GADGETS).toContain(c.gadget);
    }
  });
});

describe("given a random look", () => {
  it("should always be a valid look", () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 200; i++) {
      const look = randomLook(random);
      expect(parseLook(look)).toEqual(look);
      expect(look.color).toBeLessThan(LOOK_COLORS.length);
    }
  });
});

describe("given a look's badge", () => {
  it("should show what is worn, or the animal when nothing is", () => {
    expect(lookBadge({ ...defaultLook(0), hat: "police", gadget: "shades" })).toBe("👮😎");
    expect(lookBadge(defaultLook(3))).toBe("🐊");
  });
});
