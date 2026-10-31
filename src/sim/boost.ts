import { BOOST_ACCEL, BOOST_REACH, BOOST_SPEED, STEP } from "./constants.ts";
import type { Raft } from "./raft.ts";
import type { Box, Vec2 } from "./types.ts";

/** Index of the boost pad under `p` (within BOOST_REACH m of its box), or -1. */
export function padAt(pads: readonly Box[], p: Vec2): number {
  return pads.findIndex((pad) => {
    const dx = p.x - pad.x;
    const dy = p.y - pad.y;
    const c = Math.cos(pad.rot);
    const s = Math.sin(pad.rot);
    return (
      Math.abs(dx * c + dy * s) <= pad.hx + BOOST_REACH &&
      Math.abs(-dx * s + dy * c) <= pad.hy + BOOST_REACH
    );
  });
}

/** One tick on a pad: speed up along it, never past BOOST_SPEED that way. */
export function boostRaft(raft: Raft, pad: Box): void {
  const dir = { x: Math.cos(pad.rot), y: Math.sin(pad.rot) };
  const v = raft.body.linvel();
  const gain = Math.min(BOOST_ACCEL * STEP, BOOST_SPEED - (v.x * dir.x + v.y * dir.y));
  if (gain <= 0) return;
  const k = gain * raft.body.mass();
  raft.body.applyImpulse({ x: dir.x * k, y: dir.y * k }, true);
}
