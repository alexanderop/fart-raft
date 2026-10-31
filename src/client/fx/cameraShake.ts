import { Vector3 } from "three";
import type { SimEvent } from "../../sim/types.ts";

const DECAY = 4; // trauma lost per second

export function createCameraShake() {
  let trauma = 0;
  const offset = new Vector3();
  return {
    onEvent(e: SimEvent) {
      if (e.type === "bump") trauma = Math.min(1, trauma + e.speed * 0.08);
      if (e.type === "checkpoint") trauma = Math.min(1, trauma + 0.2);
      if (e.type === "hit") trauma = 1;
      if (e.type === "boost") trauma = Math.min(1, trauma + 0.25);
    },
    update(dt: number): Vector3 {
      trauma = Math.max(0, trauma - DECAY * dt);
      const k = trauma * trauma * 0.8;
      return offset.set(
        (Math.random() - 0.5) * k,
        (Math.random() - 0.5) * k,
        (Math.random() - 0.5) * k,
      );
    },
  };
}
