import * as THREE from "three";
import type { Box, LevelData, Pose, SimEvent } from "../../sim/types";
import { applyPose, poseMatrix } from "./coords";
import { createFoam } from "./foam";
import { createGates } from "./gates";
import type { Kit } from "./kit";
import { createWind, type SwayOptions } from "./wind";

const PLATEAU_DEPTH = 30;
const PLATEAU_EXTEND = 30;
const TOP_Y = 2.4;
const BOTTOM_Y = -8;
const GRASS = 0xa8d870;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Vertical stripes along v: light body, thin dark seams, warm bottom, like layered clay. */
function clayTexture(body: string, seam: string, bottom: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 128;
  const g = c.getContext("2d")!;
  const bands: [number, number, string][] = [
    [0, 0.3, body],
    [0.3, 0.34, seam],
    [0.34, 0.62, body],
    [0.62, 0.66, seam],
    [0.66, 0.84, body],
    [0.84, 1, bottom],
  ];
  for (const [a, b, color] of bands) {
    g.fillStyle = color;
    g.fillRect(0, a * 128, 4, (b - a) * 128 + 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

type Rect = { x: number; y: number; rot: number; hu: number; hv: number };

type Frame = { ux: number; uy: number; vx: number; vy: number };
const frameOf = (rot: number): Frame => ({
  ux: Math.cos(rot),
  uy: Math.sin(rot),
  vx: -Math.sin(rot),
  vy: Math.cos(rot),
});

/** Distance from point to the raft's intended path (spawn → checkpoints). */
function distToPath(path: { x: number; y: number }[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)));
  }
  return best;
}

/** Wind per plateau decor kind; the rest (rocks) stays put. */
const SWAY: Record<string, SwayOptions> = {
  tree_a: { height: 7, strength: 0.14, breathe: 0.025 },
  tree_b: { height: 8, strength: 0.12, breathe: 0.02 },
  bush: { height: 1.4, strength: 0.07, breathe: 0.03 },
  bamboo: { height: 4.5, strength: 0.45 },
  fern: { height: 0.9, strength: 0.1 },
  grass: { height: 0.8, strength: 0.14 },
  reeds: { height: 1.8, strength: 0.22, react: 1 },
};

export type Terrain = {
  group: THREE.Group;
  /** Call every frame with wall-clock seconds and the raft's current pose. */
  update(time: number, raft: Pose): void;
  /** Gate bounce and flash on checkpoint events. */
  onEvent(e: SimEvent): void;
};

