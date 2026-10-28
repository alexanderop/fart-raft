import { gamepads, menuIntent, type MenuIntent } from "../../input/gamepad.ts";
import { planSeats, type SeatKind } from "../../input/sources.ts";
import { DEFAULT_DIFFICULTY, MAX_LOCAL } from "../../sim/constants.ts";
import type { Difficulty } from "../../sim/types.ts";
import { difficultyPicker } from "./difficulty.ts";
import type { VolumeStore } from "../fx/volume.ts";
import { volumePanel } from "./volume.ts";

/**
 * What the start menu decides. Humans take the first seats; bots fill the rest when enabled.
 * `difficulty` is how hard the course plays (chill unless picked otherwise).
 */
export type GameConfig = { humans: number; bots: boolean; difficulty: Difficulty };

export const CONTROLS = ["WASD · Space", "Arrows · Enter", "IJKL · U", "Num 8456 · Num 0"] as const;

const STORAGE_KEY = "fart-raft:menu";

/** A phone or tablet: the first human plays on the on-screen stick and FART button. */
export const isTouchDevice = (): boolean => matchMedia("(pointer: coarse)").matches;

const KEYS_HINT =
  "Move keys slide your rider around the raft · fart key pushes it away from you · R restarts · Esc menu";
const TOUCH_HINT =
  "Left thumb: slide your rider around the raft · FART pushes it away from you · ↻ restarts · ☰ menu";

/**
 * What the player chose to start: a couch game on this machine, or the online lobby on a
 * server. `room` is set when an invite link named one.
 */
export type Launch =
  | { kind: "local"; config: GameConfig }
  | { kind: "online"; server: string; room?: string };

/**
 * In dev the server runs beside Vite on port 3000. A built client is served by the game server
 * itself (`STATIC=dist`), so it talks to /rpc next to the page.
 */
export function defaultServerUrl(): string {
  if (import.meta.env.DEV) return `ws://${location.hostname}:3000/rpc`;
  const url = new URL("rpc", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  return url.href;
}

/**
 * `?room=CODE` is an invite link, `?online=1` opens the online lobby. `&server=<ws-url>`
 * points either at a server other than the one on this host.
 */
export function launchFromUrl(search: string): Launch | undefined {
  const params = new URLSearchParams(search);
  const server = params.get("server") ?? defaultServerUrl();
  const room = params.get("room");
  if (room !== null) return { kind: "online", server, room };
  if (params.get("online") !== null) return { kind: "online", server };
  const config = configFromUrl(search);
  return config && { kind: "local", config };
}

/** Crew size for a config: a full raft with bots, otherwise one seat per human. */
export const crewSize = (c: GameConfig): number => (c.bots ? MAX_LOCAL : c.humans);

/** `?mode=wild` picks Wild; anything else (or nothing) is Chill. */
const difficultyOf = (mode: unknown): Difficulty => (mode === "wild" ? "wild" : DEFAULT_DIFFICULTY);

/** `?players=N&bots=0|1[&mode=wild]` skips the menu (handy for sharing a setup and for tests). */
export function configFromUrl(search: string): GameConfig | undefined {
  const params = new URLSearchParams(search);
  const players = params.get("players");
  if (players === null) return undefined;
  const humans = Math.max(0, Math.min(MAX_LOCAL, Number.parseInt(players, 10) || 0));
  return normalize({
    humans,
    bots: params.get("bots") === "1",
    difficulty: difficultyOf(params.get("mode")),
  });
}

export function configToSearch(c: GameConfig): string {
  const mode = c.difficulty === DEFAULT_DIFFICULTY ? "" : `&mode=${c.difficulty}`;
  return `?players=${c.humans}&bots=${c.bots ? 1 : 0}${mode}`;
}

/** No humans means watching bots; a raft needs at least one rider. */
const normalize = (c: GameConfig): GameConfig => (c.humans === 0 ? { ...c, bots: true } : c);

/** The difficulty last started from the menu: the online lobby offers it first too. */
export const lastDifficulty = (): Difficulty => loadLast().difficulty;

function loadLast(): GameConfig {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (
      typeof saved === "object" &&
      saved !== null &&
      "humans" in saved &&
      "bots" in saved &&
      typeof saved.humans === "number" &&
      typeof saved.bots === "boolean"
    ) {
      return normalize({
        humans: Math.max(0, Math.min(MAX_LOCAL, saved.humans)),
        bots: saved.bots,
        difficulty: difficultyOf("difficulty" in saved ? saved.difficulty : undefined),
      });
    }
  } catch {
    // Storage blocked (private mode): fall through to the default.
  }
  return { humans: 1, bots: false, difficulty: DEFAULT_DIFFICULTY };
}

function saveLast(c: GameConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // Not critical: the menu just won't remember.
  }
}

