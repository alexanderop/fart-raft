import * as THREE from "three";
import { CURRENT_SPEED } from "../../sim/constants.ts";

/** Purple Halloween dusk: the fog color, and what the cliffs fade into far below. */
export const HAZE = 0x4a2f6b;

/** Night dome: near-black violet overhead to purple haze at the horizon, with stars and a big moon. */
export function createSky(): THREE.Mesh {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(500, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        top: { value: new THREE.Color(0x0d0820) },
        mid: { value: new THREE.Color(0x2b1a4d) },
        moonDir: { value: new THREE.Vector3(-0.55, 0.45, -0.7).normalize() },
        horizon: { value: new THREE.Color(HAZE) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 moonDir;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 c = mix(horizon, mid, smoothstep(0.02, 0.25, h));
          c = mix(c, top, smoothstep(0.25, 0.8, h));
          vec3 cell = floor(vDir * 180.0);
          float star = step(0.9975, fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453));
          c += vec3(star) * smoothstep(0.1, 0.4, h) * 0.8;
          float m = dot(vDir, moonDir);
          c = mix(c, vec3(1.0, 0.96, 0.82), smoothstep(0.9965, 0.9975, m));
          c += vec3(0.55, 0.45, 0.7) * pow(max(m, 0.0), 220.0) * 0.6;
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
 * adds a faint shimmer and, on a channel (its `aFlow` attribute: arc length, offset across),
 * white dashed streaks drifting downstream at the sim's CURRENT_SPEED, so the current shows.
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
        "#include <common>\nattribute vec3 aFlow; varying vec3 vWPos; varying vec3 vFlow;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vFlow = aFlow;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uTime; varying vec3 vWPos; varying vec3 vFlow;",
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        vec2 p = vWPos.xz;
        float rip = sin(p.x * 0.5 + uTime * 0.8) * sin(p.y * 0.45 - uTime * 0.6);
        diffuseColor.rgb += vec3(0.015, 0.025, 0.03) * rip;
        // Streaks: lanes across the stream, each a wobbly dashed line sliding downstream.
        float s = vFlow.x - uTime * ${CURRENT_SPEED.toFixed(2)};
        float lane = floor(vFlow.y / ${STREAK_LANE.toFixed(2)} + 0.5);
        float h = fract(sin(lane * 12.9898) * 43758.5453);
        float wob = vFlow.y + 0.3 * sin(s * 0.5 + lane * 2.1);
        float off = abs(wob - lane * ${STREAK_LANE.toFixed(2)});
        float line = 1.0 - smoothstep(0.04, 0.1, off);
        float period = 9.0 + h * 7.0;
        float ph = fract(s / period + h);
        float dash = smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(0.3, 0.4, ph));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 1.0, 0.6), line * dash * vFlow.z * 0.45);`,
      );
  };
  // Open water for courses without a channel; channel courses only use the material.
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), material);
  plane.rotation.x = -Math.PI / 2;
  plane.receiveShadow = true;
  const flat = new THREE.Color(0x2fa87a);
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
