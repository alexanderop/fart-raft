import { describe, expect, it } from "vite-plus/test";
import { padInput } from "./gamepad.ts";
import { knobOffset, STICK_DEADZONE, STICK_RADIUS, stickVector, touchInput } from "./touch.ts";

describe("given the on-screen stick", () => {
  describe("when the thumb rests inside the dead zone", () => {
    it("should read as no movement", () => {
      const r = STICK_RADIUS * STICK_DEADZONE;
      expect(stickVector(r * 0.9, 0)).toEqual({ x: 0, y: 0 });
      expect(stickVector(0, 0)).toEqual({ x: 0, y: 0 });
    });
  });

  describe("when the thumb is dragged past the ring", () => {
    it("should clamp the stick to full length, keeping its direction", () => {
      const v = stickVector(STICK_RADIUS * 3, STICK_RADIUS * 3);
      expect(Math.hypot(v.x, v.y)).toBeCloseTo(1);
      expect(v.x).toBeCloseTo(v.y);
    });

    it("should keep the knob on the ring", () => {
      const k = knobOffset(STICK_RADIUS * 2, 0);
      expect(k).toEqual({ x: STICK_RADIUS, y: 0 });
      expect(knobOffset(10, -5)).toEqual({ x: 10, y: -5 });
    });
  });

  describe("when the thumb pushes up on screen", () => {
    it("should walk away from the camera, whatever way it faces", () => {
      const stick = stickVector(0, -STICK_RADIUS);
      expect(touchInput(stick, false, 0).move.x).toBeCloseTo(1);
      const turned = touchInput(stick, false, Math.PI / 2).move;
      expect(turned.x).toBeCloseTo(0);
      expect(turned.y).toBeCloseTo(1);
    });
  });

  describe("when the thumb pushes right on screen", () => {
    it("should walk to the camera's right (sim −y when facing +x)", () => {
      const move = touchInput(stickVector(STICK_RADIUS, 0), false, 0).move;
      expect(move.x).toBeCloseTo(0);
      expect(move.y).toBeCloseTo(-1);
    });

    it("should match a gamepad stick pushed the same way", () => {
      const stick = stickVector(30, -40);
      const pad = padInput({ axes: [stick.x, stick.y], buttons: [] }, 0.7);
      const touch = touchInput(stick, true, 0.7);
      // The pad applies its own deadzone on top, so compare directions.
      expect(Math.atan2(touch.move.y, touch.move.x)).toBeCloseTo(
        Math.atan2(pad.move.y, pad.move.x),
      );
      expect(touch.fart).toBe(true);
    });
  });
});
