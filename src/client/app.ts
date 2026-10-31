import canyon from "../../courses/canyon.json";
import graveyard from "../../courses/graveyard.json";
import pond from "../../courses/pond.json";
import { listenKeyboard } from "../input/keyboard.ts";
import { createTouchControls } from "../input/touch.ts";
import type { Connection } from "../net/client.ts";
import { isCourseName, RECONNECT_GRACE_MS, type CourseName } from "../net/protocol.ts";
import { STEP } from "../sim/constants.ts";
import { parseLevel } from "../sim/level.ts";
import { initPhysics } from "../sim/sim.ts";
import type { LevelData } from "../sim/types.ts";
import { createAudio, type Audio } from "./fx/audio.ts";
import { createVolumeStore } from "./fx/volume.ts";
import { startLoop } from "./loop.ts";
import { createRace } from "./race.ts";
import { localSession, onlineSession, type Session } from "./session.ts";
import { showBanner } from "./ui/banner.ts";
import { inviteLink, showOnlineMenu, showRoom, showSpectating, showTeamPick } from "./ui/lobby.ts";
import {
  configToSearch,
  defaultServerUrl,
  launchFromUrl,
  loadPlayers,
  showMenu,
  type Launch,
} from "./ui/menu.ts";

// State pattern, same shape as sim/flow.ts: a union plus a switch. Each state owns what it puts
// on the page (DOM, listeners, session, race); leaving it runs its cleanups, newest first.

/**
 * After a drop, how long to keep rejoining on our own: stops short of the server's grace, so a
 * last attempt (up to its timeout) still finds the seat held.
 */
const RETRY_FOR_MS = RECONNECT_GRACE_MS - 5000;
/** Waits between rejoin attempts: doubling from the first, capped. */
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 4000;

/** Local play picks a course with `?course=`; online, the room's creator picked it. */
const COURSES: Record<CourseName, unknown> = { canyon, graveyard, pond };

export type AppState =
  /** The start menu. */
  | { kind: "menu" }
  /** Name, then create or join a room. `room` comes from an invite link. */
  | { kind: "online"; server: string; room?: string }
  /** Seated in a room, waiting for the host to start (or for the first frame, mid-race). */
  | { kind: "room"; conn: Connection; invite: string }
  /**
   * A race on screen. `online` is set online: the racing state owns the connection until the host
   * sends the room back to its lobby, which hands it on to a `room` state.
   */
  | {
      kind: "racing";
      level: LevelData;
      session: Promise<Session>;
      online?: { conn: Connection; invite: string };
    };

