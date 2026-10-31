import * as THREE from "three";
import { halfWidthAt, nearestS, sampleChannel } from "../../sim/channel.ts";
import { RIDER_RING } from "../../sim/constants.ts";
import type { Box, LevelData, Pose, SimEvent } from "../../sim/types.ts";
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
/** Bar and sign fade to this opacity while they hide the raft, at this rate (1/s), like the drop gate. */
const FADED = 0.2;
const FADE_RATE = 8;
/** Only gates whose center is this close (m) to the raft are tested for blocking the view. */
const NEAR_GATE = 45;
/** A gate up to this far (m) beyond the raft still counts: it hides what the crew is about to meet. */
const AHEAD = 6;
/** The raft's screen box reaches this share of its own height further up, over the water just ahead. */
const REACH = 0.2;
/** Riders' heads top out about this high (m), and the raft's box spans the ring plus a margin. */
const RAFT_TOP = 3;
const RAFT_SPAN = RIDER_RING + 0.5;

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

/**
 * Does a gate's bar and sign (its box `corners`, world space) hide the raft from `camera`? It does
 * when it sits in front of the raft, or at most AHEAD m beyond it, and its screen box overlaps the
 * raft's, stretched up a little over the water just ahead. A box that straddles the camera covers
 * the screen. The camera's matrices must be current.
 */
export function gateBlocksView(
  corners: readonly THREE.Vector3[],
  raft: Pose,
  camera: THREE.Camera,
): boolean {
  const raftBox = screenBox(raftCorners(raft), camera);
  const gateBox = screenBox(corners, camera);
  if (!raftBox || !gateBox) return false;
  if (gateBox.near > raftBox.far + AHEAD) return false;
  if (gateBox.straddles) return true;
  const top = raftBox.y1 + (raftBox.y1 - raftBox.y0) * REACH;
  return (
    gateBox.x0 < raftBox.x1 &&
    gateBox.x1 > raftBox.x0 &&
    gateBox.y0 < top &&
    gateBox.y1 > raftBox.y0
  );
}

const scratch = new THREE.Vector3();
const raftPoints = Array.from({ length: 8 }, () => new THREE.Vector3());

function raftCorners(raft: Pose): THREE.Vector3[] {
  raftPoints.forEach((p, i) => {
    const sx = i & 1 ? 1 : -1;
    const sy = i & 2 ? 1 : -1;
    // Sim (x, y, h) to three (x, h, -y), see coords.ts.
    p.set(raft.x + sx * RAFT_SPAN, i & 4 ? RAFT_TOP : 0, -(raft.y + sy * RAFT_SPAN));
  });
  return raftPoints;
}

/** Screen box (NDC) and view-depth range of a set of points; undefined when all are behind. */
function screenBox(points: readonly THREE.Vector3[], camera: THREE.Camera) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let near = Infinity;
  let far = -Infinity;
  let behind = 0;
  for (const p of points) {
    scratch.copy(p).applyMatrix4(camera.matrixWorldInverse);
    const depth = -scratch.z;
    near = Math.min(near, depth);
    far = Math.max(far, depth);
    if (depth < 0.1) {
      behind++;
      continue;
    }
    scratch.applyMatrix4(camera.projectionMatrix);
    x0 = Math.min(x0, scratch.x);
    x1 = Math.max(x1, scratch.x);
    y0 = Math.min(y0, scratch.y);
    y1 = Math.max(y1, scratch.y);
  }
  if (behind === points.length) return undefined;
  return { x0, y0, x1, y1, near, far, straddles: behind > 0 };
}

type Gate = {
  sign: THREE.Group;
  baseY: number;
  phase: number;
  /** Time of the last burst, -Infinity when idle. */
  burstAt: number;
  /** Per-gate copies of the gate's materials, lit up by a checkpoint. */
  glow: THREE.MeshStandardMaterial[];
  /** World corners of the bar and sign's box, for the view test. */
  corners: THREE.Vector3[];
  center: { x: number; y: number };
  /** Per-gate bar and sign materials, faded while they hide the raft. */
  fade: THREE.Material[];
  opacity: number;
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
const isAny = (m: THREE.Material): m is THREE.Material => m.isMaterial;

/** The START gate: a Box across the channel, a few meters ahead of the spawn. Visual only. */
function startBox(level: LevelData): Box {
  const { spawn, channel } = level;
  const x = spawn.x + Math.cos(spawn.rot) * START_AHEAD;
  const y = spawn.y + Math.sin(spawn.rot) * START_AHEAD;
  const hy = channel
    ? halfWidthAt(channel, nearestS(sampleChannel(channel), { x, y }))
    : START_FALLBACK_HALF;
  return { x, y, rot: spawn.rot, hx: 0.5, hy };
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

    // The bar and sign share a frame at the gate's pose; the wrapper's rotation.x tilts the sign
    // about its own long axis. Their materials are this gate's own so it can fade alone.
    const frame = new THREE.Group();
    const bar = kit.clone("gate_bar");
    bar.scale.x = lay.half;
    bar.position.y = lay.barY;
    const wrapper = new THREE.Group();
    wrapper.rotation.order = "YXZ";
    wrapper.rotation.x = SIGN_TILT;
    wrapper.position.y = lay.signY;
    const sign = kit.clone(signKind);
    sign.scale.setScalar(lay.k);
    wrapper.add(sign);
    frame.add(bar, wrapper);
    const fade = ownMaterials(frame, isAny, (m) => (m.transparent = true));
    for (const m of fade.filter(isStandard)) {
      m.emissive.set(0xffffff);
      glow.push(m);
    }
    // Box in the frame's own space (frame still at the origin), padded for the swing and hop.
    frame.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(frame).expandByScalar(0.4);
    applyPose(frame, { x: cp.x, y: cp.y, rot: lay.signRot });
    frame.updateMatrix();
    const corners = Array.from({ length: 8 }, (_, i) =>
      new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ).applyMatrix4(frame.matrix),
    );
    group.add(frame);

    for (const m of glow) m.emissiveIntensity = 0;
    return {
      sign: wrapper,
      baseY: lay.signY,
      phase,
      burstAt: -Infinity,
      glow,
      corners,
      center: { x: cp.x, y: cp.y },
      fade,
      opacity: 1,
    };
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
  /** Fade toward FADED while a gate hides the raft from the camera, back to opaque when clear. */
  const fadeBlocking = (dt: number, raft: Pose, camera: THREE.Camera) => {
    camera.updateMatrixWorld();
    for (const g of gates) {
      const near = Math.hypot(g.center.x - raft.x, g.center.y - raft.y) < NEAR_GATE;
      const target = near && gateBlocksView(g.corners, raft, camera) ? FADED : 1;
      if (target === g.opacity) continue;
      g.opacity += (target - g.opacity) * Math.min(1, FADE_RATE * dt);
      if (Math.abs(target - g.opacity) < 0.005) g.opacity = target;
      for (const m of g.fade) {
        m.opacity = g.opacity;
        m.depthWrite = g.opacity > 0.99;
      }
    }
  };

  return {
    group,
    onEvent(e: SimEvent) {
      if (e.type === "checkpoint" && checkpointGates[e.index])
        checkpointGates[e.index]!.burstAt = now;
    },
    update(time: number, raft: Pose, camera: THREE.Camera) {
      const dt = Math.min(0.1, Math.max(0, time - now));
      now = time;
      fadeBlocking(dt, raft, camera);
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
