/** Tiny damped spring, semi-implicit Euler. Sub-steps keep it stable at any frame rate. */
export type Spring = { x: number; v: number };

export const spring = (x = 0): Spring => ({ x, v: 0 });

export function stepSpring(s: Spring, target: number, k: number, c: number, dt: number): void {
  const n = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (k * (target - s.x) - c * s.v) * h;
    s.x += s.v * h;
  }
}

/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

export const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
