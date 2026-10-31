import * as THREE from "three";
import type { Animal, Gadget, Hat, Look, Outfit } from "../../look.ts";

// Hats, outfits and gadgets, built from primitives at runtime (no kit nodes), attached to a
// rider rig's head and body. Rig space comes from assets-src/build_kit.py: Blender rider space
// scaled by RIDER_SCALE, Y-up, forward +x. Head-local positions are measured from the NECK pivot.

const S = 1.7; // build_kit.py RIDER_SCALE
const NECK_X = 0.05;
const NECK_Z = 0.78;
/** Blender rider space (x forward, z up) → head-local three (x, y). */
const head = (x: number, z: number) => [(x - NECK_X) * S, (z - NECK_Z) * S] as const;

type Anchors = {
  /** Head-local top of the head, where a hat sits. */
  top: readonly [number, number];
  /** Half-width of the head across (three z). */
  side: number;
  /** Front of the right eye (head-local x, y) and its distance from the middle. */
  eye: readonly [number, number];
  eyeSpread: number;
  /** Under the nose. */
  mouth: readonly [number, number];
  /** Body half-width factor (`seated_body` wide). */
  wide: number;
};

const ANCHORS: Record<Animal, Anchors> = {
  capybara: {
    top: head(0.08, 1.21),
    side: 0.25 * S,
    eye: head(0.36, 1.08),
    eyeSpread: 0.15 * S,
    mouth: head(0.53, 0.89),
    wide: 1.05,
  },
  hippo: {
    top: head(0.03, 1.22),
    side: 0.3 * S,
    eye: head(0.225, 1.16),
    eyeSpread: 0.13 * S,
    mouth: head(0.5, 0.85),
    wide: 1.1,
  },
  croc: {
    top: head(0.03, 1.18),
    side: 0.25 * S,
    eye: head(0.225, 1.15),
    eyeSpread: 0.12 * S,
    mouth: head(0.68, 0.98),
    wide: 1,
  },
  // Eyes sit on stalks above the head, so hats sit just behind them.
  lobster: {
    top: head(-0.02, 1.2),
    side: 0.25 * S,
    eye: head(0.25, 1.33),
    eyeSpread: 0.12 * S,
    mouth: head(0.4, 0.9),
    wide: 0.95,
  },
};

/** Body-local torso ellipsoid (`seated_body`'s main sphere). */
const TORSO_Y = 0.4 * S;
/** Deep enough in front to cover the belly sphere and the lobster's plates (front ≈ 0.39). */
const torso = (wide: number) => ({
  rx: Math.max(0.36 * wide, 0.38) * S,
  ry: 0.42 * S,
  rz: 0.34 * wide * S,
});
const NECK_Y = 0.78 * S - 0.1;

type Kit = {
  mat(
    color: THREE.ColorRepresentation,
    opts?: { emissive?: boolean; opacity?: number },
  ): THREE.Material;
  mesh(
    geo: THREE.BufferGeometry,
    color: THREE.ColorRepresentation,
    at?: [number, number, number],
  ): THREE.Mesh;
};

