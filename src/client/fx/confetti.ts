import * as THREE from "three";
import { applyPose } from "../render/coords.ts";

const CAPACITY = 480;
const GRAVITY = 7;
const COLORS = [0xff8a1f, 0xffc53d, 0x8be24a, 0x9b5cff, 0x2a1b33, 0xf2ead3];

type Piece = {
  age: number;
  life: number;
  x: number;
  y: number;
  h: number;
  vx: number;
  vy: number;
  vh: number;
  spin: [number, number, number];
  flutter: number;
  seed: number;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Paper confetti. A fixed ring of quads in one InstancedMesh: each piece tumbles, flips
 * edge-on (the flutter) and falls slowly because drag caps its fall speed.
 */
export function createConfetti(scene: THREE.Scene) {
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.34, 0.2),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    CAPACITY,
  );
  mesh.frustumCulled = false;
  const color = new THREE.Color();
  for (let i = 0; i < CAPACITY; i++) mesh.setColorAt(i, color.set(COLORS[i % COLORS.length]!));
  scene.add(mesh);

  const pieces: Piece[] = Array.from({ length: CAPACITY }, () => ({
    age: 1,
    life: 0,
    x: 0,
    y: 0,
    h: 0,
    vx: 0,
    vy: 0,
    vh: 0,
    spin: [0, 0, 0],
    flutter: 0,
    seed: 0,
  }));
  let next = 0;
  const dummy = new THREE.Object3D();

  return {
    /** Shoot a fan of confetti from a point; `spread` is the sim-space offset along the gate. */
    burst(x: number, y: number, h: number, ax: number, ay: number, half: number, count = 90) {
      for (let n = 0; n < count; n++) {
        const slot = next;
        const p = pieces[slot]!;
        next = (next + 1) % CAPACITY;
        const along = rand(-half * 0.85, half * 0.85);
        const out = rand(-1, 1);
        p.age = 0;
        p.life = rand(2.2, 3.4);
        p.x = x + ax * along;
        p.y = y + ay * along;
        p.h = h + rand(-0.2, 0.3);
        // Mostly up, a little sideways and forward/back.
        p.vx = ax * rand(-2, 2) - ay * out * 3;
        p.vy = ay * rand(-2, 2) + ax * out * 3;
        p.vh = rand(5, 10);
        p.spin = [rand(-9, 9), rand(-9, 9), rand(-9, 9)];
        p.flutter = rand(6, 12);
        p.seed = rand(0, 6.28);
        mesh.setColorAt(slot, color.set(COLORS[Math.floor(rand(0, COLORS.length))]!));
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    update(dt: number) {
      pieces.forEach((p, i) => {
        p.age += dt;
        if (p.age >= p.life) {
          dummy.scale.setScalar(0);
        } else {
          // Drag pulls velocity toward a slow terminal fall plus a sideways sway.
          const drag = Math.exp(-2.2 * dt);
          const sway = Math.sin(p.age * 3 + p.seed) * 0.9;
          p.vx *= drag;
          p.vy *= drag;
          p.vh = p.vh * drag - GRAVITY * dt * (1 - drag * 0.6);
          p.vh = Math.max(p.vh, -2.2);
          p.x += (p.vx + sway) * dt;
          p.y += (p.vy + Math.cos(p.age * 2.6 + p.seed) * 0.9) * dt;
          p.h = Math.max(0.08, p.h + p.vh * dt);
          const landed = p.h <= 0.08;
          applyPose(dummy, { x: p.x, y: p.y, rot: p.spin[1] * p.age }, p.h);
          dummy.rotation.x = landed ? -Math.PI / 2 : p.spin[0] * p.age;
          dummy.rotation.z = landed ? 0 : p.spin[2] * p.age;
          const flip = landed ? 1 : Math.abs(Math.cos(p.age * p.flutter + p.seed));
          const fade = Math.min(1, (p.life - p.age) / 0.5);
          dummy.scale.set(fade, flip * fade, fade);
        }
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
