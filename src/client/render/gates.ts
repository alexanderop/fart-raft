import * as THREE from "three";
import type { Box, LevelData, SimEvent } from "../../sim/types";
import { applyPose } from "./coords";
import type { Kit } from "./kit";

const POST_H = 1.4;

/** Where a checkpoint's posts and sign sit, shared with fx that need to spawn from the sign. */
export function gateLayout(cp: Box, last: boolean) {
  const alongX = cp.hx > cp.hy;
  const half = alongX ? cp.hx : cp.hy;
  const c = Math.cos(cp.rot);
  const s = Math.sin(cp.rot);
  // Unit vector along the gate's long axis, in sim space.
  const ax = alongX ? c : -s;
  const ay = alongX ? s : c;
  const k = Math.min(2, (half * 2) / 6);
  return {
    alongX,
    half,
    ax,
    ay,
    k,
    postH: POST_H,
    signY: 5 * POST_H - 0.7 * k,
    signRot: cp.rot - (alongX ? 0 : Math.PI / 2),
    last,
  };
}

type Gate = {
  cp: Box;
  sign: THREE.Group;
  baseY: number;
  phase: number;
  /** Time of the last burst, -Infinity when idle. */
  burstAt: number;
  flashes: { value: number }[];
  posts: THREE.MeshStandardMaterial[];
};

/** Give this object its own copy of every material matching `pick`, so one gate can glow alone. */
function ownMaterials<T extends THREE.Material>(
  root: THREE.Object3D,
  pick: (m: THREE.Material) => m is T,
  setup?: (m: T) => void,
): T[] {
  const out: T[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const mapped = list.map((m: THREE.Material) => {
      if (!pick(m)) return m;
      const own = m.clone();
      setup?.(own);
      out.push(own);
      return own;
    });
    o.material = Array.isArray(o.material) ? mapped : mapped[0]!;
  });
  return out;
}

/**
 * Checkpoint gates: marquee bulbs chase along the sign, the sign swings, and a checkpoint
 * makes the gate squash-bounce while the posts and bulbs flash.
 */
export function createGates(level: LevelData, kit: Kit, uTime: { value: number }) {
  const group = new THREE.Group();
  const gates: Gate[] = [];

  level.checkpoints.forEach((cp, i) => {
    const last = i === level.checkpoints.length - 1;
    const lay = gateLayout(cp, last);

    const posts: THREE.MeshStandardMaterial[] = [];
    for (const s of [-1, 1]) {
      const post = kit.clone("gate_post");
      post.scale.y = lay.postH;
      applyPose(post, {
        x: cp.x + lay.ax * lay.half * s,
        y: cp.y + lay.ay * lay.half * s,
        rot: cp.rot,
      });
      posts.push(
        ...ownMaterials(
          post,
          (m): m is THREE.MeshStandardMaterial => m instanceof THREE.MeshStandardMaterial,
          (m) => m.emissive.set(0xffffff),
        ),
      );
      group.add(post);
    }
    for (const m of posts) m.emissiveIntensity = 0;

    // The sign swings from a wrapper so rotation.x is the sign's own long axis (yaw first).
    const wrapper = new THREE.Group();
    wrapper.rotation.order = "YXZ";
    applyPose(wrapper, { x: cp.x, y: cp.y, rot: lay.signRot }, lay.signY);
    const sign = kit.clone(last ? "finish_sign" : "gate_sign");
    sign.scale.setScalar(lay.k);
    wrapper.add(sign);
    group.add(wrapper);

    const phase = i * 1.7;
    const flashes: { value: number }[] = [];
    ownMaterials(
      sign,
      (m): m is THREE.MeshStandardMaterial =>
        m.name === "bulb" && m instanceof THREE.MeshStandardMaterial,
      (m) => {
        const uFlash = { value: 0 };
        flashes.push(uFlash);
        m.emissive.set(0xffc233);
        m.onBeforeCompile = (shader) => {
          shader.uniforms.uTime = uTime;
          shader.uniforms.uFlash = uFlash;
          shader.uniforms.uPhase = { value: phase };
          shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nvarying vec3 vLocal;")
            .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLocal = position;");
          shader.fragmentShader = shader.fragmentShader
            .replace(
              "#include <common>",
              "#include <common>\nuniform float uTime; uniform float uFlash; uniform float uPhase; varying vec3 vLocal;",
            )
            .replace(
              "#include <emissivemap_fragment>",
              /* glsl */ `#include <emissivemap_fragment>
              float chase = smoothstep(0.2, 0.9, 0.5 + 0.5 * sin((vLocal.x + vLocal.y) * 7.0 - uTime * 6.0 + uPhase));
              totalEmissiveRadiance *= 0.25 + 1.6 * chase + uFlash * 4.0;
              diffuseColor.rgb += vec3(0.4, 0.3, 0.05) * chase + vec3(uFlash);`,
            );
        };
        m.customProgramCacheKey = () => "bulb";
      },
    );

    const line = new THREE.Mesh(
      new THREE.BoxGeometry(cp.hx * 2, 0.04, cp.hy * 2),
      new THREE.MeshBasicMaterial({
        color: last ? 0xffffff : 0xffe066,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      }),
    );
    applyPose(line, cp, 0.06);
    group.add(line);

    gates.push({
      cp,
      sign: wrapper,
      baseY: lay.signY,
      phase,
      burstAt: -Infinity,
      flashes,
      posts,
    });
  });

  let now = 0;
  return {
    group,
    onEvent(e: SimEvent) {
      if (e.type === "checkpoint" && gates[e.index]) gates[e.index]!.burstAt = now;
    },
    update(time: number) {
      now = time;
      for (const g of gates) {
        const age = time - g.burstAt;
        const live = age < 1.6;
        const decay = live ? Math.exp(-4 * age) : 0;
        // Squash first (cos starts at 1), then spring back past rest. Guarded: age is Infinity
        // before the first burst, and cos(Infinity) is NaN.
        const d = live ? decay * Math.cos(age * 16) : 0;
        const hop =
          live && age < 0.7 ? Math.max(0, Math.sin(age * 9)) * Math.exp(-2.5 * age) * 0.9 : 0;
        g.sign.scale.set(1 + d * 0.12, 1 - d * 0.3, 1);
        g.sign.position.y = g.baseY + hop;
        g.sign.rotation.x =
          Math.sin(time * 1.3 + g.phase) * 0.035 + (live ? decay * Math.sin(age * 20) * 0.12 : 0);
        g.sign.rotation.z = Math.sin(time * 0.9 + g.phase * 2) * 0.02;
        const flash = live ? Math.exp(-3 * age) : 0;
        for (const f of g.flashes) f.value = flash;
        for (const m of g.posts) m.emissiveIntensity = flash * 0.9;
      }
    },
  };
}