function kit(): Kit {
  const cache = new Map<string, THREE.Material>();
  const mat: Kit["mat"] = (color, opts = {}) => {
    const key = `${new THREE.Color(color).getHexString()}|${opts.emissive ?? false}|${opts.opacity ?? 1}`;
    let m = cache.get(key);
    if (!m) {
      const c = new THREE.Color(color);
      m = new THREE.MeshStandardMaterial({
        color: c,
        roughness: 0.55,
        metalness: 0,
        side: THREE.DoubleSide,
        emissive: opts.emissive ? c : 0x000000,
        emissiveIntensity: opts.emissive ? 0.6 : 0,
        transparent: opts.opacity !== undefined,
        opacity: opts.opacity ?? 1,
        depthWrite: opts.opacity === undefined,
      });
      cache.set(key, m);
    }
    return m;
  };
  return {
    mat,
    mesh(geo, color, at = [0, 0, 0]) {
      const m = new THREE.Mesh(geo, mat(color));
      m.position.set(...at);
      m.castShadow = true;
      return m;
    },
  };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const FRONT_FACE = V(0, 0, 1);

/** Direction on the torso: `theta` from the top, `phi` around from the front (positive = left). */
const dir = (theta: number, phi: number) =>
  V(Math.sin(theta) * Math.cos(phi), Math.cos(theta), -Math.sin(theta) * Math.sin(phi));

/** A point on the torso surface (scaled out by `k`) and its outward normal. */
function onTorso(wide: number, theta: number, phi: number, k = 1.08) {
  const { rx, ry, rz } = torso(wide);
  const d = dir(theta, phi);
  const pos = V(d.x * rx * k, TORSO_Y + d.y * ry * k, d.z * rz * k);
  const normal = V(d.x / rx, d.y / ry, d.z / rz).normalize();
  return { pos, normal };
}

/** Places `obj` on the torso, its +z facing out. */
function stick(obj: THREE.Object3D, wide: number, theta: number, phi: number, k = 1.08) {
  const { pos, normal } = onTorso(wide, theta, phi, k);
  obj.position.copy(pos);
  obj.quaternion.setFromUnitVectors(FRONT_FACE, normal);
  return obj;
}

/** A band of the torso shell from `from` to `to` (radians from the top), optionally only around the front. */
function shell(
  k: Kit,
  wide: number,
  color: THREE.ColorRepresentation,
  from: number,
  to: number,
  scale = 1.06,
  arc?: { center: number; half: number },
) {
  const { rx, ry, rz } = torso(wide);
  // SphereGeometry's phi starts at -x and runs toward +z; phi = π is +x (front), past it is left.
  const phiStart = arc ? Math.PI + arc.center - arc.half : 0;
  const phiLength = arc ? arc.half * 2 : Math.PI * 2;
  const geo = new THREE.SphereGeometry(1, 28, 12, phiStart, phiLength, from, to - from);
  const m = k.mesh(geo, color);
  m.scale.set(rx * scale, ry * scale, rz * scale);
  m.position.y = TORSO_Y;
  return m;
}

const P = Math.PI;

function cross(k: Kit, size: number, color: THREE.ColorRepresentation) {
  const g = new THREE.Group();
  g.add(
    k.mesh(new THREE.BoxGeometry(size, size * 0.32, 0.03), color),
    k.mesh(new THREE.BoxGeometry(size * 0.32, size, 0.03), color),
  );
  return g;
}

function stripes(k: Kit, wide: number, a: string, b: string, from: number, to: number, n: number) {
  const g = new THREE.Group();
  const step = (to - from) / n;
  for (let i = 0; i < n; i++) {
    g.add(shell(k, wide, i % 2 ? b : a, from + i * step, from + (i + 1) * step));
  }
  return g;
}

function belt(k: Kit, wide: number, color: string, buckle?: string) {
  const g = new THREE.Group();
  g.add(shell(k, wide, color, 0.6 * P, 0.65 * P, 1.08));
  if (buckle) {
    g.add(stick(k.mesh(new THREE.BoxGeometry(0.16, 0.12, 0.04), buckle), wide, 0.625 * P, 0, 1.1));
  }
  return g;
}

function buttons(k: Kit, wide: number, color: string, phi: number, n = 3) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const b = k.mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 10), color);
    b.rotation.x = P / 2;
    const holder = stick(new THREE.Group(), wide, (0.3 + i * 0.1) * P, phi, 1.08);
    holder.add(b);
    g.add(holder);
  }
  return g;
}

/** Body-worn part, and optionally something on the head (the astronaut's bubble). */
type Built = { body?: THREE.Object3D; head?: THREE.Object3D };

