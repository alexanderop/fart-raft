import "./style.css";
import { Vector3 } from "three";
import canyon from "../courses/canyon.json";
import { startLoop } from "./client/loop.ts";
import { createCameraShake } from "./client/fx/cameraShake.ts";
import { createConfetti } from "./client/fx/confetti.ts";
import { createParticles } from "./client/fx/particles.ts";
import { createWake } from "./client/fx/wake.ts";
import { lerpPose } from "./client/render/coords.ts";
import { gateLayout } from "./client/render/gates.ts";
import { createScene } from "./client/render/scene.ts";
import { localSession, onlineSession, type Session } from "./client/session.ts";
import { createHud, progressTrack } from "./client/ui/hud.ts";
import { showBanner } from "./client/ui/banner.ts";
import { launchFromUrl, launchToSearch, showMenu, type Launch } from "./client/ui/menu.ts";
import { listenKeyboard } from "./input/keyboard.ts";
import { STEP } from "./sim/constants.ts";
import { initPhysics } from "./sim/sim.ts";
import { parseLevel } from "./sim/level.ts";

const level = parseLevel(canyon);
const app = document.querySelector<HTMLElement>("#app")!;

const physics = initPhysics();
const launch = launchFromUrl(location.search) ?? (await showMenu(app));
history.replaceState(null, "", launchToSearch(launch));

/** The camera's forward direction on the water (sim radians): keys walk riders relative to it. */
let cameraHeading = level.spawn.rot;
const heading = () => cameraHeading;

async function startSession(choice: Launch): Promise<Session> {
  if (choice.kind === "local") return localSession(level, choice.config, heading, physics);
  const connecting = showBanner(app, "Connecting…", "info");
  try {
    return await onlineSession(choice.url, heading, (reason) =>
      showBanner(app, `${reason} · Esc for menu`, "error"),
    );
  } catch (error) {
    showBanner(
      app,
      `${error instanceof Error ? error.message : "Could not connect"} · Esc for menu`,
      "error",
    );
    throw error;
  } finally {
    connecting();
  }
}

addEventListener("keydown", (e) => {
  if (e.code === "Escape") location.href = location.pathname; // back to the menu
});

const session = await startSession(launch);
listenKeyboard(window);
addEventListener("keydown", (e) => {
  if (e.code === "KeyR") session.restart();
});

const view = await createScene(app, level, session.crew);
const particles = createParticles(view.scene);
const wake = createWake(view.scene);
const confetti = createConfetti(view.scene);
const shake = createCameraShake();
const hud = createHud(app, {
  seatLabels: session.seatLabels(),
  camera: view.camera,
  progress: progressTrack(level),
});

let lastFrame = performance.now();
const lookDir = new Vector3();

/** Confetti shoots from the sign of the gate that was just passed. */
function celebrate(index: number) {
  const cp = level.checkpoints[index];
  if (!cp) return;
  const gate = gateLayout(cp, index === level.checkpoints.length - 1);
  confetti.burst(cp.x, cp.y, gate.signY, gate.ax, gate.ay, gate.half, 110);
}

startLoop(
  STEP,
  () => session.tick(),
  (loopAlpha) => {
    // Fx run on real frame time (clamped), the sim itself stays on its fixed step.
    const now = performance.now();
    const dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    const { prev, curr, alpha, events } = session.frame(loopAlpha);
    for (const e of events) {
      particles.onEvent(e);
      shake.onEvent(e);
      hud.onEvent(e);
      wake.onEvent(e);
      if (e.type === "checkpoint") celebrate(e.index);
      view.onEvent(e);
    }
    hud.setLabels(session.seatLabels());
    particles.update(dt);
    wake.update(dt, lerpPose(prev.raft, curr.raft, alpha));
    confetti.update(dt);
    view.draw(prev, curr, alpha, shake.update(dt));
    view.camera.getWorldDirection(lookDir);
    cameraHeading = Math.atan2(-lookDir.z, lookDir.x);
    hud.draw(curr, lerpPose(prev.raft, curr.raft, alpha));
  },
);
