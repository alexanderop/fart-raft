import { Cause, Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import type { Look } from "../look.ts";
import type { Difficulty, SeatInput } from "../sim/types.ts";
import {
  RaftRpcs,
  RoomFull,
  RoomNotFound,
  ServerBusy,
  ServerMsg,
  type CourseName,
  type Frame,
  type RoomMode,
  type Roster,
  type Team,
  type Welcome,
} from "./protocol.ts";

// The only place the browser touches Effect: everything else sees the plain Connection below.

export class RaftClient extends Context.Service<
  RaftClient,
  RpcClient.FromGroup<typeof RaftRpcs, RpcClientError.RpcClientError>
>()("fart-raft/RaftClient") {}

export const clientLayer = (url: string) =>
  Layer.effect(RaftClient, RpcClient.make(RaftRpcs)).pipe(
    Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson),
  );

export type Connection = {
  /** The lobby seat. Where it rides in a race is `placeOf(roster(), seat)`. */
  readonly seat: number;
  readonly code: string;
  /** The room as of the latest Roster message. */
  roster(): Roster;
  /** Called on every roster change, and with the new roster when `rejoin()` gets back in. */
  onRoster(handler: (roster: Roster) => void): () => void;
  /** Sends only when the input differs from the last one sent. */
  send(input: SeatInput): void;
  /** Host only: leave the lobby and start the race. */
  start(): void;
  restart(): void;
  /** Host only: end the race and send everyone back to the room's lobby. */
  toLobby(): void;
  /** Changes this player's look; everyone sees it on the next roster. */
  setLook(look: Look): void;
  /** Moves this player to `team` for the next race; ignored when that team is full. */
  setTeam(team: Team): void;
  /** Host only: how the next race is raced. */
  setMode(mode: RoomMode): void;
  /** Frames that arrived before the handler was set are delivered first. */
  onFrame(handler: (frame: Frame) => void): void;
  /**
   * The connection dropped or the server ended the stream. The server holds the seat away for
   * `RECONNECT_GRACE_MS`, so `rejoin()` can take it back. Not called after `close()`.
   */
  onClose(handler: (reason: string) => void): void;
  /**
   * Opens a new link to the same room that takes this seat back (same seat, team and rider) while
   * the server still holds it; once the seat has opened up it joins as a newcomer. Back in, this
   * same Connection carries on over the new link: its handlers stay, and `onRoster` fires with the
   * new roster. A `close()` while it is in flight gives the new seat up.
   */
  rejoin(): Promise<Rejoin>;
  /**
   * Leaves the room and stops all handlers. A live seat is given up at once (`Leave`); a lost one
   * is left to the server's grace, so a `rejoin()` in flight still finds it.
   */
  close(): void;
};

/** Why a join failed: the room is full, the room is gone, the server is busy, or the network. */
export type JoinFailure = "full" | "gone" | "busy" | "unreachable" | "lost";

/** A join that failed, with a reason to show (`message`) and its kind to act on (`failure`). */
export class JoinError extends Error {
  readonly failure: JoinFailure;
  constructor(failure: JoinFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

/** How a `rejoin()` ended: back in, given up because we closed meanwhile, or failed. */
export type Rejoin =
  | { kind: "back" }
  | { kind: "closed" }
  | { kind: "failed"; failure: JoinFailure };

const sameInput = (a: SeatInput, b: SeatInput) =>
  a.fart === b.fart && a.move.x === b.move.x && a.move.y === b.move.y;

const joinErrorOf = (cause: Cause.Cause<unknown>, code: string): JoinError => {
  const error = Cause.squash(cause);
  if (error instanceof RoomFull) return new JoinError("full", "That game is full");
  if (error instanceof RoomNotFound) return new JoinError("gone", `No game with code ${code}`);
  if (error instanceof ServerBusy)
    return new JoinError("busy", "The server is busy, try again in a bit");
  return new JoinError("lost", "Connection lost");
};

const unreachable = (url: string) => new JoinError("unreachable", `No answer from ${url}`);

/** How long `close()` waits for the server to take the seat back before hanging up anyway. */
const LEAVE_TIMEOUT_MS = 1000;

/** Opens a new room on the server at `url` and returns its code. Nobody holds a seat yet. */
export async function createRoom(
  url: string,
  course: CourseName,
  difficulty: Difficulty,
  mode: RoomMode = "coop",
  timeoutMs = 5000,
) {
  const runtime = ManagedRuntime.make(clientLayer(url));
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RaftClient;
        return yield* client.CreateRoom({ course, difficulty, mode });
      }).pipe(
        Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(unreachable(url)) }),
        Effect.mapError((error) =>
          error instanceof ServerBusy
            ? joinErrorOf(Cause.fail(error), "")
            : error instanceof RpcClientError.RpcClientError
              ? unreachable(url)
              : error,
        ),
      ),
    );
  } finally {
    void runtime.dispose();
  }
}

