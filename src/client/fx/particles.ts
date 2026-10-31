import * as THREE from "three";
import { MAX_CREW } from "../../sim/constants.ts";
import type { SimEvent } from "../../sim/types.ts";
import { applyPose } from "../render/coords.ts";
import { detectQuality } from "../render/quality.ts";

const BUBBLES = 24;
/** Jet speed (m/s) as a puff leaves a rider: with the drag and life below it carries ≈ 2 m. */
const SPEED = 8;
/** Seconds between two puffs of one seat's jet: enough to read as one short plume. */
const PUFF_EVERY = 0.04;
/** A puff swells to this many times its birth size by the end of its life, so a jet fans out. */
const SWELL = 1.6;
/** Opacity of a fresh puff; it fades to 0 over the last 60% of its life. */
const ALPHA = 0.85;
const TINTS = [0x8fe03a, 0xa4ea3c, 0xbdf04a, 0x7fd832, 0xc9f25c].map((c) => new THREE.Color(c));

type Puff = {
  age: number;
  life: number;
  x: number;
  y: number;
  h: number;
  vx: number;
  vy: number;
  rise: number;
  size: number;
  /** How much the puff swells over its life (0 = not at all). */
  swell: number;
  seed: number;
  tint: THREE.Color;
};

type Bubble = { age: number; x: number; y: number; size: number };

