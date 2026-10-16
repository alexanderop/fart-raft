import * as THREE from "three";

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
 * adds only a slow, faint shimmer so it stays as calm as the reference.
 */
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
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uTime; varying vec3 vWPos;")
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        vec2 p = vWPos.xz;
        float rip = sin(p.x * 0.5 + uTime * 0.8) * sin(p.y * 0.45 - uTime * 0.6);
        diffuseColor.rgb += vec3(0.015, 0.025, 0.03) * rip;`,
      );
  };
  // Open water for courses without a channel; channel courses only use the material.
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), material);
  plane.rotation.x = -Math.PI / 2;
  plane.receiveShadow = true;
  const flat = new THREE.Color(0x3cb8f2);
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
