import { Cause, Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import type { SeatInput } from "../sim/types.ts";
import { RaftRpcs, ServerMsg, type Frame } from "./protocol.ts";

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
  readonly seat: number;
  readonly crew: number;
  /** Sends only when the input differs from the last one sent. */
  send(input: SeatInput): void;
  restart(): void;
  /** Frames that arrived before the handler was set are delivered first. */
  onFrame(handler: (frame: Frame) => void): void;
  /** The seat is lost: the connection dropped or the server ended the stream. */
  onClose(handler: (reason: string) => void): void;
  close(): void;
};

const sameInput = (a: SeatInput, b: SeatInput) =>
  a.fart === b.fart && a.move.x === b.move.x && a.move.y === b.move.y;

/** Resolves once the server has given us a seat. Rejects if the room is full or the server is unreachable. */
export async function connect(url: string, timeoutMs = 5000): Promise<Connection> {
  const runtime = ManagedRuntime.make(clientLayer(url));
  let frameHandler: ((frame: Frame) => void) | undefined;
  let closeHandler: ((reason: string) => void) | undefined;
  const backlog: Frame[] = [];

  let seated!: (seat: { seat: number; crew: number }) => void;
  let refused!: (error: Error) => void;
  const welcome = new Promise<{ seat: number; crew: number }>((resolve, reject) => {
    seated = resolve;
    refused = reject;
  });
  const lost = (reason: string) => {
    refused(new Error(reason));
    closeHandler?.(reason);
  };

  const client = await runtime.runPromise(Effect.service(RaftClient));
  runtime.runFork(
    client.Join().pipe(
      Stream.runForEach((msg) =>
        Effect.sync(() =>
          ServerMsg.match(msg, {
            Welcome: ({ seat, crew }) => seated({ seat, crew }),
            Frame: (frame) => (frameHandler ? frameHandler(frame) : backlog.push(frame)),
          }),
        ),
      ),
      Effect.matchCause({
        onSuccess: () => lost("The server closed the connection"),
        onFailure: (cause) =>
          lost(Cause.hasFails(cause) ? "Could not join the room" : "Connection lost"),
      }),
    ),
  );

  const timer = setTimeout(() => lost(`No answer from ${url}`), timeoutMs);
  let me: { seat: number; crew: number };
  try {
    me = await welcome;
  } catch (error) {
    void runtime.dispose();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let last: SeatInput | undefined;
  return {
    ...me,
    send(input) {
      if (last && sameInput(last, input)) return;
      last = input;
      runtime.runFork(
        client.SendInput({ seat: me.seat, input }, { discard: true }).pipe(Effect.ignore),
      );
    },
    restart() {
      runtime.runFork(client.Restart().pipe(Effect.ignore));
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
