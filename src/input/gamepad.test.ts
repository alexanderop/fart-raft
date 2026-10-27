import { describe, expect, it } from "vite-plus/test";
import {
  applyDeadzone,
  BTN,
  createGamepads,
  DEADZONE,
  menuIntent,
  padInput,
  type PadDevice,
  type PadState,
} from "./gamepad.ts";

const pad = (
  axes: number[] = [0, 0, 0, 0],
  pressed: number[] = [],
  values: Record<number, number> = {},
): PadState => ({
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({
    pressed: pressed.includes(i),
    value: values[i] ?? (pressed.includes(i) ? 1 : 0),
  })),
});

describe("given the stick deadzone", () => {
  describe("when the stick rests inside it", () => {
    it("should read as no movement", () => {
      expect(applyDeadzone(0.1, -0.1)).toEqual({ x: 0, y: 0 });
      expect(applyDeadzone(DEADZONE, 0)).toEqual({ x: 0, y: 0 });
    });
  });

  describe("when the stick is pushed just past it", () => {
    it("should start from zero instead of jumping to the deadzone", () => {
      const out = applyDeadzone(DEADZONE + 0.01, 0);
      expect(out.x).toBeGreaterThan(0);
      expect(out.x).toBeLessThan(0.05);
    });
  });

  describe("when the stick is at full tilt", () => {
    it("should reach length 1 in the same direction, even on a diagonal corner", () => {
      expect(applyDeadzone(1, 0)).toEqual({ x: 1, y: 0 });
      const corner = applyDeadzone(1, 1);
      expect(Math.hypot(corner.x, corner.y)).toBeCloseTo(1);
      expect(corner.x).toBeCloseTo(corner.y);
    });
  });
});

describe("given a pad and a camera heading", () => {
  describe("when the stick is pushed up and the camera looks along +x", () => {
    it("should walk forward, like the W key", () => {
      const { move } = padInput(pad([0, -1]), 0);
      expect(move.x).toBeCloseTo(1);
      expect(move.y).toBeCloseTo(0);
    });
  });

  describe("when the stick is pushed left", () => {
    it("should walk to the camera's left (+y at heading 0)", () => {
      const { move } = padInput(pad([-1, 0]), 0);
      expect(move.x).toBeCloseTo(0);
      expect(move.y).toBeCloseTo(1);
    });
  });

  describe("when the camera is turned a quarter", () => {
    it("should rotate the walk direction with it", () => {
      const { move } = padInput(pad([0, -1]), Math.PI / 2);
      expect(move.x).toBeCloseTo(0);
      expect(move.y).toBeCloseTo(1);
    });
  });

  describe("when only the D-pad is held", () => {
    it("should walk at full speed along it, normalised on diagonals", () => {
      const { move } = padInput(pad([0, 0], [BTN.up, BTN.left]), 0);
      expect(Math.hypot(move.x, move.y)).toBeCloseTo(1);
      expect(move.x).toBeGreaterThan(0);
      expect(move.y).toBeGreaterThan(0);
    });
  });

  describe("when nothing is touched", () => {
    it("should be idle", () => {
      expect(padInput(pad(), 0)).toEqual({ move: { x: 0, y: 0 }, fart: false });
    });
  });
});

describe("given the fart buttons", () => {
  describe.each([
    ["A", pad([0, 0], [BTN.a])],
    ["right bumper", pad([0, 0], [BTN.rb])],
    ["right trigger pressed", pad([0, 0], [BTN.rt])],
    ["right trigger pulled past half", pad([0, 0], [], { [BTN.rt]: 0.8 })],
  ])("when %s is down", (_name, state) => {
    it("should fart", () => {
      expect(padInput(state, 0).fart).toBe(true);
    });
  });

  describe("when a trigger is only barely touched, or another button is down", () => {
    it("should not fart", () => {
      expect(padInput(pad([0, 0], [], { [BTN.rt]: 0.2 }), 0).fart).toBe(false);
      expect(padInput(pad([0, 0], [BTN.y]), 0).fart).toBe(false);
    });
  });
});

describe("given the menu", () => {
  describe("when a pad presses buttons or tilts the stick", () => {
    it("should map to an intent", () => {
      expect(menuIntent(pad())).toBeUndefined();
      expect(menuIntent(pad([0, 0], [BTN.a]))).toBe("confirm");
      expect(menuIntent(pad([0, 0], [BTN.left]))).toBe("left");
      expect(menuIntent(pad([0, 0], [BTN.y]))).toBe("toggle");
      expect(menuIntent(pad([0.9, 0.1]))).toBe("right");
      expect(menuIntent(pad([0.1, 0.9]))).toBe("down");
      expect(menuIntent(pad([0.3, 0.3]))).toBeUndefined();
    });
  });
});

type Fake = PadDevice & { played: unknown[] };

const device = (index: number, extra: Partial<PadDevice> = {}): Fake => {
  const played: unknown[] = [];
  return {
    index,
    connected: true,
    ...pad(),
    vibrationActuator: {
      playEffect: (type, params) => {
        played.push({ type, ...params });
        return Promise.resolve("complete");
      },
    },
    played,
    ...extra,
  };
};

describe("given the gamepad registry", () => {
  describe("when pads appear and vanish between polls", () => {
    it("should list them in connection order, not index order", () => {
      let list: (PadDevice | null)[] = [null, device(1)];
      const pads = createGamepads(() => list);
      pads.poll();
      expect(pads.connected()).toEqual([1]);
      list = [device(0), device(1)];
      pads.poll();
      expect(pads.connected()).toEqual([1, 0]);
      list = [device(0), null];
      pads.poll();
      expect(pads.connected()).toEqual([0]);
    });

    it("should ignore devices without a stick and disconnected pads", () => {
      const list = [device(0, { axes: [] }), device(1, { connected: false }), device(2)];
      const pads = createGamepads(() => list);
      pads.poll();
      expect(pads.connected()).toEqual([2]);
    });
  });

  describe("when rumbling", () => {
    it("should throttle fart buzzes and let a hit override them", () => {
      const dev = device(0);
      const pads = createGamepads(() => [dev]);
      pads.poll();
      pads.rumble(0, "fart", 0);
      pads.rumble(0, "fart", 16);
      pads.rumble(0, "fart", 70);
      expect(dev.played).toHaveLength(2);
      pads.rumble(0, "hit", 100);
      pads.rumble(0, "fart", 200);
      expect(dev.played).toHaveLength(3);
      expect(dev.played[2]).toMatchObject({ type: "dual-rumble", strongMagnitude: 1 });
      pads.rumble(0, "fart", 500);
      expect(dev.played).toHaveLength(4);
    });

    it("should do nothing on pads without haptics", () => {
      const pads = createGamepads(() => [device(0, { vibrationActuator: null })]);
      pads.poll();
      expect(() => pads.rumble(0, "hit", 0)).not.toThrow();
    });

    it("should survive an actuator that throws", () => {
      const bad = device(0, {
        vibrationActuator: {
          playEffect: () => {
            throw new Error("gone");
          },
        },
      });
      const pads = createGamepads(() => [bad]);
      pads.poll();
      expect(() => pads.rumble(0, "hit", 0)).not.toThrow();
    });
  });
});
