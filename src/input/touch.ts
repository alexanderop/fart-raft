import type { SeatInput, Vec2 } from "../sim/types.ts";
import { applyDeadzone } from "./gamepad.ts";
import { cameraRelative, type InputSource } from "./sources.ts";

/** How far (CSS px) the thumb travels from where it landed to push the stick all the way. */
export const STICK_RADIUS = 56;
export const STICK_DEADZONE = 0.15;

/**
 * Thumb offset from where it landed (screen px, y down) to a stick in the unit circle: clamped
 * at `radius`, with the same rescaled radial deadzone as a gamepad stick.
 */
export function stickVector(
  dx: number,
  dy: number,
  radius = STICK_RADIUS,
  deadzone = STICK_DEADZONE,
): Vec2 {
  return applyDeadzone(dx / radius, dy / radius, deadzone);
}

/** Where the knob is drawn: the thumb offset, clamped to the ring. */
export function knobOffset(dx: number, dy: number, radius = STICK_RADIUS): Vec2 {
  const len = Math.hypot(dx, dy);
  if (len <= radius) return { x: dx, y: dy };
  return { x: (dx / len) * radius, y: (dy / len) * radius };
}

/** Like the pad stick: thumb up (screen y −1) walks away from the camera. */
export function touchInput(stick: Vec2, fart: boolean, heading: number): SeatInput {
  return { move: cameraRelative(-stick.y, -stick.x, heading), fart };
}

/** What the on-screen controls hold right now. One set per page, like the keyboard's held keys. */
const held: { stick: Vec2; fart: boolean } = { stick: { x: 0, y: 0 }, fart: false };

/** The on-screen stick and FART button as a seat's input. Read once per sim tick. */
export function touchSource(heading: () => number): InputSource {
  return { read: () => touchInput(held.stick, held.fart, heading()) };
}

export type TouchControlsOptions = {
  /** The ↻ button (same as R). */
  onRestart?: () => void;
  /** The ☰ button (same as Esc). */
  onMenu?: () => void;
};

export type TouchControls = { source: InputSource; dispose(): void };

const COARSE = "(pointer: coarse)";

/** No long-press menu on the controls. */
const noMenu = (e: Event) => e.preventDefault();

/**
 * Floating stick on the left half (appears where the thumb lands), a FART button bottom-right
 * that farts while held, and restart / menu buttons. Pointer Events, so the stick and the button
 * work at the same time. Shown on touch screens, or after the first touch anywhere.
 */
export function createTouchControls(
  host: HTMLElement,
  heading: () => number,
  opts: TouchControlsOptions = {},
): TouchControls {
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="touch" data-touch hidden>
      <div class="touch-stick-zone" data-zone>
        <div class="touch-stick" data-stick><i class="touch-knob" data-knob></i></div>
      </div>
      <button type="button" class="touch-fart" data-fart aria-label="Fart">FART</button>
      <div class="touch-top">
        ${opts.onMenu ? `<button type="button" class="touch-btn" data-menu aria-label="Menu">☰</button>` : ""}
        ${opts.onRestart ? `<button type="button" class="touch-btn" data-restart aria-label="Restart">↻</button>` : ""}
      </div>
    </div>`,
  );
  const root = [...host.querySelectorAll<HTMLElement>("[data-touch]")].at(-1)!;
  const zone = root.querySelector<HTMLElement>("[data-zone]")!;
  const stick = root.querySelector<HTMLElement>("[data-stick]")!;
  const knob = root.querySelector<HTMLElement>("[data-knob]")!;
  const fart = root.querySelector<HTMLElement>("[data-fart]")!;
  const menu = root.querySelector<HTMLElement>("[data-menu]");
  const restart = root.querySelector<HTMLElement>("[data-restart]");

  const coarse = matchMedia(COARSE);
  const show = () => {
    root.hidden = false;
    document.documentElement.classList.add("touch-on");
  };
  const onCoarse = () => coarse.matches && show();
  onCoarse();
  coarse.addEventListener("change", onCoarse);
  const onFirstTouch = (e: PointerEvent) => e.pointerType === "touch" && show();
  addEventListener("pointerdown", onFirstTouch, true);

  let stickId: number | undefined;
  let originX = 0;
  let originY = 0;
  const fartIds = new Set<number>();

  const moveStick = (x: number, y: number) => {
    const dx = x - originX;
    const dy = y - originY;
    held.stick = stickVector(dx, dy);
    const k = knobOffset(dx, dy);
    knob.style.translate = `${k.x.toFixed(1)}px ${k.y.toFixed(1)}px`;
  };
  const releaseStick = () => {
    stickId = undefined;
    held.stick = { x: 0, y: 0 };
    knob.style.translate = "";
    stick.classList.remove("on");
  };
  const syncFart = () => {
    held.fart = fartIds.size > 0;
    fart.classList.toggle("on", held.fart);
  };
  const releaseAll = () => {
    releaseStick();
    fartIds.clear();
    syncFart();
  };

  zone.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (stickId !== undefined) return;
    stickId = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    const box = zone.getBoundingClientRect();
    originX = e.clientX;
    originY = e.clientY;
    stick.style.left = `${originX - box.left}px`;
    stick.style.top = `${originY - box.top}px`;
    stick.classList.add("on");
    moveStick(e.clientX, e.clientY);
  });
  zone.addEventListener("pointermove", (e) => {
    if (e.pointerId === stickId) moveStick(e.clientX, e.clientY);
  });
  const endStick = (e: PointerEvent) => e.pointerId === stickId && releaseStick();
  zone.addEventListener("pointerup", endStick);
  zone.addEventListener("pointercancel", endStick);
  zone.addEventListener("lostpointercapture", endStick);

  fart.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    fart.setPointerCapture(e.pointerId);
    fartIds.add(e.pointerId);
    syncFart();
  });
  const endFart = (e: PointerEvent) => {
    if (fartIds.delete(e.pointerId)) syncFart();
  };
  fart.addEventListener("pointerup", endFart);
  fart.addEventListener("pointercancel", endFart);
  fart.addEventListener("lostpointercapture", endFart);

  // Taps, not clicks: a click waits for the pointer to come up on the same element.
  menu?.addEventListener("click", () => opts.onMenu?.());
  restart?.addEventListener("click", () => opts.onRestart?.());

  root.addEventListener("contextmenu", noMenu);
  const onHidden = () => document.hidden && releaseAll();
  document.addEventListener("visibilitychange", onHidden);
  addEventListener("blur", releaseAll);

  return {
    source: touchSource(heading),
    dispose() {
      releaseAll();
      coarse.removeEventListener("change", onCoarse);
      removeEventListener("pointerdown", onFirstTouch, true);
      document.removeEventListener("visibilitychange", onHidden);
      removeEventListener("blur", releaseAll);
      document.documentElement.classList.remove("touch-on");
      root.remove();
    },
  };
}
