import * as THREE from "three";
import type { Box } from "../../sim/types";
import { applyPose } from "./coords";

const FOAM_Y = 0.05;
const flat = (size: number) => new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);

const HASH = /* glsl */ `float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`;

/**
 * Animated foam on the water: a wobbling band hugging each rock (with rings that lap outward)
 * and a lapping strip along every bamboo rim. Pure shader, one shared time uniform.
 */
export function createFoam(uTime: { value: number }) {
  const group = new THREE.Group();

  const rockGeo = flat(2);
  const rockFoam = (rock: Box, margin: number) => {
    const ex = rock.hx + margin;
    const ey = rock.hy + margin;
    const r0 = new THREE.Vector2(rock.hx / ex, rock.hy / ey);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime,
        uR0: { value: r0 },
        uMax: { value: Math.min(ex / rock.hx, ey / rock.hy) },
        uSeed: { value: (rock.x * 0.37 + rock.y * 0.71) % 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vP;
        void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec2 uR0; uniform float uMax; uniform float uSeed;
        varying vec2 vP;
        ${HASH}
        void main() {
          float e = length(vP / uR0);
          float t = clamp((e - 0.85) / (uMax - 0.85), 0.0, 1.0);
          float ang = atan(vP.y, vP.x);
          float wob = 0.07 * sin(ang * 6.0 + uTime * 1.7 + uSeed * 6.0) + 0.05 * sin(ang * 11.0 - uTime * 2.3);
          float body = 1.0 - smoothstep(0.3 + wob, 0.62 + wob, t);
          float pulse = fract(uTime * 0.28 + uSeed);
          float ring = smoothstep(0.09, 0.0, abs(t - (0.25 + pulse * 0.7))) * (1.0 - pulse);
          float bubbles = step(0.3, hash21(floor(vP * 14.0 + uSeed * 20.0 + floor(uTime * 0.7))));
          float a = max(body * (0.55 + 0.35 * bubbles), ring * 0.7) * (1.0 - smoothstep(0.8, 1.0, t));
          gl_FragColor = vec4(0.97, 0.99, 1.0, a);
        }`,
    });
    const mesh = new THREE.Mesh(rockGeo, material);
    mesh.scale.set(ex, 1, ey);
    applyPose(mesh, rock, FOAM_Y);
    return mesh;
  };

  const stripMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec2 vW;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv; varying vec2 vW;
      void main() {
        float d = abs(vUv.y - 0.5) * 2.0;
        float wob = 0.12 * sin(vW.x * 1.3 + vW.y * 1.1 + uTime * 1.2) + 0.08 * sin(vW.x * 3.1 - vW.y * 2.7 - uTime * 1.9);
        float band = 1.0 - smoothstep(0.3 + wob, 0.75 + wob, d);
        float lap = smoothstep(0.1, 0.0, abs(d - fract(uTime * 0.3 + (vW.x + vW.y) * 0.07)));
        float a = band * 0.85 + lap * 0.35 * (1.0 - d);
        gl_FragColor = vec4(0.97, 0.99, 1.0, clamp(a, 0.0, 1.0));
      }`,
  });

  return {
    group,
    rocks(rocks: readonly Box[], margin = 1.1) {
      for (const rock of rocks) group.add(rockFoam(rock, margin));
    },
    /** One matrix per rim segment, scaled (length, 1, width) in the segment's own frame. */
    strips(matrices: readonly THREE.Matrix4[]) {
      const mesh = new THREE.InstancedMesh(flat(1), stripMaterial, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.frustumCulled = false;
      group.add(mesh);
    },
  };
}