function outfit(k: Kit, kind: Outfit, a: Anchors): Built {
  const w = a.wide;
  const g = new THREE.Group();
  const top = 0.2 * P;
  const bottom = 0.68 * P;
  switch (kind) {
    case "none":
      return {};
    case "police": {
      g.add(shell(k, w, "#26357a", top, bottom));
      g.add(shell(k, w, "#7fb2ff", 0.17 * P, 0.24 * P, 1.08, { center: 0, half: 0.6 })); // collar
      g.add(belt(k, w, "#151515", "#c9c9c9"));
      const badge = k.mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.03, 6), "#ffcc33");
      badge.rotation.x = P / 2;
      g.add(stick(new THREE.Group().add(badge), w, 0.33 * P, 0.4));
      g.add(buttons(k, w, "#c9c9c9", 0));
      break;
    }
    case "nurse":
      g.add(shell(k, w, "#f6f7fb", top, bottom));
      g.add(shell(k, w, "#ff9cc0", 0.19 * P, 0.24 * P, 1.08)); // collar trim
      g.add(stick(cross(k, 0.26, "#e8202a"), w, 0.34 * P, 0));
      g.add(belt(k, w, "#ff9cc0"));
      break;
    case "doctor":
      g.add(shell(k, w, "#fbfcfd", top, bottom));
      g.add(shell(k, w, "#5aa7e8", 0.2 * P, 0.6 * P, 1.08, { center: 0, half: 0.32 })); // scrubs
      g.add(buttons(k, w, "#d8dde3", 0.42));
      g.add(
        stick(k.mesh(new THREE.BoxGeometry(0.16, 0.14, 0.02), "#e9edf2"), w, 0.36 * P, -0.5, 1.1),
      );
      g.add(
        stick(
          k.mesh(new THREE.BoxGeometry(0.025, 0.16, 0.025), "#2a62d6"),
          w,
          0.33 * P,
          -0.45,
          1.13,
        ),
      );
      break;
    case "firefighter":
      g.add(shell(k, w, "#d2a034", top, bottom));
      g.add(shell(k, w, "#e9ff5c", 0.4 * P, 0.44 * P, 1.08));
      g.add(shell(k, w, "#e9ff5c", 0.54 * P, 0.58 * P, 1.08));
      g.add(shell(k, w, "#3a3330", 0.2 * P, 0.68 * P, 1.08, { center: 0, half: 0.05 })); // zipper
      break;
    case "chef":
      g.add(shell(k, w, "#ffffff", top, bottom));
      g.add(buttons(k, w, "#222222", 0.28));
      g.add(buttons(k, w, "#222222", -0.28));
      g.add(neckerchief(k, "#e8202a"));
      break;
    case "pirate":
      g.add(stripes(k, w, "#ffffff", "#d92b2b", top, bottom, 7));
      g.add(belt(k, w, "#5a3519", "#ffcc33"));
      break;
    case "superhero": {
      g.add(shell(k, w, "#2a5bd7", top, bottom));
      g.add(belt(k, w, "#ffd23f"));
      const emblem = new THREE.Group();
      const disc = k.mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 20), "#ffd23f");
      disc.rotation.x = P / 2;
      const diamond = k.mesh(new THREE.BoxGeometry(0.13, 0.13, 0.04), "#e8202a");
      diamond.rotation.z = P / 4;
      emblem.add(disc, diamond);
      g.add(stick(emblem, w, 0.34 * P, 0));
      g.add(cape(k, w, "#e8202a"));
      break;
    }
    case "prisoner":
      g.add(stripes(k, w, "#f2f2f2", "#1d1d1d", top, bottom, 8));
      g.add(
        stick(k.mesh(new THREE.BoxGeometry(0.24, 0.1, 0.02), "#ffffff"), w, 0.36 * P, 0.45, 1.12),
      );
      break;
    case "tuxedo":
      g.add(shell(k, w, "#16161c", top, bottom));
      g.add(shell(k, w, "#ffffff", 0.18 * P, 0.55 * P, 1.08, { center: 0, half: 0.28 }));
      g.add(buttons(k, w, "#16161c", 0, 2));
      break;
    case "hula": {
      const skirt = new THREE.Group();
      const { rx } = torso(w);
      for (let i = 0; i < 28; i++) {
        const angle = (i / 28) * P * 2;
        const blade = k.mesh(
          new THREE.BoxGeometry(0.1, 0.5, 0.02),
          i % 3 === 0 ? "#c7d94a" : i % 3 === 1 ? "#8fbf3a" : "#dcc56a",
        );
        const pivot = new THREE.Group();
        pivot.rotation.y = angle;
        blade.position.set(rx * 1.02, TORSO_Y - 0.12, 0);
        blade.rotation.z = 0.2;
        pivot.add(blade);
        skirt.add(pivot);
      }
      g.add(skirt, lei(k));
      break;
    }
    case "astronaut": {
      g.add(shell(k, w, "#eef1f5", top, bottom));
      g.add(shell(k, w, "#9aa3ad", 0.18 * P, 0.23 * P, 1.08));
      const panel = new THREE.Group();
      panel.add(k.mesh(new THREE.BoxGeometry(0.3, 0.22, 0.05), "#8a939e"));
      for (const [x, color] of [
        [-0.08, "#e8202a"],
        [0, "#3d9bff"],
        [0.08, "#ffd23f"],
      ] as const) {
        panel.add(k.mesh(new THREE.BoxGeometry(0.05, 0.05, 0.03), color, [x, 0.04, 0.03]));
      }
      g.add(stick(panel, w, 0.36 * P, 0));
      const bubble = new THREE.Mesh(
        new THREE.SphereGeometry(0.82, 24, 16),
        k.mat("#bfe9ff", { opacity: 0.28 }),
      );
      bubble.position.set(a.top[0] + 0.15, a.top[1] - 0.45, 0);
      return { body: g, head: bubble };
    }
  }
  return { body: g };
}

