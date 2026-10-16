import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

/**
 * The Blender asset kit (public/models/kit.glb). Every top-level node is a named template.
 * A missing file or node falls back to a colored placeholder so the game still runs.
 */
export type Kit = {
  /** Deep clone, ready to place. */
  clone(name: string): THREE.Object3D;
  /**
   * One InstancedMesh per mesh in the template, one slot per matrix (matrices are in template space).
   * Each geometry gets an `aPivot` attribute (the slot's origin) so shaders can animate per instance.
   */
  instance(name: string, matrices: readonly THREE.Matrix4[]): THREE.Group;
};

const mat = (color: number) => new THREE.MeshLambertMaterial({ color });

function mesh(geo: THREE.BufferGeometry, color: number, y = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat(color));
  m.position.y = y;
  return m;
}

function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  g.add(...children);
  return g;
}

const PLACEHOLDERS: Record<string, () => THREE.Object3D> = {
  raft: () => {
    const g = group(mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.5, 32), 0xffd23f, 0.25));
    const seats = [
      [-1, 0.8],
      [-1, -0.8],
      [1, 0.8],
      [1, -0.8],
    ] as const;
    seats.forEach(([x, y], i) => {
      const r = mesh(
        new THREE.SphereGeometry(0.4, 12, 8),
        [0xff7a59, 0x4fc3f7, 0xb388ff, 0x9ccc65][i]!,
        0.9,
      );
      r.name = `rider_${i}`;
      r.position.x = x;
      r.position.z = -y;
      g.add(r);
    });
    return g;
  },
  spinner: () => {
    const m = mesh(new THREE.CylinderGeometry(1, 1, 2, 12), 0x8d5524);
    m.rotation.z = Math.PI / 2;
    return group(m);
  },
  gate_post: () => group(mesh(new THREE.BoxGeometry(0.4, 8.5, 0.4), 0xedb040, 4.25)),
  gate_bar: () => group(mesh(new THREE.BoxGeometry(2, 0.4, 0.4), 0xedb040)),
  gate_sign: () => group(mesh(new THREE.BoxGeometry(6.4, 1.6, 0.2), 0xe0502b)),
  finish_sign: () => group(mesh(new THREE.BoxGeometry(6.4, 1.6, 0.2), 0xfff3d9)),
  start_sign: () => group(mesh(new THREE.BoxGeometry(6.4, 1.6, 0.2), 0x3fc0b2)),
  // Pivot at the origin end, arm along +x, 2 m long. Scaled (len / 2, 1, 1).
  sweeper: () => {
    const m = mesh(new THREE.BoxGeometry(2, 0.6, 0.6), 0xd8329a, 0.45);
    m.position.x = 1;
    return group(m);
  },
  // 2 m along x. Spikes point toward local -z (sim +y, the channel side).
  spike_strip: () => {
    const spike = mesh(new THREE.ConeGeometry(0.1, 0.32, 6), 0xfffdf4, 0.2);
    spike.rotation.x = -Math.PI / 2;
    spike.position.z = -0.35;
    return group(mesh(new THREE.BoxGeometry(2, 0.5, 0.4), 0xb02fa8, 0.25), spike);
  },
  tree_round: () =>
    group(
      mesh(new THREE.CylinderGeometry(0.2, 0.3, 3.2, 6), 0x7a4a38, 1.6),
      mesh(new THREE.IcosahedronGeometry(1.5, 1), 0x3e9e2e, 3.9),
    ),
  bush: () => group(mesh(new THREE.IcosahedronGeometry(0.9, 0), 0x4bbf3f, 0.6)),
  fern: () => group(mesh(new THREE.ConeGeometry(0.6, 0.8, 5), 0xc8d44a, 0.4)),
  grass: () => group(mesh(new THREE.ConeGeometry(0.2, 0.7, 4), 0x6cc24a, 0.35)),
};

const FALLBACK = () => group(mesh(new THREE.BoxGeometry(1, 1, 1), 0xff00ff, 0.5));

export async function loadKit(url = `${import.meta.env.BASE_URL}models/kit.glb`): Promise<Kit> {
  const templates = new Map<string, THREE.Object3D>();
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    for (const node of gltf.scene.children.slice()) {
      node.removeFromParent();
      // Blender may lay assets out side by side; the contract is "origin at the asset".
      node.position.set(0, 0, 0);
      node.rotation.set(0, 0, 0);
      node.scale.set(1, 1, 1);
      node.updateMatrixWorld(true);
      templates.set(node.name, node);
    }
  } catch (err) {
    console.warn("kit.glb not usable, using placeholders", err);
  }

  const template = (name: string): THREE.Object3D => {
    let t = templates.get(name);
    if (!t) {
      if (!(name in PLACEHOLDERS)) console.warn(`kit: unknown asset "${name}"`);
      t = (PLACEHOLDERS[name] ?? FALLBACK)();
      t.updateMatrixWorld(true);
      templates.set(name, t);
    }
    return t;
  };

  return {
    clone(name) {
      const c = cloneSkinned(template(name));
      c.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      return c;
    },
    instance(name, matrices) {
      const root = template(name);
      const out = new THREE.Group();
      const tmp = new THREE.Matrix4();
      root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const geometry = o.geometry.clone();
        const pivots = new Float32Array(matrices.length * 3);
        matrices.forEach((m, i) => {
          pivots[i * 3] = m.elements[12]!;
          pivots[i * 3 + 1] = m.elements[13]!;
          pivots[i * 3 + 2] = m.elements[14]!;
        });
        geometry.setAttribute("aPivot", new THREE.InstancedBufferAttribute(pivots, 3));
        const im = new THREE.InstancedMesh(geometry, o.material, matrices.length);
        matrices.forEach((m, i) => im.setMatrixAt(i, tmp.multiplyMatrices(m, o.matrixWorld)));
        im.castShadow = true;
        im.receiveShadow = true;
        im.frustumCulled = false;
        out.add(im);
      });
      return out;
    },
  };
}
