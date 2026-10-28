import * as THREE from "three";
import { describe, expect, it } from "vite-plus/test";
import { fitWidth, portraitness } from "./chaseCamera.ts";
import { gateBlocksView } from "./gates.ts";

/** A gate's bar-and-sign box across a channel along sim +x: 1 m thick, 14 m wide, 4.5 to 8.3 m up. */
function gateAt(x: number): THREE.Vector3[] {
  return Array.from(
    { length: 8 },
    (_, i) =>
      // Sim (x, y, h) to three (x, h, -y).
      new THREE.Vector3(x + (i & 1 ? 0.5 : -0.5), i & 2 ? 8.3 : 4.5, i & 4 ? 7 : -7),
  );
}

/** Framed like chaseCamera.ts: landscape 10 m behind and 11.5 m up, portrait 5 m behind and 18.5 m up. */
function chaseCamera(raftX: number, aspect = 16 / 10): THREE.PerspectiveCamera {
  const tall = portraitness(aspect);
  const camera = new THREE.PerspectiveCamera(fitWidth(52, aspect), aspect, 0.1, 700);
  const lookAhead = 5 + 9 * tall;
  camera.position.set(raftX + lookAhead - (15 + 4 * tall), 11.5 + 7 * tall, 0);
  camera.lookAt(raftX + lookAhead, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

const raft = (x: number) => ({ x, y: 0, rot: 0 });

describe("given a gate across the channel", () => {
  describe("when the raft has just passed under it and the camera has not", () => {
    it("should count as blocking the view", () => {
      expect(gateBlocksView(gateAt(10), raft(14), chaseCamera(14))).toBe(true);
    });
  });

  describe("when the raft waits 4 m in front of it, on a phone in portrait", () => {
    it("should count as blocking the view", () => {
      expect(gateBlocksView(gateAt(2), raft(-2), chaseCamera(-2, 390 / 844))).toBe(true);
    });
  });

  describe("when the gate is far down the channel", () => {
    it("should not count as blocking", () => {
      expect(gateBlocksView(gateAt(40), raft(0), chaseCamera(0))).toBe(false);
    });
  });

  describe("when the camera has passed it too", () => {
    it("should not count as blocking", () => {
      expect(gateBlocksView(gateAt(10), raft(40), chaseCamera(40))).toBe(false);
    });
  });
});
