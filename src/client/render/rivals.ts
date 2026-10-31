import * as THREE from "three";
import type { Contact, LevelData, SimEvent, View } from "../../sim/types.ts";
import type { Look } from "../../look.ts";
import { teamColor } from "../teams.ts";
import { applyPose, lerpPose } from "./coords.ts";
import type { Kit } from "./kit.ts";
import { createRaftMotion, type RaftMotion } from "./raftMotion.ts";
import { createRiderAnimator, type RiderAnimator } from "./riders.ts";
import { createTeamRing } from "./zones.ts";

/** How see-through a Ghost race's rival raft is drawn (GR-1: about 40%). */
const GHOST_OPACITY = 0.4;

/** One rival raft as the renderer needs it: its index and two views to blend between. */
export type RivalFrame = { raft: number; prev: View; curr: View; looks: readonly Look[] };

type RivalRaft = {
  root: THREE.Object3D;
  ring: THREE.Group;
  riders: RiderAnimator;
  motion: RaftMotion;
  contact: Contact;
};

/**
 * The other rafts of a team race: each a copy of the kit raft with its riders (animated like
 * ours, from that raft's events and views) and a ring in its team color. In a Ghost race every
 * material is swapped for a see-through copy (the kit shares materials with our own raft).
 */
export function createRivals(scene: THREE.Scene, kit: Kit, level: LevelData) {
  const rafts = new Map<number, RivalRaft>();
  /** Ghost copies by original material, so a re-dressed rider reuses them. */
  const ghosts = new Map<THREE.Material, THREE.Material>();
  const ghostly = new Set<THREE.Material>();

  const ghostOf = (m: THREE.Material): THREE.Material => {
    if (ghostly.has(m)) return m;
    let g = ghosts.get(m);
    if (!g) {
      g = m.clone();
      g.transparent = true;
      g.opacity = m.opacity * GHOST_OPACITY;
      g.depthWrite = false;
      ghosts.set(m, g);
      ghostly.add(g);
    }
    return g;
  };

  /** Every mesh under `root` on its ghost material; cheap once done, so run every frame (riders re-dress). */
  const ghost = (root: THREE.Object3D) =>
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = false;
      o.material = Array.isArray(o.material) ? o.material.map(ghostOf) : ghostOf(o.material);
    });

  const drop = (raft: number) => {
    const r = rafts.get(raft);
    if (!r) return;
    r.root.removeFromParent();
    // The hull and riders share the kit's materials (or the ghost copies, kept for reuse): free only the ring.
    r.ring.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      for (const m of [o.material].flat()) if (m instanceof THREE.Material) m.dispose();
    });
    rafts.delete(raft);
  };

  const make = (raft: number, contact: Contact): RivalRaft => {
    const root = kit.clone("raft");
    root.name = `rival_${raft}`;
    const ring = createTeamRing(teamColor(raft));
    root.add(ring);
    scene.add(root);
    const riders = createRiderAnimator(root, level);
    const r = { root, ring, riders, motion: createRaftMotion(root), contact };
    rafts.set(raft, r);
    return r;
  };

  return {
    /** A rival raft's event: its riders and hull react, as ours do to our events. */
    onEvent(e: SimEvent, now: number) {
      if (e.type === "go") return;
      const r = rafts.get(e.raft);
      r?.riders.onEvent(e, now);
      r?.motion.onEvent(e, now);
    },
    update(dt: number, now: number, rivals: readonly RivalFrame[], alpha: number) {
      for (const raft of rafts.keys()) if (!rivals.some((f) => f.raft === raft)) drop(raft);
      for (const { raft, prev, curr, looks } of rivals) {
        // A Bump rematch after a Ghost race (or back) gets a fresh raft with the kit's own materials.
        if (rafts.get(raft)?.contact !== curr.contact) drop(raft);
        const r = rafts.get(raft) ?? make(raft, curr.contact);
        const pose = lerpPose(prev.raft, curr.raft, alpha);
        r.riders.setLooks(looks);
        applyPose(r.root, pose);
        r.motion.update(dt, now, prev, curr, pose);
        r.riders.update(dt, now, prev, curr, alpha, pose);
        if (curr.contact === "ghost") ghost(r.root);
      }
    },
  };
}
