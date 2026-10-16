import { Vector3, type PerspectiveCamera } from "three";
import { nearestS, sampleChannel } from "../../sim/channel";
import { GAS_MAX, TICK_RATE, type Seat } from "../../sim/constants";
import type { LevelData, Pose, SimEvent, Snapshot } from "../../sim/types";

const LOW_GAS = 0.25;
/** Fart events fire every tick while a seat farts. A gap longer than this starts a new puff. */
const PUFF_GAP_TICKS = 6;
/** Height above the water where the name tag floats, in meters. */
const TAG_HEIGHT = 2.4;

const CLOCK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M12 7v5.5l3.5 2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PUFF_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 18.5a4.5 4.5 0 0 1-.6-8.96A5.5 5.5 0 0 1 17.4 8.9a4.8 4.8 0 0 1 .1 9.6z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>`;

/** Re-run a CSS animation class on an element, even if it is already playing. */
function replay(el: HTMLElement, className: string) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `mm:ss.cc`, e.g. 01:19.65. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 10));
  const cs = total % 100;
  const s = Math.floor(total / 100) % 60;
  const m = Math.floor(total / 6000);
  return `${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

export type ProgressTrack = {
  /** 0..1 along the course. */
  at(snap: Snapshot): number;
  /** Where each checkpoint sits on the bar, 0..1, in race order. */
  markers: number[];
};

/**
 * Course progress for the top bar. A channel course measures real distance along its
 * centerline; a course without one splits the bar into equal spawn→gate segments.
 */
export function progressTrack(level: LevelData): ProgressTrack {
  const { checkpoints, spawn, channel } = level;
  const n = checkpoints.length;
  if (channel) {
    const route = sampleChannel(channel);
    const finish = nearestS(route, checkpoints[n - 1]!) || 1;
    const start = nearestS(route, spawn);
    const frac = (p: { x: number; y: number }) =>
      Math.min(1, Math.max(0, (nearestS(route, p) - start) / (finish - start)));
    return {
      at: (snap) =>
        snap.phase.kind === "finished" ? 1 : snap.phase.kind === "countdown" ? 0 : frac(snap.raft),
      markers: checkpoints.map(frac),
    };
  }
  return {
    at(snap) {
      const { phase, raft } = snap;
      if (phase.kind === "finished") return 1;
      if (phase.kind === "countdown") return 0;
      const k = Math.min(phase.nextCheckpoint, n - 1);
      const from = k === 0 ? spawn : checkpoints[k - 1]!;
      const to = checkpoints[k]!;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : ((raft.x - from.x) * dx + (raft.y - from.y) * dy) / len2;
      return (k + Math.min(1, Math.max(0, t))) / n;
    },
    markers: checkpoints.map((_, i) => (i + 1) / n),
  };
}

export type HudOptions = {
  seatLabels: readonly string[];
  seats: readonly Seat[];
  camera: PerspectiveCamera;
  progress: ProgressTrack;
};

export function createHud(host: HTMLElement, opts: HudOptions) {
  const { seatLabels, seats, camera, progress } = opts;
  const { markers } = progress;
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="hud">
      <div class="hud-track" data-track>
        <div class="track-fill" data-fill></div>
        ${markers.map((m) => `<i class="track-mark" style="left:${m * 100}%"></i>`).join("")}
        <b class="track-raft" data-raft></b>
      </div>
      <div class="hud-timer" data-status>${CLOCK_ICON}<span data-time>00:00.00</span></div>
      <div class="hud-farts" data-farts>${PUFF_ICON}<span data-puffs>0</span></div>
      <div class="hud-count" data-count></div>
      <div class="hud-toast" data-toast></div>
      <div class="hud-finish" data-finish>
        <div class="finish-title">Finish!</div>
        <div class="finish-time" data-finish-time></div>
        <div class="finish-hint">R to restart · Esc for menu</div>
      </div>
      <div class="hud-tags">${seatLabels
        .map((label, i) => `<div class="tag" data-seat="${i}"><span>${label}</span><i></i></div>`)
        .join("")}</div>
    </div>`,
  );
  const $ = (sel: string) => host.querySelector<HTMLElement>(sel)!;
  const status = $("[data-status]");
  const time = $("[data-time]");
  const fartPill = $("[data-farts]");
  const puffs = $("[data-puffs]");
  const count = $("[data-count]");
  const toast = $("[data-toast]");
  const finish = $("[data-finish]");
  const finishTime = $("[data-finish-time]");
  const fill = $("[data-fill]");
  const raftMark = $("[data-raft]");
  const marks = [...host.querySelectorAll<HTMLElement>(".track-mark")];
  const tags = [...host.querySelectorAll<HTMLElement>(".tag")];
  const fills = tags.map((g) => g.querySelector<HTMLElement>("i")!);
  const lastGas = tags.map(() => GAS_MAX);

  let shownCount = "";
  let puffCount = 0;
  const fartedThisFrame = seats.map(() => false);
  const lastFartTick = seats.map(() => -Infinity);
  const world = new Vector3();

  status.addEventListener("animationend", () => status.classList.remove("pop"));
  fartPill.addEventListener("animationend", () => fartPill.classList.remove("pop"));

  const show = (text: string, kind: "slam" | "bounce") => {
    toast.textContent = text;
    toast.className = `hud-toast ${kind}`;
    replay(toast, "on");
  };

  function countPuffs(tick: number, phaseKind: string) {
    if (phaseKind === "countdown") {
      puffCount = 0;
      lastFartTick.fill(-Infinity);
      fartedThisFrame.fill(false);
      puffs.textContent = "0";
      return;
    }
    let rose = false;
    fartedThisFrame.forEach((farted, i) => {
      if (!farted) return;
      fartedThisFrame[i] = false;
      if (tick - lastFartTick[i]! > PUFF_GAP_TICKS) {
        puffCount++;
        rose = true;
      }
      lastFartTick[i] = tick;
    });
    if (rose) {
      puffs.textContent = String(puffCount);
      replay(fartPill, "pop");
    }
  }

  function placeTags(raft: Pose) {
    const cos = Math.cos(raft.rot);
    const sin = Math.sin(raft.rot);
    tags.forEach((tag, i) => {
      const seat = seats[i]!;
      const sx = raft.x + seat.x * cos - seat.y * sin;
      const sy = raft.y + seat.x * sin + seat.y * cos;
      world.set(sx, TAG_HEIGHT, -sy).project(camera);
      const visible = world.z < 1;
      tag.style.visibility = visible ? "visible" : "hidden";
      if (!visible) return;
      const x = ((world.x + 1) / 2) * innerWidth;
      const y = ((1 - world.y) / 2) * innerHeight;
      tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    });
  }

  return {
    onEvent(e: SimEvent) {
      if (e.type === "go") show("GO!", "slam");
      if (e.type === "checkpoint") {
        show(`Checkpoint ${e.index + 1}`, "bounce");
        replay(status, "pop");
      }
      if (e.type === "fart") fartedThisFrame[e.seat] = true;
    },
    draw(snap: Snapshot, raft: Pose) {
      const { phase } = snap;
      const ms =
        phase.kind === "countdown"
          ? 0
          : phase.kind === "racing"
            ? ((snap.tick - phase.startTick) / TICK_RATE) * 1000
            : phase.timeMs;
      time.textContent = formatTime(ms);

      const p = Math.min(1, Math.max(0, progress.at(snap)));
      fill.style.width = `${p * 100}%`;
      raftMark.style.left = `calc(9px + (100% - 18px) * ${p})`;
      marks.forEach((m, i) => m.classList.toggle("done", p >= markers[i]! - 1e-6));

      countPuffs(snap.tick, phase.kind);

      // Big countdown number: pops in each time it changes.
      const number = phase.kind === "countdown" ? `${Math.ceil(phase.ticksLeft / TICK_RATE)}` : "";
      if (number !== shownCount) {
        shownCount = number;
        count.textContent = number;
        if (number) replay(count, "on");
        else count.classList.remove("on");
      }

      const done = phase.kind === "finished";
      if (done && !finish.classList.contains("on")) {
        finishTime.textContent = formatTime(phase.timeMs);
        replay(finish, "on");
      } else if (!done) finish.classList.remove("on");

      fills.forEach((bar, i) => {
        const gas = snap.gas[i]!;
        const frac = gas / GAS_MAX;
        bar.style.width = `${frac * 100}%`;
        tags[i]!.classList.toggle("low", frac < LOW_GAS);
        tags[i]!.classList.toggle("draining", gas < lastGas[i]! - 1e-6);
        lastGas[i] = gas;
      });
      placeTags(raft);
    },
  };
}
