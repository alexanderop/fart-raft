import { connect, createRoom, type Connection } from "../../net/client.ts";
import { showBanner } from "./banner.ts";
import { difficultyPicker, MODE_LABELS } from "./difficulty.ts";
import { lastDifficulty } from "./menu.ts";
import {
  CODE_LENGTH,
  CODE_LETTERS,
  isCourseName,
  MAX_NAME,
  riderOf,
  type CourseName,
  type Roster,
} from "../../net/protocol.ts";

const NAME_KEY = "fart-raft:name";

/** Courses offered when creating a game. Pond is the test course, so it stays hidden. */
const PICKABLE: readonly { course: CourseName; label: string; blurb: string }[] = [
  { course: "canyon", label: "🏜️ Canyon", blurb: "Sweepers, hammers, piston alley" },
  { course: "graveyard", label: "🪦 Graveyard", blurb: "Wide pools, logs, pumpkins" },
];

const loadName = (): string => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

const saveName = (name: string): void => {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Not critical: the name is just asked again next time.
  }
};

/** Upper-cases and drops anything that can't be in a room code. */
export const normalizeCode = (raw: string): string =>
  raw
    .toUpperCase()
    .replace(new RegExp(`[^${CODE_LETTERS}]`, "g"), "")
    .slice(0, CODE_LENGTH);

