import * as THREE from "three";
import { bumperRadius } from "../../sim/hazards/bumper.ts";
import { doublegateAngles, doublegateShut } from "../../sim/hazards/doublegate.ts";
import { dropgateLift, dropgateShake } from "../../sim/hazards/dropgate.ts";
import { hammerLift, hammerPivot } from "../../sim/hazards/hammer.ts";
import { MACE_BANK_GAP } from "../../sim/constants.ts";
import { maceAngle, maceBob, maceRope } from "../../sim/hazards/mace.ts";
import { mineCenter } from "../../sim/hazards/mine.ts";
import { pistonOut } from "../../sim/hazards/piston.ts";
import type { HazardDef, Pose } from "../../sim/types.ts";
import { applyPose } from "./coords.ts";
import type { Kit } from "./kit.ts";

/** Where the frame is seen from: the camera (three space) and the raft (sim pose). */
export type Eye = { camera: THREE.Vector3; raft: Pose };

/** One hazard's mesh, kept in step with its sim pose. */
export type HazardView = {
  root: THREE.Object3D;
  /** `pose` is the interpolated sim pose, `t` the hazard time (s, `hazardTime`) the frame shows, `eye` the view. */
  update(pose: Pose, t: number, eye: Eye): void;
};

/**
 * `log` in the kit: half-length and radius of the template (its spike tips included). It is
 * scaled by (hx / LOG_HALF, hy, hy), so a log built with hx = LOG_HALF · hy is not distorted.
 */
const LOG_HALF = 2.4;
/** A bumper floats and bobs this high (m) and this fast (relative to its pulse). */
const BOB = 0.08;
/** `hammer` in the kit: its head's half-length across the arm, scaled to the smash zone's hy. */
const HAMMER_HALF = 1.5;
/** The piston's ram reaches this far (m) behind the head when it rests, into the bank. */
const ROD_REST = 0.6;
/**
 * `dropgate_bar` in the kit: its half-thickness across the bar, scaled to the gate's hy. Raised, the
 * bar's spike tips hang DROPGATE_RAISE m above the water, over the riders and under the camera's
 * line to the raft until the raft is well past it (and then the bar fades, see `occludes`).
 */
const DROPGATE_HALF = 0.6;
const DROPGATE_RAISE = 6.2;
/** The posts stand this far (m) beyond the bar's ends, on the banks. */
const DROPGATE_POST_OUT = 0.7;
/** A slam's splash spreads and fades over this many seconds. */
const SPLASH_TIME = 0.6;
/** How far a raised bar fades when it hides the raft from the camera, and how fast (1/s). */
const FADED = 0.22;
const FADE_RATE = 8;
/** `doublegate_door` in the kit: its length, hinge to tip, scaled to the gate's hx. */
const DOOR_LENGTH = 6.75;
/** Shut doors hide the raft that just slipped through: aim the sight test this high (m). */
const DOOR_MID = 1.5;
/** A mine bobs this high (m), and its lamp blinks once per this many seconds. */
const MINE_BOB = 0.1;
const MINE_BLINK = 1.4;
/**
 * A mace's bob hangs this far (m, times its radius) above the water at the bottom of its swing:
 * low enough to sweep the riders. Its collar's top sits MACE_COLLAR radii above the bob's center.
 */
const MACE_LOW = 1.1;
const MACE_COLLAR = 0.75;
/** The gantry posts stand this far (m) beyond the bob's swing plus MACE_BANK_GAP, on the banks. */
const MACE_POST_OUT = 0.7;
/** `mace_post` and `mace_beam` in the kit: the post's height and the beam's half-length. */
const MACE_POST_H = 10;
const MACE_BEAM_HALF = 1;
/** The bob turns slowly on its rope, rad/s. */
const MACE_SPIN = 0.6;

/**
 * Does a ball of radius `r` at three-space `at` stand between the camera and the raft? It does when
 * it is between them and within `r` (plus a margin) of the sight line to the riders.
 */
function blocks(at: THREE.Vector3, r: number, eye: Eye): boolean {
  const ax = eye.camera.x;
  const ay = eye.camera.y;
  const az = eye.camera.z;
  const dx = eye.raft.x - ax;
  const dy = 1.2 - ay;
  const dz = -eye.raft.y - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  const f = ((at.x - ax) * dx + (at.y - ay) * dy + (at.z - az) * dz) / len2;
  if (f <= 0 || f >= 1) return false;
  const px = ax + dx * f - at.x;
  const py = ay + dy * f - at.y;
  const pz = az + dz * f - at.z;
  return Math.hypot(px, py, pz) < r + 1;
}

