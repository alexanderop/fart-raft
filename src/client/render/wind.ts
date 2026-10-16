import * as THREE from "three";
import type { Pose } from "../../sim/types";
import { applyPose } from "./coords";

export type SwayOptions = {
  /** World height (above the instance origin) at which the full sway applies. */
  height: number;
  /** Sway at full height, in world units. */
  strength: number;
  /** Canopy "breathing": relative scale pulse, weighted by height. */
  breathe?: number;
  /** 0..1: how much the raft passing close rustles and bends this plant. */
  react?: number;
};

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const COMMON = /* glsl */ `#include <common>
uniform float uTime; uniform vec2 uRaft; uniform float uAmp;
attribute vec3 aPivot;`;

/** Plants: bend from the root, per-instance phase from the pivot, rustle when the raft is near. */
const swayBody = (o: Required<SwayOptions>) => /* glsl */ `
vec4 wp = instanceMatrix * vec4(transformed, 1.0);
vec3 pv = aPivot;
float ph = pv.x * 0.7 + pv.z * 1.3;
float h = clamp((wp.y - pv.y) / ${o.height.toFixed(2)}, 0.0, 1.0);
float w = h * h;
vec2 toRaft = pv.xz - uRaft;
float rd = max(length(toRaft), 0.001);
float near = ${o.react.toFixed(2)} * (1.0 - smoothstep(0.0, 7.0, rd));
float gust = 0.65 + 0.35 * sin(pv.x * 0.06 - uTime * 0.9);
vec2 sw = vec2(sin(uTime * 1.6 + ph) + 0.5 * sin(uTime * 3.1 + ph * 2.0), 0.6 * cos(uTime * 1.3 + ph * 1.4)) * gust;
vec2 shake = vec2(sin(uTime * 15.0 + ph * 3.0), cos(uTime * 13.0 + ph * 2.0)) * near * 0.12;
vec2 push = toRaft / rd * near * 0.5;
vec2 d = (sw * ${o.strength.toFixed(3)} * (1.0 + near * 2.0) + shake + push) * w * uAmp;
wp.xz += d;
wp.y -= length(d) * 0.25;
float br = 1.0 + ${o.breathe.toFixed(3)} * uAmp * sin(uTime * 1.4 + ph);
wp.xyz = pv + (wp.xyz - pv) * vec3(mix(1.0, br, h), mix(1.0, br, h), mix(1.0, br, h));
vec4 mvPosition = modelViewMatrix * wp;
gl_Position = projectionMatrix * mvPosition;`;

/**
 * Shared wind and raft-proximity uniforms. `sway` patches an InstancedMesh group
 * (from `kit.instance`) so all motion runs on the GPU; `update` is the only per-frame cost.
 */
const scratch = new THREE.Object3D();

export function createWind() {
  const uniforms = {
    uTime: { value: 0 },
    uRaft: { value: new THREE.Vector2(1e5, 1e5) },
    uAmp: { value: reducedMotion() ? 0.25 : 1 },
  };

  const patch = (group: THREE.Object3D, key: string, body: string) =>
    group.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh)) return;
      const source: THREE.Material = o.material;
      const material = source.clone();
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", COMMON)
          .replace("#include <project_vertex>", body);
      };
      material.customProgramCacheKey = () => key;
      o.material = material;
    });

  return {
    uniforms,
    sway(group: THREE.Object3D, opts: SwayOptions) {
      const full = { breathe: 0, react: 0, ...opts };
      patch(group, `sway-${JSON.stringify(full)}`, swayBody(full));
      return group;
    },
    update(time: number, raft: Pose) {
      uniforms.uTime.value = time;
      applyPose(scratch, raft);
      uniforms.uRaft.value.set(scratch.position.x, scratch.position.z);
    },
  };
}

export type Wind = ReturnType<typeof createWind>;
