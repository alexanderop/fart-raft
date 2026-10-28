import * as THREE from "three";
import { MAX_CREW, TICK_RATE } from "../../sim/constants.ts";
import type { LevelData, Pose, SimEvent, Snapshot } from "../../sim/types.ts";
import { clamp, damp, spring, stepSpring, wrapAngle, type Spring } from "./spring.ts";
import { SEAT_COLORS } from "./zones.ts";

/**
 * Drives the kit's rider rigs (body → head, arm_l, arm_r) from SimEvents + Snapshots only.
 * Never touches input, so it works the same for local and networked seats.
 */
export type RiderAnimator = {
  onEvent(e: SimEvent, now: number): void;
  update(dt: number, now: number, prev: Snapshot, curr: Snapshot, alpha: number, pose: Pose): void;
  reset(): void;
};

const FART_WINDOW = 0.1; // a seat counts as farting this long after its last fart event
/** Riders wade outside the ring: lean in over it and reach forward onto it. */
const LEAN_IN = 0.18;
const REACH = 1.25;
const WADDLE_RATE = 13; // steps per second-ish while walking
/** A hit sends the riders reeling: arms flail and bodies sway for this long (s), fading out. */
const STAGGER_TIME = 1.6;

type Rest = { pos: THREE.Vector3; rotY: number };

type Rider = {
  body: THREE.Object3D;
  head: THREE.Object3D | undefined;
  armL: THREE.Object3D | undefined;
  armR: THREE.Object3D | undefined;
  rest: Rest;
  phase: number;
  lastFart: number;
  /** Exhaust direction in the raft's local sim frame. */
  exhaust: number;
  /** 0..1, smoothed: how much the rider is walking right now. */
  walk: number;
  lastX: number;
  lastY: number;
  wasFarting: boolean;
  yaw: Spring;
  hop: Spring;
  squash: Spring;
  bumpX: Spring;
  bumpZ: Spring;
  wobble: Spring;
  cheerAt: number;
  hopAt: number;
  /** When the last hit staggered this rider. */
  staggerAt: number;
  slump: number;
  puff: number;
  lean: number;
  lookYaw: Spring;
  lookPitch: Spring;
  lookTarget: { yaw: number; pitch: number };
  nextLook: number;
  blinkAt: number;
  nextBlink: number;
};

/**
 * A copy of `m` with its color turned to `hue`, saturated enough to read (a dusty purple hippo
 * would otherwise come out grey). Eyes, teeth and trim are grey and stay so.
 */
function tinted(m: THREE.Material, hue: number): THREE.Material {
  const c = m.clone();
  if ("color" in c && c.color instanceof THREE.Color) {
    const hsl = c.color.getHSL({ h: 0, s: 0, l: 0 });
    if (hsl.s > 0.15) c.color.setHSL(hue, Math.max(hsl.s, 0.65), hsl.l);
  }
  return c;
}

/**
 * One rider rig per seat, in seat order. The kit ships four animals; seats beyond them ride a
 * copy of animal `i % kit`, renamed (rider_i, rider_i_head, …) and with its colored materials
 * turned to the seat's hue, so an eight-crew shows eight distinct riders.
 */
function riderBodies(raft: THREE.Object3D): THREE.Object3D[] {
  const bodies: THREE.Object3D[] = [];
  for (let body = raft.getObjectByName("rider_0"); body;) {
    bodies.push(body);
    body = raft.getObjectByName(`rider_${bodies.length}`);
  }
  const kit = bodies.length;
  if (kit === 0) return bodies;
  for (let i = kit; i < MAX_CREW; i++) {
    const from = bodies[i % kit]!;
    const copy = from.clone(true);
    const hue = new THREE.Color(SEAT_COLORS[i]).getHSL({ h: 0, s: 0, l: 0 }).h;
    copy.traverse((o) => {
      o.name = o.name.replace(`rider_${i % kit}`, `rider_${i}`);
      if (!(o instanceof THREE.Mesh)) return;
      o.material = Array.isArray(o.material)
        ? o.material.map((m: THREE.Material) => tinted(m, hue))
        : tinted(o.material, hue);
    });
    from.parent!.add(copy);
    bodies.push(copy);
  }
  return bodies;
}

