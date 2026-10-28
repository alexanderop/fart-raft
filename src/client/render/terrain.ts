import * as THREE from "three";
import { rapidsAt, sampleChannel, type Sample } from "../../sim/channel.ts";
import { isIsland, islandRadius } from "../../sim/island.ts";
import type { Box, Channel, LevelData, Pose, SimEvent } from "../../sim/types.ts";
import { applyPose, poseMatrix } from "./coords.ts";
import { createGates } from "./gates.ts";
import type { Kit } from "./kit.ts";
import { createWind, type SwayOptions } from "./wind.ts";

// Halloween take on Fart Together's look: the channel is cut into dusky violet plateaus that float
// in a night sky, with cliffs dropping into the purple haze, a pumpkin-orange bumper rail on every
// bank and spike strips on the dangerous ones. The water is eerie slime green. All of it is generated from the channel centerline.

const BANK_TOP = 0.9;
const CLIFF_BOTTOM = -70;
const RAIL_RADIUS = 0.34;
const WATER_MARGIN = 0.6;

const COLORS = {
  edge: new THREE.Color(0x4a3a62),
  top: new THREE.Color(0x56456f),
  topFar: new THREE.Color(0x5e4c7a),
  bankFace: new THREE.Color(0x4a3866),
  cliffLip: new THREE.Color(0x3c2c55),
  cliff: new THREE.Color(0x4b3868),
  cliffDeep: new THREE.Color(0x5a3f7a),
  waterEdge: new THREE.Color(0x1d7a55),
  waterMid: new THREE.Color(0x45c486),
  island: new THREE.Color(0x7a6899),
  rail: 0xff8a1f,
  teal: 0x8be24a,
};

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

/** Sim point → Three vector at height y. */
const v3 = (x: number, y: number, h: number) => new THREE.Vector3(x, h, -y);

/**
 * A grid surface through `rows` (each the same length), one color per row, so a strip reads as a
 * gradient across its width. Double-sided, so winding never decides whether it shows.
 */
