import * as THREE from "three";
import { CURRENT_SPEED, RAPIDS_SPEED } from "../../sim/constants.ts";

/** Pale sky haze: the fog color, and what the cliffs fade into far below. */
export const HAZE = 0xeaf5fb;

/** Soft gradient dome, light blue overhead to near-white haze at and below the horizon. */
export function createSky(): THREE.Mesh {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(500, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        top: { value: new THREE.Color(0x8cc8f0) },
        mid: { value: new THREE.Color(0xc9e6f7) },
        horizon: { value: new THREE.Color(HAZE) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top; uniform vec3 mid; uniform vec3 horizon;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 c = mix(horizon, mid, smoothstep(0.02, 0.25, h));
          c = mix(c, top, smoothstep(0.25, 0.8, h));
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -1;
  return sky;
}

/**
 * Flat, saturated cartoon water. Vertex colors carry the bank-to-center gradient; the shader
 * adds a faint shimmer and, on a channel (its `aFlow` attribute: arc length, offset across, on),
 * white dashed streaks drifting downstream at the sim's CURRENT_SPEED, so the current shows.
 * In rapids (`aRapid`, 0..1) the streaks race at RAPIDS_SPEED, crowd together and the water
 * froths white.
 */
const STREAK_LANE = 1.7; // m between streak lanes across the stream

export function createWater() {
  const uTime = { value: 0 };
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute vec3 aFlow; attribute float aRapid; varying vec3 vWPos; varying vec3 vFlow; varying float vRapid;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vFlow = aFlow; vRapid = aRapid;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform float uTime; varying vec3 vWPos; varying vec3 vFlow; varying float vRapid;
        // Streaks for water running at \`speed\`: lanes \`gap\` m apart across the stream, each a
        // wobbly dashed line sliding downstream.
        float streaks(float speed, float gap, float dashes) {
          float s = vFlow.x - uTime * speed;
          float lane = floor(vFlow.y / gap + 0.5);
          float h = fract(sin(lane * 12.9898) * 43758.5453);
          float wob = vFlow.y + 0.3 * sin(s * 0.5 + lane * 2.1);
          float line = 1.0 - smoothstep(0.04, 0.1, abs(wob - lane * gap));
          float ph = fract(s / (dashes * (9.0 + h * 7.0)) + h);
          return line * smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(0.3, 0.4, ph));
        }`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        vec2 p = vWPos.xz;
        float rip = sin(p.x * 0.5 + uTime * 0.8) * sin(p.y * 0.45 - uTime * 0.6);
        diffuseColor.rgb += vec3(0.015, 0.025, 0.03) * rip;
        float calm = streaks(${CURRENT_SPEED.toFixed(2)}, ${STREAK_LANE.toFixed(2)}, 1.0);
        float fast = streaks(${RAPIDS_SPEED.toFixed(2)}, ${(STREAK_LANE * 0.6).toFixed(2)}, 0.7);
        // Rapids froth: churning white blotches over brighter water.
        float froth = smoothstep(0.55, 0.9, sin(p.x * 1.7 + uTime * 5.0) * sin(p.y * 1.9 - uTime * 4.0) * 0.5 + 0.5 + 0.25 * rip);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6, 0.88, 1.0), vRapid * 0.3);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), vRapid * froth * 0.35);
        float streak = mix(calm * 0.45, fast * 0.85, vRapid);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), streak * vFlow.z);`,
      );
  };
  // Open water for courses without a channel; channel courses only use the material.
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), material);
  plane.rotation.x = -Math.PI / 2;
  plane.receiveShadow = true;
  const flat = new THREE.Color(0x3fb6ee);
  const colors = new Float32Array(plane.geometry.attributes.position!.count * 3).map(
    (_, i) => [flat.r, flat.g, flat.b][i % 3]!,
  );
  plane.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return {
    material,
    plane,
    update(seconds: number) {
      uTime.value = seconds;
    },
  };
}