export function buildTerrain(level: LevelData, kit: Kit): Terrain {
  const root = new THREE.Group();
  const wind = createWind();
  const foam = createFoam(wind.uniforms.uTime);
  root.add(foam.group);
  const rand = mulberry32(hashString(level.name));
  const range = (a: number, b: number) => a + rand() * (b - a);

  const path = [level.spawn, ...level.checkpoints];
  const centroid = {
    x: path.reduce((s, p) => s + p.x, 0) / path.length,
    y: path.reduce((s, p) => s + p.y, 0) / path.length,
  };

  const clay = [
    clayTexture("#f08f7f", "#d9705f", "#f7b27a"),
    clayTexture("#f7b27a", "#e0955a", "#f08f7f"),
  ].map((map) => new THREE.MeshLambertMaterial({ map }));
  const grass = new THREE.MeshLambertMaterial({ color: GRASS });

  const rects: Rect[] = [];
  const rimMatrices: THREE.Matrix4[] = [];
  const waterDecor = { lily: [] as THREE.Matrix4[], reeds: [] as THREE.Matrix4[] };
  const waterRocks: Box[] = [];
  const foamMatrices: THREE.Matrix4[] = [];
  const rocksInWater: { x: number; y: number; r: number }[] = [];

  const banks: Box[] = [];
  for (const wall of level.walls) {
    if (Math.min(wall.hx, wall.hy) >= 1) {
      const rock = kit.clone("rock");
      rock.scale.set(wall.hx, ((wall.hx + wall.hy) / 2) * 0.9, wall.hy);
      applyPose(rock, wall);
      root.add(rock);
      waterRocks.push(wall);
      rocksInWater.push({ x: wall.x, y: wall.y, r: Math.max(wall.hx, wall.hy) });
    } else banks.push(wall);
  }

  const free = (x: number, y: number) =>
    distToPath(path, x, y) > 3.5 &&
    rocksInWater.every((r) => Math.hypot(x - r.x, y - r.y) > r.r + 1.5);
  banks.forEach((wall, wi) => {
    const f = frameOf(wall.rot);
    const thinIsX = wall.hx < wall.hy;
    const thin = thinIsX ? wall.hx : wall.hy;
    const longHalf = thinIsX ? wall.hy : wall.hx;
    // Thin-axis and long-axis unit vectors in sim space.
    const tx = thinIsX ? f.ux : f.vx;
    const ty = thinIsX ? f.uy : f.vy;
    const lx = thinIsX ? f.vx : f.ux;
    const ly = thinIsX ? f.vy : f.uy;
    const out = Math.sign((wall.x - centroid.x) * tx + (wall.y - centroid.y) * ty) || 1;
    const nx = tx * out;
    const ny = ty * out;

    // Plateau slab on the outward side.
    const off = thin + PLATEAU_DEPTH / 2;
    const px = wall.x + nx * off;
    const py = wall.y + ny * off;
    const w = thinIsX ? PLATEAU_DEPTH : (longHalf + PLATEAU_EXTEND) * 2;
    const d = thinIsX ? (longHalf + PLATEAU_EXTEND) * 2 : PLATEAU_DEPTH;
    const sideMat = clay[wi % clay.length]!;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, TOP_Y - BOTTOM_Y, d), [
      sideMat,
      sideMat,
      grass,
      sideMat,
      sideMat,
      sideMat,
    ]);
    applyPose(slab, { x: px, y: py, rot: wall.rot }, (TOP_Y + BOTTOM_Y) / 2 + wi * 0.003);
    slab.receiveShadow = true;
    root.add(slab);
    rects.push({
      x: px,
      y: py,
      rot: wall.rot,
      hu: thinIsX ? PLATEAU_DEPTH / 2 : longHalf + PLATEAU_EXTEND,
      hv: thinIsX ? longHalf + PLATEAU_EXTEND : PLATEAU_DEPTH / 2,
    });

    // Bamboo rim along the inner face.
    const count = Math.max(1, Math.round(longHalf));
    const seg = (longHalf * 2) / count;
    const rimRot = wall.rot + (thinIsX ? Math.PI / 2 : 0);
    const inward = thin - 0.15;
    for (let k = 0; k < count; k++) {
      const t = -longHalf + (k + 0.5) * seg;
      rimMatrices.push(
        poseMatrix(
          { x: wall.x + lx * t - nx * inward, y: wall.y + ly * t - ny * inward, rot: rimRot },
          0,
          [seg / 2, 1, 1],
        ),
      );
    }

    for (let k = 0; k < count; k++) {
      const t = -longHalf + (k + 0.5) * seg;
      foamMatrices.push(
        poseMatrix(
          { x: wall.x + lx * t - nx * thin, y: wall.y + ly * t - ny * thin, rot: rimRot },
          0.05,
          [seg, 1, 1.5],
        ),
      );
    }

    // Lilies and reeds in the water along the bank, away from the raft path and rocks.
    const place = (list: THREE.Matrix4[], t: number, inwardDist: number, scale: number) => {
      const x = wall.x + lx * t - nx * (thin + inwardDist);
      const y = wall.y + ly * t - ny * (thin + inwardDist);
      if (free(x, y))
        list.push(poseMatrix({ x, y, rot: range(0, 6.28) }, 0, [scale, scale, scale]));
    };
    for (let k = 0; k < Math.floor(longHalf / 3); k++) {
      const t = range(-longHalf + 2, longHalf - 2);
      const dist = range(1.4, 5);
      const n = 2 + Math.floor(rand() * 3);
      for (let j = 0; j < n; j++)
        place(waterDecor.lily, t + range(-0.9, 0.9), dist + range(-0.7, 0.7), range(0.8, 1.2));
    }
    for (let k = 0; k < Math.floor(longHalf / 4); k++) {
      const t = range(-longHalf + 2, longHalf - 2);
      const n = 2 + Math.floor(rand() * 3);
      for (let j = 0; j < n; j++)
        place(waterDecor.reeds, t + range(-0.6, 0.6), range(0.6, 1.4), range(0.9, 1.4));
    }
  });

  foam.rocks(waterRocks);
  if (foamMatrices.length) foam.strips(foamMatrices);
  if (rimMatrices.length) root.add(kit.instance("rim", rimMatrices));
  if (waterDecor.lily.length) root.add(wind.drift(kit.instance("lily", waterDecor.lily)));
  if (waterDecor.reeds.length)
    root.add(wind.sway(kit.instance("reeds", waterDecor.reeds), SWAY.reeds!));

  // Plateau-top decor.
  const decor: Record<string, { density: number; scale: [number, number] }> = {
    tree_a: { density: 0.0035, scale: [0.9, 1.5] },
    tree_b: { density: 0.0035, scale: [0.9, 1.5] },
    bush: { density: 0.005, scale: [0.8, 1.4] },
    bamboo: { density: 0.0015, scale: [0.9, 1.4] },
    rock: { density: 0.0015, scale: [0.8, 1.6] },
    fern: { density: 0.004, scale: [0.8, 1.3] },
    grass: { density: 0.012, scale: [0.8, 1.5] },
  };
  for (const [name, spec] of Object.entries(decor)) {
    const list: THREE.Matrix4[] = [];
    for (const r of rects) {
      const f = frameOf(r.rot);
      const n = Math.round(r.hu * r.hv * 4 * spec.density);
      for (let i = 0; i < n; i++) {
        const u = range(-r.hu + 1.5, r.hu - 1.5);
        const v = range(-r.hv + 1.5, r.hv - 1.5);
        const x = r.x + f.ux * u + f.vx * v;
        const y = r.y + f.uy * u + f.vy * v;
        // Keep decor off the water-facing edge: distance to every bank wall's outer face.
        if (banks.some((b) => nearWater(b, x, y, 2.5))) continue;
        const s = range(spec.scale[0], spec.scale[1]);
        list.push(poseMatrix({ x, y, rot: range(0, 6.28) }, TOP_Y, [s, s, s]));
      }
    }
    if (!list.length) continue;
    const group = kit.instance(name, list);
    root.add(SWAY[name] ? wind.sway(group, SWAY[name]) : group);
  }

  const gates = createGates(level, kit, wind.uniforms.uTime);
  root.add(gates.group);

  return {
    group: root,
    update(time, raft) {
      wind.update(time, raft);
      gates.update(time);
    },
    onEvent: (e) => gates.onEvent(e),
  };
}

/** True when (x, y) is within `margin` of a bank wall's water-facing side (either side, since the slab is outward). */
function nearWater(b: Box, x: number, y: number, margin: number): boolean {
  const f = frameOf(b.rot);
  const dx = x - b.x;
  const dy = y - b.y;
  const u = dx * f.ux + dy * f.uy;
  const v = dx * f.vx + dy * f.vy;
  return Math.abs(u) < b.hx + margin && Math.abs(v) < b.hy + margin;
}