/** Runs the game in `host`: deep links (`?players=…`, `?room=…`) skip the start menu. */
export function startApp(host: HTMLElement): void {
  const physics = initPhysics(); // loads Rapier while the menu is up
  /** Player volume, shared by the start menu, the HUD speaker button and the audio graph. */
  const volume = createVolumeStore();
  /** Made on the first race and kept: one AudioContext for the app, suspended between races. */
  let audio: Audio | undefined;

  /** The camera's forward direction on the water (sim radians): keys walk riders relative to it. */
  let cameraHeading = 0;
  const heading = () => cameraHeading;

  // Each go() bumps the generation, so async work that outlives its state (a menu promise, a
  // session or scene still loading) sees it is stale and frees what it made instead of entering.
  let generation = 0;
  let cleanups: (() => void)[] = [];
  const own = (cleanup: () => void) => void cleanups.push(cleanup);

  function go(next: AppState): void {
    const old = cleanups;
    cleanups = [];
    generation++;
    for (const cleanup of old.toReversed()) cleanup();
    enter(next, generation);
  }

  const toMenu = () => {
    history.replaceState(null, "", location.pathname);
    go({ kind: "menu" });
  };

  /**
   * For an online state (room, loading, racing): when `conn` drops, say so and rejoin the same
   * seat on our own while the server holds it; back in, it is the `room` state again with the new
   * connection, which re-enters the race on its first frame. Out of tries, a Reconnect button tries
   * once more (a newcomer's seat if ours has opened up) and Esc goes to the menu.
   */
  function holdSeat(conn: Connection, invite: string, live: () => boolean): void {
    let hide: (() => void) | undefined;
    let timer = 0;
    own(() => {
      clearTimeout(timer);
      hide?.();
    });
    const say = (
      text: string,
      tone: "info" | "error",
      action?: Parameters<typeof showBanner>[3],
    ) => {
      hide?.();
      hide = showBanner(host, text, tone, action);
    };
    const attempt = async (until: number, wait: number) => {
      try {
        const next = await conn.rejoin();
        // Esc (or anything else) moved on while we were rejoining: give the new seat up.
        if (!live()) return next.close();
        go({ kind: "room", conn: next, invite });
      } catch {
        if (!live()) return;
        if (Date.now() + wait < until) {
          timer = window.setTimeout(() => attempt(until, Math.min(wait * 2, RETRY_MAX_MS)), wait);
          return;
        }
        say("Connection lost · Esc for menu", "error", {
          label: "Reconnect",
          run: () => {
            say("Reconnecting…", "info");
            void attempt(0, 0);
          },
        });
      }
    };
    conn.onClose(() => {
      say("Connection lost · Reconnecting…", "info");
      timer = window.setTimeout(
        () => attempt(Date.now() + RETRY_FOR_MS, RETRY_FIRST_MS * 2),
        RETRY_FIRST_MS,
      );
    });
  }

  function launched(launch: Launch): AppState {
    if (launch.kind === "online")
      return { kind: "online", server: launch.server, room: launch.room };
    const param = new URLSearchParams(location.search).get("course") ?? "canyon";
    const course = isCourseName(param) ? param : "canyon";
    const level = parseLevel(COURSES[course]);
    const { config } = launch;
    const suffix = course === "canyon" ? "" : `&course=${course}`;
    history.replaceState(null, "", configToSearch(config) + suffix);
    return {
      kind: "racing",
      level,
      session: localSession(level, config, loadPlayers(), heading, physics),
    };
  }

  function enter(state: AppState, gen: number): void {
    const live = () => gen === generation;
    switch (state.kind) {
      case "menu":
        // The menu only ends by its own choice, and takes its DOM down when it does.
        void showMenu(host, volume).then((launch) => {
          if (live()) go(launched(launch));
        });
        return;

      case "online":
        void showOnlineMenu(host, state.server, state.room).then((conn) => {
          if (!live()) return conn?.close();
          if (!conn) return toMenu();
          const invite = inviteLink(conn.code, state.server, defaultServerUrl());
          history.replaceState(null, "", new URL(invite).search);
          go({ kind: "room", conn, invite });
        });
        return;

      case "room": {
        const { conn } = state;
        let handedOff = false;
        own(() => {
          if (!handedOff) conn.close();
        });
        own(showRoom(host, conn, state.invite, toMenu));
        own(
          listen("keydown", (e) => {
            if (e.code === "Escape") toMenu();
          }),
        );
        holdSeat(conn, state.invite, live);
        const level = parseLevel(COURSES[conn.roster().course]);
        // Resolves on the first frame: the host started, or we joined mid-race.
        void onlineSession(conn, heading).then((session) => {
          if (!live()) return session.dispose();
          handedOff = true;
          go({
            kind: "racing",
            level,
            session: Promise.resolve(session),
            online: { conn, invite: state.invite },
          });
        });
        return;
      }

      case "racing":
        void race(state, live);
        return;
    }
  }

  async function race(state: Extract<AppState, { kind: "racing" }>, live: () => boolean) {
    const { level } = state;
    cameraHeading = level.spawn.rot;
    let session: Session | undefined;
    let hideBlocked: (() => void) | undefined;
    let blockedTimer = 0;
    /** Restarts, or briefly says why not (a team room with an empty team). */
    const restart = () => {
      const blocked = session?.restart() ?? null;
      if (blocked === null) return;
      hideBlocked?.();
      clearTimeout(blockedTimer);
      hideBlocked = showBanner(host, `Can't restart: ${blocked}`, "info");
      blockedTimer = window.setTimeout(() => hideBlocked?.(), 2500);
    };
    own(() => {
      clearTimeout(blockedTimer);
      hideBlocked?.();
    });
    const online = state.online;
    own(listenKeyboard(window));
    own(
      listen("keydown", (e) => {
        if (e.code === "Escape") toMenu();
        else if (e.code === "KeyR") restart();
        else if (e.code === "KeyL" && online && isHost(online.conn)) online.conn.toLobby();
      }),
    );
    const touch = createTouchControls(host, heading, {
      onRestart: restart,
      onMenu: toMenu,
    });
    own(() => touch.dispose());
    if (online) {
      const { conn, invite } = online;
      let handedOff = false;
      own(() => {
        if (!handedOff) conn.close();
      });
      holdSeat(conn, invite, live);
      // The host sent the room back to its lobby: same connection, same seat, no reload.
      own(
        conn.onRoster((roster) => {
          if (roster.started) return;
          handedOff = true;
          go({ kind: "room", conn, invite });
        }),
      );
      own(showSpectating(host, conn));
      own(showTeamPick(host, conn));
    }

    const ready = await state.session;
    if (!live()) return ready.dispose();
    session = ready;
    own(() => ready.dispose());

    audio ??= createAudio(volume);
    const view = await createRace({
      host,
      level,
      session: ready,
      volume,
      audio,
      heading,
      setHeading: (h) => (cameraHeading = h),
      lobby: online && { can: () => isHost(online.conn), go: () => online.conn.toLobby() },
    });
    if (!live()) return view.dispose();
    own(() => view.dispose());
    own(
      startLoop(
        STEP,
        () => ready.tick(),
        (alpha) => view.frame(alpha),
      ),
    );
  }

  const deepLink = launchFromUrl(location.search);
  go(deepLink ? launched(deepLink) : { kind: "menu" });
}

/** Only the host can send the room back to its lobby. */
const isHost = (conn: Connection) => conn.roster().host === conn.seat;

/** Adds a window listener and returns the function that removes it. */
function listen<K extends keyof WindowEventMap>(
  type: K,
  handler: (e: WindowEventMap[K]) => void,
): () => void {
  addEventListener(type, handler);
  return () => removeEventListener(type, handler);
}