function strip(rows: THREE.Vector3[][], colors: THREE.Color[]): THREE.BufferGeometry {
  const n = rows[0]!.length;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  rows.forEach((row, r) => {
    for (const p of row) {
      pos.push(p.x, p.y, p.z);
      col.push(colors[r]!.r, colors[r]!.g, colors[r]!.b);
    }
  });
  for (let r = 0; r + 1 < rows.length; r++)
    for (let i = 0; i + 1 < n; i++) {
      const a = r * n + i;
      const b = (r + 1) * n + i;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The point `d` m left of a centerline sample, at height `h`, in Three space. */
const at = (p: Sample, d: number, h: number) => v3(p.x + p.nx * d, p.y + p.ny * d, h);

const decorKind = (r: number) =>
  r < 0.12 ? "tree_round" : r < 0.35 ? "bush" : r < 0.6 ? "fern" : "grass";

const clayMaterial = () =>
  new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

/** Signed curvature per sample (positive = turning left), from the tangent change. */
function curvature(samples: readonly Sample[]): number[] {
  return samples.map((_, i) => {
    const a = samples[Math.max(0, i - 1)]!;
    const b = samples[Math.min(samples.length - 1, i + 1)]!;
    return (a.tx * b.ty - a.ty * b.tx) / (b.s - a.s || 1);
  });
}

/**
 * How far each bank's plateau reaches, per sample. Wavy so the outer cliffs look carved, and
 * capped on the inside of bends so the strip never folds over itself.
 */
function plateauWidths(samples: readonly Sample[], hw: number, side: 1 | -1, seed: number) {
  const k = curvature(samples);
  const raw = samples.map((p, i) => {
    const wave =
      11 + 4 * Math.sin(p.s * 0.045 + seed) + 2.5 * Math.sin(p.s * 0.13 + seed * 2.3) - 1;
    const inner = k[i]! * side;
    const cap = inner > 1e-4 ? 0.8 / inner - hw : Infinity;
    return Math.max(1.6, Math.min(wave, cap));
  });
  // A window minimum keeps the cap in force a little before and after the tightest point.
  const W = 10;
  return raw.map((_, i) => Math.min(...raw.slice(Math.max(0, i - W), i + W + 1)));
}

function buildChannel(ch: Channel, kit: Kit, water: THREE.Material, rand: () => number) {
  const group = new THREE.Group();
  const samples = sampleChannel(ch);
  const hw = ch.halfWidth;
  const clay = clayMaterial();

  // Water: a ribbon a little wider than the channel, darker at the banks.
  const across = [-1, -0.6, 0, 0.6, 1];
  const stream = new THREE.Mesh(
    strip(
      across.map((u) => samples.map((p) => at(p, u * (hw + WATER_MARGIN), 0))),
      across.map((u) => COLORS.waterEdge.clone().lerp(COLORS.waterMid, 1 - Math.abs(u) ** 2)),
    ),
    water,
  );
  // Flow coordinates for the water shader's streaks: (arc length, offset across, on).
  stream.geometry.setAttribute(
    "aFlow",
    new THREE.Float32BufferAttribute(
      across.flatMap((u) => samples.flatMap((p) => [p.s, u * (hw + WATER_MARGIN), 1])),
      3,
    ),
  );
  stream.geometry.setAttribute(
    "aRapid",
    new THREE.Float32BufferAttribute(
      across.flatMap(() => samples.map((p) => rapidsAt(ch, p.s))),
      1,
    ),
  );
  stream.receiveShadow = true;
  group.add(stream);

  const outerEdges: { side: 1 | -1; widths: number[] }[] = [];
  for (const side of [1, -1] as const) {
    const widths = plateauWidths(samples, hw, side, side === 1 ? 1.3 : 4.1);
    outerEdges.push({ side, widths });
    const out = (i: number) => side * (hw + widths[i]!);

    // Bank face (orange band under the rail), plateau top, then the cliff.
    const bank = new THREE.Mesh(
      strip(
        [
          samples.map((p) => at(p, side * hw, -0.4)),
          samples.map((p) => at(p, side * hw, BANK_TOP)),
        ],
        [COLORS.bankFace, COLORS.bankFace],
      ),
      clay,
    );
    const top = new THREE.Mesh(
      strip(
        [
          samples.map((p) => at(p, side * hw, BANK_TOP)),
          samples.map((p) => at(p, side * (hw + 1.4), BANK_TOP)),
          samples.map((p, i) => at(p, out(i), BANK_TOP)),
        ],
        [COLORS.edge, COLORS.top, COLORS.topFar],
      ),
      clay,
    );
    const cliff = new THREE.Mesh(
      strip(
        [
          samples.map((p, i) => at(p, out(i), BANK_TOP)),
          samples.map((p, i) => at(p, out(i), BANK_TOP - 1.4)),
          samples.map((p, i) => at(p, out(i) * 0.98, CLIFF_BOTTOM)),
        ],
        [COLORS.cliffLip, COLORS.cliff, COLORS.cliffDeep],
      ),
      clay,
    );
    top.receiveShadow = true;
    group.add(bank, top, cliff);

    // Lime bumper rail along the water edge.
    const rail = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(samples.map((p) => at(p, side * (hw + 0.05), BANK_TOP + 0.12))),
        samples.length * 2,
        RAIL_RADIUS,
        8,
      ),
      new THREE.MeshLambertMaterial({ color: COLORS.rail }),
    );
    rail.castShadow = true;
    group.add(rail);

    // Spike strips along the spiky spans, spikes facing the water.
    const sideName = side === 1 ? "left" : "right";
    const spikes: THREE.Matrix4[] = [];
    for (const span of ch.spikes.filter((sp) => sp.side === sideName)) {
      for (let s = span.from + 1; s < span.to; s += 2) {
        const p = samples.find((q) => q.s >= s) ?? samples[samples.length - 1]!;
        const rot = Math.atan2(p.ty, p.tx) + (side === 1 ? Math.PI : 0);
        const off = side * (hw - 0.15);
        spikes.push(poseMatrix({ x: p.x + p.nx * off, y: p.y + p.ny * off, rot }, BANK_TOP - 0.5));
      }
    }
    if (spikes.length) group.add(kit.instance("spike_strip", spikes));
  }

  // Land caps beyond both channel ends, so the stream starts and stops inside a plateau.
  for (const [end, dir] of [
    [samples[0]!, -1],
    [samples[samples.length - 1]!, 1],
  ] as const) {
    const depth = 18;
    const width = (hw + 12) * 2;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(depth, BANK_TOP - CLIFF_BOTTOM, width), [
      cliffSide(),
      cliffSide(),
      new THREE.MeshLambertMaterial({ color: COLORS.top }),
      cliffSide(),
      cliffSide(),
      cliffSide(),
    ]);
    applyPose(
      mesh,
      {
        x: end.x + end.tx * (depth / 2) * dir,
        y: end.y + end.ty * (depth / 2) * dir,
        rot: Math.atan2(end.ty, end.tx),
      },
      (BANK_TOP + CLIFF_BOTTOM) / 2,
    );
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Plateau-top decor: sparse puffy trees and plants, kept off the rail.
  const decor: Record<string, THREE.Matrix4[]> = { tree_round: [], bush: [], fern: [], grass: [] };
  for (const { side, widths } of outerEdges) {
    for (let i = 0; i < samples.length; i += 2) {
      const w = widths[i]!;
      if (w < 4 || rand() < 0.45) continue;
      const p = samples[i]!;
      const kind = decorKind(rand());
      const d = side * (hw + 2.2 + rand() * (w - 3.4));
      const s = 0.8 + rand() * 0.6;
      decor[kind]!.push(
        poseMatrix({ x: p.x + p.nx * d, y: p.y + p.ny * d, rot: rand() * 6.28 }, BANK_TOP, [
          s,
          s,
          s,
        ]),
      );
    }
  }

  return { group, samples, decor, outerEdges };
}

