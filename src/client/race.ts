import { Vector3 } from "three";
import type { LevelData, Pose, SimEvent } from "../sim/types.ts";
import type { Audio } from "./fx/audio.ts";
import { createCameraShake } from "./fx/cameraShake.ts";
import { createConfetti } from "./fx/confetti.ts";
import { createParticles } from "./fx/particles.ts";
import type { VolumeStore } from "./fx/volume.ts";
import { createWake } from "./fx/wake.ts";
import { lerpPose } from "./render/coords.ts";
import { gateLayout } from "./render/gates.ts";
import { createScene } from "./render/scene.ts";
import type { FrameView, Session } from "./session.ts";
import { createHud, progressTrack } from "./ui/hud.ts";
import { createVolumeButton } from "./ui/volume.ts";

/** One frame as the fx see it: the session's frame plus the interpolated raft pose. */
export type RaceFrame = FrameView & { raft: Pose };

/**
 * Anything that reacts to drained SimEvents and/or ticks on real frame time. The race feeds
 * every event to every sink in array order, then updates them in the same order.
 */
export type EventSink = {
  onEvent?(e: SimEvent): void;
  update?(dt: number, frame: RaceFrame): void;
};

export type Race = {
  /** Render one frame; `loopAlpha` is the fixed loop's interpolation factor. */
  frame(loopAlpha: number): void;
  /**
   * Frees the scene (WebGL context, GPU buffers, canvas), removes the HUD and volume button DOM
   * and the race's listeners, and suspends the shared audio. The session is not the race's: its
   * owner disposes it.
   */
  dispose(): void;
};

export type RaceOptions = {
  host: HTMLElement;
  level: LevelData;
  session: Session;
  volume: VolumeStore;
  /** One audio graph for the app's lifetime: the race resumes it and suspends it on dispose. */
  audio: Audio;
  /** Reads the camera heading last drawn; the race reports each new one through `setHeading`. */
  heading: () => number;
  setHeading: (heading: number) => void;
};

/** The race scene: renderer, fx, HUD and audio, drawn from the session once per frame. */
export async function createRace(opts: RaceOptions): Promise<Race> {
  const { host, level, session, volume, audio, heading, setHeading } = opts;
  const view = await createScene(host, level);
  const particles = createParticles(view.scene);
  const wake = createWake(view.scene);
  const confetti = createConfetti(view.scene);
  const shake = createCameraShake();
  audio.resume();
  const onKey = (e: KeyboardEvent) => {
    if (e.code === "KeyM" && !e.repeat) audio.toggleMute();
  };
  addEventListener("keydown", onKey);
  Object.assign(window, { __audio: audio });
  const hud = createHud(host, {
    seatLabels: session.seatLabels(),
    camera: view.camera,
    progress: progressTrack(level),
  });
  const volumeButton = createVolumeButton(host, volume);

  /** Confetti shoots from the sign of the gate that was just passed. */
  function celebrate(index: number) {
    const cp = level.checkpoints[index];
    if (!cp) return;
    const gate = gateLayout(cp, index === level.checkpoints.length - 1);
    confetti.burst(cp.x, cp.y, gate.signY, gate.ax, gate.ay, gate.half, 110);
  }

  // Order is the event order within a frame. Shake, HUD and view also draw, but their draws
  // depend on each other (shake offset → camera → name tags), so frame() calls those directly.
  const sinks: EventSink[] = [
    particles,
    { onEvent: (e) => shake.onEvent(e) },
    { onEvent: (e) => hud.onEvent(e) },
    { onEvent: (e) => wake.onEvent(e), update: (dt, f) => wake.update(dt, f.raft) },
    { onEvent: (e) => audio.onEvent(e), update: (_, f) => audio.update(f.curr, heading()) },
    {
      onEvent: (e) => e.type === "checkpoint" && celebrate(e.index),
      update: (dt) => confetti.update(dt),
    },
    { onEvent: (e) => view.onEvent(e) },
  ];

  let lastFrame = performance.now();
  const lookDir = new Vector3();

  return {
    frame(loopAlpha) {
      // Fx run on real frame time (clamped), the sim itself stays on its fixed step.
      const now = performance.now();
      const dt = Math.min((now - lastFrame) / 1000, 0.05);
      lastFrame = now;
      const { prev, curr, alpha, events } = session.frame(loopAlpha);
      const f: RaceFrame = {
        prev,
        curr,
        alpha,
        events,
        raft: lerpPose(prev.raft, curr.raft, alpha),
      };
      for (const e of events) for (const sink of sinks) sink.onEvent?.(e);
      hud.setLabels(session.seatLabels());
      for (const sink of sinks) sink.update?.(dt, f);
      view.draw(prev, curr, alpha, shake.update(dt));
      view.camera.getWorldDirection(lookDir);
      setHeading(Math.atan2(-lookDir.z, lookDir.x));
      hud.draw(curr, f.raft);
    },
    dispose() {
      removeEventListener("keydown", onKey);
      audio.suspend();
      volumeButton.dispose();
      hud.dispose();
      view.dispose();
    },
  };
}
