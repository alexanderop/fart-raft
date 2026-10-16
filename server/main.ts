import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Layer } from "effect";
import { createServer } from "node:http";
import canyon from "../courses/canyon.json" with { type: "json" };
import { parseLevel } from "../src/sim/level.ts";
import { appLayer } from "./app.ts";

const Port = Config.Port("PORT").pipe(Config.withDefault(3000));

appLayer(parseLevel(canyon)).pipe(
  Layer.provide(NodeHttpServer.layerConfig(createServer, { port: Port })),
  Layer.launch,
  NodeRuntime.runMain,
);
