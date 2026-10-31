import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  halfWidthAt,
  maxHalfWidth,
  pointAt,
  rapidsAt,
  sampleChannel,
  type Sample,
} from "../../sim/channel.ts";
import { isIsland, islandRadius } from "../../sim/island.ts";
import type { Box, Channel, LevelData, Pose, SimEvent } from "../../sim/types.ts";
import { applyPose, poseMatrix } from "./coords.ts";
import { createGates } from "./gates.ts";
import { buildPondDecor, buildRocks, isRock } from "./ponds.ts";
import type { Kit } from "./kit.ts";
import { createWind, type SwayOptions } from "./wind.ts";

// Fart Together's look: the channel is sunk between layered coral walls a few meters high, with
// a thick lime pipe rail on an orange lip along every bank and purple spike tubes on the
// dangerous spans. Above the walls, peach clay plateaus float in a pale sky. All of it is
// generated from the channel centerline.
//
// Bank cross-section, offsets (m) beyond the sim's bank line (`halfWidth`, where the raft hits):
//
//            PLATEAU_TOP ┌──────── plateau
//          coral layers  │
//   rail ◯   orange lip  │
//  ~~~~~~~~┴─────────────┘ WALL_FOOT
//   0 = bank line

/** Islands and plain walls stay low so they never hide the raft in the pools. */
const ISLAND_TOP = 0.9;
const PLATEAU_TOP = 2.6;
const CLIFF_BOTTOM = -70;
const LIP_TOP = 0.3;
/** Where the coral wall rises from the lip, and how far its top leans back. */
const WALL_FOOT = 1.9;
const WALL_LEAN = 0.35;
/** The rail's inner face sits on the bank line; on spiked spans it moves back behind the spike tube. */
const RAIL_RADIUS = 0.45;
const RAIL_Y = 0.55;
const RAIL_OFF = RAIL_RADIUS;
const RAIL_OFF_SPIKED = 1.25;
/** Spike tube: its inner face a hair past the bank line, cone tips ≈ 0.5 m into the water. */
const TUBE_RADIUS = 0.42;
const TUBE_OFF = 0.35;
const TUBE_Y = 0.38;
const SPIKE_EVERY = 0.9;
/** The rail eases back behind a spike tube over this many meters before and after it. */
const SPIKE_RAMP = 2.5;
const WATER_MARGIN = 0.6;

const COLORS = {
  edge: new THREE.Color(0xf6b07c),
  top: new THREE.Color(0xf9c18b),
  topFar: new THREE.Color(0xfacb98),
  lip: new THREE.Color(0xf0883f),
  lipFace: new THREE.Color(0xe0702e),
  wallLow: new THREE.Color(0xe2756a),
  wallMid: new THREE.Color(0xf08c7a),
  wallHigh: new THREE.Color(0xf7a790),
  wallRim: new THREE.Color(0xfcc6aa),
  cliffLip: new THREE.Color(0xe8705f),
  cliff: new THREE.Color(0xf28d78),
  cliffDeep: new THREE.Color(0xf7c2b4),
  waterEdge: new THREE.Color(0x2a9fe2),
  waterMid: new THREE.Color(0x4cc4f6),
  island: new THREE.Color(0xf9c18b),
  rail: new THREE.Color(0x9ad64b),
  railUnder: new THREE.Color(0x5e9a2a),
  tube: new THREE.Color(0xc444dc),
  tubeUnder: new THREE.Color(0x8a26a8),
  spike: 0xfffdf4,
  teal: 0x6fdcc8,
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
function plateauWidths(samples: readonly Sample[], hw: number[], side: 1 | -1, seed: number) {
  const k = curvature(samples);
  const raw = samples.map((p, i) => {
    const wave =
      11 + 4 * Math.sin(p.s * 0.045 + seed) + 2.5 * Math.sin(p.s * 0.13 + seed * 2.3) - 1;
    const inner = k[i]! * side;
    const cap = inner > 1e-4 ? 0.8 / inner - hw[i]! : Infinity;
    return Math.max(3.4, Math.min(wave, cap));
  });
  // A window minimum keeps the cap in force a little before and after the tightest point.
  const W = 10;
  return raw.map((_, i) => Math.min(...raw.slice(Math.max(0, i - W), i + W + 1)));
}

const UP = new THREE.Vector3(0, 1, 0);
/** A white spike: base at the origin, tip 0.6 m up +y (turned to face the water per instance). */
const SPIKE_CONE = new THREE.ConeGeometry(0.24, 0.6, 6).translate(0, 0.3, 0);

const smooth01 = (u: number) => {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
};

/** A round pipe through `points` (one tube segment per `step` m of input), capped with half balls. */
function tube(points: THREE.Vector3[], radius: number, step: number): THREE.BufferGeometry {
  const body = new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(points),
    Math.max(2, Math.ceil(points.length / step)),
    radius,
    10,
  );
  const cap = (p: THREE.Vector3) =>
    new THREE.SphereGeometry(radius, 10, 6).translate(p.x, p.y, p.z);
  const parts = [body, cap(points[0]!), cap(points[points.length - 1]!)];
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return merged;
}