/** Start screen: pick how many people are playing and whether bots fill the empty seats, or go online. */
export function showMenu(host: HTMLElement, volume: VolumeStore): Promise<Launch> {
  let config = loadLast();
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="menu" role="dialog" aria-labelledby="menu-title">
      <div class="menu-card menu-split">
        <div class="menu-who">
        <h1 id="menu-title" class="menu-title">🎃 Fart Raft 🎃</h1>
        <p class="menu-sub">Steer the raft together. Every fart pushes it.</p>
        <div class="menu-label" id="players-label">Players</div>
        <div class="menu-players" role="radiogroup" aria-labelledby="players-label">
          ${[0, 1, 2, 3, 4]
            .map(
              (n) =>
                `<button type="button" role="radio" data-humans="${n}">${n === 0 ? "Bots only" : n}</button>`,
            )
            .join("")}
        </div>
        <label class="menu-bots">
          <input type="checkbox" data-bots />
          <span>Fill empty seats with bots</span>
        </label>
        <div class="menu-mode" data-mode-picker></div>
        <p class="menu-hint menu-pads" data-pads aria-live="polite"></p>
        </div>
        <div class="menu-go">
        <ol class="menu-seats" data-seats></ol>
        <button type="button" class="menu-start" data-start>Start</button>
        <button type="button" class="menu-online" data-online>Play online</button>
        <div class="menu-volume" data-volume></div>
        <p class="menu-hint">${isTouchDevice() ? TOUCH_HINT : KEYS_HINT}</p>
        </div>
      </div>
    </div>`,
  );
  const root = host.querySelector<HTMLElement>(".menu")!;
  const playerButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-humans]")];
  const bots = root.querySelector<HTMLInputElement>("[data-bots]")!;
  const seats = root.querySelector<HTMLElement>("[data-seats]")!;
  const start = root.querySelector<HTMLButtonElement>("[data-start]")!;
  const online = root.querySelector<HTMLButtonElement>("[data-online]")!;
  const padLine = root.querySelector<HTMLElement>("[data-pads]")!;
  const mode = difficultyPicker(config.difficulty, (difficulty) => {
    config = { ...config, difficulty };
  });
  root.querySelector("[data-mode-picker]")!.append(mode.el);
  const sound = volumePanel(volume, { compact: true });
  root.querySelector("[data-volume]")!.append(sound.el);

  const render = () => {
    for (const b of playerButtons) {
      const on = Number(b.dataset.humans) === config.humans;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    bots.checked = config.bots;
    bots.disabled = config.humans === 0 || config.humans === MAX_LOCAL;
    const size = crewSize(config);
    const connected = gamepads.connected();
    const touch = isTouchDevice();
    // A phone rarely has a pad: only mention controllers once one shows up.
    padLine.hidden = touch && connected.length === 0;
    padLine.textContent =
      connected.length === 0
        ? "🎮 No controller · press a button on one to connect"
        : `🎮 ${connected.length} ${connected.length === 1 ? "controller" : "controllers"} connected · D-pad ◀ ▶ players · A start · Y bots`;
    // Same rule as the race: pads take the first human seats, keyboards the rest.
    const kinds: SeatKind[] = Array.from({ length: size }, (_, i) =>
      i < config.humans ? "human" : "bot",
    );
    const plan = planSeats(kinds, connected, new Set());
    const padSeats = new Set(plan.pads.values());
    seats.innerHTML = Array.from({ length: size }, (_, i) => {
      if (i >= config.humans) return `<li class="bot">Bot</li>`;
      if (padSeats.has(i)) return `<li><b>P${i + 1}</b> 🎮 Controller</li>`;
      if (touch && i === 0) return `<li><b>P1</b> 👆 Touch</li>`;
      const keys = config.humans === 1 ? "WASD / Arrows · Space" : CONTROLS[plan.keys.get(i) ?? i];
      return `<li><b>P${i + 1}</b> ${keys}</li>`;
    }).join("");
  };

  const pick = (humans: number) => {
    config = normalize({
      ...config,
      humans,
      bots: humans === 0 ? true : config.bots && humans < MAX_LOCAL,
    });
    render();
  };

  for (const b of playerButtons) b.addEventListener("click", () => pick(Number(b.dataset.humans)));
  bots.addEventListener("change", () => {
    config = normalize({ ...config, bots: bots.checked });
    render();
  });
  render();
  start.focus();

  return new Promise((resolve) => {
    let padFrame = 0;
    const launch = (choice: Launch) => {
      cancelAnimationFrame(padFrame);
      removeEventListener("keydown", onKey);
      sound.dispose();
      root.remove();
      resolve(choice);
    };
    const go = () => {
      saveLast(config);
      launch({ kind: "local", config });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Enter" || e.code === "Space") {
        if (document.activeElement instanceof HTMLButtonElement && document.activeElement !== start)
          return;
        e.preventDefault();
        go();
      }
      const n = Number.parseInt(e.key, 10);
      if (n >= 0 && n <= MAX_LOCAL) pick(n);
    };
    const act = (intent: MenuIntent) => {
      if (intent === "left" || intent === "right") {
        pick(Math.max(0, Math.min(MAX_LOCAL, config.humans + (intent === "left" ? -1 : 1))));
      } else if (intent === "up" || intent === "down") {
        (document.activeElement === online ? start : online).focus();
      } else if (intent === "toggle") {
        if (!bots.disabled) {
          config = normalize({ ...config, bots: !config.bots });
          render();
        }
      } else if (document.activeElement === online) {
        online.click();
      } else {
        start.click();
      }
    };
    // Pads are polled, not evented: act when a pad's intent changes. A pad that just
    // appeared is usually still holding the button that woke it, so swallow that first state.
    let lastIntent: MenuIntent | undefined;
    let lastCount = -1;
    const pollPads = () => {
      gamepads.poll();
      const connected = gamepads.connected();
      const intent = connected
        .map((i) => gamepads.state(i))
        .map((state) => state && menuIntent(state))
        .find((x) => x !== undefined);
      if (connected.length !== lastCount) {
        lastCount = connected.length;
        render();
      } else if (intent !== undefined && intent !== lastIntent) {
        act(intent);
      }
      lastIntent = intent;
      padFrame = requestAnimationFrame(pollPads);
    };
    padFrame = requestAnimationFrame(pollPads);
    start.addEventListener("click", go);
    online.addEventListener("click", () => launch({ kind: "online", server: defaultServerUrl() }));
    addEventListener("keydown", onKey);
  });
}
