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
  /** Called on every roster change. Returns a function that stops listening. */
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
   * A new connection to the same room that takes this seat back (same seat, team and rider) while
   * the server still holds it; once the seat has opened up it joins as a newcomer. Rejects like
   * `connect`.
   */
  rejoin(): Promise<Connection>;
  /**
   * Leaves the room and stops all handlers. A live seat is given up at once (`Leave`); a lost one
   * is left to the server's grace, so a `rejoin()` in flight still finds it.
   */
  close(): void;
};

const sameInput = (a: SeatInput, b: SeatInput) =>
  a.fart === b.fart && a.move.x === b.move.x && a.move.y === b.move.y;

const reasonFor = (cause: Cause.Cause<unknown>, code: string): string => {
  const error = Cause.squash(cause);
  if (error instanceof RoomFull) return "That game is full";
  if (error instanceof RoomNotFound) return `No game with code ${code}`;
  if (error instanceof ServerBusy) return "The server is busy, try again in a bit";
  return "Connection lost";
};

const unreachable = (url: string) => new Error(`No answer from ${url}`);

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
            ? new Error(reasonFor(Cause.fail(error), ""))
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
 * Joins room `code` as `name` in `look`, or takes back the seat token `resume` holds. Resolves
 * once the server has given us a seat and the room's roster. Rejects if the room is full or gone,
 * or the server is unreachable.
 */
export async function connect(
  url: string,
  code: string,
  name: string,
  look: Look,
  { resume, timeoutMs = 5000 }: { resume?: string; timeoutMs?: number } = {},
): Promise<Connection> {
  const runtime = ManagedRuntime.make(clientLayer(url));
  let frameHandler: ((frame: Frame) => void) | undefined;
  let closeHandler: ((reason: string) => void) | undefined;
  const rosterHandlers = new Set<(roster: Roster) => void>();
  const backlog: Frame[] = [];
  let welcome: Welcome | undefined;
  let roster: Roster | undefined;
  let closed = false;
  /** The Join stream has ended: the seat is no longer ours to give up. */
  let lost = false;
  let last: SeatInput | undefined;

  let seated!: () => void;
  let refused!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    seated = resolve;
    refused = reject;
  });
  const lose = (reason: string) => {
    lost = true;
    if (closed) return;
    refused(new Error(reason));
    closeHandler?.(reason);
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
              if (closed) return;
              roster = r.roster;
              // The server idles every input when a race ends, so the next input must be sent again.
              if (!r.roster.started) last = undefined;
              if (welcome) seated();
              for (const handler of rosterHandlers) handler(r.roster);
            },
            Frame: (frame) => {
              if (closed) return;
              if (frameHandler) frameHandler(frame);
              else backlog.push(frame);
            },
          }),
        ),
      ),
      Effect.matchCause({
        onSuccess: () => lose("The server closed the connection"),
        onFailure: (cause) => lose(reasonFor(cause, code)),
      }),
    ),
  );

  const timer = setTimeout(() => lose(unreachable(url).message), timeoutMs);
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

  return {
    seat: me.seat,
    code,
    roster: () => roster!,
    onRoster(handler) {
      rosterHandlers.add(handler);
      return () => rosterHandlers.delete(handler);
    },
    send(input) {
      if (closed || (last && sameInput(last, input))) return;
      last = input;
      runtime.runFork(client.SendInput({ ...seat, input }, { discard: true }).pipe(Effect.ignore));
    },
    start() {
      runtime.runFork(client.Start(seat).pipe(Effect.ignore));
    },
    restart() {
      runtime.runFork(client.Restart(seat).pipe(Effect.ignore));
    },
    toLobby() {
      if (closed) return;
      runtime.runFork(client.ToLobby(seat).pipe(Effect.ignore));
    },
    setLook(next) {
      if (closed) return;
      runtime.runFork(client.SetLook({ ...seat, look: next }).pipe(Effect.ignore));
    },
    setTeam(team) {
      if (closed) return;
      runtime.runFork(client.SetTeam({ ...seat, team }).pipe(Effect.ignore));
    },
    setMode(next) {
      if (closed) return;
      runtime.runFork(client.SetMode({ ...seat, mode: next }).pipe(Effect.ignore));
    },
    onFrame(handler) {
      frameHandler = handler;
      for (const frame of backlog.splice(0)) handler(frame);
    },
    onClose(handler) {
      closeHandler = handler;
    },
    rejoin() {
      const mine = roster?.seats[me.seat];
      return connect(url, code, mine?.name ?? name, mine?.look ?? look, { resume: me.token });
    },
    close() {
      if (closed) return;
      closed = true;
      frameHandler = closeHandler = undefined;
      rosterHandlers.clear();
      backlog.length = 0;
      const leave = lost
        ? Effect.void
        : client.Leave(seat).pipe(Effect.timeout(LEAVE_TIMEOUT_MS), Effect.ignore);
      void runtime.runPromise(leave).finally(() => runtime.dispose());
    },
  };
}
