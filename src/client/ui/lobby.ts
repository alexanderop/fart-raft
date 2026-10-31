import { connect, createRoom, type Connection } from "../../net/client.ts";
import { showBanner } from "./banner.ts";
import {
  contactPicker,
  difficultyPicker,
  DIFFICULTY_LABELS,
  RACE_LABELS,
  racePicker,
} from "./pickers.ts";
import { lastDifficulty, lastRace, loadPlayers, savePlayers } from "./menu.ts";
import { teamColor, teamName } from "../teams.ts";
import { openWardrobe } from "./wardrobe.ts";
import { lookBadge, lookColor, type Look } from "../../look.ts";
import {
  CODE_LENGTH,
  CODE_LETTERS,
  isCourseName,
  isTeamMode,
  MAX_NAME,
  MAX_TEAM,
  placeOf,
  startBlocker,
  TEAMS,
  teamSize,
  type CourseName,
  type Player,
  type Roster,
  type Team,
} from "../../net/protocol.ts";

const NAME_KEY = "fart-raft:name";

/** Courses offered when creating a game. Pond is the test course, so it stays hidden. */
const PICKABLE: readonly { course: CourseName; label: string; blurb: string }[] = [
  { course: "canyon", label: "🏜️ Canyon", blurb: "Sweepers, hammers, piston alley" },
  { course: "graveyard", label: "🏝️ Graveyard", blurb: "Wide pools, logs, bumpers" },
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

/** Online you ride in player 1's look from the couch wardrobe; changes here dress them too. */
const myLook = (): Look => loadPlayers()[0]!.look;
const saveMyLook = (look: Look) => {
  const players = loadPlayers();
  savePlayers(players.with(0, { ...players[0]!, look }));
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
        <button type="button" class="menu-online lobby-dress" data-dress></button>
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
            <div data-race-picker></div>
            <div data-mode-picker></div>
            <div class="menu-label">Course</div>
            <div class="lobby-courses">
              ${PICKABLE.map(
                (c) =>
                  `<button type="button" class="menu-online lobby-course" data-course="${c.course}">
                    ${c.label}<small>${c.blurb}</small>
                  </button>`,
              ).join("")}
            </div>
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
  const race = racePicker(lastRace());
  root.querySelector("[data-race-picker]")!.append(race.el);
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
  const dressButton = root.querySelector<HTMLButtonElement>("[data-dress]")!;
  let look = myLook();
  const showLook = () => {
    dressButton.style.setProperty("--c", lookColor(look));
    dressButton.innerHTML = `<span class="menu-dress-badge">${lookBadge(look)}</span> Dress up your rider 🎨`;
  };
  showLook();
  dressButton.addEventListener("click", async () => {
    const chosen = await openWardrobe(host, { title: "Your rider", look });
    if (chosen) {
      look = chosen.look;
      saveMyLook(look);
      showLook();
    }
    dressButton.focus();
  });

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
        finish(await connect(server, await code(), name, look));
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
      b.addEventListener("click", () =>
        enter(() => createRoom(server, course, mode.value(), race.value())),
      );
    }
    root.querySelector("[data-back]")!.addEventListener("click", () => finish(undefined));
  });
}

/**
 * The room before the race: its code and invite link, who is in, and Start for the host. A team
 * room splits the players into Red and Blue columns with a Join button each, and the host picks
 * Ghost or Bump. Re-renders on every roster change. Leave calls `onLeave`; call the returned
 * function to take it down.
 */
