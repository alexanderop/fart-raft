import * as THREE from "three";
import { crewZones } from "../../sim/constants.ts";
import { hazardTime } from "../../sim/hazards/shape.ts";
import type { HazardDef, LevelData, SimEvent, View } from "../../sim/types.ts";
import { applyPose, lerpPose } from "./coords.ts";
import { createSky, createWater, HAZE } from "./env.ts";
import { loadKit } from "./kit.ts";
import { createBoostPads } from "./boosts.ts";
import { createChaseCamera } from "./chaseCamera.ts";
import { createHazardView, type HazardView } from "./hazards.ts";
import { createRaftMotion } from "./raftMotion.ts";
import { createRiderAnimator } from "./riders.ts";
import { createRivals, type RivalFrame } from "./rivals.ts";
import { buildTerrain } from "./terrain.ts";
import { createZoneMarks } from "./zones.ts";
import { lookColor, type Look } from "../../look.ts";
import { createPixelRatioGovernor, detectQuality } from "./quality.ts";

export type SceneView = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Feed every drained SimEvent of our raft here; animation reacts to events and snapshots only. */
  onEvent(e: SimEvent): void;
  /** Another raft's event (team race): only that raft's hull and riders react. */
  onRivalEvent(e: SimEvent): void;
  /** Our raft from `prev`/`curr`, the camera behind it, and each rival raft. */
  draw(
    prev: View,
    curr: View,
    alpha: number,
    shake: THREE.Vector3,
    rivals: readonly RivalFrame[],
  ): void;
  /** One look per rider (animal, color, costume); cheap to call every frame. */
  setLooks(looks: readonly Look[]): void;
  /** Frees the GPU side (geometries, materials, textures, the WebGL context) and removes the canvas. */
  dispose(): void;
};

const SUN_OFFSET = new THREE.Vector3(22, 40, 12);

/** Frees every geometry, material and texture the scene graph holds. */
function disposeGraph(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
  });
  for (const m of materials) {
    for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
    if (m instanceof THREE.ShaderMaterial) {
      for (const u of Object.values(m.uniforms))
        if (u.value instanceof THREE.Texture) u.value.dispose();
    }
    m.dispose();
  }
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
  scene.add(new THREE.HemisphereLight(0xf2f8ff, 0xf3c3a4, 2.2));

  const sun = new THREE.DirectionalLight(0xfff6e8, 1.3);
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
  const boosts = createBoostPads(level);
  scene.add(boosts.group);

  // Each view with its kind: hazard time runs at the kind's rate (`hazardTime`).
  const hazards = new Map<string, { view: HazardView; kind: HazardDef["kind"] }>(
    level.hazards.map((h) => {
      const view = createHazardView(kit, h);
      scene.add(view.root);
      return [h.id, { view, kind: h.kind }] as const;
    }),
  );

  const raft = kit.clone("raft");
  scene.add(raft);
  let marks: THREE.Group | undefined;
  let marked = "";
  let colors: string[] = [];
  /** Rider colors on the ring for `crew` riders, rebuilt whenever the crew or a color changes. */
  const markCrew = (crew: number) => {
    const key = `${crew}|${colors.slice(0, crew).join()}`;
    if (key === marked) return;
    marked = key;
    if (marks) {
      raft.remove(marks);
      disposeGraph(marks);
    }
    marks = createZoneMarks(crewZones(crew), colors);
    raft.add(marks);
  };

  const riders = createRiderAnimator(raft, level);
  const rivals = createRivals(scene, kit, level);
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
  const observer = new ResizeObserver(resize);
  observer.observe(renderer.domElement);
  addEventListener("resize", resize);
  visualViewport?.addEventListener("resize", resize);
  resize();

  return {
    renderer,
    scene,
    camera,
    setLooks(looks) {
      colors = looks.map(lookColor);
      riders.setLooks(looks);
    },
    onEvent(e) {
      const t = performance.now() / 1000;
      riders.onEvent(e, t);
      motion.onEvent(e, t);
      terrain.onEvent(e);
      boosts.onEvent(e);
    },
    onRivalEvent(e) {
      rivals.onEvent(e, performance.now() / 1000);
    },
    draw(prev, curr, alpha, shake, rivalFrames) {
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
      rivals.update(dt, now, rivalFrames, alpha);
      // The camera is where it was last frame: close enough to tell what hides the raft.
      const eye = { camera: camera.position, raft: pose };
      // Hazard time between the two snapshots: online they are FRAME_TICKS apart, not one.
      const tick = prev.tick + (curr.tick - prev.tick) * alpha;
      curr.hazards.forEach((h, i) => {
        const hazard = hazards.get(h.id);
        if (!hazard) return;
        const t = hazardTime(curr.difficulty, tick, hazard.kind);
        hazard.view.update(lerpPose(prev.hazards[i] ?? h, h, alpha), t, eye);
      });
      chase.update(camera, dt, pose, curr, motion.vel, motion.thrust, shake);
      // Tight shadow frustum that follows the raft.
      sun.target.position.set(pose.x, 0, -pose.y);
      sun.position.copy(sun.target.position).add(SUN_OFFSET);
      sky.position.copy(camera.position);
      terrain.update(now, pose, camera);
      boosts.update(now, dt);
      water.update(now);
      renderer.render(scene, camera);
    },
    dispose() {
      observer.disconnect();
      removeEventListener("resize", resize);
      visualViewport?.removeEventListener("resize", resize);
      disposeGraph(scene);
      sun.shadow.dispose();
      renderer.dispose();
      // Browsers cap live WebGL contexts per page: drop this one now rather than on GC.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