function neckerchief(k: Kit, color: string) {
  const knot = k.mesh(new THREE.TorusGeometry(0.42, 0.07, 8, 24), color, [0.05, NECK_Y, 0]);
  knot.rotation.x = P / 2;
  return knot;
}

function lei(k: Kit) {
  const g = new THREE.Group();
  const colors = ["#ff4fb0", "#ffd23f", "#ff8a3d", "#ffffff"];
  for (let i = 0; i < 14; i++) {
    const t = (i / 14) * P * 2;
    g.add(
      k.mesh(new THREE.IcosahedronGeometry(0.09, 0), colors[i % colors.length]!, [
        0.05 + Math.cos(t) * 0.44,
        NECK_Y - 0.02 + Math.cos(t) * -0.06,
        Math.sin(t) * 0.42,
      ]),
    );
  }
  return g;
}

function cape(k: Kit, wide: number, color: string) {
  const { rx } = torso(wide);
  // CylinderGeometry's theta 0 is +z, π/2 is +x (front): center the cape on the back, 3π/2.
  const geo = new THREE.CylinderGeometry(rx * 0.8, rx * 1.35, 1.1, 20, 1, true, P * 1.1, P * 0.8);
  const m = k.mesh(geo, color, [-0.08, NECK_Y - 0.55, 0]);
  return m;
}