export function showRoom(
  host: HTMLElement,
  conn: Connection,
  invite: string,
  onLeave: () => void,
): () => void {
  const { course: picked, difficulty } = conn.roster();
  const course = PICKABLE.find((c) => c.course === picked)?.label ?? "";
  const level = DIFFICULTY_LABELS[difficulty].label;
  host.insertAdjacentHTML(
    "beforeend",
    `<div class="menu" role="dialog" aria-labelledby="room-title">
      <div class="menu-card lobby">
        <div class="menu-label" id="room-title">Room code</div>
        <div class="lobby-code" aria-live="polite">${conn.code}</div>
        <div class="lobby-course-name">${course} · ${level}</div>
        <div class="lobby-race" data-race>
          <div class="lobby-race-name" data-race-name></div>
        </div>
        <div class="lobby-row lobby-invite">
          <input class="lobby-input" readonly value="${escapeHtml(invite)}" aria-label="Invite link" data-link />
          <button type="button" class="menu-online lobby-copy" data-copy>Copy link</button>
        </div>
        <div data-who>
          <ol class="menu-seats lobby-seats" data-seats></ol>
          <div class="lobby-teams" data-teams></div>
        </div>
        <button type="button" class="menu-start" data-start>Start race</button>
        <p class="menu-hint" data-wait></p>
        <button type="button" class="lobby-back" data-leave>← Leave</button>
      </div>
    </div>`,
  );
  const root = host.querySelector<HTMLElement>(".menu:last-child")!;
  const who = root.querySelector<HTMLElement>("[data-who]")!;
  const seats = root.querySelector<HTMLElement>("[data-seats]")!;
  const teams = root.querySelector<HTMLElement>("[data-teams]")!;
  const raceRow = root.querySelector<HTMLElement>("[data-race]")!;
  const raceName = root.querySelector<HTMLElement>("[data-race-name]")!;
  const start = root.querySelector<HTMLButtonElement>("[data-start]")!;
  const wait = root.querySelector<HTMLElement>("[data-wait]")!;
  const copy = root.querySelector<HTMLButtonElement>("[data-copy]")!;
  const link = root.querySelector<HTMLInputElement>("[data-link]")!;
  // Only the host switches Ghost / Bump; everyone else reads the mode's name.
  const contact = contactPicker("ghost", (c) => conn.setMode(c));
  raceRow.append(contact.el);

  /** One player's line; your own is a button that opens the wardrobe. */
  const playerItem = (roster: Roster, player: Player, i: number) => {
    const tags = [i === roster.host ? "👑" : "", i === conn.seat ? "(you)" : ""].join(" ");
    const badge = `<span class="menu-dress-badge">${lookBadge(player.look)}</span>`;
    const name = `${badge}<span><b>${escapeHtml(player.name)}</b> ${tags}</span>`;
    if (i !== conn.seat) {
      return `<li class="menu-seat lobby-player" style="--c:${lookColor(player.look)}">${name}</li>`;
    }
    return `<li class="menu-seat me" style="--c:${lookColor(player.look)}">
      <button type="button" class="menu-dress" data-dress aria-label="Dress up your rider">
        ${name}<span class="menu-dress-edit">🎨</span>
      </button>
    </li>`;
  };

  /** Red and Blue side by side: who is on each, and a Join button unless full or yours. */
  const teamColumns = (roster: Roster) => {
    const mine = roster.seats[conn.seat]?.team;
    return TEAMS.map((_, t) => {
      const team = t === 0 ? 0 : 1;
      const size = teamSize(roster, team);
      const players = roster.seats
        .map((p, i) => (p?.team === team ? playerItem(roster, p, i) : ""))
        .join("");
      const label =
        mine === team
          ? "✓ Your team"
          : size >= MAX_TEAM
            ? `${teamName(team)} is full`
            : `Join ${teamName(team)}`;
      const disabled = mine === team || size >= MAX_TEAM ? "disabled" : "";
      return `<section class="lobby-team" style="--team:${teamColor(team)}">
        <h3 class="lobby-team-name">${teamName(team)} <small>${size}/${MAX_TEAM}</small></h3>
        <ol class="menu-seats lobby-seats">${players || `<li class="open">No riders yet</li>`}</ol>
        <button type="button" class="menu-online lobby-team-join" data-team="${team}" ${disabled}>${label}</button>
      </section>`;
    }).join("");
  };

  const render = (roster: Roster) => {
    const team = isTeamMode(roster.mode);
    const amHost = roster.host === conn.seat;
    seats.hidden = team;
    teams.hidden = !team;
    raceRow.hidden = !team;
    if (team) {
      teams.innerHTML = teamColumns(roster);
      contact.el.hidden = !amHost;
      contact.set(roster.mode === "bump" ? "bump" : "ghost");
      raceName.hidden = amHost;
      raceName.textContent = RACE_LABELS[roster.mode].label;
    } else {
      seats.innerHTML = roster.seats
        .map((player, i) =>
          player === null
            ? `<li class="open">Open seat<small>share the link</small></li>`
            : playerItem(roster, player, i),
        )
        .join("");
    }
    start.hidden = !amHost;
    const blocked = startBlocker(roster);
    start.disabled = blocked !== null;
    start.textContent = blocked ?? "Start race";
    const hostName =
      (roster.host === null ? undefined : roster.seats[roster.host]?.name) ?? "the host";
    wait.textContent = amHost
      ? team
        ? "Pick your team. Friends who join mid-race ride in the next one."
        : "Everyone here races. Friends who join mid-race ride in the next one."
      : `Waiting for ${hostName} to start…`;
    if (amHost && document.activeElement === document.body) start.focus();
  };
  render(conn.roster());
  const stop = conn.onRoster(render);
  let dressing = false;
  // The host may start while the wardrobe is open: the race takes the screen, so close it.
  const leaving = new AbortController();
  who.addEventListener("click", async (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const join = target?.closest<HTMLButtonElement>("[data-team]");
    if (join) {
      conn.setTeam(join.dataset.team === "1" ? 1 : 0);
      return;
    }
    if (dressing || !target?.closest("[data-dress]")) return;
    const mine = conn.roster().seats[conn.seat];
    dressing = true;
    const chosen = await openWardrobe(host, {
      title: "Your rider",
      look: mine?.look ?? myLook(),
      signal: leaving.signal,
    });
    dressing = false;
    if (!chosen) return;
    saveMyLook(chosen.look);
    conn.setLook(chosen.look);
  });

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
  root.querySelector("[data-leave]")!.addEventListener("click", onLeave);

  return () => {
    leaving.abort();
    stop();
    root.remove();
  };
}