/** Vertex colors from the normal, `under` facing down to `over` facing up, so a pipe reads round. */
function shade(g: THREE.BufferGeometry, under: THREE.Color, over: THREE.Color) {
  const n = g.getAttribute("normal");
  const col = new Float32Array(n.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n.count; i++) {
    c.copy(under).lerp(over, Math.min(1, (n.getY(i) + 1) / 1.3));
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

function buildChannel(ch: Channel, water: THREE.Material, rand: () => number) {
  const group = new THREE.Group();
  const samples = sampleChannel(ch);
  // Half-width per sample: wider in the ponds.
  const hw = samples.map((p) => halfWidthAt(ch, p.s));
  const length = samples[samples.length - 1]!.s;
  const clay = clayMaterial();

  // Water: a ribbon a little wider than the channel, darker at the banks.
  const across = [-1, -0.6, 0, 0.6, 1];
  const stream = new THREE.Mesh(
    strip(
      across.map((u) => samples.map((p, i) => at(p, u * (hw[i]! + WATER_MARGIN), 0))),
      across.map((u) => COLORS.waterEdge.clone().lerp(COLORS.waterMid, 1 - Math.abs(u) ** 2)),
    ),
    water,
  );
  // Flow coordinates for the water shader's streaks: (arc length, offset across, on). The
  // streaks fade out in the ponds, where the water is calm.
  stream.geometry.setAttribute(
    "aFlow",
    new THREE.Float32BufferAttribute(
      across.flatMap((u) =>
        samples.flatMap((p, i) => [p.s, u * (hw[i]! + WATER_MARGIN), (ch.halfWidth / hw[i]!) ** 3]),
      ),
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
  const spiked: THREE.BufferGeometry[] = [];
  const spikes: THREE.Matrix4[] = [];
  const rails: THREE.BufferGeometry[] = [];
  for (const side of [1, -1] as const) {
    const widths = plateauWidths(samples, hw, side, side === 1 ? 1.3 : 4.1);
    outerEdges.push({ side, widths });
    const out = (i: number) => side * (hw[i]! + widths[i]!);
    const row = (o: number, h: number) => samples.map((p, i) => at(p, side * (hw[i]! + o), h));
    /** The point `o` m beyond this bank's line at arc length `s`, at height `h`. */
    const bank = (s: number, o: number, h: number) =>
      at(pointAt(samples, s), side * (halfWidthAt(ch, s) + o), h);

    // Orange lip at the water's edge, the layered coral wall, the plateau top, then the cliff.
    const lip = strip(
      [row(0, -0.4), row(0, LIP_TOP), row(WALL_FOOT, LIP_TOP)],
      [COLORS.lipFace, COLORS.lip, COLORS.lip],
    );
    // Paired rows give flat bands with thin seams; each band steps back a little, like strata.
    const lean = (f: number) => WALL_FOOT + WALL_LEAN * f;
    const bands: [number, THREE.Color][] = [
      [LIP_TOP, COLORS.wallLow],
      [0.95, COLORS.wallLow],
      [1.02, COLORS.wallMid],
      [1.7, COLORS.wallMid],
      [1.77, COLORS.wallHigh],
      [2.45, COLORS.wallHigh],
      [PLATEAU_TOP, COLORS.wallRim],
    ];
    const wall = strip(
      bands.map(([h]) => row(lean((h - LIP_TOP) / (PLATEAU_TOP - LIP_TOP)), h)),
      bands.map(([, c]) => c),
    );
    const top = strip(
      [
        row(WALL_FOOT + WALL_LEAN, PLATEAU_TOP),
        row(WALL_FOOT + WALL_LEAN + 1.2, PLATEAU_TOP),
        samples.map((p, i) => at(p, out(i), PLATEAU_TOP)),
      ],
      [COLORS.edge, COLORS.top, COLORS.topFar],
    );
    const cliff = strip(
      [
        samples.map((p, i) => at(p, out(i), PLATEAU_TOP)),
        samples.map((p, i) => at(p, out(i), PLATEAU_TOP - 1.4)),
        samples.map((p, i) => at(p, out(i) * 0.98, CLIFF_BOTTOM)),
      ],
      [COLORS.cliffLip, COLORS.cliff, COLORS.cliffDeep],
    );
    const ground = new THREE.Mesh(mergeGeometries([lip, wall, top, cliff]), clay);
    ground.receiveShadow = true;
    group.add(ground);
    for (const g of [lip, wall, top, cliff]) g.dispose();

    // The lime pipe rail, sampled every meter so it can step back behind the spike tubes.
    const spans = ch.spikes.filter((sp) => sp.side === (side === 1 ? "left" : "right"));
    const back = (s: number) =>
      Math.max(
        0,
        ...spans.map((sp) => 1 - smooth01(Math.max(sp.from - s, s - sp.to, 0) / SPIKE_RAMP)),
      );
    const along: THREE.Vector3[] = [];
    for (let s = 0; s <= length; s += 1) {
      const o = RAIL_OFF + (RAIL_OFF_SPIKED - RAIL_OFF) * back(s);
      along.push(bank(s, o, RAIL_Y));
    }
    rails.push(tube(along, RAIL_RADIUS, 1));

    // Spiked spans: one purple tube in front of the rail, studded with white cones facing the water.
    for (const sp of spans) {
      const pts: THREE.Vector3[] = [];
      for (let s = sp.from; s < sp.to; s += 0.5) pts.push(bank(s, TUBE_OFF, TUBE_Y));
      pts.push(bank(sp.to, TUBE_OFF, TUBE_Y));
      if (pts.length > 1) spiked.push(tube(pts, TUBE_RADIUS, 0.5));
      const n = Math.max(1, Math.round((sp.to - sp.from) / SPIKE_EVERY));
      for (let k = 0; k < n; k++) {
        const s = sp.from + ((k + 0.5) * (sp.to - sp.from)) / n;
        const p = pointAt(samples, s);
        const base = bank(s, TUBE_OFF - TUBE_RADIUS + 0.12, TUBE_Y);
        // Into the water, alternating a little up and down so the row reads as a bristle.
        const dir = new THREE.Vector3(-p.nx * side, k % 2 ? 0.45 : -0.1, p.ny * side).normalize();
        spikes.push(
          new THREE.Matrix4().compose(
            base,
            new THREE.Quaternion().setFromUnitVectors(UP, dir),
            new THREE.Vector3(1, 1, 1),
          ),
        );
      }
    }
  }

  const rail = new THREE.Mesh(
    shade(mergeGeometries(rails), COLORS.railUnder, COLORS.rail),
    new THREE.MeshLambertMaterial({ vertexColors: true }),
  );
  rail.castShadow = true;
  group.add(rail);
  if (spiked.length) {
    const tubes = new THREE.Mesh(
      shade(mergeGeometries(spiked), COLORS.tubeUnder, COLORS.tube),
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    tubes.castShadow = true;
    const cones = new THREE.InstancedMesh(
      SPIKE_CONE,
      new THREE.MeshLambertMaterial({ color: COLORS.spike, flatShading: true }),
      spikes.length,
    );
    spikes.forEach((m, i) => cones.setMatrixAt(i, m));
    group.add(tubes, cones);
  }

  // Land caps beyond both channel ends, so the stream starts and stops inside a plateau.
  for (const [end, dir] of [
    [samples[0]!, -1],
    [samples[samples.length - 1]!, 1],
  ] as const) {
    const depth = 18;
    const width = (halfWidthAt(ch, end.s) + 12) * 2;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(depth, PLATEAU_TOP - CLIFF_BOTTOM, width), [
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
      (PLATEAU_TOP + CLIFF_BOTTOM) / 2,
    );
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Plateau-top decor: sparse puffy trees and plants, kept off the rail.
  const decor: Record<string, THREE.Matrix4[]> = { tree_round: [], bush: [], fern: [], grass: [] };
  for (const { side, widths } of outerEdges) {
    for (let i = 0; i < samples.length; i += 2) {
      const w = widths[i]!;
      if (w < 5 || rand() < 0.45) continue;
      const p = samples[i]!;
      const kind = decorKind(rand());
      const d = side * (hw[i]! + 3 + rand() * (w - 4));
      const s = 0.8 + rand() * 0.6;
      decor[kind]!.push(
        poseMatrix({ x: p.x + p.nx * d, y: p.y + p.ny * d, rot: rand() * 6.28 }, PLATEAU_TOP, [
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

/** Ferns, bushes and a puffy tree or two on every island big enough, from a seeded roll. */
function islandDecor(walls: readonly Box[], kit: Kit, rand: () => number): THREE.Group {
  const group = new THREE.Group();
  const decor: Record<string, THREE.Matrix4[]> = { fern: [], bush: [], tree_round: [] };
  for (const wall of walls.filter((w) => isIsland(w) && !isRock(w))) {
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
          ISLAND_TOP,
          [scale, scale, scale],
        ),
      );
    }
  }
  for (const [name, list] of Object.entries(decor))
    if (list.length) group.add(kit.instance(name, list));
  return group;
}

/**
 * Islands and plain walls from `level.walls`: thick boxes become octagonal islands with a teal
 * rim. Rock-sized islands are left to `buildRocks`.
 */
function buildWalls(walls: readonly Box[]): THREE.Group {
  const group = new THREE.Group();
  for (const wall of walls) {
    if (isRock(wall)) continue;
    if (!isIsland(wall)) {
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(wall.hx * 2, ISLAND_TOP + 0.4, wall.hy * 2),
        new THREE.MeshLambertMaterial({ color: COLORS.top }),
      );
      applyPose(slab, wall, (ISLAND_TOP - 0.4) / 2);
      group.add(slab);
      continue;
    }
    const r = islandRadius(wall);
    const island = mesa(r, ISLAND_TOP, -1.5, 8, COLORS.island);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(r * 1.02, 0.28, 6, 8),
      new THREE.MeshLambertMaterial({ color: COLORS.teal }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = ISLAND_TOP - island.position.y;
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

  // Ponds roll their own dice, so adding one leaves the rest of the course's decor where it was.
  const pondRand = mulberry32(hashString(`${level.name}:ponds`));
  root.add(
    buildWalls(level.walls),
    islandDecor(level.walls, kit, rand),
    buildRocks(level.walls, pondRand),
  );
  if (level.channel) {
    const channel = buildChannel(level.channel, water, rand);
    root.add(
      buildPondDecor(
        level.channel,
        channel.samples,
        level.walls,
        WALL_FOOT + WALL_LEAN,
        PLATEAU_TOP,
        pondRand,
      ),
    );
    root.add(channel.group, scatterMesas(channel.samples, maxHalfWidth(level.channel), rand));
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
