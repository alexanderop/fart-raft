import * as THREE from "three";

export const HAZE = 0xd3ebf6;

/** Pastel gradient dome. Follows the camera so it never clips. */
export function createSky(): THREE.Mesh {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(500, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        top: { value: new THREE.Color(0x58a8ec) },
        mid: { value: new THREE.Color(0x9ed2f6) },
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
          vec3 c = mix(horizon, mid, smoothstep(0.0, 0.18, h));
          c = mix(c, top, smoothstep(0.15, 0.7, h));
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -1;
  return sky;
}

/** Bright cartoon water: flat blue with slow caustic-ish bands and tiny twinkles, driven by a time uniform. */
export function createWater() {
  const uTime = { value: 0 };
  const material = new THREE.MeshLambertMaterial({ color: 0x2cb4f2 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform float uTime; varying vec3 vWPos;
        float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        vec2 p = vWPos.xz;
        float rip = sin(p.x * 0.7 + uTime * 0.9) * sin(p.y * 0.6 - uTime * 0.7)
                  + sin((p.x + p.y) * 0.35 + uTime * 0.5);
        diffuseColor.rgb += vec3(0.02, 0.04, 0.05) * rip;
        vec2 g = p * 2.5;
        vec2 cell = floor(g);
        float ph = hash21(cell) * 6.2831;
        float tw = pow(max(0.0, sin(uTime * 1.6 + ph)), 12.0);
        float on = step(0.82, hash21(cell + 7.0));
        float d = length(fract(g) - 0.5);
        diffuseColor.rgb += tw * on * smoothstep(0.3, 0.0, d) * 0.55;`,
      );
  };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  return {
    mesh,
    update(seconds: number) {
      uTime.value = seconds;
    },
  };
}
