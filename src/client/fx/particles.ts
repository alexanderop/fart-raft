import * as THREE from "three";
import type { SimEvent } from "../../sim/types";
import { applyPose } from "../render/coords";

const CAPACITY = 384;
const BUBBLES = 24;
const SPEED = 3.5;
const TINTS = [0x8ed14a, 0xa6dc4c, 0xc7e34a, 0xdcea5a, 0x7fcf6b].map((c) => new THREE.Color(c));

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
  seed: number;
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
  seed: 0,
});
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Overshoot easing: pops past 1 then settles. */
const easeOutBack = (t: number) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Fart clouds. Each fart spawns a small cluster of toon puffs that pop in with overshoot,
 * wobble, drift on their own drag and rise, then shrink away. An InstancedMesh with a fixed
 * ring of slots: the oldest puff is overwritten when full. Farts fire every sim tick, so
 * each seat is rate-limited. Now and then a bubble ring pops on the water.
 */
export function createParticles(scene: THREE.Scene) {
  const mesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.5, 2),
    new THREE.MeshToonMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    CAPACITY,
  );
  mesh.frustumCulled = false;
  for (let i = 0; i < CAPACITY; i++) mesh.setColorAt(i, TINTS[0]!);
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
  const cooldown = [0, 0, 0, 0];
  const dummy = new THREE.Object3D();

  const spawn = (
    e: Extract<SimEvent, { type: "fart" }>,
    size: number,
    speed: number,
    back: number,
  ) => {
    const slot = next;
    const puff = puffs[slot]!;
    next = (next + 1) % CAPACITY;
    const jitter = rand(-0.5, 0.5);
    Object.assign(puff, {
      age: 0,
      life: rand(0.55, 0.85),
      x: e.x + e.dirX * back + rand(-0.12, 0.12),
      y: e.y + e.dirY * back + rand(-0.12, 0.12),
      h: 0.35 + rand(0, 0.1),
      vx: (e.dirX - e.dirY * jitter) * speed,
      vy: (e.dirY + e.dirX * jitter) * speed,
      rise: rand(0.8, 1.4),
      size,
      seed: rand(0, 6.28),
    });
    mesh.setColorAt(slot, TINTS[Math.floor(Math.random() * TINTS.length)]!);
  };

  return {
    onEvent(e: SimEvent) {
      if (e.type !== "fart" || (cooldown[e.seat] ?? 0) > 0) return;
      cooldown[e.seat] = 0.09;
      spawn(e, rand(0.32, 0.45), SPEED, 0.1);
      if (Math.random() < 0.7) spawn(e, rand(0.2, 0.3), SPEED * 1.5, 0.4);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
      const drag = Math.exp(-2.6 * dt);
      puffs.forEach((puff, i) => {
        puff.age += dt;
        const t = puff.age / puff.life;
        if (t >= 1) {
          dummy.scale.setScalar(0);
        } else {
          puff.vx *= drag;
          puff.vy *= drag;
          puff.x += puff.vx * dt;
          puff.y += puff.vy * dt;
          puff.h += puff.rise * dt * (1 - t);
          const pop = easeOutBack(Math.min(1, puff.age / 0.22));
          const shrink = 1 - smooth(0.55, 1, t) * 0.95;
          const s = puff.size * pop * shrink;
          const w = puff.age * 13 + puff.seed;
          applyPose(dummy, { x: puff.x, y: puff.y, rot: puff.seed }, puff.h);
          // Jelly wobble: squash and stretch out of phase on each axis.
          dummy.scale.set(
            s * (1 + 0.14 * Math.sin(w)),
            s * (1 + 0.14 * Math.cos(w * 0.8 + 1)),
            s * (1 + 0.14 * Math.sin(w * 1.2 + 2)),
          );
        }
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;

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