function hat(k: Kit, kind: Hat, a: Anchors): THREE.Object3D | undefined {
  const g = new THREE.Group();
  const [x, y] = a.top;
  g.position.set(x, y - 0.06, 0);
  const r = Math.max(0.32, a.side * 0.82);
  switch (kind) {
    case "none":
      return undefined;
    case "police": {
      g.add(
        k.mesh(new THREE.CylinderGeometry(r * 1.15, r * 0.95, 0.26, 24), "#26357a", [0, 0.13, 0]),
      );
      g.add(
        k.mesh(new THREE.CylinderGeometry(r * 0.97, r * 0.97, 0.08, 24), "#111111", [0, 0.05, 0]),
      );
      const visor = k.mesh(
        new THREE.CylinderGeometry(r * 0.75, r * 0.75, 0.03, 20, 1, false, P / 2 - 0.9, 1.8),
        "#111111",
        [r * 0.55, 0.03, 0],
      );
      g.add(visor);
      const badge = k.mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.03, 6), "#ffcc33", [
        r * 1.05,
        0.15,
        0,
      ]);
      badge.rotation.z = P / 2;
      g.add(badge);
      g.rotation.z = 0.08;
      break;
    }
    case "nurse": {
      g.add(k.mesh(new THREE.BoxGeometry(r * 1.1, 0.24, r * 1.7), "#ffffff", [0, 0.12, 0]));
      const c = cross(k, 0.18, "#e8202a");
      c.position.set(r * 0.56, 0.13, 0);
      c.rotation.y = P / 2;
      g.add(c);
      g.rotation.z = 0.25;
      break;
    }
    case "firefighter": {
      const dome = k.mesh(
        new THREE.SphereGeometry(r * 1.05, 20, 12, 0, P * 2, 0, P / 2),
        "#d92b2b",
      );
      dome.scale.y = 0.85;
      g.add(dome);
      const brim = k.mesh(
        new THREE.CylinderGeometry(r * 1.45, r * 1.5, 0.05, 24),
        "#b81f1f",
        [-0.08, 0.02, 0],
      );
      brim.scale.x = 1.15;
      g.add(brim);
      const shield = k.mesh(new THREE.BoxGeometry(0.03, 0.22, 0.2), "#ffcc33", [r * 1.0, 0.24, 0]);
      shield.rotation.z = -0.5;
      g.add(shield);
      break;
    }
    case "chef":
      g.add(
        k.mesh(new THREE.CylinderGeometry(r * 0.95, r * 0.9, 0.3, 20), "#ffffff", [0, 0.15, 0]),
      );
      for (const [dx, dz, s] of [
        [0, 0, 1],
        [0.12, 0.15, 0.7],
        [-0.12, -0.15, 0.7],
        [0.12, -0.15, 0.7],
        [-0.12, 0.15, 0.7],
      ] as const) {
        g.add(
          k.mesh(new THREE.SphereGeometry(r * 0.75 * s, 14, 10), "#ffffff", [
            dx,
            0.5 + s * 0.05,
            dz,
          ]),
        );
      }
      break;
    case "pirate": {
      const tricorn = k.mesh(
        new THREE.CylinderGeometry(r * 1.75, r * 1.25, 0.3, 3, 1, true),
        "#1e1e22",
        [0, 0.16, 0],
      );
      tricorn.rotation.y = P / 6; // one corner forward
      g.add(tricorn);
      const crown = k.mesh(
        new THREE.SphereGeometry(r * 1.05, 18, 10, 0, P * 2, 0, P / 2),
        "#1e1e22",
        [0, 0.05, 0],
      );
      g.add(crown);
      g.add(k.mesh(new THREE.SphereGeometry(0.08, 10, 8), "#ffffff", [r * 1.05, 0.25, 0]));
      g.add(k.mesh(new THREE.BoxGeometry(0.03, 0.03, 0.2), "#ffffff", [r * 1.07, 0.16, 0]));
      break;
    }
    case "crown": {
      g.add(
        k.mesh(
          new THREE.CylinderGeometry(r * 0.9, r * 0.85, 0.2, 20, 1, true),
          "#ffcc33",
          [0, 0.1, 0],
        ),
      );
      for (let i = 0; i < 6; i++) {
        const t = (i / 6) * P * 2;
        g.add(
          k.mesh(new THREE.ConeGeometry(0.07, 0.2, 6), "#ffcc33", [
            Math.cos(t) * r * 0.9,
            0.3,
            Math.sin(t) * r * 0.9,
          ]),
        );
        g.add(
          k.mesh(new THREE.SphereGeometry(0.05, 8, 6), i % 2 ? "#e8202a" : "#3d9bff", [
            Math.cos(t) * r * 0.93,
            0.1,
            Math.sin(t) * r * 0.93,
          ]),
        );
      }
      break;
    }
    case "tophat":
      g.add(
        k.mesh(new THREE.CylinderGeometry(r * 1.4, r * 1.4, 0.04, 24), "#16161c", [0, 0.02, 0]),
      );
      g.add(
        k.mesh(new THREE.CylinderGeometry(r * 0.85, r * 0.8, 0.62, 24), "#16161c", [0, 0.33, 0]),
      );
      g.add(
        k.mesh(new THREE.CylinderGeometry(r * 0.82, r * 0.82, 0.12, 24), "#c8202a", [0, 0.1, 0]),
      );
      g.rotation.z = -0.12;
      break;
    case "cowboy": {
      const brim = k.mesh(
        new THREE.CylinderGeometry(r * 1.85, r * 1.85, 0.05, 28),
        "#a8692f",
        [0, 0.03, 0],
      );
      brim.scale.z = 0.8;
      g.add(brim);
      g.add(
        k.mesh(new THREE.CylinderGeometry(r * 0.75, r * 0.9, 0.38, 20), "#a8692f", [0, 0.22, 0]),
      );
      g.add(
        k.mesh(new THREE.CylinderGeometry(r * 0.91, r * 0.91, 0.08, 20), "#4a2a14", [0, 0.08, 0]),
      );
      break;
    }
    case "party": {
      const cone = k.mesh(new THREE.ConeGeometry(r * 0.7, 0.75, 20), "#ff4fb0", [0, 0.37, 0]);
      g.add(cone);
      for (let i = 0; i < 3; i++) {
        g.add(
          k
            .mesh(
              new THREE.TorusGeometry(r * 0.6 * (1 - (i + 0.5) / 3.4), 0.025, 6, 20),
              "#ffd23f",
              [0, 0.12 + i * 0.22, 0],
            )
            .rotateX(P / 2),
        );
      }
      g.add(k.mesh(new THREE.IcosahedronGeometry(0.1, 1), "#5ee9ff", [0, 0.78, 0]));
      g.rotation.z = -0.25;
      break;
    }
    case "viking": {
      const dome = k.mesh(
        new THREE.SphereGeometry(r * 1.08, 20, 12, 0, P * 2, 0, P / 2),
        "#9aa3ad",
      );
      dome.scale.y = 0.9;
      g.add(dome);
      g.add(k.mesh(new THREE.CylinderGeometry(r * 1.1, r * 1.1, 0.1, 20), "#7a5a2a", [0, 0.04, 0]));
      for (const s of [1, -1]) {
        const horn = k.mesh(new THREE.ConeGeometry(0.1, 0.5, 10), "#f3ead2", [
          0,
          0.25,
          s * r * 1.1,
        ]);
        horn.rotation.x = -s * 0.9;
        g.add(horn);
      }
      break;
    }
    case "bunny":
      for (const s of [1, -1]) {
        const ear = new THREE.Group();
        ear.position.set(-0.05, 0, s * r * 0.5);
        ear.rotation.x = -s * 0.25;
        const outer = k.mesh(new THREE.SphereGeometry(0.13, 14, 10), "#ffffff", [0, 0.38, 0]);
        outer.scale.set(0.8, 3.2, 1);
        const inner = k.mesh(new THREE.SphereGeometry(0.08, 12, 8), "#ffadd0", [0.06, 0.36, 0]);
        inner.scale.set(0.5, 3.4, 0.9);
        ear.add(outer, inner);
        g.add(ear);
      }
      break;
    case "propeller": {
      const colors = ["#e8202a", "#ffd23f", "#3d9bff", "#2fd17a"];
      for (let i = 0; i < 4; i++) {
        g.add(
          k.mesh(
            new THREE.SphereGeometry(r * 1.02, 10, 8, (i * P) / 2, P / 2, 0, P / 2),
            colors[i]!,
          ),
        );
      }
      g.add(k.mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.2, 6), "#333333", [0, r + 0.08, 0]));
      const prop = new THREE.Group();
      prop.position.y = r + 0.18;
      prop.userData.spin = 14;
      for (const s of [1, -1])
        prop.add(k.mesh(new THREE.BoxGeometry(0.42, 0.02, 0.08), "#ffd23f", [s * 0.21, 0, 0]));
      g.add(prop);
      break;
    }
    case "halo": {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r * 0.85, 0.05, 10, 32),
        k.mat("#ffe27a", { emissive: true }),
      );
      ring.rotation.x = P / 2;
      ring.position.y = 0.4;
      ring.userData.bob = 1;
      g.add(ring);
      break;
    }
  }
  return g;
}