/**
 * During a race: a banner while this player is seated but not in the crew (joined mid-race).
 * Goes away once a restart puts them on the raft. The returned function stops it.
 */
export function showSpectating(host: HTMLElement, conn: Connection): () => void {
  let hide: (() => void) | undefined;
  const render = (roster: Roster) => {
    const watching = roster.started && placeOf(roster, conn.seat) === null;
    if (watching && !hide) {
      hide = showBanner(host, "Watching this race · you ride in the next one", "info");
    } else if (!watching && hide) {
      hide();
      hide = undefined;
    }
  };
  render(conn.roster());
  const stop = conn.onRoster(render);
  return () => {
    stop();
    hide?.();
  };
}

const teamButton = (roster: Roster, team: Team, mine: Team, label: string) => {
  const size = teamSize(roster, team);
  const state = mine === team ? "✓ " : "";
  const disabled = mine === team || size >= MAX_TEAM ? "disabled" : "";
  return `<button type="button" class="team-pick-btn" style="--team:${teamColor(team)}" data-team="${team}" ${disabled}>${state}${label}</button>`;
};

/**
 * During a team race: pick the team you ride in the next race, from any seat. A spectator (joined
 * mid-race) sees both teams; a rider gets one small button for the other team. A full team is
 * disabled (`MAX_TEAM`). The host also gets Ghost / Bump buttons, since a started room has no
 * lobby screen to switch the mode in. A spectator's camera follows its team's raft, so picking one also moves
 * the view there at once. The returned function removes the strip.
 */
export function showTeamPick(host: HTMLElement, conn: Connection): () => void {
  const el = document.createElement("div");
  el.className = "team-pick";
  el.hidden = true;
  host.append(el);
  // Space and Enter belong to the fart, not to a focused button.
  el.addEventListener("keydown", (e) => {
    if (e.code !== "Escape") e.stopPropagation();
  });
  el.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const pick = target?.closest<HTMLButtonElement>("[data-team]");
    const mode = target?.closest<HTMLButtonElement>("[data-mode]");
    if (pick) conn.setTeam(pick.dataset.team === "1" ? 1 : 0);
    else if (mode) conn.setMode(mode.dataset.mode === "bump" ? "bump" : "ghost");
    else return;
    (pick ?? mode)?.blur();
  });
  /** The host also picks how the next race is raced, since a started room has no lobby screen. */
  const modeButtons = (roster: Roster) =>
    roster.host !== conn.seat
      ? ""
      : (["ghost", "bump"] as const)
          .map(
            (m) =>
              `<button type="button" class="team-pick-btn team-pick-mode" data-mode="${m}" ${roster.mode === m ? "disabled" : ""}>${roster.mode === m ? "✓ " : ""}${m === "bump" ? "💥 Bump" : "👻 Ghost"}</button>`,
          )
          .join("");
  const render = (roster: Roster) => {
    const mine = roster.seats[conn.seat]?.team;
    el.hidden = !(roster.started && isTeamMode(roster.mode) && mine !== undefined);
    if (el.hidden || mine === undefined) return;
    const other = mine === 0 ? 1 : 0;
    if (placeOf(roster, conn.seat) === null) {
      el.innerHTML = `<span class="team-pick-label">Ride next race for</span>${TEAMS.map(
        (name, t) => {
          const team = t === 0 ? 0 : 1;
          return teamButton(roster, team, mine, `${name} ${teamSize(roster, team)}/${MAX_TEAM}`);
        },
      ).join("")}`;
    } else {
      const full = teamSize(roster, other) >= MAX_TEAM;
      el.innerHTML = teamButton(
        roster,
        other,
        mine,
        full ? `${teamName(other)} is full` : `Next race: ${teamName(other)} ⇄`,
      );
    }
    el.insertAdjacentHTML("beforeend", modeButtons(roster));
  };
  render(conn.roster());
  const stop = conn.onRoster(render);
  return () => {
    stop();
    el.remove();
  };
}
