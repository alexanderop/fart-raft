import * as THREE from "three";
import type { Box, LevelData, SimEvent } from "../../sim/types.ts";
import { applyPose } from "./coords.ts";
import type { Kit } from "./kit.ts";

/** Crossbar height above the water. Matches BAR_Z in assets-src/build_kit.py (pole is 8.5 tall). */
const BAR_Y = 7.4;
/** The sign hangs this far (in sign-space units, scaled by k) below the crossbar. */
const SIGN_DROP = 1.0;
/** The start gate stands this far ahead of the spawn point. */
const START_AHEAD = 4;
const START_FALLBACK_HALF = 8;
/** Signs lean back so the high camera behind the raft reads their face, like the video's. */
const SIGN_TILT = -0.95;

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
    barY: BAR_Y,
    signY: BAR_Y - SIGN_DROP * k,
    signRot: cp.rot - (alongX ? 0 : Math.PI / 2),
    last,
  };
}

type Gate = {
  sign: THREE.Group;
  baseY: number;
  phase: number;
  /** Time of the last burst, -Infinity when idle. */
  burstAt: number;
  /** Per-gate copies of the gate's materials, lit up by a checkpoint. */
  glow: THREE.MeshStandardMaterial[];
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

const isStandard = (m: THREE.Material): m is THREE.MeshStandardMaterial =>
  m instanceof THREE.MeshStandardMaterial;

/** The START gate: a Box across the channel, a few meters ahead of the spawn. Visual only. */
function startBox(level: LevelData): Box {
  const { spawn, channel } = level;
  return {
    x: spawn.x + Math.cos(spawn.rot) * START_AHEAD,
    y: spawn.y + Math.sin(spawn.rot) * START_AHEAD,
    rot: spawn.rot,
    hx: 0.5,
    hy: channel ? channel.halfWidth : START_FALLBACK_HALF,
  };
}

/**
 * Bamboo gates: two poles, a crossbar and a hanging sign (START, CHECKPOINT, FINISH). The sign
 * swings, and a checkpoint makes it squash-bounce while the gate lights up.
 */
export function createGates(level: LevelData, kit: Kit, _uTime: { value: number }) {
  const group = new THREE.Group();
  const gates: Gate[] = [];
  const lastIndex = level.checkpoints.length - 1;

  const addGate = (cp: Box, signKind: string, last: boolean, phase: number): Gate => {
    const lay = gateLayout(cp, last);
    const glow: THREE.MeshStandardMaterial[] = [];
    const lightUp = (obj: THREE.Object3D) =>
      glow.push(...ownMaterials(obj, isStandard, (m) => m.emissive.set(0xffffff)));

    for (const s of [-1, 1]) {
      const post = kit.clone("gate_post");
      applyPose(post, {
        x: cp.x + lay.ax * lay.half * s,
        y: cp.y + lay.ay * lay.half * s,
        rot: cp.rot,
      });
      lightUp(post);
      group.add(post);
    }

    // Wrapper rotation.x is the sign's own long axis (yaw first); the crossbar rides in the same frame.
    const bar = kit.clone("gate_bar");
    bar.scale.x = lay.half;
    applyPose(bar, { x: cp.x, y: cp.y, rot: lay.signRot }, lay.barY);
    lightUp(bar);
    group.add(bar);

    const wrapper = new THREE.Group();
    wrapper.rotation.order = "YXZ";
    applyPose(wrapper, { x: cp.x, y: cp.y, rot: lay.signRot }, lay.signY);
    const sign = kit.clone(signKind);
    sign.scale.setScalar(lay.k);
    lightUp(sign);
    wrapper.add(sign);
    group.add(wrapper);

    for (const m of glow) m.emissiveIntensity = 0;
    return { sign: wrapper, baseY: lay.signY, phase, burstAt: -Infinity, glow };
  };

  gates.push(addGate(startBox(level), "start_sign", false, 0));
  const checkpointGates = level.checkpoints.map((cp, i) => {
    const last = i === lastIndex;
    const gate = addGate(cp, last ? "finish_sign" : "gate_sign", last, (i + 1) * 1.7);
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
    return gate;
  });
  gates.push(...checkpointGates);

  let now = 0;
  return {
    group,
    onEvent(e: SimEvent) {
      if (e.type === "checkpoint" && checkpointGates[e.index])
        checkpointGates[e.index]!.burstAt = now;
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
          SIGN_TILT +
          Math.sin(time * 1.3 + g.phase) * 0.035 +
          (live ? decay * Math.sin(age * 20) * 0.12 : 0);
        g.sign.rotation.z = Math.sin(time * 0.9 + g.phase * 2) * 0.02;
        const flash = live ? Math.exp(-3 * age) : 0;
        for (const m of g.glow) m.emissiveIntensity = flash * 0.7;
      }
    },
  };
}