function gadget(k: Kit, kind: Gadget, a: Anchors): Built {
  const [ex, ey] = a.eye;
  const g = new THREE.Group();
  const lens = (color: string, r = 0.13, opts?: { opacity?: number }) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.03, 20), k.mat(color, opts));
    m.rotation.z = P / 2;
    return m;
  };
  switch (kind) {
    case "none":
      return {};
    case "shades":
      for (const s of [1, -1]) {
        const l = lens("#15151a");
        l.position.set(ex + 0.06, ey, s * a.eyeSpread);
        g.add(l);
        const arm = k.mesh(new THREE.BoxGeometry(ex + 0.06, 0.03, 0.03), "#15151a", [
          (ex + 0.06) / 2,
          ey + 0.04,
          s * (a.side + 0.02),
        ]);
        g.add(arm);
      }
      g.add(
        k.mesh(new THREE.BoxGeometry(0.03, 0.03, a.eyeSpread * 2), "#15151a", [
          ex + 0.07,
          ey + 0.05,
          0,
        ]),
      );
      return { head: g };
    case "monocle": {
      const ring = k.mesh(new THREE.TorusGeometry(0.12, 0.022, 8, 20), "#ffcc33", [
        ex + 0.06,
        ey,
        -a.eyeSpread,
      ]);
      ring.rotation.y = P / 2;
      g.add(ring);
      const glass = lens("#cfefff", 0.11, { opacity: 0.35 });
      glass.position.set(ex + 0.06, ey, -a.eyeSpread);
      g.add(glass);
      g.add(
        k.mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.45, 4), "#ffcc33", [
          ex + 0.04,
          ey - 0.33,
          -a.eyeSpread - 0.05,
        ]),
      );
      return { head: g };
    }
    case "mustache": {
      const [mx, my] = a.mouth;
      for (const s of [1, -1]) {
        const half = k.mesh(new THREE.SphereGeometry(0.1, 12, 8), "#3b2416", [mx, my, s * 0.11]);
        half.scale.set(0.6, 0.55, 1.6);
        half.rotation.x = s * 0.35;
        g.add(half);
        const curl = k.mesh(new THREE.SphereGeometry(0.05, 10, 8), "#3b2416", [
          mx - 0.02,
          my + 0.06,
          s * 0.27,
        ]);
        g.add(curl);
      }
      return { head: g };
    }
    case "flower": {
      const flower = new THREE.Group();
      flower.position.set(a.top[0] - 0.05, a.top[1] - 0.12, a.side * 0.85);
      flower.rotation.x = -0.9;
      for (let i = 0; i < 5; i++) {
        const t = (i / 5) * P * 2;
        const petal = k.mesh(new THREE.SphereGeometry(0.09, 10, 8), "#ff6fb8", [
          Math.cos(t) * 0.1,
          0,
          Math.sin(t) * 0.1,
        ]);
        petal.scale.y = 0.4;
        flower.add(petal);
      }
      flower.add(k.mesh(new THREE.SphereGeometry(0.06, 10, 8), "#ffd23f", [0, 0.03, 0]));
      g.add(flower);
      return { head: g };
    }
    case "snorkel": {
      const mask = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.22, a.eyeSpread * 2 + 0.28),
        k.mat("#7fe3ff", { opacity: 0.45 }),
      );
      mask.position.set(ex + 0.06, ey, 0);
      g.add(mask);
      g.add(
        k.mesh(new THREE.BoxGeometry(0.13, 0.04, a.eyeSpread * 2 + 0.34), "#ff8a3d", [
          ex + 0.06,
          ey + 0.12,
          0,
        ]),
      );
      const strap = k.mesh(new THREE.TorusGeometry(a.side + 0.03, 0.03, 6, 24), "#222222", [
        ex * 0.3,
        ey,
        0,
      ]);
      strap.rotation.x = P / 2;
      strap.scale.x = Math.max(1, (ex + 0.1) / (a.side + 0.03));
      g.add(strap);
      const tube = k.mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.75, 8), "#ff8a3d", [
        ex * 0.4,
        ey + 0.2,
        a.side + 0.06,
      ]);
      g.add(tube);
      g.add(
        k.mesh(new THREE.SphereGeometry(0.06, 8, 6), "#ffd23f", [
          ex * 0.4,
          ey + 0.58,
          a.side + 0.06,
        ]),
      );
      return { head: g };
    }
    case "headphones": {
      const band = k.mesh(new THREE.TorusGeometry(a.side + 0.05, 0.04, 8, 24, P), "#26262c", [
        a.top[0] - 0.05,
        a.top[1] - a.side * 0.75,
        0,
      ]);
      band.scale.y = 1.05;
      g.add(band);
      for (const s of [1, -1]) {
        const cup = k.mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 16), "#e8202a", [
          a.top[0] - 0.05,
          a.top[1] - a.side * 0.75,
          s * (a.side + 0.05),
        ]);
        cup.rotation.x = P / 2;
        g.add(cup);
      }
      return { head: g };
    }
    case "stethoscope": {
      const w = a.wide;
      const loop = k.mesh(new THREE.TorusGeometry(0.46, 0.025, 6, 24, P * 1.3), "#3a3d44", [
        0.05,
        NECK_Y - 0.05,
        0,
      ]);
      loop.rotation.set(P / 2, 0, P - 0.65 * P);
      g.add(loop);
      const disc = k.mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.04, 16), "#c9ced6");
      disc.rotation.x = P / 2;
      g.add(stick(new THREE.Group().add(disc), w, 0.42 * P, -0.25, 1.12));
      g.add(
        stick(k.mesh(new THREE.BoxGeometry(0.02, 0.4, 0.02), "#3a3d44"), w, 0.33 * P, -0.25, 1.1),
      );
      return { body: g };
    }
    case "bowtie": {
      const tie = new THREE.Group();
      for (const s of [1, -1]) {
        const wing = k.mesh(new THREE.ConeGeometry(0.1, 0.2, 4), "#e8202a", [0, 0, s * 0.1]);
        wing.rotation.x = s * (P / 2);
        tie.add(wing);
      }
      tie.add(k.mesh(new THREE.SphereGeometry(0.05, 10, 8), "#b81f1f"));
      stick(tie, a.wide, 0.2 * P, 0, 1.1);
      tie.quaternion.identity();
      g.add(tie);
      return { body: g };
    }
  }
  return {};
}

