import { MAX_CREW } from "../../sim/constants";

/** What the start menu decides. Humans take the first seats; bots fill the rest when enabled. */
export type GameConfig = { humans: number; bots: boolean };

export const CONTROLS = ["WASD · Space", "Arrows · Enter", "IJKL · U", "Num 8456 · Num 0"] as const;

const STORAGE_KEY = "fart-raft:menu";

/** Crew size for a config: a full raft with bots, otherwise one seat per human. */
export const crewSize = (c: GameConfig): number => (c.bots ? MAX_CREW : c.humans);

/** `?players=N&bots=0|1` skips the menu (handy for sharing a setup and for tests). */
export function configFromUrl(search: string): GameConfig | undefined {
  const params = new URLSearchParams(search);
  const players = params.get("players");
  if (players === null) return undefined;
  const humans = Math.max(0, Math.min(MAX_CREW, Number.parseInt(players, 10) || 0));
  return normalize({ humans, bots: params.get("bots") === "1" });
}

export function configToSearch(c: GameConfig): string {
  return `?players=${c.humans}&bots=${c.bots ? 1 : 0}`;
}

/** No humans means watching bots; a raft needs at least one rider. */
const normalize = (c: GameConfig): GameConfig => (c.humans === 0 ? { humans: 0, bots: true } : c);

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
      return normalize({ humans: Math.max(0, Math.min(MAX_CREW, saved.humans)), bots: saved.bots });
    }
  } catch {
    // Storage blocked (private mode): fall through to the default.
  }
  return { humans: 1, bots: false };
}

function saveLast(c: GameConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // Not critical: the menu just won't remember.
  }
}

/** Start screen: pick how many people are playing and whether bots fill the empty seats. */
export function showMenu(host: HTMLElement): Promise<GameConfig> {
  let config = loadLast();
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="menu" role="dialog" aria-labelledby="menu-title">
      <div class="menu-card">
        <h1 id="menu-title" class="menu-title">Fart Raft</h1>
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
        <ol class="menu-seats" data-seats></ol>
        <button type="button" class="menu-start" data-start>Start</button>
        <p class="menu-hint">Fart = up key, aim = left / right · R restarts · Esc menu</p>
      </div>
    </div>`,
  );
  const root = host.querySelector<HTMLElement>(".menu")!;
  const playerButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-humans]")];
  const bots = root.querySelector<HTMLInputElement>("[data-bots]")!;
  const seats = root.querySelector<HTMLElement>("[data-seats]")!;
  const start = root.querySelector<HTMLButtonElement>("[data-start]")!;

  const render = () => {
    for (const b of playerButtons) {
      const on = Number(b.dataset.humans) === config.humans;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    bots.checked = config.bots;
    bots.disabled = config.humans === 0 || config.humans === MAX_CREW;
    const size = crewSize(config);
    seats.innerHTML = Array.from({ length: size }, (_, i) => {
      if (i >= config.humans) return `<li class="bot">Bot</li>`;
      const keys = config.humans === 1 ? "WASD / Arrows · Space" : CONTROLS[i];
      return `<li><b>P${i + 1}</b> ${keys}</li>`;
    }).join("");
  };

  const pick = (humans: number) => {
    config = normalize({ humans, bots: humans === 0 ? true : config.bots && humans < MAX_CREW });
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
    const go = () => {
      removeEventListener("keydown", onKey);
      saveLast(config);
      root.remove();
      resolve(config);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Enter" || e.code === "Space") {
        if (document.activeElement instanceof HTMLButtonElement && document.activeElement !== start)
          return;
        e.preventDefault();
        go();
      }
      const n = Number.parseInt(e.key, 10);
      if (n >= 0 && n <= MAX_CREW) pick(n);
    };
    start.addEventListener("click", go);
    addEventListener("keydown", onKey);
  });
}
