import "./style.css";
import { Vector3 } from "three";
import canyon from "../courses/canyon.json";
import graveyard from "../courses/graveyard.json";
import pond from "../courses/pond.json";
import { startLoop } from "./client/loop.ts";
import { createAudio } from "./client/fx/audio.ts";
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
import { inviteLink, showOnlineMenu, showRoom, showSpectating } from "./client/ui/lobby.ts";
import { configToSearch, defaultServerUrl, launchFromUrl, showMenu } from "./client/ui/menu.ts";
import { listenKeyboard } from "./input/keyboard.ts";
import { createTouchControls } from "./input/touch.ts";
import { STEP } from "./sim/constants.ts";
import { initPhysics } from "./sim/sim.ts";
import { parseLevel } from "./sim/level.ts";
import { isCourseName, type CourseName } from "./net/protocol.ts";
import type { LevelData } from "./sim/types.ts";

/** Local play picks a course with `?course=`; online, the room's creator picked it. */
const COURSES: Record<CourseName, unknown> = { canyon, graveyard, pond };
const app = document.querySelector<HTMLElement>("#app")!;
const physics = initPhysics();

/** The camera's forward direction on the water (sim radians): keys walk riders relative to it. */
let cameraHeading = 0;
const heading = () => cameraHeading;

const showLost = (reason: string) => showBanner(app, `${reason} · Esc for menu`, "error");

/** Menus until there is a game to play: its course, and how to start its session. */
async function choose(): Promise<{ level: LevelData; start: () => Promise<Session> }> {
  let launch = launchFromUrl(location.search);
  while (true) {
    launch ??= await showMenu(app);
    if (launch.kind === "local") {
      const param = new URLSearchParams(location.search).get("course") ?? "canyon";
      const course = isCourseName(param) ? param : "canyon";
      const level = parseLevel(COURSES[course]);
      const { config } = launch;
      const suffix = course === "canyon" ? "" : `&course=${course}`;
      history.replaceState(null, "", configToSearch(config) + suffix);
      return { level, start: () => localSession(level, config, heading, physics) };
    }
    const conn = await showOnlineMenu(app, launch.server, launch.room);
    if (!conn) {
      launch = undefined;
      history.replaceState(null, "", location.pathname);
      continue;
    }
    const invite = inviteLink(conn.code, launch.server, defaultServerUrl());
    history.replaceState(null, "", new URL(invite).search);
    const level = parseLevel(COURSES[conn.roster().course]);
    return {
      level,
      async start() {
        const hideRoom = showRoom(app, conn, invite);
        try {
          return await onlineSession(conn, heading, showLost);
        } finally {
          hideRoom();
          showSpectating(app, conn);
        }
      },
    };
  }
}

const game = await choose();
const level = game.level;
cameraHeading = level.spawn.rot;

addEventListener("keydown", (e) => {
  if (e.code === "Escape") location.href = location.pathname; // back to the menu
});

const session = await game.start();
createTouchControls(app, heading, {
  onRestart: () => session.restart(),
  onMenu: () => (location.href = location.pathname),
});
listenKeyboard(window);
addEventListener("keydown", (e) => {
  if (e.code === "KeyR") session.restart();
});

const view = await createScene(app, level);
const particles = createParticles(view.scene);
const wake = createWake(view.scene);
const confetti = createConfetti(view.scene);
const shake = createCameraShake();
const audio = createAudio();
addEventListener("keydown", (e) => {
  if (e.code === "KeyM" && !e.repeat) audio.toggleMute();
});
Object.assign(window, { __audio: audio });
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
      audio.onEvent(e);
      if (e.type === "checkpoint") celebrate(e.index);
      view.onEvent(e);
    }
    audio.update(curr, cameraHeading);
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
