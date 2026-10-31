import * as THREE from "three";
import { LOOK_COLORS } from "../../look.ts";
import { RAFT_HULL, RAFT_RADIUS, type Zone } from "../../sim/constants.ts";

/** One color per seat until its player picks one: the first eight look colors. */
export const SEAT_COLORS = LOOK_COLORS.slice(0, 8);

const DECK_Y = 0.41; // just above the kit raft's floor (top ≈ 0.39)
const DECK_EDGE = RAFT_RADIUS - 0.3; // where the deck meets the ring tube
const WATER_Y = 0.03;
const BAND_IN = RAFT_RADIUS + 0.05;
const BAND_OUT = RAFT_HULL;

/** CircleGeometry/RingGeometry sweep from +x toward +y; rotateX(-90°) maps that onto sim → three. */
const flat = <T extends THREE.BufferGeometry>(geo: T): T => geo.rotateX(-Math.PI / 2);

/**
 * Each rider's stretch of the ring in its color (`colors[i]`, else the seat color): a colored band on the water where it wades, plus a tinted
 * wedge of deck, with white dividers between seats. A child of the raft, so it bobs and turns
 * along. A solo rider owns the whole ring: no marks.
 */
export function createZoneMarks(
  zones: readonly Zone[],
  colors: readonly string[] = SEAT_COLORS,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "zones";
  if (zones.length < 2) return group;

  const divider = new THREE.MeshBasicMaterial({ color: 0xffffff });
  zones.forEach((zone, i) => {
    const start = zone.center - zone.half;
    const len = zone.half * 2;
    const color = colors[i] ?? SEAT_COLORS[i % SEAT_COLORS.length];
    const tint = (opacity: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });

    const deck = new THREE.Mesh(
      flat(new THREE.CircleGeometry(DECK_EDGE, 32, start, len)),
      tint(0.4),
    );
    deck.position.y = DECK_Y;
    const band = new THREE.Mesh(
      flat(new THREE.RingGeometry(BAND_IN, BAND_OUT, 48, 1, start + 0.02, len - 0.04)),
      tint(0.4),
    );
    band.position.y = WATER_Y;
    group.add(deck, band);

    for (const [from, to, y] of [
      [0, DECK_EDGE, DECK_Y + 0.01],
      [BAND_IN, BAND_OUT, WATER_Y + 0.01],
    ] as const) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(to - from, 0.04, 0.09), divider);
      const mid = (from + to) / 2;
      line.position.set(Math.cos(start) * mid, y, -Math.sin(start) * mid);
      line.rotation.y = start;
      group.add(line);
    }
  });
  return group;
}