function cliffSide() {
  return new THREE.MeshLambertMaterial({ color: COLORS.cliff });
}

/** A chunky octagonal clay prism: peach top, coral sides. */
function mesa(
  r: number,
  topY: number,
  bottomY: number,
  sides = 8,
  top: THREE.Color = COLORS.top,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.04, topY - bottomY, sides, 1), [
    new THREE.MeshLambertMaterial({ color: COLORS.cliff, flatShading: true }),
    new THREE.MeshLambertMaterial({ color: top }),
    new THREE.MeshLambertMaterial({ color: COLORS.cliff }),
  ]);
  mesh.position.y = (topY + bottomY) / 2;
  mesh.receiveShadow = true;
  return mesh;
}

/** Background mesas floating around the course, clear of the channel's plateaus. */
function scatterMesas(samples: readonly Sample[], hw: number, rand: () => number): THREE.Group {
  const group = new THREE.Group();
  const xs = samples.map((p) => p.x);
  const ys = samples.map((p) => p.y);
  const pad = 70;
  const [x0, x1] = [Math.min(...xs) - pad, Math.max(...xs) + pad];
  const [y0, y1] = [Math.min(...ys) - pad, Math.max(...ys) + pad];
  const placed: { x: number; y: number; r: number }[] = [];
  for (let tries = 0; tries < 600 && placed.length < 46; tries++) {
    const r = 6 + rand() * 14;
    const x = x0 + rand() * (x1 - x0);
    const y = y0 + rand() * (y1 - y0);
    const clear = samples.every((p) => Math.hypot(p.x - x, p.y - y) > hw + 24 + r);
    if (!clear || placed.some((m) => Math.hypot(m.x - x, m.y - y) < m.r + r + 4)) continue;
    placed.push({ x, y, r });
    const topY = -10 + rand() * 22;
    const m = mesa(r, topY, CLIFF_BOTTOM - 10, 7 + Math.floor(rand() * 3));
    m.position.x = x;
    m.position.z = -y;
    m.rotation.y = rand() * 6.28;
    group.add(m);
  }
  return group;
}

