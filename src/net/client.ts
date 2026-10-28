import { Cause, Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import type { SeatInput } from "../sim/types.ts";
import {
  RaftRpcs,
  RoomFull,
  RoomNotFound,
  ServerBusy,
  ServerMsg,
  type CourseName,
  type Frame,
  type Roster,
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
  /** The lobby seat. The rider it drives in a race is `riderOf(roster(), seat)`. */
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
  /** Frames that arrived before the handler was set are delivered first. */
  onFrame(handler: (frame: Frame) => void): void;
  /** The seat is lost: the connection dropped or the server ended the stream. */
  onClose(handler: (reason: string) => void): void;
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

/** Opens a new room on the server at `url` and returns its code. Nobody holds a seat yet. */
export async function createRoom(url: string, course: CourseName, timeoutMs = 5000) {
  const runtime = ManagedRuntime.make(clientLayer(url));
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RaftClient;
        return yield* client.CreateRoom({ course });
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
 * Joins room `code` as `name`. Resolves once the server has given us a seat and the room's
 * roster. Rejects if the room is full or gone, or the server is unreachable.
 */
export async function connect(
  url: string,
  code: string,
  name: string,
  timeoutMs = 5000,
): Promise<Connection> {
  const runtime = ManagedRuntime.make(clientLayer(url));
  let frameHandler: ((frame: Frame) => void) | undefined;
  let closeHandler: ((reason: string) => void) | undefined;
  const rosterHandlers = new Set<(roster: Roster) => void>();
  const backlog: Frame[] = [];
  let welcome: Welcome | undefined;
  let roster: Roster | undefined;

  let seated!: () => void;
  let refused!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    seated = resolve;
    refused = reject;
  });
  const lost = (reason: string) => {
    refused(new Error(reason));
    closeHandler?.(reason);
  };

  const client = await runtime.runPromise(Effect.service(RaftClient));
  runtime.runFork(
    client.Join({ code, name }).pipe(
      Stream.runForEach((msg) =>
        Effect.sync(() =>
          ServerMsg.match(msg, {
            Welcome: (w) => {
              welcome = w;
            },
            Roster: (r) => {
              roster = r.roster;
              if (welcome) seated();
              for (const handler of rosterHandlers) handler(r.roster);
            },
            Frame: (frame) => (frameHandler ? frameHandler(frame) : backlog.push(frame)),
          }),
        ),
      ),
      Effect.matchCause({
        onSuccess: () => lost("The server closed the connection"),
        onFailure: (cause) => lost(reasonFor(cause, code)),
      }),
    ),
  );

  const timer = setTimeout(() => lost(unreachable(url).message), timeoutMs);
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

  let last: SeatInput | undefined;
  return {
    seat: me.seat,
    code,
    roster: () => roster!,
    onRoster(handler) {
      rosterHandlers.add(handler);
      return () => rosterHandlers.delete(handler);
    },
    send(input) {
      if (last && sameInput(last, input)) return;
      last = input;
      runtime.runFork(client.SendInput({ ...seat, input }, { discard: true }).pipe(Effect.ignore));
    },
    start() {
      runtime.runFork(client.Start(seat).pipe(Effect.ignore));
    },
    restart() {
      runtime.runFork(client.Restart(seat).pipe(Effect.ignore));
    },
    onFrame(handler) {
      frameHandler = handler;
      for (const frame of backlog.splice(0)) handler(frame);
    },
    onClose(handler) {
      closeHandler = handler;
    },
    close() {
      void runtime.dispose();
    },
  };
}