/**
 * Does a bar hanging `height` m up on the line through (x, y) along `rot` stand between the camera
 * and the raft? It does when the two are on either side of the line and the sight line crosses it
 * near the bar's height.
 */
function occludes(x: number, y: number, rot: number, height: number, eye: Eye): boolean {
  const nx = -Math.sin(rot);
  const ny = Math.cos(rot);
  const raft = (eye.raft.x - x) * nx + (eye.raft.y - y) * ny;
  const cam = (eye.camera.x - x) * nx + (-eye.camera.z - y) * ny;
  if (Math.sign(raft) === Math.sign(cam)) return false;
  const f = cam / (cam - raft);
  const sight = eye.camera.y + (1.2 - eye.camera.y) * f; // aimed at the riders, about 1.2 m up
  return sight > height - 1.5 && sight < height + 2.5;
}

/** Per-view copies of the template's materials, so one hazard can fade or glow on its own. */
function ownMaterials(root: THREE.Object3D, pick: (m: THREE.Material) => boolean = () => true) {
  const own: (THREE.MeshStandardMaterial | THREE.MeshLambertMaterial)[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const material: unknown = o.material;
    const lit =
      material instanceof THREE.MeshStandardMaterial ||
      material instanceof THREE.MeshLambertMaterial;
    if (!lit || !pick(material)) return;
    const copy = material.clone();
    o.material = copy;
    own.push(copy);
  });
  return own;
}

/** Kit nodes for kinds whose main mesh is not named after the kind. */
const ASSET: Partial<Record<HazardDef["kind"], string>> = {
  cross: "spinner",
  dropgate: "dropgate_bar",
  doublegate: "doublegate_door",
};

/** Builds one kind's view around `mesh`, its kit node (see `ASSET`). */
type ViewOf = (def: HazardDef, mesh: THREE.Object3D, kit: Kit) => HazardView;