/** Gravestones, jack-o'-lanterns and a dead tree or two on every island big enough, from a seeded roll. */
function islandDecor(walls: readonly Box[], kit: Kit, rand: () => number): THREE.Group {
  const group = new THREE.Group();
  const decor: Record<string, THREE.Matrix4[]> = { fern: [], bush: [], tree_round: [] };
  for (const wall of walls.filter(isIsland)) {
    const r = islandRadius(wall);
    const count = Math.max(2, Math.round(r * 0.8));
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const d = (0.25 + rand() * 0.55) * r;
      const roll = rand();
      const kind = roll < 0.55 ? "fern" : roll < 0.85 || r < 3 ? "bush" : "tree_round";
      const scale = kind === "tree_round" ? 0.55 + rand() * 0.2 : 0.9 + rand() * 0.4;
      decor[kind]!.push(
        poseMatrix(
          { x: wall.x + Math.cos(a) * d, y: wall.y + Math.sin(a) * d, rot: rand() * Math.PI * 2 },
          BANK_TOP,
          [scale, scale, scale],
        ),
      );
    }
  }
  for (const [name, list] of Object.entries(decor))
    if (list.length) group.add(kit.instance(name, list));
  return group;
}

/** Islands and plain walls from `level.walls`: thick boxes become octagonal islands with a teal rim. */
function buildWalls(walls: readonly Box[]): THREE.Group {
  const group = new THREE.Group();
  for (const wall of walls) {
    if (!isIsland(wall)) {
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(wall.hx * 2, BANK_TOP + 0.4, wall.hy * 2),
        new THREE.MeshLambertMaterial({ color: COLORS.top }),
      );
      applyPose(slab, wall, (BANK_TOP - 0.4) / 2);
      group.add(slab);
      continue;
    }
    const r = islandRadius(wall);
    const island = mesa(r, BANK_TOP, -1.5, 8, COLORS.island);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(r * 1.02, 0.28, 6, 8),
      new THREE.MeshLambertMaterial({ color: COLORS.teal }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = BANK_TOP - island.position.y;
    island.add(rim);
    island.position.x = wall.x;
    island.position.z = -wall.y;
    island.rotation.y = wall.rot + Math.PI / 8;
    group.add(island);
  }
  return group;
}

const SWAY: Record<string, SwayOptions> = {
  tree_round: { height: 5, strength: 0.12, breathe: 0.025 },
  bush: { height: 1.4, strength: 0.07, breathe: 0.03 },
  fern: { height: 0.9, strength: 0.1 },
  grass: { height: 0.8, strength: 0.14 },
};

export type Terrain = {
  group: THREE.Group;
  /** Call every frame with wall-clock seconds, the raft's current pose and the camera (gate fade). */
  update(time: number, raft: Pose, camera: THREE.Camera): void;
  /** Gate bounce and flash on checkpoint events. */
  onEvent(e: SimEvent): void;
};

/** `water` is the shared animated water material (env.ts), used for the channel ribbon. */
export function buildTerrain(level: LevelData, kit: Kit, water: THREE.Material): Terrain {
  const root = new THREE.Group();
  const wind = createWind();
  const rand = mulberry32(hashString(level.name));

  root.add(buildWalls(level.walls), islandDecor(level.walls, kit, rand));
  if (level.channel) {
    const channel = buildChannel(level.channel, kit, water, rand);
    root.add(channel.group, scatterMesas(channel.samples, level.channel.halfWidth, rand));
    for (const [name, list] of Object.entries(channel.decor)) {
      if (!list.length) continue;
      const g = kit.instance(name, list);
      root.add(SWAY[name] ? wind.sway(g, SWAY[name]) : g);
    }
  }

  const gates = createGates(level, kit, wind.uniforms.uTime);
  root.add(gates.group);

  return {
    group: root,
    update(time, raft, camera) {
      wind.update(time, raft);
      gates.update(time, raft, camera);
    },
    onEvent: (e) => gates.onEvent(e),
  };
}