/** What a dressed rider wears; `remove()` takes it off and frees it. */
export type Dressed = {
  /** Spins propellers and bobs halos. */
  update(t: number, dt: number): void;
  remove(): void;
};

/** Puts `look`'s hat, outfit and gadget on a rider rig (`head` may be missing on placeholders). */
export function dress(
  body: THREE.Object3D,
  headNode: THREE.Object3D | undefined,
  look: Look,
): Dressed {
  const k = kit();
  const a = ANCHORS[look.animal];
  const onBody = new THREE.Group();
  onBody.name = "outfit";
  const onHead = new THREE.Group();
  onHead.name = "hat";
  for (const part of [outfit(k, look.outfit, a), gadget(k, look.gadget, a)]) {
    if (part.body) onBody.add(part.body);
    if (part.head) onHead.add(part.head);
  }
  const h = hat(k, look.hat, a);
  if (h) onHead.add(h);
  body.add(onBody);
  (headNode ?? body).add(onHead);
  if (!headNode) onHead.position.set(NECK_X * S, NECK_Z * S, 0);

  const spinners: THREE.Object3D[] = [];
  const bobbers: THREE.Object3D[] = [];
  for (const root of [onBody, onHead]) {
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
      if (o.userData.spin) spinners.push(o);
      if (o.userData.bob) bobbers.push(o);
    });
  }
  const baseY = bobbers.map((o) => o.position.y);

  return {
    update(t, dt) {
      for (const o of spinners) o.rotation.y += Number(o.userData.spin) * dt;
      bobbers.forEach((o, i) => (o.position.y = baseY[i]! + Math.sin(t * 2.4) * 0.04));
    },
    remove() {
      for (const root of [onBody, onHead]) {
        root.removeFromParent();
        const materials = new Set<THREE.Material>();
        root.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          o.geometry.dispose();
          const own: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of own) materials.add(m);
        });
        for (const m of materials) m.dispose();
      }
    },
  };
}