const blank = (): Puff => ({
  age: 1,
  life: 1,
  x: 0,
  y: 0,
  h: 0,
  vx: 0,
  vy: 0,
  rise: 0,
  size: 0,
  swell: 0,
  seed: 0,
  tint: TINTS[0]!,
});
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Overshoot easing: pops past 1 then settles. */
const easeOutBack = (t: number) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Fart jets, like Fart Together's lime puffs: while a seat farts it streams small translucent
 * puffs that pop in with overshoot, shoot out behind the rider (a short plume pointing away from
 * it), swell a little as they slow, wobble and fade out within half a second. Opacity is per
 * instance (`aAlpha`, patched into the material's shader). An InstancedMesh with a fixed
 * ring of slots: the oldest puff is overwritten when full. Only live puffs are drawn: they are
 * packed into the first instances each frame and `count` trimmed to them. Farts fire every sim
 * tick, so each seat is rate-limited. Now and then a bubble ring pops on the water.
 */
export function createParticles(scene: THREE.Scene) {
  const { puffCapacity: CAPACITY, puffDetail } = detectQuality();
  const mesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.5, puffDetail),
    // A little lime glow keeps the gas neon even on the shaded side.
    new THREE.MeshToonMaterial({
      color: 0xffffff,
      emissive: 0x4f9a12,
      emissiveIntensity: 0.55,
      transparent: true,
      depthWrite: false,
    }),
    CAPACITY,
  );
  const alpha = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
  alpha.setUsage(THREE.DynamicDrawUsage);
  mesh.geometry.setAttribute("aAlpha", alpha);
  mesh.material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float aAlpha; varying float vAlpha;",
      )
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvAlpha = aAlpha;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vAlpha;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= vAlpha;");
  };
  mesh.frustumCulled = false;
  for (let i = 0; i < CAPACITY; i++) mesh.setColorAt(i, TINTS[0]!);
  mesh.count = 0;
  scene.add(mesh);

  const ringMesh = new THREE.InstancedMesh(
    new THREE.TorusGeometry(0.5, 0.05, 6, 20).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xe9ffb8, transparent: true, opacity: 0.8 }),
    BUBBLES,
  );
  ringMesh.frustumCulled = false;
  scene.add(ringMesh);

  const puffs = Array.from({ length: CAPACITY }, blank);
  const bubbles: Bubble[] = Array.from({ length: BUBBLES }, () => ({
    age: 1,
    x: 0,
    y: 0,
    size: 0,
  }));
  let next = 0;
  let nextBubble = 0;
  /** Per rider, by `raft * MAX_CREW + seat`: rival rafts' riders puff on their own clocks. */
  const cooldown: number[] = [];
  const dummy = new THREE.Object3D();

  const spawn = (
    e: Extract<SimEvent, { type: "fart" }>,
    size: number,
    speed: number,
    back: number,
    swell: number,
  ) => {
    const slot = next;
    const puff = puffs[slot]!;
    next = (next + 1) % CAPACITY;
    const jitter = rand(-0.22, 0.22);
    Object.assign(puff, {
      age: 0,
      life: rand(0.45, 0.6),
      x: e.x + e.dirX * back + rand(-0.15, 0.15),
      y: e.y + e.dirY * back + rand(-0.15, 0.15),
      h: 0.4 + rand(0, 0.1),
      vx: (e.dirX - e.dirY * jitter) * speed,
      vy: (e.dirY + e.dirX * jitter) * speed,
      rise: rand(0.1, 0.4),
      size,
      swell,
      seed: rand(0, 6.28),
      tint: TINTS[Math.floor(Math.random() * TINTS.length)]!,
    });
  };

  return {
    onEvent(e: SimEvent) {
      if (e.type !== "fart") return;
      const rider = e.raft * MAX_CREW + e.seat;
      if ((cooldown[rider] ?? 0) > 0) return;
      cooldown[rider] = PUFF_EVERY;
      spawn(e, rand(0.34, 0.42), rand(0.85, 1.1) * SPEED, 0.35, SWELL * rand(0.8, 1.2));
      if (Math.random() < 0.4) spawn(e, rand(0.2, 0.26), SPEED * 0.55, 0.3, SWELL * 0.6);
      if (Math.random() < 0.12) {
        const b = bubbles[nextBubble]!;
        nextBubble = (nextBubble + 1) % BUBBLES;
        Object.assign(b, {
          age: 0,
          x: e.x + e.dirX * rand(0.8, 2.2) + rand(-0.4, 0.4),
          y: e.y + e.dirY * rand(0.8, 2.2) + rand(-0.4, 0.4),
          size: rand(0.5, 0.9),
        });
      }
    },
    update(dt: number) {
      cooldown.forEach((_, i) => (cooldown[i] = Math.max(0, cooldown[i]! - dt)));
      const drag = Math.exp(-3 * dt);
      let live = 0;
      puffs.forEach((puff) => {
        puff.age += dt;
        const t = puff.age / puff.life;
        if (t >= 1) return;
        puff.vx *= drag;
        puff.vy *= drag;
        puff.x += puff.vx * dt;
        puff.y += puff.vy * dt;
        puff.h += puff.rise * dt * (1 - t);
        const pop = easeOutBack(Math.min(1, puff.age / 0.12));
        const shrink = 1 - smooth(0.7, 1, t) * 0.5;
        const s = puff.size * pop * (1 + puff.swell * Math.sqrt(t)) * shrink;
        const w = puff.age * 13 + puff.seed;
        applyPose(dummy, { x: puff.x, y: puff.y, rot: puff.seed }, puff.h);
        // Jelly wobble: squash and stretch out of phase on each axis.
        dummy.scale.set(
          s * (1 + 0.14 * Math.sin(w)),
          s * (1 + 0.14 * Math.cos(w * 0.8 + 1)),
          s * (1 + 0.14 * Math.sin(w * 1.2 + 2)),
        );
        dummy.updateMatrix();
        mesh.setMatrixAt(live, dummy.matrix);
        mesh.setColorAt(live, puff.tint);
        alpha.setX(live, ALPHA * (1 - smooth(0.4, 1, t)));
        live++;
      });
      mesh.count = live;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      alpha.needsUpdate = true;

      bubbles.forEach((b, i) => {
        b.age += dt;
        const t = b.age / 1.1;
        applyPose(dummy, { x: b.x, y: b.y, rot: 0 }, 0.07);
        // Expand quickly, then pop: snap to zero at the end.
        dummy.scale.setScalar(
          t < 1 ? b.size * (0.3 + 0.7 * Math.sqrt(t)) * (t > 0.85 ? 1.25 : 1) : 0,
        );
        dummy.updateMatrix();
        ringMesh.setMatrixAt(i, dummy.matrix);
      });
      ringMesh.instanceMatrix.needsUpdate = true;
    },
  };
}
