import { Vector3, type PerspectiveCamera } from "three";
import { nearestS, sampleChannel } from "../../sim/channel.ts";
import { GAS_MAX, MAX_CREW, TICK_RATE } from "../../sim/constants.ts";
import { SEAT_COLORS } from "../render/zones.ts";
import type { Crew, LevelData, Pose, SimEvent, View } from "../../sim/types.ts";
import { teamColor, teamName } from "../teams.ts";
import { teamResult, type TeamResult } from "./result.ts";
import "./deaths.css";

const LOW_GAS = 0.25;
/** Fart events fire every tick while a seat farts. A gap longer than this starts a new puff. */
const PUFF_GAP_TICKS = 6;
/** Height above the water where the name tag floats, in meters. */
const TAG_HEIGHT = 2.9;
/** The rival raft's tag floats above its riders' name height. */
const RIVAL_TAG_HEIGHT = 3.6;

const CLOCK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M12 7v5.5l3.5 2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PUFF_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 18.5a4.5 4.5 0 0 1-.6-8.96A5.5 5.5 0 0 1 17.4 8.9a4.8 4.8 0 0 1 .1 9.6z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>`;

/** The death counter's icon: a little skull. */
const SKULL_ICON = `<svg class="skull" viewBox="0 0 32 32" aria-hidden="true"><path class="bone" d="M16 3C9 3 4.5 7.8 4.5 14c0 3.6 1.6 6.4 4 8.1V26a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3.9c2.4-1.7 4-4.5 4-8.1C27.5 7.8 23 3 16 3z"/><circle class="eye" cx="11" cy="15" r="3.2"/><circle class="eye" cx="21" cy="15" r="3.2"/><path class="eye" d="M16 18.5l-2 3.2h4z"/><path class="teeth" d="M13 24.5v3M16 24.5v3M19 24.5v3"/></svg>`;

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

/** What the progress bar reads of a raft: where it is and how far its race got. */
type Progress = Pick<Crew, "raft" | "phase">;

export type ProgressTrack = {
  /** 0..1 along the course. */
  at(crew: Progress): number;
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
      at: (crew) =>
        crew.phase.kind === "finished" ? 1 : crew.phase.kind === "countdown" ? 0 : frac(crew.raft),
      markers: checkpoints.map(frac),
    };
  }
  return {
    at(crew) {
      const { phase, raft } = crew;
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

/**
 * A team race as the HUD draws it: the raft we follow, every raft's crew and interpolated pose
 * (by raft index), and the tick for live race clocks.
 */
export type TeamHud = {
  raft: number;
  crews: readonly Crew[];
  poses: readonly Pose[];
  tick: number;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** "Red wins!" in Red's color, or "Draw!". */
const resultTitle = (r: TeamResult) =>
  r.winner === "draw"
    ? "Draw!"
    : `<span style="color:${teamColor(r.winner)}">${escapeHtml(teamName(r.winner))}</span> wins!`;

const gapText = (r: TeamResult) => (r.winner === "draw" ? "" : `+${formatTime(r.gapMs)}`);

/** Both rafts' times and wipeouts; a raft still racing shows its clock running. */
const resultRows = (r: TeamResult, ours: number) =>
  r.rows
    .map(
      (row) =>
        `<div class="result-row${row.finished ? "" : " racing"}" style="--team:${teamColor(row.raft)}">
          <b>${escapeHtml(teamName(row.raft))}${row.raft === ours ? " (you)" : ""}</b>
          <span>${formatTime(row.timeMs)}${row.finished ? "" : "…"}</span>
          <span>💀 ${row.deaths}</span>
        </div>`,
    )
    .join("");

/** The marker or tag for raft `raft`, made on first use. */
function rivalEl(map: Map<number, HTMLElement>, raft: number, make: () => HTMLElement) {
  let el = map.get(raft);
  if (!el) {
    el = make();
    el.style.setProperty("--team", teamColor(raft));
    map.set(raft, el);
  }
  return el;
}

export type HudOptions = {
  /** First labels, one per rider. A tag exists for every possible seat; riders not in the snapshot hide theirs. */
  seatLabels: readonly string[];
  camera: PerspectiveCamera;
  progress: ProgressTrack;
};

export function createHud(host: HTMLElement, opts: HudOptions) {
  const { seatLabels, camera, progress } = opts;
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
      <div class="hud-deaths" data-deaths aria-label="Wipeouts">${SKULL_ICON}<span data-death-count>0</span></div>
      <div class="hud-farts" data-farts>${PUFF_ICON}<span data-puffs>0</span></div>
      <div class="hud-count" data-count></div>
      <div class="hud-toast" data-toast></div>
      <div class="hud-result" data-result aria-live="polite"></div>
      <div class="hud-rivals" data-rivals></div>
      <div class="hud-finish" data-finish>
        <div class="finish-title">Finish!</div>
        <div class="finish-time" data-finish-time></div>
        <div class="finish-deaths" data-finish-deaths></div>
        <div class="finish-result" data-finish-result></div>
        <div class="finish-hint">${matchMedia("(pointer: coarse)").matches ? "↻ to restart · ☰ for menu" : "R to restart · Esc for menu"}</div>
      </div>
      <div class="hud-hurt" data-hurt></div>
      <div class="hud-tags">${Array.from(
        { length: MAX_CREW },
        (_, i) =>
          `<div class="tag" data-seat="${i}" style="--seat:${SEAT_COLORS[i]}"><span>${seatLabels[i] ?? ""}</span><i></i></div>`,
      ).join("")}</div>
    </div>`,
  );
  const root = [...host.querySelectorAll<HTMLElement>(".hud")].at(-1)!;
  const $ = (sel: string) => root.querySelector<HTMLElement>(sel)!;
  const status = $("[data-status]");
  const time = $("[data-time]");
  const fartPill = $("[data-farts]");
  const puffs = $("[data-puffs]");
  const count = $("[data-count]");
  const toast = $("[data-toast]");
  const finish = $("[data-finish]");
  const finishTime = $("[data-finish-time]");
  const finishDeaths = $("[data-finish-deaths]");
  const finishTitle = $(".finish-title");
  const finishResult = $("[data-finish-result]");
  const resultStrip = $("[data-result]");
  const rivalLayer = $("[data-rivals]");
  const track = $("[data-track]");
  /** Progress-bar markers and floating "Rival" tags of the other rafts, by raft index. */
  const rivalMarks = new Map<number, HTMLElement>();
  const rivalTags = new Map<number, HTMLElement>();
  let shownResult = "";
  const deathPill = $("[data-deaths]");
  const deathCount = $("[data-death-count]");
  const hurt = $("[data-hurt]");
  const fill = $("[data-fill]");
  const raftMark = $("[data-raft]");
  const marks = [...root.querySelectorAll<HTMLElement>(".track-mark")];
  const tags = [...root.querySelectorAll<HTMLElement>(".tag")];
  const fills = tags.map((g) => g.querySelector<HTMLElement>("i")!);
  const labelSpans = tags.map((g) => g.querySelector<HTMLElement>("span")!);
  const lastGas = tags.map(() => GAS_MAX);
  let shownDeaths = 0;

  let shownCount = "";
  let puffCount = 0;
  const fartedThisFrame = tags.map(() => false);
  const lastFartTick = tags.map(() => -Infinity);
  const world = new Vector3();

  status.addEventListener("animationend", () => status.classList.remove("pop"));
  fartPill.addEventListener("animationend", () => fartPill.classList.remove("pop"));
  deathPill.addEventListener("animationend", () => deathPill.classList.remove("hit"));
  hurt.addEventListener("animationend", () => hurt.classList.remove("on"));

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

  /** Screen position of a world point (sim x, y at `height`), or null behind the camera. */
  function onScreen(x: number, y: number, height: number): { x: number; y: number } | null {
    world.set(x, height, -y).project(camera);
    if (world.z >= 1) return null;
    return { x: ((world.x + 1) / 2) * innerWidth, y: ((1 - world.y) / 2) * innerHeight };
  }

  function drawTeams(t: TeamHud | null) {
    raftMark.style.removeProperty("--team");
    if (t === null || t.crews.length < 2) {
      for (const el of [...rivalMarks.values(), ...rivalTags.values()]) el.remove();
      rivalMarks.clear();
      rivalTags.clear();
      showResult(null, t?.raft ?? 0);
      return;
    }
    raftMark.style.setProperty("--team", teamColor(t.raft));
    t.crews.forEach((crew, raft) => {
      if (raft === t.raft) return;
      const mark = rivalEl(rivalMarks, raft, () => {
        const b = document.createElement("b");
        b.className = "track-raft rival";
        track.insertBefore(b, raftMark);
        return b;
      });
      const p = Math.min(1, Math.max(0, progress.at(crew)));
      mark.style.left = `calc(9px + (100% - 18px) * ${p})`;

      const tag = rivalEl(rivalTags, raft, () => {
        const el = document.createElement("div");
        el.className = "rival-tag";
        el.textContent = "Rival";
        rivalLayer.append(el);
        return el;
      });
      const pose = t.poses[raft] ?? crew.raft;
      const at = onScreen(pose.x, pose.y, RIVAL_TAG_HEIGHT);
      tag.style.visibility = at ? "visible" : "hidden";
      if (at)
        tag.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translate(-50%, -100%)`;
    });

    const result = teamResult(t.crews, t.tick);
    // A raft still racing sees the result as a strip; once it finishes, inside its finish card.
    resultStrip.classList.toggle(
      "on",
      result !== null && t.crews[t.raft]?.phase.kind !== "finished",
    );
    showResult(result, t.raft);
  }

  /** Writes the result into the strip and the finish card, only when its text changed. */
  function showResult(result: TeamResult | null, ours: number) {
    const title = result ? resultTitle(result) : "Finish!";
    const strip = result ? `${title} <span class="result-gap">${gapText(result)}</span>` : "";
    const card = result
      ? `${resultRows(result, ours)}<div class="result-gap">${result.settled ? "" : "Still racing · "}${gapText(result)}</div>`
      : "";
    const key = `${strip}|${card}`;
    if (key === shownResult) return;
    shownResult = key;
    if (!result) resultStrip.classList.remove("on");
    finishTitle.innerHTML = title;
    resultStrip.innerHTML = strip;
    finishResult.innerHTML = card;
  }

  function placeTags(raft: Pose, riders: View["riders"]) {
    const cos = Math.cos(raft.rot);
    const sin = Math.sin(raft.rot);
    tags.forEach((tag, i) => {
      const rider = riders[i];
      if (!rider) {
        tag.style.visibility = "hidden";
        return;
      }
      const sx = raft.x + rider.x * cos - rider.y * sin;
      const sy = raft.y + rider.x * sin + rider.y * cos;
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
    /** Each rider's color (name and gas bar), changed only when it differs. */
    setColors(colors: readonly string[]) {
      tags.forEach((tag, i) => {
        const color = colors[i];
        if (color !== undefined && tag.style.getPropertyValue("--seat") !== color)
          tag.style.setProperty("--seat", color);
      });
    },
    /** Online, riders come and go: the server says who sits where. */
    setLabels(labels: readonly string[]) {
      labelSpans.forEach((span, i) => {
        const label = labels[i];
        if (label !== undefined && span.textContent !== label) span.textContent = label;
      });
    },
    onEvent(e: SimEvent) {
      if (e.type === "go") show("GO!", "slam");
      if (e.type === "checkpoint") {
        show(`Checkpoint ${e.index + 1}`, "bounce");
        replay(status, "pop");
      }
      if (e.type === "fart") fartedThisFrame[e.seat] = true;
      if (e.type === "hit") {
        replay(hurt, "on");
        replay(deathPill, "hit");
        show("Wipeout!", "slam");
      }
    },
    /** Team race extras (rival markers and tags, the result), or null in co-op. After `draw`. */
    drawTeams,
    draw(snap: View, raft: Pose) {
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
        finishDeaths.textContent =
          snap.deaths === 0 ? "Flawless!" : `${snap.deaths} wipeout${snap.deaths === 1 ? "" : "s"}`;
        replay(finish, "on");
      } else if (!done) finish.classList.remove("on");

      if (snap.deaths !== shownDeaths) {
        shownDeaths = snap.deaths;
        deathCount.textContent = String(snap.deaths);
      }

      fills.forEach((bar, i) => {
        const gas = snap.gas[i];
        if (gas === undefined) return;
        const frac = gas / GAS_MAX;
        bar.style.width = `${frac * 100}%`;
        tags[i]!.classList.toggle("low", frac < LOW_GAS);
        tags[i]!.classList.toggle("draining", gas < lastGas[i]! - 1e-6);
        lastGas[i] = gas;
      });
      placeTags(raft, snap.riders);
    },
    dispose() {
      root.remove();
    },
  };
}
