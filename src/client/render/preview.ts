import * as THREE from "three";
import type { Look } from "../../look.ts";
import { loadKit } from "./kit.ts";
import { dress, type Dressed } from "./outfits.ts";
import { cloneRig, kitRiders } from "./riders.ts";

export type LookPreview = {
  show(look: Look): void;
  dispose(): void;
};

/** Frees a rider copy's materials (tinted clones); its geometry is the kit's. */
const free = (root: THREE.Object3D) =>
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
  });

/**
 * A small turntable that shows one rider in a look, for the wardrobe. Its own renderer and
 * WebGL context, freed by `dispose()`.
 */
export async function createLookPreview(host: HTMLElement): Promise<LookPreview> {
  const kit = await loadKit();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.domElement.classList.add("wardrobe-canvas");
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xf2f8ff, 0xf3c3a4, 2.4));
  const sun = new THREE.DirectionalLight(0xfff6e8, 1.4);
  sun.position.set(3, 5, 2);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  // Feet at 0, the tallest hats end near 3 m: frame all of it.
  camera.position.set(6.2, 2.4, 0);
  camera.lookAt(0, 1.5, 0);

  const raft = kit.clone("raft");
  const templates = kitRiders(raft);
  const stand = new THREE.Group();
  scene.add(stand);

  let rider: { body: THREE.Object3D; dressed: Dressed } | undefined;

  const resize = () => {
    const w = host.clientWidth || 200;
    const h = host.clientHeight || 220;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  let frame = 0;
  let last = performance.now() / 1000;
  const loop = () => {
    const now = performance.now() / 1000;
    const dt = Math.min(0.05, now - last);
    last = now;
    stand.rotation.y = Math.sin(now * 0.7) * 0.9 + 0.5;
    stand.position.y = Math.abs(Math.sin(now * 2.2)) * 0.05;
    rider?.dressed.update(now, dt);
    renderer.render(scene, camera);
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  return {
    show(look) {
      if (rider) {
        rider.dressed.remove();
        rider.body.removeFromParent();
        free(rider.body);
      }
      const rig = cloneRig(templates, 0, look);
      rig.body.position.set(0, 0, 0);
      rig.body.rotation.set(0, 0, 0);
      rig.body.visible = true;
      // Arms rest forward on the ring in the race; here they hang a little forward.
      rig.armL?.rotation.set(0, 0, 0.5);
      rig.armR?.rotation.set(0, 0, 0.5);
      stand.add(rig.body);
      rider = { body: rig.body, dressed: dress(rig.body, rig.head, look) };
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      rider?.dressed.remove();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      if (rider) free(rider.body);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
