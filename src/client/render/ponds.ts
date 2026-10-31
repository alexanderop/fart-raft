import * as THREE from "three";
import { halfWidthAt, pointAt, type Sample } from "../../sim/channel.ts";
import { POND_RAMP } from "../../sim/constants.ts";
import { isIsland, islandRadius } from "../../sim/island.ts";
import type { Box, Channel } from "../../sim/types.ts";
import { poseMatrix } from "./coords.ts";

// The calm ponds (`Channel.ponds`): lily pads on the still water off the racing line, and grey
// rocks, on the shore and as the small islands a course puts in the water.

/** An island no bigger than this (larger half-extent, m) is drawn as a grey rock, not a mesa. */
const ROCK_MAX_HALF = 1.5;
/** Pads keep this far (m) off the centerline, so the racing line stays open water. */
const PAD_CLEAR = 8;
const PADS_PER_POND = 22;

const COLORS = {
  rock: 0x9a9ca3,
  pad: 0x72c447,
  flower: 0xff9ad2,
};

export const isRock = (wall: Box): boolean =>
  isIsland(wall) && Math.max(wall.hx, wall.hy) <= ROCK_MAX_HALF;

/** A chunky low-poly boulder of radius `r`, its base a little under the water. */
function boulder(r: number, rand: () => number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const k = 0.85 + rand() * 0.3;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
  }
  g.scale(r, r * 0.8, r);
  g.translate(0, r * 0.45, 0);
  g.computeVertexNormals();
  return g;
}

const rockMaterial = () => new THREE.MeshLambertMaterial({ color: COLORS.rock, flatShading: true });

/** A grey rock for each rock-sized island in `walls`, sized to its octagon. */
export function buildRocks(walls: readonly Box[], rand: () => number): THREE.Group {
  const group = new THREE.Group();
  const material = rockMaterial();
  for (const wall of walls.filter(isRock)) {
    const mesh = new THREE.Mesh(boulder(islandRadius(wall), rand), material);
    mesh.position.set(wall.x, -0.2, -wall.y);
    mesh.rotation.y = rand() * Math.PI * 2;
    mesh.castShadow = true;
    group.add(mesh);
  }
  return group;
}

/**
 * Lily pads and shore rocks for every pond of `ch`. `shore` is how far past the bank line (m) the
 * plateau top starts, where the shore rocks sit at height `top`.
 */
export function buildPondDecor(
  ch: Channel,
  samples: readonly Sample[],
  walls: readonly Box[],
  shore: number,
  top: number,
  rand: () => number,
): THREE.Group {
  const group = new THREE.Group();
  const pads: THREE.Matrix4[] = [];
  const flowers: THREE.Matrix4[] = [];
  const rocks = walls.filter(isRock);
  const shoreRock = rockMaterial();
  for (const pond of ch.ponds ?? []) {
    for (let n = 0, tries = 0; n < PADS_PER_POND && tries < PADS_PER_POND * 6; tries++) {
      const s = pond.from + POND_RAMP * 0.4 + rand() * (pond.to - pond.from - POND_RAMP * 0.8);
      const hw = halfWidthAt(ch, s);
      const room = hw - 1.2 - PAD_CLEAR;
      if (room <= 0) continue;
      const lat = (rand() < 0.5 ? 1 : -1) * (PAD_CLEAR + rand() * room);
      const p = pointAt(samples, s);
      const x = p.x + p.nx * lat;
      const y = p.y + p.ny * lat;
      if (rocks.some((r) => Math.hypot(r.x - x, r.y - y) < islandRadius(r) + 1)) continue;
      const size = 0.55 + rand() * 0.5;
      pads.push(poseMatrix({ x, y, rot: rand() * Math.PI * 2 }, 0.04, [size, 1, size]));
      if (rand() < 0.3) flowers.push(poseMatrix({ x, y, rot: 0 }, 0.04, [size, size, size]));
      n++;
    }
    // A couple of boulders on each shore, on the plateau just past the coral wall.
    for (const side of [1, -1]) {
      for (let k = 0; k < 2; k++) {
        const s = pond.from + (pond.to - pond.from) * (0.3 + 0.4 * rand());
        const p = pointAt(samples, s);
        const d = side * (halfWidthAt(ch, s) + shore + 0.8 + rand() * 2);
        const r = 1.3 + rand() * 1.1;
        const mesh = new THREE.Mesh(boulder(r, rand), shoreRock);
        mesh.position.set(p.x + p.nx * d, top - 0.3, -(p.y + p.ny * d));
        mesh.rotation.y = rand() * Math.PI * 2;
        mesh.castShadow = true;
        group.add(mesh);
      }
    }
  }
  if (pads.length) {
    // A round pad with the lily's notch cut out of it, lying flat on the water.
    const pad = new THREE.CircleGeometry(1, 14, 0.35, Math.PI * 2 - 0.7).rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(
      pad,
      new THREE.MeshLambertMaterial({ color: COLORS.pad, side: THREE.DoubleSide }),
      pads.length,
    );
    pads.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (flowers.length) {
    const bloom = new THREE.ConeGeometry(0.22, 0.28, 6).translate(0.15, 0.14, 0.1);
    const mesh = new THREE.InstancedMesh(
      bloom,
      new THREE.MeshLambertMaterial({ color: COLORS.flower, flatShading: true }),
      flowers.length,
    );
    flowers.forEach((m, i) => mesh.setMatrixAt(i, m));
    group.add(mesh);
  }
  return group;
}
