import * as THREE from "three";
import { crewZones, STEP } from "../../sim/constants.ts";
import type { LevelData, SimEvent, Snapshot } from "../../sim/types.ts";
import { applyPose, lerpPose } from "./coords.ts";
import { createSky, createWater, HAZE } from "./env.ts";
import { loadKit } from "./kit.ts";
import { createChaseCamera } from "./chaseCamera.ts";
import { createHazardView, type HazardView } from "./hazards.ts";
import { createRaftMotion } from "./raftMotion.ts";
import { createRiderAnimator } from "./riders.ts";
import { buildTerrain } from "./terrain.ts";
import { createZoneMarks } from "./zones.ts";
import { createPixelRatioGovernor, detectQuality } from "./quality.ts";

export type SceneView = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Feed every drained SimEvent here; animation reacts to events and snapshots only. */
  onEvent(e: SimEvent): void;
  draw(prev: Snapshot, curr: Snapshot, alpha: number, shake: THREE.Vector3): void;
};

const SUN_OFFSET = new THREE.Vector3(22, 40, 12);

/** Frees a zone-marks group's GPU buffers. */
function disposeMarks(group: THREE.Object3D): void {
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    (o.material as THREE.Material).dispose();
  });
}

/** The crew size is read from each snapshot (`riders.length`), so a restart may change it. */
export async function createScene(canvasHost: HTMLElement, level: LevelData): Promise<SceneView> {
  const kit = await loadKit();

  const quality = detectQuality();
  const renderer = new THREE.WebGLRenderer({
    antialias: quality.antialias,
    powerPreference: "high-performance",
  });
  const governor = createPixelRatioGovernor(
    Math.min(devicePixelRatio, quality.maxPixelRatio),
    quality.minPixelRatio,
  );
  renderer.setPixelRatio(governor.ratio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.classList.add("game-canvas");
  canvasHost.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HAZE, 45, 170);
  const sky = createSky();
  scene.add(sky);
  scene.add(new THREE.HemisphereLight(0xa996e0, 0x3a2030, 1.6));

  const sun = new THREE.DirectionalLight(0xd6dcff, 1.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
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

  const hazards = new Map<string, HazardView>(
    level.hazards.map((h) => {
      const view = createHazardView(kit, h);
      scene.add(view.root);
      return [h.id, view] as const;
    }),
  );

  const raft = kit.clone("raft");
  scene.add(raft);
  let marks: THREE.Group | undefined;
  let markedCrew = -1;
  /** Seat colors on the ring for `crew` riders, rebuilt whenever the crew size changes. */
  const markCrew = (crew: number) => {
    if (crew === markedCrew) return;
    markedCrew = crew;
    if (marks) {
      raft.remove(marks);
      disposeMarks(marks);
    }
    marks = createZoneMarks(crewZones(crew));
    raft.add(marks);
  };

  const riders = createRiderAnimator(raft, level);
  const motion = createRaftMotion(raft);
  const chase = createChaseCamera(level);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 700);
  let lastDraw = performance.now() / 1000;

  // The canvas is CSS-sized to the viewport (`.game-canvas`), so its box already follows
  // rotation and the iOS address bar: size the drawing buffer from it.
  let width = 0;
  let height = 0;
  const resize = () => {
    const canvas = renderer.domElement;
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    if (w === width && h === height) return;
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(renderer.domElement);
  addEventListener("resize", resize);
  visualViewport?.addEventListener("resize", resize);
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
      const lowered = governor.frame((now - lastDraw) * 1000);
      if (lowered !== undefined) {
        renderer.setPixelRatio(lowered); // also resizes the drawing buffer
      }
      const dt = Math.min(0.05, Math.max(0.001, now - lastDraw));
      lastDraw = now;
      const pose = lerpPose(prev.raft, curr.raft, alpha);
      markCrew(curr.riders.length);
      applyPose(raft, pose);
      motion.update(dt, now, prev, curr, pose);
      riders.update(dt, now, prev, curr, alpha, pose);
      curr.hazards.forEach((h, i) => {
        hazards
          .get(h.id)
          ?.update(lerpPose(prev.hazards[i] ?? h, h, alpha), (prev.tick + alpha) * STEP);
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