/**
 * Joins room `code` as `name` in `look`. Resolves once the server has given us a seat and the
 * room's roster. Rejects with a `JoinError` if the room is full or gone, or the server is
 * unreachable.
 */
export async function connect(
  url: string,
  code: string,
  name: string,
  look: Look,
  { timeoutMs = 5000 }: { timeoutMs?: number } = {},
): Promise<Connection> {
  // The one link this connection runs over: `rejoin()` swaps in a new one, nothing else holds it.
  let link = await openLink(url, code, name, look, { timeoutMs });
  const rosterHandlers = new Set<(roster: Roster) => void>();
  let frameHandler: ((frame: Frame) => void) | undefined;
  let closeHandler: ((reason: string) => void) | undefined;
  let closed = false;

  const attach = (next: Link) => {
    next.onRoster((roster) => {
      for (const handler of rosterHandlers) handler(roster);
    });
    if (frameHandler) next.onFrame(frameHandler);
    if (closeHandler) next.onClose(closeHandler);
  };
  attach(link);

  return {
    get seat() {
      return link.seat;
    },
    code,
    roster: () => link.roster(),
    onRoster(handler) {
      rosterHandlers.add(handler);
      return () => rosterHandlers.delete(handler);
    },
    send: (input) => link.send(input),
    start: () => link.start(),
    restart: () => link.restart(),
    toLobby: () => link.toLobby(),
    setLook: (next) => link.setLook(next),
    setTeam: (team) => link.setTeam(team),
    setMode: (mode) => link.setMode(mode),
    onFrame(handler) {
      frameHandler = handler;
      link.onFrame(handler);
    },
    onClose(handler) {
      closeHandler = handler;
      link.onClose(handler);
    },
    async rejoin() {
      const mine = link.roster().seats[link.seat];
      let next: Link;
      try {
        next = await openLink(url, code, mine?.name ?? name, mine?.look ?? look, {
          resume: link.token,
          timeoutMs,
        });
      } catch (error) {
        if (closed) return { kind: "closed" };
        return { kind: "failed", failure: error instanceof JoinError ? error.failure : "lost" };
      }
      if (closed) {
        next.close({ leave: true });
        return { kind: "closed" };
      }
      // Same token on both links: hanging up the old one must not Leave the seat we just took back.
      link.close({ leave: false });
      link = next;
      attach(next);
      const roster = next.roster();
      for (const handler of rosterHandlers) handler(roster);
      return { kind: "back" };
    },
    close() {
      if (closed) return;
      closed = true;
      rosterHandlers.clear();
      frameHandler = closeHandler = undefined;
      link.close({ leave: true });
    },
  };
}

/**
 * Where a link is: `joining` until the first roster after `Welcome`, `seated` while the Join
 * stream runs, `lost` once it ended on its own (the seat is no longer ours to give up), `closed`
 * once we hung up. joining → seated → lost → closed; joining → lost; any → closed.
 */
type LinkPhase = "joining" | "seated" | "lost" | "closed";

/** One Join stream and the runtime it runs on: a Connection runs over one at a time. */
type Link = Omit<Connection, "rejoin" | "close"> & {
  readonly token: string;
  /** Stops all handlers; `leave` gives a live seat up (`Leave`), never a lost one. */
  close(opts: { leave: boolean }): void;
};

