import * as THREE from "three";
import type { Seat } from "../../sim/constants";
import type { LevelData, SimEvent, Snapshot } from "../../sim/types";
import { applyPose, lerpPose } from "./coords";
import { createSky, createWater, HAZE } from "./env";
import { loadKit } from "./kit";
import { createChaseCamera } from "./chaseCamera";
import { createRaftMotion } from "./raftMotion";
import { createRiderAnimator } from "./riders";
import { buildTerrain } from "./terrain";

export type SceneView = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Feed every drained SimEvent here; animation reacts to events and snapshots only. */
  onEvent(e: SimEvent): void;
  draw(prev: Snapshot, curr: Snapshot, alpha: number, shake: THREE.Vector3): void;
};

const SUN_OFFSET = new THREE.Vector3(22, 40, 12);

export async function createScene(
  canvasHost: HTMLElement,
  level: LevelData,
  seats: readonly Seat[],
): Promise<SceneView> {
  const kit = await loadKit();

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  canvasHost.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HAZE, 45, 170);
  const sky = createSky();
  scene.add(sky);
  scene.add(new THREE.HemisphereLight(0xf2f8ff, 0xf3c3a4, 2.2));

  const sun = new THREE.DirectionalLight(0xfff6e8, 1.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -30;
  cam.right = cam.top = 30;
  cam.near = 1;
  cam.far = 120;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  scene.add(sun, sun.target);

  const water = createWater();
  if (!level.channel) scene.add(water.plane);
  const terrain = buildTerrain(level, kit, water.material);
  scene.add(terrain.group);

  const hazardMeshes = new Map(
    level.hazards.map((h) => {
      const mesh = kit.clone(h.kind);
      if (h.kind === "spinner") mesh.scale.set(h.hx, h.hy, h.hy);
      else mesh.scale.set(h.hx, 1, 1);
      scene.add(mesh);
      return [h.id, mesh] as const;
    }),
  );

  const raft = kit.clone("raft");
  scene.add(raft);

  const riders = createRiderAnimator(raft, level, seats);
  const motion = createRaftMotion(raft);
  const chase = createChaseCamera(level);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 700);
  let lastDraw = performance.now() / 1000;

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener("resize", resize);
  resize();

  return {
    renderer,
    scene,
    camera,
    onEvent(e) {
      const t = performance.now() / 1000;
      riders.onEvent(e, t);
      motion.onEvent(e, t);
      terrain.onEvent(e);
    },
    draw(prev, curr, alpha, shake) {
      const now = performance.now() / 1000;
      const dt = Math.min(0.05, Math.max(0.001, now - lastDraw));
      lastDraw = now;
      const pose = lerpPose(prev.raft, curr.raft, alpha);
      applyPose(raft, pose);
      motion.update(dt, now, prev, curr, pose);
      riders.update(dt, now, prev, curr, pose);
      curr.hazards.forEach((h, i) => {
        const def = level.hazards.find((d) => d.id === h.id);
        const mesh = hazardMeshes.get(h.id);
        if (mesh && def)
          applyPose(
            mesh,
            lerpPose(prev.hazards[i] ?? h, h, alpha),
            def.kind === "spinner" ? def.hy : 0,
          );
      });
      chase.update(camera, dt, pose, curr, motion.vel, motion.thrust, shake);
      // Tight shadow frustum that follows the raft.
      sun.target.position.set(pose.x, 0, -pose.y);
      sun.position.copy(sun.target.position).add(SUN_OFFSET);
      sky.position.copy(camera.position);
      terrain.update(now, pose);
      water.update(now);
      renderer.render(scene, camera);
    },
  };
}
