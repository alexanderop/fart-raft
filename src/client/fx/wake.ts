import * as THREE from "three";
import { RAFT_RADIUS } from "../../sim/constants.ts";
import type { Pose, SimEvent } from "../../sim/types.ts";
import { applyPose } from "../render/coords.ts";

const WATER_Y = 0.045;
const flat = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

type Disc = {
  age: number;
  life: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** 0 = ring keeps its radius (the shader expands it), 1 = disc grows with age. */
  grow: number;
  seed: number;
};

const VERT = /* glsl */ `
  attribute float aLife; attribute float aSeed;
  varying vec2 vP; varying float vLife; varying float vSeed;
  void main() {
    vP = position.xz; vLife = aLife; vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }`;

const RIPPLE = /* glsl */ `
  varying vec2 vP; varying float vLife; varying float vSeed;
  void main() {
    float r = length(vP);
    float R = 0.15 + 0.85 * (1.0 - pow(1.0 - vLife, 2.0));
    float w = 0.02 + 0.08 * (1.0 - vLife * 0.5);
    float ring = smoothstep(w, 0.0, abs(r - R));
    float inner = smoothstep(w * 0.7, 0.0, abs(r - R * 0.62)) * 0.6 * step(0.12, vLife);
    float a = (ring + inner) * pow(1.0 - vLife, 1.5) * 0.9;
    gl_FragColor = vec4(0.97, 0.99, 1.0, a);
  }`;

const FOAM = /* glsl */ `
  varying vec2 vP; varying float vLife; varying float vSeed;
  void main() {
    float r = length(vP);
    float n = sin(vP.x * 9.0 + vSeed * 6.0) * sin(vP.y * 8.0 - vSeed * 3.0) * 0.12
            + sin(atan(vP.y, vP.x) * 5.0 + vSeed * 10.0) * 0.08;
    float body = 1.0 - smoothstep(0.55 + n, 0.95 + n * 0.5, r);
    float bubbles = smoothstep(0.2, 0.8, sin(vP.x * 11.0 + vSeed * 7.0) * sin(vP.y * 10.0 - vSeed * 3.0) * 0.5 + 0.5);
    float a = body * pow(1.0 - vLife, 1.3) * (0.3 + 0.3 * bubbles);
    gl_FragColor = vec4(0.97, 0.99, 1.0, a);
  }`;

/** A ring buffer of flat water-surface quads, each drawn by one fragment shader. */
function createDiscPool(capacity: number, fragmentShader: string) {
  const lifeAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  const seedAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  const geometry = flat.clone();
  geometry.setAttribute("aLife", lifeAttr);
  geometry.setAttribute("aSeed", seedAttr);
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: VERT,
      fragmentShader,
    }),
    capacity,
  );
  mesh.frustumCulled = false;

  const discs: Disc[] = Array.from({ length: capacity }, () => ({
    age: 1,
    life: 1,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    radius: 0,
    grow: 0,
    seed: 0,
  }));
  let next = 0;
  const dummy = new THREE.Object3D();

  return {
    mesh,
    spawn(d: Partial<Disc> & Pick<Disc, "x" | "y" | "radius" | "life">) {
      Object.assign(discs[next]!, { age: 0, vx: 0, vy: 0, grow: 0, seed: Math.random() * 10 }, d);
      next = (next + 1) % capacity;
    },
    update(dt: number) {
      discs.forEach((d, i) => {
        d.age += dt;
        const t = d.age / d.life;
        const alive = t < 1;
        if (alive) {
          d.x += d.vx * dt;
          d.y += d.vy * dt;
        }
        applyPose(dummy, { x: d.x, y: d.y, rot: 0 }, WATER_Y);
        dummy.scale.setScalar(alive ? d.radius * (1 + d.grow * t * 0.9) : 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        lifeAttr.setX(i, Math.min(t, 1));
        seedAttr.setX(i, d.seed);
      });
      mesh.instanceMatrix.needsUpdate = true;
      lifeAttr.needsUpdate = true;
      seedAttr.needsUpdate = true;
    },
  };
}

/**
 * Water response to the raft: a foam V trail behind it, expanding rings at fart spots and
 * on bumps, and a slow idle ring so a parked raft still looks afloat. Driven by the raft pose
 * and SimEvents only.
 */
export function createWake(scene: THREE.Scene) {
  const ripples = createDiscPool(96, RIPPLE);
  const foam = createDiscPool(256, FOAM);
  scene.add(ripples.mesh, foam.mesh);

  let last: Pose | undefined;
  let travelled = 0;
  let idle = 0;
  const fartCooldown = [0, 0, 0, 0];

  return {
    onEvent(e: SimEvent) {
      if (e.type === "fart" && (fartCooldown[e.seat] ?? 0) <= 0) {
        fartCooldown[e.seat] = 0.22;
        ripples.spawn({ x: e.x, y: e.y, radius: 2.4, life: 1.1 });
      } else if (e.type === "bump") {
        const radius = 2.5 + Math.min(e.speed, 8) * 0.45;
        ripples.spawn({ x: e.x, y: e.y, radius, life: 1.4 });
        foam.spawn({ x: e.x, y: e.y, radius: 1.1, life: 1.2, grow: 1 });
      }
    },
    update(dt: number, raft: Pose) {
      fartCooldown.forEach((_, i) => (fartCooldown[i] = Math.max(0, fartCooldown[i]! - dt)));
      const mx = last ? raft.x - last.x : 0;
      const my = last ? raft.y - last.y : 0;
      const moved = Math.hypot(mx, my);
      const speed = dt > 0 ? moved / dt : 0;
      last = { ...raft };

      // The raft is round and spins freely, so the wake follows where it travels, not its nose.
      const fx = moved > 1e-6 ? mx / moved : Math.cos(raft.rot);
      const fy = moved > 1e-6 ? my / moved : Math.sin(raft.rot);
      const lx = -fy;
      const ly = fx;
      travelled += moved;
      while (travelled > 0.7) {
        travelled -= 0.7;
        if (speed < 0.8) continue;
        const spread = 0.7 + Math.min(speed, 9) * 0.14;
        const radius = 0.5 + Math.min(speed, 9) * 0.05;
        for (const side of [-1, 1]) {
          // Stern: the wake widens into a V as the blobs drift outward.
          foam.spawn({
            x: raft.x - fx * RAFT_RADIUS * 0.8 + lx * RAFT_RADIUS * 0.6 * side,
            y: raft.y - fy * RAFT_RADIUS * 0.8 + ly * RAFT_RADIUS * 0.6 * side,
            vx: lx * spread * side,
            vy: ly * spread * side,
            radius,
            life: 1.5,
            grow: 1,
          });
          // Bow: a smaller, shorter curl pushed out sideways.
          foam.spawn({
            x: raft.x + fx * RAFT_RADIUS * 0.75 + lx * RAFT_RADIUS * 0.66 * side,
            y: raft.y + fy * RAFT_RADIUS * 0.75 + ly * RAFT_RADIUS * 0.66 * side,
            vx: lx * spread * 1.3 * side,
            vy: ly * spread * 1.3 * side,
            radius: radius * 0.6,
            life: 0.9,
            grow: 0.6,
          });
        }
      }

      idle += dt;
      if (idle > 1.4) {
        idle = 0;
        ripples.spawn({ x: raft.x, y: raft.y, radius: 2.6, life: 2.4 });
      }
      ripples.update(dt);
      foam.update(dt);
    },
  };
}