/** One entry per hazard kind, so a kind without a view fails the typecheck. */
const VIEWS: Record<HazardDef["kind"], ViewOf> = {
  spinner(def, mesh) {
    mesh.scale.set(def.hx, def.hy, def.hy);
    return {
      root: mesh,
      update: (pose) => applyPose(mesh, pose, def.hy),
    };
  },
  cross(def, mesh, kit) {
    // Two spinner bars on one hub, the second square to the first.
    const holder = new THREE.Group();
    const second = kit.clone("spinner");
    second.rotation.y = Math.PI / 2;
    for (const bar of [mesh, second]) {
      bar.scale.set(def.hx, def.hy, def.hy);
      holder.add(bar);
    }
    return { root: holder, update: (pose) => applyPose(holder, pose, def.hy) };
  },
  hammer(def, mesh, kit) {
    // The post stands on the bank; the arm swings up about its axle by the shared schedule.
    const holder = new THREE.Group();
    holder.add(kit.clone("hammer_post"), mesh);
    mesh.scale.z = def.hy / HAMMER_HALF;
    applyPose(holder, { ...hammerPivot(def), rot: def.rot });
    return {
      root: holder,
      update(_, t) {
        mesh.rotation.z = hammerLift(def, t);
      },
    };
  },
  piston(def, mesh, kit) {
    // The head follows the sim pose; the ram behind it stretches back to where it rests.
    const holder = new THREE.Group();
    const rod = kit.clone("piston_rod");
    mesh.scale.set(def.hx, 1, def.hy); // three z is across: the sim's y
    rod.position.x = -def.hx;
    holder.add(mesh, rod);
    return {
      root: holder,
      update(pose, t) {
        applyPose(holder, pose);
        rod.scale.x = (def.range ?? 0) * pistonOut(def, t) + ROD_REST;
      },
    };
  },
  sweeper(def, mesh) {
    mesh.scale.set(def.hx, 1, 1);
    return { root: mesh, update: (pose) => applyPose(mesh, pose) };
  },
  log(def, mesh) {
    // The log rolls across its axis: the holder follows the sim pose, the mesh spins as it travels.
    mesh.scale.set(def.hx / LOG_HALF, def.hy, def.hy);
    const holder = new THREE.Group();
    holder.add(mesh);
    return {
      root: holder,
      update(pose) {
        applyPose(holder, pose);
        // Distance travelled along the sim's left of the axis, from where the log started.
        const run = -(pose.x - def.x) * Math.sin(def.rot) + (pose.y - def.y) * Math.cos(def.rot);
        mesh.rotation.x = -run / def.hy;
      },
    };
  },
  dropgate(def, mesh, kit) {
    // The posts stand on the banks; the bar rides up and down between them by the shared schedule.
    const holder = new THREE.Group();
    for (const side of [1, -1]) {
      const post = kit.clone("dropgate_post");
      post.position.x = side * (def.hx + DROPGATE_POST_OUT);
      post.rotation.y = side > 0 ? Math.PI : 0; // its slot faces the bar
      holder.add(post);
    }
    mesh.scale.set(def.hx, 1, def.hy / DROPGATE_HALF);
    holder.add(mesh);
    const faded = ownMaterials(mesh);
    for (const m of faded) m.transparent = true;
    const spray = new THREE.MeshBasicMaterial({
      color: 0xe8f6ff,
      transparent: true,
      depthWrite: false,
    });
    const splash = new THREE.Mesh(new THREE.CircleGeometry(1, 24), spray);
    splash.rotation.x = -Math.PI / 2;
    splash.position.y = 0.05;
    splash.visible = false;
    holder.add(splash);
    applyPose(holder, def);
    let opacity = 1;
    let lastT = 0;
    let lastLift = 1;
    let slamAt = -Infinity;
    return {
      root: holder,
      update(_, t, eye) {
        const lift = dropgateLift(def, t);
        if (t < lastT) slamAt = -Infinity; // a restart
        if (lift === 0 && lastLift > 0) slamAt = t;
        const dt = Math.min(0.1, Math.max(0, t - lastT));
        lastT = t;
        lastLift = lift;
        // The tell: the bar rattles on its chains before it drops.
        const shake = dropgateShake(def, t);
        const height = lift * DROPGATE_RAISE;
        mesh.position.set(
          Math.sin(t * 71) * 0.07 * shake,
          height + Math.sin(t * 53) * 0.12 * shake,
          0,
        );
        mesh.rotation.x = Math.sin(t * 61) * 0.06 * shake;
        const target = lift > 0.5 && occludes(def.x, def.y, def.rot, height, eye) ? FADED : 1;
        opacity += (target - opacity) * Math.min(1, FADE_RATE * dt);
        for (const m of faded) {
          m.opacity = opacity;
          m.depthWrite = opacity > 0.99;
        }
        // The slam throws up a sheet of spray along the bar.
        const since = (t - slamAt) / SPLASH_TIME;
        splash.visible = since >= 0 && since < 1;
        if (splash.visible) {
          splash.scale.set(def.hx * (0.9 + 0.3 * since), (1 + 3.5 * since) * def.hy * 1.5, 1);
          spray.opacity = 0.75 * (1 - since);
        }
      },
    };
  },
  doublegate(def, mesh, kit) {
    // A post and a door on each bank; the doors swing about their hinges by the shared schedule.
    const holder = new THREE.Group();
    const doors = [mesh, kit.clone("doublegate_door")];
    doors.forEach((door, i) => {
      const post = kit.clone("doublegate_post");
      const hinge = new THREE.Group();
      // The holder is posed at (x, y, rot): the left hinge sits hx along its +x, the right one -hx.
      hinge.position.x = i === 0 ? def.hx : -def.hx;
      post.rotation.y = i === 0 ? 0 : Math.PI; // the post stands behind its door, in the bank
      door.scale.x = def.hx / DOOR_LENGTH;
      hinge.add(post, door);
      holder.add(hinge);
    });
    applyPose(holder, def);
    const faded = doors.flatMap((door) => ownMaterials(door));
    for (const m of faded) m.transparent = true;
    let opacity = 1;
    let lastT = 0;
    return {
      root: holder,
      update(_, t, eye) {
        const angles = doublegateAngles(def, t);
        // Door angles are sim angles; relative to the holder (posed at rot) they turn about y.
        doors.forEach((door, i) => (door.rotation.y = angles[i]! - def.rot));
        const dt = Math.min(0.1, Math.max(0, t - lastT));
        lastT = t;
        const shut = doublegateShut(def, t) > 0.3;
        const target = shut && occludes(def.x, def.y, def.rot, DOOR_MID, eye) ? FADED : 1;
        opacity += (target - opacity) * Math.min(1, FADE_RATE * dt);
        for (const m of faded) {
          m.opacity = opacity;
          m.depthWrite = opacity > 0.99;
        }
      },
    };
  },
  mine(def, mesh) {
    // Bobs on the water and turns slowly; its lamp blinks, each mine on its own beat.
    const holder = new THREE.Group();
    mesh.scale.setScalar(def.hx);
    holder.add(mesh);
    const lamps = ownMaterials(mesh, (m) => m.name === "mine_lamp");
    const glow = lamps.map((m) => m.emissiveIntensity);
    const beat = (def.phase ?? 0) + def.x * 0.37;
    return {
      root: holder,
      update(_, t) {
        applyPose(
          holder,
          { ...mineCenter(def, t), rot: 0.3 * t + beat },
          MINE_BOB * Math.sin(t * 2.1 + beat),
        );
        const u = (t / MINE_BLINK + beat) % 1;
        const blink = Math.max(0, 1 - Math.abs(u - 0.1) / 0.1); // a short flash, then dim
        lamps.forEach((m, i) => (m.emissiveIntensity = glow[i]! * (0.25 + 1.5 * blink)));
      },
    };
  },
  mace(def, mesh, kit) {
    // A gantry stands across the channel; the rope swings from the middle of its beam by the shared
    // schedule, and the bob rises on the arc exactly as `maceBob` says.
    const holder = new THREE.Group();
    const rope = maceRope(def);
    const low = def.hx * MACE_LOW;
    const pivot = low + rope;
    const out = (def.range ?? 0) + MACE_BANK_GAP + MACE_POST_OUT;
    for (const side of [1, -1]) {
      const post = kit.clone("mace_post");
      post.position.x = side * out;
      post.scale.y = (pivot + 0.6) / MACE_POST_H;
      holder.add(post);
    }
    const beam = kit.clone("mace_beam");
    beam.position.y = pivot + 0.6;
    beam.scale.x = (out + 0.5) / MACE_BEAM_HALF;
    const swing = new THREE.Group();
    swing.position.y = pivot;
    const line = kit.clone("mace_rope");
    line.scale.y = rope - def.hx * MACE_COLLAR;
    mesh.scale.setScalar(def.hx);
    mesh.position.y = -rope;
    swing.add(line, mesh);
    holder.add(beam, swing);
    applyPose(holder, def);
    const faded = [beam, line, mesh].flatMap((o) => ownMaterials(o));
    for (const m of faded) m.transparent = true;
    const at = new THREE.Vector3();
    let opacity = 1;
    let lastT = 0;
    return {
      root: holder,
      update(_, t, eye) {
        swing.rotation.z = maceAngle(def, t);
        mesh.rotation.y = MACE_SPIN * t;
        const dt = Math.min(0.1, Math.max(0, t - lastT));
        lastT = t;
        const bob = maceBob(def, t);
        at.set(bob.x, low + bob.lift, -bob.y);
        const hidden = blocks(at, def.hx, eye) || occludes(def.x, def.y, def.rot, pivot, eye);
        opacity += ((hidden ? FADED : 1) - opacity) * Math.min(1, FADE_RATE * dt);
        for (const m of faded) {
          m.opacity = opacity;
          m.depthWrite = opacity > 0.99;
        }
      },
    };
  },
  bumper(def, mesh) {
    // Faces upstream, so the grin greets the raft; swells with the sim's pulse and bobs on the water.
    const holder = new THREE.Group();
    mesh.rotation.y = Math.PI;
    holder.add(mesh);
    return {
      root: holder,
      update(pose, t) {
        const r = bumperRadius(def, t);
        holder.scale.setScalar(r);
        applyPose(holder, pose, BOB * Math.sin(t * def.speed * 1.5 + (def.phase ?? 0)));
      },
    };
  },
};

export function createHazardView(kit: Kit, def: HazardDef): HazardView {
  return VIEWS[def.kind](def, kit.clone(ASSET[def.kind] ?? def.kind), kit);
}
