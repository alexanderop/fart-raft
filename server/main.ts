import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Duration, Effect, Layer, Option } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/http";
import { createServer } from "node:http";
import canyon from "../courses/canyon.json" with { type: "json" };
import graveyard from "../courses/graveyard.json" with { type: "json" };
import pond from "../courses/pond.json" with { type: "json" };
import { parseLevel } from "../src/sim/level.ts";
import { rpcLayer } from "./app.ts";

const Port = Config.Port("PORT").pipe(Config.withDefault(3000));

/** `STATIC=dist` also serves the built client, so one URL is both the game and its server. */
const staticFiles = Layer.unwrap(
  Effect.gen(function* () {
    const root = yield* Config.option(Config.String("STATIC"));
    return Option.match(root, {
      onNone: () => Layer.empty,
      onSome: (dir) =>
        HttpStaticServer.layer({ root: dir, mimeTypes: { glb: "model/gltf-binary" } }),
    });
  }),
);

const courses = {
  canyon: parseLevel(canyon),
  graveyard: parseLevel(graveyard),
  pond: parseLevel(pond),
};

HttpRouter.serve(Layer.mergeAll(rpcLayer(courses), staticFiles)).pipe(
  Layer.provide(
    // Open WebSockets would otherwise hold a Ctrl+C for the default 20 s.
    NodeHttpServer.layerConfig(createServer, {
      port: Port,
      gracefulShutdownTimeout: Config.succeed(Duration.seconds(1)),
    }),
  ),
  Layer.launch,
  NodeRuntime.runMain,
);
