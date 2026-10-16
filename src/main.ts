import "./style.css";
import pond from "../courses/pond.json";
import { startLoop } from "./client/loop";
import { createCameraShake } from "./client/fx/cameraShake";
import { createConfetti } from "./client/fx/confetti";
import { createParticles } from "./client/fx/particles";
import { createWake } from "./client/fx/wake";
import { lerpPose } from "./client/render/coords";
import { gateLayout } from "./client/render/gates";
import { createScene } from "./client/render/scene";
import { createHud } from "./client/ui/hud";
import { ARROWS, keyboardSource, listenKeyboard, WASD, WASD_OR_ARROWS } from "./input/keyboard";
import { createSeats, readSeats } from "./input/sources";
import { SEATS, SOLO_SEATS, STEP } from "./sim/constants";
import { createSim, initPhysics, snapshot, step } from "./sim/sim";
import type { SimEvent } from "./sim/types";
import { parseLevel } from "./sim/level";

await initPhysics();

const level = parseLevel(pond);
const app = document.querySelector<HTMLElement>("#app")!;

// Single player by default: one rider, WASD or Arrows. `?players=2` is couch co-op on one
// keyboard (WASD + Arrows on the two rear seats of the four-seat crew).
const coop = new URLSearchParams(location.search).get("players") === "2";
const crew = coop ? SEATS : SOLO_SEATS;
const seats = createSeats(crew.length);
if (coop) {
  seats[0] = keyboardSource(WASD, STEP);
  seats[1] = keyboardSource(ARROWS, STEP);
} else {
  seats[0] = keyboardSource(WASD_OR_ARROWS, STEP);
}
listenKeyboard(window);

let sim = createSim(level, crew);
let prev = snapshot(sim);
let curr = prev;
let pending: SimEvent[] = [];

addEventListener("keydown", (e) => {
  if (e.code !== "KeyR") return;
  sim.world.free();
  sim = createSim(level, crew);
  prev = curr = snapshot(sim);
});

const view = await createScene(app, level, crew);
const particles = createParticles(view.scene);
const wake = createWake(view.scene);
const confetti = createConfetti(view.scene);
const shake = createCameraShake();
const hud = createHud(app, coop ? ["WASD", "Arrows", "—", "—"] : ["Gas"]);

let lastFrame = performance.now();

/** Confetti shoots from the sign of the gate that was just passed. */
function celebrate(index: number) {
  const cp = level.checkpoints[index];
  if (!cp) return;
  const gate = gateLayout(cp, index === level.checkpoints.length - 1);
  confetti.burst(cp.x, cp.y, gate.signY, gate.ax, gate.ay, gate.half, 110);
}

startLoop(
  STEP,
  () => {
    prev = curr;
    pending.push(...step(sim, readSeats(seats)));
    curr = snapshot(sim);
  },
  (alpha) => {
    // Fx run on real frame time (clamped), the sim itself stays on its fixed step.
    const now = performance.now();
    const dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    for (const e of pending) {
      particles.onEvent(e);
      shake.onEvent(e);
      hud.onEvent(e);
      wake.onEvent(e);
      if (e.type === "checkpoint") celebrate(e.index);
      view.onEvent(e);
    }
    pending = [];
    particles.update(dt);
    wake.update(dt, lerpPose(prev.raft, curr.raft, alpha));
    confetti.update(dt);
    view.draw(prev, curr, alpha, shake.update(dt));
    hud.draw(curr);
  },
);
