import { IDLE_INPUT, type SeatInput, type Vec2 } from "../sim/types.ts";
import { cameraRelative, type InputSource } from "./sources.ts";

/** The slice of a `Gamepad` the game reads, so tests can pass plain objects. */
export type PadState = {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
};

/** Standard mapping button indices (https://w3c.github.io/gamepad/#remapping). */
export const BTN = {
  a: 0,
  x: 2,
  y: 3,
  rb: 5,
  rt: 7,
  select: 8,
  start: 9,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

const FART_BUTTONS = [BTN.a, BTN.rb, BTN.rt];
const TRIGGER_THRESHOLD = 0.5;

export const DEADZONE = 0.2;

/**
 * Radial deadzone with rescaling: inside the deadzone nothing, outside the length climbs from 0
 * to 1 (not jumping to `deadzone`), so small pushes give small speeds. Direction is kept.
 */
export function applyDeadzone(x: number, y: number, deadzone = DEADZONE): Vec2 {
  const len = Math.hypot(x, y);
  if (!(len > deadzone)) return { x: 0, y: 0 };
  const scaled = (Math.min(len, 1) - deadzone) / (1 - deadzone);
  return { x: (x / len) * scaled, y: (y / len) * scaled };
}

export function buttonDown(pad: PadState, index: number): boolean {
  const b = pad.buttons[index];
  return b !== undefined && (b.pressed || b.value > TRIGGER_THRESHOLD);
}

/** A / right bumper / right trigger. */
export const isFarting = (pad: PadState): boolean => FART_BUTTONS.some((i) => buttonDown(pad, i));

/**
 * One pad to one seat's input. Left stick (D-pad as a fallback) walks relative to the camera,
 * like the keyboard: stick up (axis y −1) walks away from the camera.
 */
export function padInput(pad: PadState, heading: number): SeatInput {
  const stick = applyDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
  let fwd = -stick.y;
  let left = -stick.x;
  if (fwd === 0 && left === 0) {
    fwd = (buttonDown(pad, BTN.up) ? 1 : 0) - (buttonDown(pad, BTN.down) ? 1 : 0);
    left = (buttonDown(pad, BTN.left) ? 1 : 0) - (buttonDown(pad, BTN.right) ? 1 : 0);
    const len = Math.hypot(fwd, left) || 1;
    fwd /= len;
    left /= len;
  }
  return { move: cameraRelative(fwd, left, heading), fart: isFarting(pad) };
}

export type MenuIntent = "left" | "right" | "up" | "down" | "confirm" | "toggle";

const NAV_STICK = 0.6;

/** What a pad asks of the menu right now (the menu fires on changes, not on every frame). */
export function menuIntent(pad: PadState): MenuIntent | undefined {
  if (buttonDown(pad, BTN.a) || buttonDown(pad, BTN.start)) return "confirm";
  if (buttonDown(pad, BTN.x) || buttonDown(pad, BTN.y)) return "toggle";
  if (buttonDown(pad, BTN.left)) return "left";
  if (buttonDown(pad, BTN.right)) return "right";
  if (buttonDown(pad, BTN.up)) return "up";
  if (buttonDown(pad, BTN.down)) return "down";
  const x = pad.axes[0] ?? 0;
  const y = pad.axes[1] ?? 0;
  if (Math.hypot(x, y) < NAV_STICK) return undefined;
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? "left" : "right";
  return y < 0 ? "up" : "down";
}

/** The rumble motor, as far as we use it. Chrome and Firefox expose it as `vibrationActuator`. */
type Actuator = {
  playEffect?(
    type: "dual-rumble",
    params: {
      startDelay?: number;
      duration?: number;
      weakMagnitude?: number;
      strongMagnitude?: number;
    },
  ): Promise<unknown>;
};

/** A browser `Gamepad`, narrowed to what we touch. */
export type PadDevice = PadState & {
  readonly index: number;
  readonly connected: boolean;
  readonly vibrationActuator?: Actuator | null;
};

export type Rumble = "fart" | "hit";

const RUMBLES = {
  fart: { duration: 70, weakMagnitude: 0.35, strongMagnitude: 0.1 },
  hit: { duration: 350, weakMagnitude: 1, strongMagnitude: 1 },
} as const;

/** Fart events repeat every tick while a seat farts: one puff of rumble per this many ms. */
const FART_RUMBLE_GAP_MS = 60;

export type Gamepads = {
  /** Snapshot every pad. Pads are not event-driven: call once per tick (or menu frame). */
  poll(): void;
  /** Indices of usable pads, oldest connection first. */
  connected(): readonly number[];
  state(index: number): PadState | undefined;
  /** Best-effort haptics. A hit is never cut short by fart rumble. */
  rumble(index: number, kind: Rumble, now?: number): void;
};

/** `read` is `navigator.getGamepads` (injected so tests need no browser). */
export function createGamepads(read: () => ArrayLike<PadDevice | null | undefined>): Gamepads {
  const devices = new Map<number, PadDevice>();
  let order: number[] = [];
  const quiet = new Map<number, { fartAt: number; hitUntil: number }>();

  return {
    poll() {
      devices.clear();
      const list = read();
      for (let i = 0; i < list.length; i++) {
        const pad = list[i];
        // Skip odd HID devices that Chrome reports as pads but have no stick.
        if (pad?.connected && pad.axes.length >= 2) devices.set(pad.index, pad);
      }
      order = order.filter((i) => devices.has(i));
      for (const i of [...devices.keys()].toSorted((a, b) => a - b)) {
        if (!order.includes(i)) order.push(i);
      }
    },
    connected: () => order,
    state: (index) => devices.get(index),
    rumble(index, kind, now = performance.now()) {
      const actuator = devices.get(index)?.vibrationActuator;
      if (!actuator?.playEffect) return;
      const mem = quiet.get(index) ?? { fartAt: -Infinity, hitUntil: -Infinity };
      quiet.set(index, mem);
      if (kind === "fart") {
        if (now < mem.hitUntil || now - mem.fartAt < FART_RUMBLE_GAP_MS) return;
        mem.fartAt = now;
      } else {
        mem.hitUntil = now + RUMBLES.hit.duration;
      }
      try {
        const played = actuator.playEffect("dual-rumble", { startDelay: 0, ...RUMBLES[kind] });
        Promise.resolve(played).catch(() => {});
      } catch {
        // Unsupported effect or a pad that vanished: haptics are a bonus.
      }
    },
  };
}

/** The shared pad registry for the page. */
export const gamepads: Gamepads = createGamepads(() => navigator.getGamepads?.() ?? []);

/** One seat's input from pad `index` (resolved on every read, so a pad can come and go). */
export function gamepadSource(
  pads: Pick<Gamepads, "state">,
  index: () => number | undefined,
  heading: () => number,
): InputSource {
  return {
    read(): SeatInput {
      const i = index();
      const pad = i === undefined ? undefined : pads.state(i);
      return pad ? padInput(pad, heading()) : IDLE_INPUT;
    },
  };
}
