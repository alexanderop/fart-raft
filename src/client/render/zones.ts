import * as THREE from "three";
import { RAFT_HULL, RAFT_RADIUS, type Zone } from "../../sim/constants";

/** One color per seat, shared by the zone marks and the name tags. */
export const SEAT_COLORS = ["#ff8a3d", "#3d9bff", "#b07cff", "#ffd23f"] as const;

const DECK_Y = 0.41; // just above the kit raft's floor (top ≈ 0.39)
const DECK_EDGE = RAFT_RADIUS - 0.3; // where the deck meets the ring tube
const WATER_Y = 0.03;
const BAND_IN = RAFT_RADIUS + 0.05;
const BAND_OUT = RAFT_HULL;

/** CircleGeometry/RingGeometry sweep from +x toward +y; rotateX(-90°) maps that onto sim → three. */
const flat = <T extends THREE.BufferGeometry>(geo: T): T => geo.rotateX(-Math.PI / 2);

/**
 * Each rider's stretch of the ring: a colored band on the water where it wades, plus a tinted
 * wedge of deck, with white dividers between seats. A child of the raft, so it bobs and turns
 * along. A solo rider owns the whole ring: no marks.
 */
export function createZoneMarks(zones: readonly Zone[]): THREE.Group {
  const group = new THREE.Group();
  group.name = "zones";
  if (zones.length < 2) return group;

  const divider = new THREE.MeshBasicMaterial({ color: 0xffffff });
  zones.forEach((zone, i) => {
    const start = zone.center - zone.half;
    const len = zone.half * 2;
    const color = SEAT_COLORS[i];
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
