import { describe, expect, it } from "vite-plus/test";
import {
  clampLevel,
  DEFAULT_MASTER,
  DEFAULT_VOLUME,
  isSilent,
  masterLevel,
  parseVolume,
  serializeVolume,
  setLevel,
  speakerLevel,
  toggleMute,
} from "./volume.ts";

describe("given a stored volume", () => {
  describe("when nothing was stored yet", () => {
    it("should start at the default level, muted", () => {
      expect(parseVolume(null, null)).toEqual(DEFAULT_VOLUME);
      expect(DEFAULT_VOLUME.master).toBe(DEFAULT_MASTER);
      expect(DEFAULT_VOLUME.muted).toBe(true);
    });

    it("should keep a saved mute flag either way", () => {
      expect(parseVolume(null, "1").muted).toBe(true);
      expect(parseVolume(null, "0").muted).toBe(false);
    });
  });

  describe("when the stored value is junk or out of range", () => {
    it("should fall back or clamp to 0..1", () => {
      expect(parseVolume("not json", null)).toEqual(DEFAULT_VOLUME);
      expect(parseVolume('"loud"', null)).toEqual(DEFAULT_VOLUME);
      const v = parseVolume('{"master":7,"farts":-1,"effects":"0.3"}', null);
      expect(v).toMatchObject({ master: 1, farts: 0, effects: 0.3 });
    });

    it("should read a bare number as master", () => {
      expect(parseVolume("0.4", null).master).toBe(0.4);
    });
  });

  describe("when it is written and read back", () => {
    it("should round-trip", () => {
      const v = {
        ...DEFAULT_VOLUME,
        muted: false,
        master: 0.35,
        farts: 0.6,
        effects: 0.1,
        restore: 0.35,
      };
      expect(parseVolume(serializeVolume(v), "0")).toEqual(v);
    });
  });
});

describe("given a level", () => {
  it("should clamp, round to two decimals and reject junk", () => {
    expect(clampLevel(1.5, 0.8)).toBe(1);
    expect(clampLevel(-2, 0.8)).toBe(0);
    expect(clampLevel(0.333, 0.8)).toBe(0.33);
    expect(clampLevel(Number.NaN, 0.8)).toBe(0.8);
    expect(clampLevel(undefined, 0.5)).toBe(0.5);
  });
});

describe("given volume and mute", () => {
  describe("when master is dragged to 0", () => {
    it("should show as muted and silence the master", () => {
      const v = setLevel(DEFAULT_VOLUME, "master", 0);
      expect(isSilent(v)).toBe(true);
      expect(speakerLevel(v)).toBe("muted");
      expect(masterLevel(v)).toBe(0);
    });

    it("should bring the last audible level back on unmute", () => {
      const v = toggleMute(setLevel(setLevel(DEFAULT_VOLUME, "master", 0.3), "master", 0));
      expect(v).toMatchObject({ muted: false, master: 0.3 });
      expect(masterLevel(v)).toBe(0.3);
    });
  });

  describe("when muted with the slider up", () => {
    it("should keep the level and restore it on unmute", () => {
      const muted = toggleMute(setLevel(DEFAULT_VOLUME, "master", 0.6));
      expect(muted).toMatchObject({ muted: true, master: 0.6 });
      expect(masterLevel(muted)).toBe(0);
      expect(masterLevel(toggleMute(muted))).toBe(0.6);
    });

    it("should unmute when master is raised", () => {
      const muted = toggleMute(DEFAULT_VOLUME);
      expect(setLevel(muted, "master", 0.5).muted).toBe(false);
    });

    it("should stay muted when only farts or effects move", () => {
      const muted = toggleMute({ ...DEFAULT_VOLUME, muted: false });
      expect(setLevel(muted, "farts", 0.2)).toMatchObject({ muted: true, farts: 0.2 });
    });
  });

  describe("when the speaker icon is picked", () => {
    it("should read low under half and high from half up", () => {
      expect(speakerLevel(setLevel(DEFAULT_VOLUME, "master", 0.2))).toBe("low");
      expect(speakerLevel(setLevel(DEFAULT_VOLUME, "master", 0.5))).toBe("high");
    });
  });
});
