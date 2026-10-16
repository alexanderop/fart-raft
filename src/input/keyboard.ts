import type { SeatInput } from "../sim/types";
import type { InputSource } from "./sources";

/** Each action fires on any of its keys. */
export type KeyBinding = { thrust: string[]; left: string[]; right: string[] };

export const WASD: KeyBinding = { thrust: ["KeyW"], left: ["KeyA"], right: ["KeyD"] };
export const ARROWS: KeyBinding = {
  thrust: ["ArrowUp"],
  left: ["ArrowLeft"],
  right: ["ArrowRight"],
};
/** Single player plays on either cluster. */
export const WASD_OR_ARROWS: KeyBinding = {
  thrust: [...WASD.thrust, ...ARROWS.thrust],
  left: [...WASD.left, ...ARROWS.left],
  right: [...WASD.right, ...ARROWS.right],
};

const AIM_LIMIT = Math.PI / 3; // nozzle swings ±60° from straight back
const AIM_SPEED = 3; // radians per second

const held = new Set<string>();
const anyHeld = (codes: readonly string[]) => codes.some((c) => held.has(c));

export function listenKeyboard(target: Window): void {
  target.addEventListener("keydown", (e) => {
    if (e.code.startsWith("Arrow")) e.preventDefault();
    held.add(e.code);
  });
  target.addEventListener("keyup", (e) => held.delete(e.code));
  target.addEventListener("blur", () => held.clear());
}

/** Thrust key farts, left/right swing the nozzle. Read once per sim tick. */
export function keyboardSource(keys: KeyBinding, step: number): InputSource {
  let aim = 0;
  return {
    read(): SeatInput {
      const turn = (anyHeld(keys.left) ? 1 : 0) - (anyHeld(keys.right) ? 1 : 0);
      aim = Math.max(-AIM_LIMIT, Math.min(AIM_LIMIT, aim + turn * AIM_SPEED * step));
      return { thrust: anyHeld(keys.thrust), aim };
    },
  };
}
