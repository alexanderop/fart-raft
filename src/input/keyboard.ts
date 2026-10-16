import type { SeatInput } from "../sim/types";
import type { InputSource } from "./sources";

/** Each action fires on any of its keys. */
export type KeyBinding = {
  up: string[];
  down: string[];
  left: string[];
  right: string[];
  fart: string[];
};

export const WASD: KeyBinding = {
  up: ["KeyW"],
  down: ["KeyS"],
  left: ["KeyA"],
  right: ["KeyD"],
  fart: ["Space"],
};
export const ARROWS: KeyBinding = {
  up: ["ArrowUp"],
  down: ["ArrowDown"],
  left: ["ArrowLeft"],
  right: ["ArrowRight"],
  fart: ["Enter", "ShiftRight"],
};
export const IJKL: KeyBinding = {
  up: ["KeyI"],
  down: ["KeyK"],
  left: ["KeyJ"],
  right: ["KeyL"],
  fart: ["KeyU", "KeyO"],
};
export const NUMPAD: KeyBinding = {
  up: ["Numpad8"],
  down: ["Numpad5", "Numpad2"],
  left: ["Numpad4"],
  right: ["Numpad6"],
  fart: ["Numpad0", "NumpadEnter"],
};
/** Couch co-op bindings by player index (P1…P4) on one keyboard. */
export const PLAYER_KEYS = [WASD, ARROWS, IJKL, NUMPAD] as const;
/** Single player plays on either cluster. */
export const WASD_OR_ARROWS: KeyBinding = {
  up: [...WASD.up, ...ARROWS.up],
  down: [...WASD.down, ...ARROWS.down],
  left: [...WASD.left, ...ARROWS.left],
  right: [...WASD.right, ...ARROWS.right],
  fart: [...WASD.fart, ...ARROWS.fart],
};

const held = new Set<string>();
const anyHeld = (codes: readonly string[]) => codes.some((c) => held.has(c));

export function listenKeyboard(target: Window): void {
  target.addEventListener("keydown", (e) => {
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
    held.add(e.code);
  });
  target.addEventListener("keyup", (e) => held.delete(e.code));
  target.addEventListener("blur", () => held.clear());
}

/**
 * Keys walk the rider relative to the screen: up walks away from the camera. `heading` is the
 * camera's forward direction on the water (sim radians), so the sim still only sees a world
 * vector. Read once per sim tick.
 */
export function keyboardSource(keys: KeyBinding, heading: () => number): InputSource {
  return {
    read(): SeatInput {
      const fwd = (anyHeld(keys.up) ? 1 : 0) - (anyHeld(keys.down) ? 1 : 0);
      const left = (anyHeld(keys.left) ? 1 : 0) - (anyHeld(keys.right) ? 1 : 0);
      const len = Math.hypot(fwd, left) || 1;
      const h = heading();
      const c = Math.cos(h);
      const s = Math.sin(h);
      // Forward is (c, s), left is (-s, c).
      const move = { x: (fwd * c - left * s) / len, y: (fwd * s + left * c) / len };
      return { move, fart: anyHeld(keys.fart) };
    },
  };
}
