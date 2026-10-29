// Game Loop: fixed-step update, variable-rate render with interpolation (alpha).
const MAX_STEPS_PER_FRAME = 5;

/** Runs until the returned function is called. */

export function startLoop(
  stepSeconds: number,
  update: () => void,
  render: (alpha: number) => void,
): () => void {
  const stepMs = stepSeconds * 1000;
  let last = performance.now();
  let lag = 0;

  const frame = (now: number) => {
    lag += Math.min(now - last, 250); // clamp tab-return spikes
    last = now;

    let steps = 0;
    while (lag >= stepMs && steps < MAX_STEPS_PER_FRAME) {
      update();
      lag -= stepMs;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) lag = 0; // avoid the spiral of death

    render(lag / stepMs);
    handle = requestAnimationFrame(frame);
  };
  let handle = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(handle);
}
