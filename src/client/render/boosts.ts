import * as THREE from "three";
import type { Box, LevelData, SimEvent } from "../../sim/types.ts";
import { applyPose } from "./coords.ts";

// Boost pads: chunky red `>>` chevrons with a white rim, floating on the water and pointing along
// the pad (sim `rot`). They chase-blink back to front so they read from the chase camera, and a
// pad the raft runs onto flashes and pops.

const RED = 0xf0472c;
const GLOW = new THREE.Color(0xffb25a);
const RIM = 0xffffff;
/** Chevrons per pad, and their arm depth, arm thickness (both along the pad) and rim width, m. */
const CHEVRONS = 2;
const DEPTH = 0.95;
const THICK = 0.85;
const RIM_W = 0.16;
const TOP_Y = 0.07;
const RIM_Y = 0.03;
/** Seconds a chase blink takes to run over one pad, and how long a hit pad flashes. */
const CHASE = 0.9;
const FLASH = 0.6;

/**
 * A chevron with its tip at the origin pointing +x, arms reaching `half` m to either side and
 * `DEPTH` m back, `THICK` thick. `grow` pushes every edge out (the rim behind the red top).
 */
function chevron(half: number, grow = 0): THREE.Shape {
  const front = grow;
  const back = -THICK - grow;
  const h = half + grow;
  return new THREE.Shape([
    new THREE.Vector2(-DEPTH + front, h),
    new THREE.Vector2(front, 0),
    new THREE.Vector2(-DEPTH + front, -h),
    new THREE.Vector2(-DEPTH + back, -h),
    new THREE.Vector2(back, 0),
    new THREE.Vector2(-DEPTH + back, h),
  ]);
}

/** Shape space (x forward, y left) extruded up: the sim frame on the water, Y up. */
function slab(shape: THREE.Shape, depth: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

type Pad = { box: Box; root: THREE.Group; tops: THREE.MeshLambertMaterial[]; flash: number };

export function createBoostPads(level: LevelData) {
  const group = new THREE.Group();
  const rim = new THREE.MeshLambertMaterial({ color: RIM });
  const pads: Pad[] = (level.boosts ?? []).map((box) => {
    const root = new THREE.Group();
    applyPose(root, box);
    // Spread the chevrons over the pad's length, tips toward its front end.
    const half = box.hy - RIM_W;
    const pitch = (2 * box.hx - DEPTH - THICK) / Math.max(1, CHEVRONS - 1);
    const tops = Array.from({ length: CHEVRONS }, (_, i) => {
      const tip = box.hx - RIM_W - i * pitch;
      const top = new THREE.MeshLambertMaterial({
        color: RED,
        emissive: GLOW,
        emissiveIntensity: 0,
      });
      const red = new THREE.Mesh(slab(chevron(half - RIM_W), 0.06), top);
      const white = new THREE.Mesh(slab(chevron(half - RIM_W, RIM_W), 0.05), rim);
      red.position.set(tip, TOP_Y, 0);
      white.position.set(tip, RIM_Y, 0);
      red.receiveShadow = white.receiveShadow = true;
      root.add(red, white);
      return top;
    });
    group.add(root);
    return { box, root, tops, flash: 0 };
  });

  return {
    group,
    onEvent(e: SimEvent) {
      if (e.type !== "boost") return;
      // The pad under the raft: the nearest one.
      let best: Pad | undefined;
      let bestD = Infinity;
      for (const pad of pads) {
        const d = Math.hypot(pad.box.x - e.x, pad.box.y - e.y);
        if (d < bestD) [best, bestD] = [pad, d];
      }
      if (best) best.flash = FLASH;
    },
    update(time: number, dt: number) {
      for (const pad of pads) {
        pad.flash = Math.max(0, pad.flash - dt);
        const hit = pad.flash / FLASH;
        // Chase lights: a glow runs from the back chevron to the front one, over and over.
        pad.tops.forEach((top, i) => {
          const phase = (time / CHASE - (CHEVRONS - 1 - i) / CHEVRONS) % 1;
          const chase = Math.max(0, 1 - Math.abs(phase - 0.25) * 3);
          top.emissiveIntensity = Math.max(chase * 0.55, hit);
        });
        const pop = 1 + 0.25 * Math.sin(hit * Math.PI);
        pad.root.scale.set(pop, 1 + hit * 2, pop);
        pad.root.position.y = 0.03 * Math.sin(time * 2.2 + pad.box.x);
      }
    },
  };
}