/** The link a friend opens to land on this room's join screen. */
export function inviteLink(code: string, server: string, defaultServer: string): string {
  const params = new URLSearchParams({ room: code });
  if (server !== defaultServer) params.set("server", server);
  return `${location.origin}${location.pathname}?${params}`;
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/**
 * Online start screen: your name, then create a game on a course or join one by code.
 * Resolves with a seated connection, or `undefined` when the player goes back.
 */
export function showOnlineMenu(
  host: HTMLElement,
  server: string,
  room?: string,
): Promise<Connection | undefined> {
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="menu" role="dialog" aria-labelledby="online-title">
      <form class="menu-card lobby" data-join novalidate>
        <h1 id="online-title" class="menu-title lobby-title">${room ? `Join ${normalizeCode(room)}` : "Play online"}</h1>
        <label class="menu-label" for="lobby-name">Your name</label>
        <input id="lobby-name" class="lobby-input" data-name maxlength="${MAX_NAME}"
          autocomplete="nickname" placeholder="Captain Toot" />
        <div class="lobby-split">
          <section>
            <div class="menu-label">Join a game</div>
            <div class="lobby-row">
              <input class="lobby-input lobby-code-input" data-code maxlength="${CODE_LENGTH}"
                autocomplete="off" autocapitalize="characters" spellcheck="false"
                placeholder="CODE" aria-label="Room code" />
              <button type="submit" class="menu-online lobby-join">Join</button>
            </div>
          </section>
          <section>
            <div class="menu-label">Or start a new one</div>
            <div class="lobby-courses">
              ${PICKABLE.map(
                (c) =>
                  `<button type="button" class="menu-online lobby-course" data-course="${c.course}">
                    ${c.label}<small>${c.blurb}</small>
                  </button>`,
              ).join("")}
            </div>
            <div data-mode-picker></div>
          </section>
        </div>
        <p class="lobby-error" data-error role="alert"></p>
        <button type="button" class="lobby-back" data-back>← Back</button>
      </form>
    </div>`,
  );
  const root = host.querySelector<HTMLElement>(".menu:last-child")!;
  const form = root.querySelector<HTMLFormElement>("[data-join]")!;
  const nameInput = root.querySelector<HTMLInputElement>("[data-name]")!;
  const codeInput = root.querySelector<HTMLInputElement>("[data-code]")!;
  const errorLine = root.querySelector<HTMLElement>("[data-error]")!;
  const mode = difficultyPicker(lastDifficulty());
  root.querySelector("[data-mode-picker]")!.append(mode.el);
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];

  nameInput.value = loadName();
  codeInput.value = normalizeCode(room ?? "");
  codeInput.addEventListener("input", () => {
    codeInput.value = normalizeCode(codeInput.value);
  });
  (room && nameInput.value ? codeInput : nameInput).focus();

  const busy = (on: boolean, text = "") => {
    for (const b of buttons) b.disabled = on;
    errorLine.textContent = text;
    errorLine.classList.toggle("info", on);
  };

  return new Promise((resolve) => {
    const finish = (conn: Connection | undefined) => {
      root.remove();
      resolve(conn);
    };
    const enter = async (code: () => Promise<string>) => {
      const name = nameInput.value.trim();
      saveName(name);
      busy(true, "Connecting…");
      try {
        finish(await connect(server, await code(), name));
      } catch (error) {
        busy(false, error instanceof Error ? error.message : "Could not connect");
      }
    };

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const code = normalizeCode(codeInput.value);
      if (code.length !== CODE_LENGTH) {
        errorLine.textContent = `A room code has ${CODE_LENGTH} letters`;
        codeInput.focus();
        return;
      }
      void enter(async () => code);
    });
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-course]")) {
      const course = b.dataset.course;
      if (!isCourseName(course)) continue;
      b.addEventListener("click", () => enter(() => createRoom(server, course, mode.value())));
    }
    root.querySelector("[data-back]")!.addEventListener("click", () => finish(undefined));
  });
}

/**
 * The room before the race: its code and invite link, who is in, and Start for the host.
 * Re-renders on every roster change. Call the returned function to take it down.
 */
export function showRoom(host: HTMLElement, conn: Connection, invite: string): () => void {
  const { course: picked, difficulty } = conn.roster();
  const course = PICKABLE.find((c) => c.course === picked)?.label ?? "";
  const mode = MODE_LABELS[difficulty].label;
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="menu" role="dialog" aria-labelledby="room-title">
      <div class="menu-card lobby">
        <div class="menu-label" id="room-title">Room code</div>
        <div class="lobby-code" aria-live="polite">${conn.code}</div>
        <div class="lobby-course-name">${course} · ${mode}</div>
        <div class="lobby-row lobby-invite">
          <input class="lobby-input" readonly value="${escapeHtml(invite)}" aria-label="Invite link" data-link />
          <button type="button" class="menu-online lobby-copy" data-copy>Copy link</button>
        </div>
        <ol class="menu-seats lobby-seats" data-seats></ol>
        <button type="button" class="menu-start" data-start>Start race</button>
        <p class="menu-hint" data-wait></p>
        <button type="button" class="lobby-back" data-leave>← Leave</button>
      </div>
    </div>`,
  );
  const root = host.querySelector<HTMLElement>(".menu:last-child")!;
  const seats = root.querySelector<HTMLElement>("[data-seats]")!;
  const start = root.querySelector<HTMLButtonElement>("[data-start]")!;
  const wait = root.querySelector<HTMLElement>("[data-wait]")!;
  const copy = root.querySelector<HTMLButtonElement>("[data-copy]")!;
  const link = root.querySelector<HTMLInputElement>("[data-link]")!;

  const render = (roster: Roster) => {
    seats.innerHTML = roster.seats
      .map((name, i) => {
        if (name === null) return `<li class="open">Open seat<small>share the link</small></li>`;
        const tags = [i === roster.host ? "👑" : "", i === conn.seat ? "(you)" : ""].join(" ");
        return `<li${i === conn.seat ? ' class="me"' : ""}><b>${escapeHtml(name)}</b> ${tags}</li>`;
      })
      .join("");
    const amHost = roster.host === conn.seat;
    start.hidden = !amHost;
    const hostName = roster.host === null ? "the host" : roster.seats[roster.host];
    wait.textContent = amHost
      ? "Everyone here races. Friends who join mid-race ride in the next one."
      : `Waiting for ${hostName} to start…`;
    if (amHost && document.activeElement === document.body) start.focus();
  };
  render(conn.roster());
  const stop = conn.onRoster(render);

  start.addEventListener("click", () => {
    start.disabled = true;
    conn.start();
  });
  copy.addEventListener("click", async () => {
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) {
        await navigator.share({
          title: "Fart Raft",
          text: `Join my raft: ${conn.code}`,
          url: invite,
        });
        return;
      }
      await navigator.clipboard.writeText(invite);
      copy.textContent = "Copied!";
    } catch {
      link.select();
      copy.textContent = "Press ⌘C";
    }
    setTimeout(() => (copy.textContent = "Copy link"), 1500);
  });
  link.addEventListener("focus", () => link.select());
  root.querySelector("[data-leave]")!.addEventListener("click", () => {
    location.href = location.pathname;
  });

  return () => {
    stop();
    root.remove();
  };
}

/**
 * During a race: a banner while this player is seated but not in the crew (joined mid-race).
 * Goes away once a restart puts them on the raft.
 */
export function showSpectating(host: HTMLElement, conn: Connection): void {
  let hide: (() => void) | undefined;
  const render = (roster: Roster) => {
    const watching = roster.started && riderOf(roster, conn.seat) < 0;
    if (watching && !hide) {
      hide = showBanner(host, "Watching this race · you ride in the next one", "info");
    } else if (!watching && hide) {
      hide();
      hide = undefined;
    }
  };
  render(conn.roster());
  conn.onRoster(render);
}
