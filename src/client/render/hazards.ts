import * as THREE from "three";
import { bumperRadius } from "../../sim/hazards/shape.ts";
import type { HazardDef, Pose } from "../../sim/types.ts";
import { applyPose } from "./coords.ts";
import type { Kit } from "./kit.ts";

/** One hazard's mesh, kept in step with its sim pose. */
export type HazardView = {
  root: THREE.Object3D;
  /** `pose` is the interpolated sim pose, `t` the sim time (s) the frame shows. */
  update(pose: Pose, t: number): void;
};

/**
 * `log` in the kit: half-length and radius of the template (its spike tips included). It is
 * scaled by (hx / LOG_HALF, hy, hy), so a log built with hx = LOG_HALF · hy is not distorted.
 */
const LOG_HALF = 2.4;
/** A bumper floats and bobs this high (m) and this fast (relative to its pulse). */
const BOB = 0.08;

export function createHazardView(kit: Kit, def: HazardDef): HazardView {
  const mesh = kit.clone(def.kind);
  switch (def.kind) {
    case "spinner":
      mesh.scale.set(def.hx, def.hy, def.hy);
      return {
        root: mesh,
        update: (pose) => applyPose(mesh, pose, def.hy),
      };
    case "sweeper":
      mesh.scale.set(def.hx, 1, 1);
      return { root: mesh, update: (pose) => applyPose(mesh, pose) };
    case "log": {
      // The log rolls across its axis: the holder follows the sim pose, the mesh spins as it travels.
      mesh.scale.set(def.hx / LOG_HALF, def.hy, def.hy);
      const holder = new THREE.Group();
      holder.add(mesh);
      return {
        root: holder,
        update(pose) {
          applyPose(holder, pose);
          // Distance travelled along the sim's left of the axis, from where the log started.
          const run = -(pose.x - def.x) * Math.sin(def.rot) + (pose.y - def.y) * Math.cos(def.rot);
          mesh.rotation.x = -run / def.hy;
        },
      };
    }
    case "bumper": {
      // Faces upstream, so the grin greets the raft; swells with the sim's pulse and bobs on the water.
      const holder = new THREE.Group();
      mesh.rotation.y = Math.PI;
      holder.add(mesh);
      return {
        root: holder,
        update(pose, t) {
          const r = bumperRadius(def, t);
          holder.scale.setScalar(r);
          applyPose(holder, pose, BOB * Math.sin(t * def.speed * 1.5 + (def.phase ?? 0)));
        },
      };
    }
  }
}
