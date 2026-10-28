/**
 * Render settings per device class. Phones and tablets (coarse pointer) get a lower pixel ratio,
 * no MSAA, a smaller shadow map and fewer particles; desktop keeps the full look.
 */
export type Quality = {
  mobile: boolean;
  /** Cap on devicePixelRatio. */
  maxPixelRatio: number;
  /** Lowest pixel ratio the adaptive step may fall to. */
  minPixelRatio: number;
  antialias: boolean;
  shadowMapSize: number;
  /** Fart puff slots and the puff mesh's icosahedron detail. */
  puffCapacity: number;
  puffDetail: number;
};

const DESKTOP: Quality = {
  mobile: false,
  maxPixelRatio: 2,
  minPixelRatio: 1,
  antialias: true,
  shadowMapSize: 2048,
  puffCapacity: 900,
  puffDetail: 2,
};

const MOBILE: Quality = {
  mobile: true,
  maxPixelRatio: 1.5,
  minPixelRatio: 1,
  antialias: false,
  shadowMapSize: 1024,
  puffCapacity: 450,
  puffDetail: 1,
};

export function detectQuality(): Quality {
  return matchMedia("(pointer: coarse)").matches ? MOBILE : DESKTOP;
}

/** Average frame time (ms) that counts as struggling: below ~45 fps. */
const SLOW_FRAME_MS = 22;
/** How long frames must stay slow before stepping down. */
const SLOW_FOR_MS = 2000;
const STEP_DOWN = 0.25;
const MAX_STEPS = 2;
/** Gaps longer than this are a hidden tab or a breakpoint, not slow rendering. */
const IGNORE_GAP_MS = 250;

/**
 * Adaptive resolution: if frames average over SLOW_FRAME_MS for SLOW_FOR_MS, step the pixel ratio
 * down by STEP_DOWN, at most MAX_STEPS times and never below `min`. Returns the new ratio when
 * it changes. Pure, so it is testable without a GPU.
 */
export function createPixelRatioGovernor(start: number, min: number) {
  let ratio = start;
  let steps = 0;
  let windowMs = 0;
  let frames = 0;
  return {
    get ratio() {
      return ratio;
    },
    frame(dtMs: number): number | undefined {
      if (steps >= MAX_STEPS || ratio <= min) return undefined;
      if (dtMs > IGNORE_GAP_MS) return undefined;
      windowMs += dtMs;
      frames++;
      if (windowMs < SLOW_FOR_MS) return undefined;
      const avg = windowMs / frames;
      windowMs = 0;
      frames = 0;
      if (avg <= SLOW_FRAME_MS) return undefined;
      ratio = Math.max(min, ratio - STEP_DOWN);
      steps++;
      return ratio;
    },
  };
}