/**
 * Rigs every kit rider; each frame shows one per rider in the snapshot and hides the rest, so the
 * crew size can change between races (online restarts).
 */
export function createRiderAnimator(raft: THREE.Object3D, level: LevelData): RiderAnimator {
  const riders: Rider[] = riderBodies(raft).map((body, i) => {
    return {
      body,
      head: body.getObjectByName(`rider_${i}_head`),
      armL: body.getObjectByName(`rider_${i}_arm_l`),
      armR: body.getObjectByName(`rider_${i}_arm_r`),
      rest: { pos: body.position.clone(), rotY: body.rotation.y },
      phase: i * 1.7 + 0.4,
      lastFart: -10,
      exhaust: Math.PI,
      walk: 0,
      lastX: 0,
      lastY: 0,
      wasFarting: false,
      yaw: spring(),
      hop: spring(),
      squash: spring(),
      bumpX: spring(),
      bumpZ: spring(),
      wobble: spring(),
      cheerAt: -10,
      hopAt: -10,
      staggerAt: -10,
      slump: 0,
      puff: 0,
      lean: 0,
      lookYaw: spring(),
      lookPitch: spring(),
      lookTarget: { yaw: 0, pitch: 0 },
      nextLook: 1 + Math.random() * 3,
      blinkAt: -10,
      nextBlink: 1 + Math.random() * 4,
    };
  });

  let lastCountdownSecond = -1;
  let lastTick = 0;
  let lastPose: Pose | null = null;

  function onEvent(e: SimEvent, now: number): void {
    switch (e.type) {
      case "fart": {
        const r = riders[e.seat];
        if (!r) return;
        if (now - r.lastFart > FART_WINDOW) r.squash.v += 9; // pulse on the first fart of a burst
        r.lastFart = now;
        break;
      }
      case "bump": {
        if (!lastPose) return;
        // Jolt opposite the hit: we only know where, so push away from the impact point.
        const dx = e.x - lastPose.x;
        const dy = e.y - lastPose.y;
        const local = Math.atan2(dy, dx) - lastPose.rot;
        const power = clamp(e.speed / 6, 0.3, 1.6);
        riders.forEach((r, i) => {
          r.bumpX.v += -Math.cos(local) * 14 * power;
          r.bumpZ.v += Math.sin(local) * 14 * power; // sim +y is three -z, so flip twice
          r.wobble.v += (i % 2 ? 1 : -1) * 18 * power;
          r.hop.v += 2.5 * power;
          r.squash.v += 6 * power;
        });
        break;
      }
      case "hit": {
        if (!lastPose) return;
        // Thrown along (dirX, dirY): the riders lurch the other way, toward the hazard, and flail.
        const local = Math.atan2(e.dirY, e.dirX) - lastPose.rot;
        riders.forEach((r, i) => {
          r.bumpX.v += -Math.cos(local) * 30;
          r.bumpZ.v += Math.sin(local) * 30;
          r.wobble.v += (i % 2 ? 1 : -1) * 45;
          r.hop.v += 4;
          r.squash.v += 9;
          r.staggerAt = now + i * 0.04;
        });
        break;
      }
      case "go":
        riders.forEach((r, i) => {
          r.hopAt = now + i * 0.04;
        });
        break;
      case "checkpoint":
        riders.forEach((r, i) => {
          r.cheerAt = now + i * 0.09;
        });
        break;
      case "finished":
        riders.forEach((r, i) => {
          r.cheerAt = now + i * 0.07;
        });
        break;
    }
  }

  function reset(): void {
    lastCountdownSecond = -1;
    for (const r of riders) {
      for (const s of [r.yaw, r.hop, r.squash, r.bumpX, r.bumpZ, r.wobble]) s.x = s.v = 0;
      r.cheerAt = r.hopAt = r.lastFart = r.staggerAt = -10;
      r.slump = 0;
    }
  }

  function update(
    dt: number,
    now: number,
    prev: Snapshot,
    curr: Snapshot,
    alpha: number,
    pose: Pose,
  ): void {
    if (curr.tick < lastTick) reset();
    lastTick = curr.tick;
    lastPose = pose;

    const phase = curr.phase;
    const finished = phase.kind === "finished";

    // Countdown: bounce on each new second.
    if (phase.kind === "countdown") {
      const sec = Math.ceil(phase.ticksLeft / TICK_RATE);
      if (sec !== lastCountdownSecond) {
        lastCountdownSecond = sec;
        for (const r of riders) {
          r.hop.v += 3.2;
          r.squash.v += 5;
        }
      }
    }

    const nextIdx = phase.kind === "racing" ? phase.nextCheckpoint : 0;
    const gate = level.checkpoints[nextIdx];
    const gateDist = gate ? Math.hypot(gate.x - pose.x, gate.y - pose.y) : Infinity;

    riders.forEach((r, i) => {
      const { body } = r;
      const to = curr.riders[i];
      body.visible = to !== undefined;
      if (!to) return;
      const t = now + r.phase;
      const from = prev.riders[i] ?? to;
      const x = from.x + (to.x - from.x) * alpha;
      const y = from.y + (to.y - from.y) * alpha;
      const step = Math.hypot(x - r.lastX, y - r.lastY);
      r.lastX = x;
      r.lastY = y;
      r.walk += ((dt > 0 && step / dt > 0.3 ? 1 : 0) - r.walk) * damp(10, dt);
      const waddle = Math.sin(now * WADDLE_RATE + r.phase) * r.walk;
      const farting = now - r.lastFart < FART_WINDOW;
      const gas = curr.gas[i] ?? 100;
      const slumpTarget = gas < 12 ? 1 : 0;

      if (farting && !r.wasFarting) r.hop.v += 1.2;
      r.wasFarting = farting;

      r.slump += (slumpTarget - r.slump) * damp(4, dt);
      r.puff += ((farting ? 1 : 0) - r.puff) * damp(farting ? 25 : 8, dt);
      r.lean += ((farting ? 1 : 0) - r.lean) * damp(12, dt);

      // Face where the sim says; the butt (and the exhaust) points the other way.
      r.exhaust = to.face + Math.PI;
      stepSpring(r.yaw, r.yaw.x + wrapAngle(to.face - r.yaw.x), 160, 16, dt);

      // Cheer envelope: both arms up, jumping, then settle (loops softly after the finish).
      const cheerT = now - r.cheerAt;
      const cheering = cheerT > 0 && (finished || cheerT < 1.4);
      const cheer = cheering ? (finished ? 1 : Math.min(1, (1.4 - cheerT) * 2.5, cheerT * 12)) : 0;
      const cheerHop = cheering
        ? Math.abs(Math.sin(cheerT * (finished ? 5 : 8))) * (finished ? 0.4 : 0.55)
        : 0;

      const staggerT = now - r.staggerAt;
      const stagger = staggerT >= 0 ? Math.max(0, 1 - staggerT / STAGGER_TIME) ** 1.5 : 0;
      const reel = stagger * Math.sin(now * 15 + r.phase * 2);

      const hopT = now - r.hopAt;
      if (hopT >= 0 && hopT < dt + 1e-3 + 0.02) {
        r.hop.v += 5;
        r.squash.v += 8;
        r.hopAt = -10;
      }

      stepSpring(r.hop, 0, 220, 14, dt);
      stepSpring(r.squash, 0, 260, 11, dt);
      stepSpring(r.bumpX, 0, 120, 7, dt);
      stepSpring(r.bumpZ, 0, 120, 7, dt);
      stepSpring(r.wobble, 0, 140, 6, dt);

      // Hop only goes up off the seat.
      const lift = Math.max(0, r.hop.x) * 0.5 + cheerHop + Math.abs(waddle) * 0.12;
      const breathRate = 2.2 + r.slump * 3.5;
      const breath = Math.sin(t * breathRate) * (0.022 + r.slump * 0.02);
      const jitter = r.puff * Math.sin(now * 85 + r.phase * 9);
      const sq = r.squash.x * 0.05 + r.puff * 0.1 + r.slump * 0.1;

      // Shuffle toward the push side while farting (push = −exhaust).
      const shuffle = r.puff * 0.07;
      body.position.set(
        x - Math.cos(r.exhaust) * shuffle + r.bumpX.x * 0.015,
        r.rest.pos.y + lift - r.slump * 0.05,
        -y + Math.sin(r.exhaust) * shuffle + r.bumpZ.x * 0.015 + jitter * 0.015,
      );
      body.rotation.set(
        Math.sin(t * 0.9) * 0.045 + r.wobble.x * 0.012 + jitter * 0.05 + waddle * 0.14 + reel * 0.4,
        r.rest.rotY + r.yaw.x,
        -LEAN_IN -
          r.lean * 0.16 -
          r.slump * 0.22 -
          stagger * 0.3 +
          Math.sin(t * 0.7 + 1) * 0.025 +
          r.hop.x * 0.02 +
          reel * 0.12,
        "YXZ",
      );
      const stretch = Math.max(0, r.hop.x) * 0.06;
      const sy = 1 - sq + breath + stretch + cheerHop * 0.05;
      const sxz = 1 + sq * 0.7 - breath * 0.5 - stretch * 0.4 + r.puff * 0.04;
      body.scale.set(sxz, sy, sxz);

      // Head: look around, glance at the next gate, blink, tilt back when cheering.
      if (r.head) {
        if (now > r.nextLook) {
          r.nextLook = now + 1.5 + Math.random() * 3.5;
          r.lookTarget = { yaw: (Math.random() - 0.5) * 1.1, pitch: (Math.random() - 0.4) * 0.3 };
        }
        let lookYaw = r.lookTarget.yaw;
        let lookPitch = r.lookTarget.pitch;
        if (gate && gateDist < 30 && !farting) {
          const toGate = wrapAngle(
            Math.atan2(gate.y - pose.y, gate.x - pose.x) - pose.rot - r.yaw.x,
          );
          lookYaw = clamp(toGate, -0.9, 0.9);
          lookPitch = 0.05;
        }
        if (farting) {
          lookYaw = -r.yaw.x * 0.6; // keep eyes roughly forward while the body turns
          lookPitch = -0.15;
        }
        stepSpring(r.lookYaw, lookYaw, 90, 12, dt);
        stepSpring(r.lookPitch, lookPitch, 90, 12, dt);

        if (now > r.nextBlink) {
          r.blinkAt = now;
          r.nextBlink = now + 2 + Math.random() * 4;
        }
        const blinkT = (now - r.blinkAt) / 0.14;
        const blink = blinkT >= 0 && blinkT < 1 ? Math.sin(blinkT * Math.PI) * 0.18 : 0;

        r.head.rotation.set(
          r.wobble.x * 0.01 + reel * 0.5,
          r.lookYaw.x,
          r.lookPitch.x +
            cheer * 0.45 -
            r.slump * 0.35 +
            r.wobble.x * 0.015 +
            Math.sin(t * 2.2) * 0.02,
          "YXZ",
        );
        r.head.scale.set(1 + r.puff * 0.05, 1 - blink + r.puff * 0.06, 1 + r.puff * 0.05);
      }

      // Arms: down by default, flail while farting, both up when cheering, droop when slumped.
      const flail =
        r.puff * (0.7 + 0.5 * Math.sin(now * 28 + r.phase)) +
        Math.sin(t * 1.3) * 0.06 +
        stagger * (2.6 + 1.6 * Math.sin(now * 24 + r.phase));
      const wave = finished ? Math.sin(now * 9 + r.phase) * 0.35 : 0;
      const up = cheer * 2.7;
      const angL = Math.max(0, up + flail + wave + r.wobble.x * 0.01) - r.slump * 0.05;
      const angR = Math.max(0, up + flail * 0.9 - wave + r.wobble.x * 0.01) - r.slump * 0.05;
      // Left is mirrored from right: left arm raises with +x rotation, right with −x.
      // Hands rest on the ring in front, except while cheering.
      const reach = REACH * (1 - cheer) * (1 - 0.85 * stagger);
      if (r.armL) r.armL.rotation.set(angL * 0.4, 0, reach + cheer * 0.2, "XYZ");
      if (r.armR) r.armR.rotation.set(-angR * 0.4, 0, reach + cheer * 0.2, "XYZ");
    });
  }

  return { onEvent, update, reset };
}
