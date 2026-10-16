import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Duration, Layer } from "effect";
import { createServer } from "node:http";
import canyon from "../courses/canyon.json" with { type: "json" };
import { parseLevel } from "../src/sim/level.ts";
import { appLayer } from "./app.ts";

const Port = Config.Port("PORT").pipe(Config.withDefault(3000));

appLayer(parseLevel(canyon)).pipe(
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