/** The kit rider (`rider_N`) that an animal in a color is cloned from, and whether it needs a tint. */
export function bodyTemplate(look: Look): { index: number; tint: boolean } {
  const index = KIT_RIDER[look.animal](look.color);
  return { index, tint: look.color !== KIT_COLOR[index] };
}

/** Which kit rider (`rider_N`) an animal is cloned from; the hippo has a blue and a purple one. */
const KIT_RIDER: Record<Look["animal"], (color: number) => number> = {
  capybara: () => 0,
  hippo: (color) => (color === 2 ? 2 : 1),
  croc: () => 3,
  lobster: () => 4,
};
/** The LOOK_COLORS index each kit rider already is, so it needs no tint (lobster = red). */
const KIT_COLOR = [0, 1, 2, 3, 7];

/**
 * A copy of `m` turned to `hex`'s hue, saturated enough to read (a dusty purple hippo would
 * otherwise come out grey). Eyes, teeth and trim are grey and stay so.
 */
export function tinted(m: THREE.Material, hex: string): THREE.Material {
  const hue = new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 }).h;
  const c = m.clone();
  if ("color" in c && c.color instanceof THREE.Color) {
    const hsl = c.color.getHSL({ h: 0, s: 0, l: 0 });
    if (hsl.s > 0.15) c.color.setHSL(hue, Math.max(hsl.s, 0.65), hsl.l);
  }
  return c;
}
