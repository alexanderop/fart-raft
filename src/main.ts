import "./style.css";
import canyon from "../courses/canyon.json";
import { startLoop } from "./client/loop";
import { createCameraShake } from "./client/fx/cameraShake";
import { createConfetti } from "./client/fx/confetti";
import { createParticles } from "./client/fx/particles";
import { createWake } from "./client/fx/wake";
import { lerpPose } from "./client/render/coords";
import { gateLayout } from "./client/render/gates";
import { createScene } from "./client/render/scene";
import { createHud, progressTrack } from "./client/ui/hud";
import {
  configFromUrl,
  configToSearch,
  CONTROLS,
  crewSize,
  showMenu,
  type GameConfig,
} from "./client/ui/menu";
import { botSource } from "./input/bot";
import { keyboardSource, listenKeyboard, PLAYER_KEYS, WASD_OR_ARROWS } from "./input/keyboard";
import { createSeats, readSeats, type InputSource } from "./input/sources";
import { crewSeats, STEP, type Seat } from "./sim/constants";
import { createSim, initPhysics, snapshot, step } from "./sim/sim";
import type { LevelData, SimEvent, Snapshot } from "./sim/types";
import { parseLevel } from "./sim/level";

const level = parseLevel(canyon);
const app = document.querySelector<HTMLElement>("#app")!;

const [, config] = await Promise.all([
  initPhysics(),
  configFromUrl(location.search) ?? showMenu(app),
]);
history.replaceState(null, "", configToSearch(config));

const crew = crewSeats(crewSize(config));

/**
 * Fill seats from the menu choice. Humans take the first seats, bots the rest. Each one is
 * just an InputSource, so a networked player later is one more `seats[i] = …` line.
 */
function fillSeats(
  cfg: GameConfig,
  seats: readonly Seat[],
  observe: () => Snapshot,
  lvl: LevelData,
): InputSource[] {
  const sources = createSeats(seats.length);
  for (let i = 0; i < seats.length; i++) {
    sources[i] =
      i >= cfg.humans
        ? botSource(i, seats, lvl, observe)
        : keyboardSource(cfg.humans === 1 ? WASD_OR_ARROWS : PLAYER_KEYS[i]!, STEP);
  }
  return sources;
}

const seatLabels = crew.map((_, i) =>
  i >= config.humans ? "Bot" : config.humans === 1 ? "You" : `P${i + 1} · ${CONTROLS[i]}`,
);

let sim = createSim(level, crew);
let prev = snapshot(sim);
let curr = prev;
let pending: SimEvent[] = [];
// Bots read the latest snapshot, the same data a server would broadcast.
let seats = fillSeats(config, crew, () => curr, level);
listenKeyboard(window);

addEventListener("keydown", (e) => {
  if (e.code === "Escape") {
    location.href = location.pathname; // back to the menu
    return;
  }
  if (e.code !== "KeyR") return;
  sim.world.free();
  sim = createSim(level, crew);
  prev = curr = snapshot(sim);
  seats = fillSeats(config, crew, () => curr, level);
});

const view = await createScene(app, level, crew);
const particles = createParticles(view.scene);
const wake = createWake(view.scene);
const confetti = createConfetti(view.scene);
const shake = createCameraShake();
const hud = createHud(app, {
  seatLabels,
  seats: crew,
  camera: view.camera,
  progress: progressTrack(level),
});

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
    hud.draw(curr, lerpPose(prev.raft, curr.raft, alpha));
  },
);