/** Opens one Join stream, or takes back the seat token `resume` holds. Rejects with a `JoinError`. */
async function openLink(
  url: string,
  code: string,
  name: string,
  look: Look,
  { resume, timeoutMs }: { resume?: string; timeoutMs: number },
): Promise<Link> {
  const runtime = ManagedRuntime.make(clientLayer(url));
  let frameHandler: ((frame: Frame) => void) | undefined;
  let closeHandler: ((reason: string) => void) | undefined;
  let rosterHandler: ((roster: Roster) => void) | undefined;
  const backlog: Frame[] = [];
  let welcome: Welcome | undefined;
  let roster: Roster | undefined;
  let phase: LinkPhase = "joining";
  let last: SeatInput | undefined;

  let seated!: () => void;
  let refused!: (error: JoinError) => void;
  const ready = new Promise<void>((resolve, reject) => {
    seated = resolve;
    refused = reject;
  });
  const lose = (error: JoinError) => {
    if (phase === "lost" || phase === "closed") return;
    phase = "lost";
    refused(error);
    closeHandler?.(error.message);
  };

  const client = await runtime.runPromise(Effect.service(RaftClient));
  runtime.runFork(
    client.Join({ code, name, look, resume }).pipe(
      Stream.runForEach((msg) =>
        Effect.sync(() =>
          ServerMsg.match(msg, {
            Welcome: (w) => {
              welcome = w;
            },
            Roster: (r) => {
              if (phase === "closed") return;
              roster = r.roster;
              // The server idles every input when a race ends, so the next input must be sent again.
              if (!r.roster.started) last = undefined;
              if (welcome && phase === "joining") {
                phase = "seated";
                seated();
              }
              rosterHandler?.(r.roster);
            },
            Frame: (frame) => {
              if (phase === "closed") return;
              if (frameHandler) frameHandler(frame);
              else backlog.push(frame);
            },
          }),
        ),
      ),
      Effect.matchCause({
        onSuccess: () => lose(new JoinError("lost", "The server closed the connection")),
        onFailure: (cause) => lose(joinErrorOf(cause, code)),
      }),
    ),
  );

  const timer = setTimeout(() => lose(unreachable(url)), timeoutMs);
  try {
    await ready;
  } catch (error) {
    void runtime.dispose();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const me = welcome!;
  const seat = { code, token: me.token };
  /** Only a seated link talks to the server: a lost seat is away, a closed one gone. */
  const rpc = (call: Effect.Effect<unknown, unknown>) => {
    if (phase === "seated") runtime.runFork(call.pipe(Effect.ignore));
  };

  return {
    seat: me.seat,
    token: me.token,
    code,
    roster: () => roster!,
    onRoster(handler) {
      rosterHandler = handler;
      return () => (rosterHandler = undefined);
    },
    send(input) {
      if (phase !== "seated" || (last && sameInput(last, input))) return;
      last = input;
      rpc(client.SendInput({ ...seat, input }, { discard: true }));
    },
    start: () => rpc(client.Start(seat)),
    restart: () => rpc(client.Restart(seat)),
    toLobby: () => rpc(client.ToLobby(seat)),
    setLook: (next) => rpc(client.SetLook({ ...seat, look: next })),
    setTeam: (team) => rpc(client.SetTeam({ ...seat, team })),
    setMode: (next) => rpc(client.SetMode({ ...seat, mode: next })),
    onFrame(handler) {
      frameHandler = handler;
      for (const frame of backlog.splice(0)) handler(frame);
    },
    onClose(handler) {
      closeHandler = handler;
    },
    close({ leave }) {
      if (phase === "closed") return;
      const live = phase === "seated";
      phase = "closed";
      frameHandler = closeHandler = rosterHandler = undefined;
      backlog.length = 0;
      const bye =
        leave && live
          ? client.Leave(seat).pipe(Effect.timeout(LEAVE_TIMEOUT_MS), Effect.ignore)
          : Effect.void;
      void runtime.runPromise(bye).finally(() => runtime.dispose());
    },
  };
}
