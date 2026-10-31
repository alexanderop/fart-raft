/**
 * Server load benchmark: N team rooms (4 vs 4) stepped on one thread, the way server/room.ts
 * ticks each one: `step` then `snapshot` every 60 Hz tick, plus a frame encode for every client
 * on every FRAME_TICKS-th tick. Prints the cost of one tick for ALL rooms against the 16.7 ms
 * budget.
 *
 *   node scripts/bench-rooms.ts [--rooms 50] [--course canyon|graveyard] [--ticks 7200] [--runs 5]
 *
 * One reference race is played by bots and recorded; every room then replays that input script
 * with its own deterministic dropouts, so the rooms drift apart (different wipeouts, bumps,
 * positions) without paying the bots' planning cost, which is not server work.
 */
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import canyon from "../courses/canyon.json" with { type: "json" };
import graveyard from "../courses/graveyard.json" with { type: "json" };
import { botSource } from "../src/input/bot.ts";
import { crewZones, TICK_RATE } from "../src/sim/constants.ts";
import { parseLevel } from "../src/sim/level.ts";
import { createSim, initPhysics, snapshot, step } from "../src/sim/sim.ts";
import type { Contact, SeatInput, SimEvent } from "../src/sim/types.ts";
import { viewOf } from "../src/sim/view.ts";

const FRAME_TICKS = 3;
const CLIENTS_PER_ROOM = 8;
const BUDGET_MS = 1000 / TICK_RATE;
const ZONES = [crewZones(4), crewZones(4)];

const { values } = parseArgs({
  options: {
    rooms: { type: "string", default: "50" },
    course: { type: "string", default: "canyon" },
    ticks: { type: "string", default: "7200" },
    runs: { type: "string", default: "5" },
  },
});
const ROOMS = Number(values.rooms);
const TICKS = Number(values.ticks);
const RUNS = Number(values.runs);
const level = parseLevel(values.course === "graveyard" ? graveyard : canyon);

const quantile = (sorted: readonly number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
const sortedAsc = (xs: readonly number[]) => xs.toSorted((a, b) => a - b);

const range = (xs: number[]) => `${Math.min(...xs).toFixed(2)}-${Math.max(...xs).toFixed(2)}`;
const median = (xs: number[]) => quantile(sortedAsc(xs), 0.5);

/** Bots play one 4 vs 4 race; returns each tick's eight inputs, raft by raft. */
function recordRace(contact: Contact): SeatInput[][] {
  const sim = createSim(level, ZONES, { difficulty: "wild", contact });
  let views = ZONES.map((_, r) => viewOf(snapshot(sim), r));
  const sources = ZONES.flatMap((seats, r) =>
    seats.map((_, i) => botSource(i, seats, level, () => views[r]!)),
  );
  const script: SeatInput[][] = [];
  for (let t = 0; t < TICKS; t++) {
    const inputs = sources.map((s) => s.read());
    script.push(inputs);
    step(sim, inputs);
    const snap = snapshot(sim);
    views = ZONES.map((_, r) => viewOf(snap, r));
  }
  sim.world.free();
  return script;
}

/** Room `room` drops a rider's fart now and then, so no two rooms play the same race. */
const perturbed = (inputs: readonly SeatInput[], room: number, tick: number): SeatInput[] =>
  inputs.map((input, seat) =>
    (tick + seat * 7) % (23 + room) === 0 ? { ...input, fart: false } : input,
  );

type Run = {
  tickMs: number[];
  events: number;
  wipeouts: number;
  finished: number;
  bumps: number;
  bytes: number;
  badRafts: number;
};

function run(contact: Contact, script: readonly SeatInput[][]): Run {
  const sims = Array.from({ length: ROOMS }, () =>
    createSim(level, ZONES, { difficulty: "wild", contact }),
  );
  const tickMs: number[] = [];
  let events = 0;
  let bumps = 0;
  let bytes = 0;
  for (let t = 0; t < TICKS; t++) {
    const inputs = sims.map((_, room) => perturbed(script[t]!, room, t));
    const t0 = performance.now();
    sims.forEach((sim, room) => {
      const out: SimEvent[] = step(sim, inputs[room]!);
      const snap = snapshot(sim);
      if (snap.tick % FRAME_TICKS === 0) {
        for (let c = 0; c < CLIENTS_PER_ROOM; c++) {
          bytes += JSON.stringify({ snapshot: snap, events: out }).length;
        }
      }
      events += out.length;
      bumps += out.filter((e) => e.type === "bump").length;
    });
    tickMs.push(performance.now() - t0);
  }
  const last = sims.map((sim) => snapshot(sim));
  const crews = last.flatMap((s) => s.crews);
  const badRafts = crews.filter((c) => !Number.isFinite(c.raft.x) || !Number.isFinite(c.raft.y));
  for (const sim of sims) sim.world.free();
  return {
    tickMs,
    events,
    wipeouts: crews.reduce((n, c) => n + c.deaths, 0),
    finished: crews.filter((c) => c.phase.kind === "finished").length,
    bumps,
    bytes,
    badRafts: badRafts.length,
  };
}

await initPhysics();
console.log(
  `${ROOMS} rooms x 4v4, ${values.course}, ${TICKS} ticks/run (${(TICKS / TICK_RATE).toFixed(0)} s game time), ${RUNS} runs after 1 warm-up, budget ${BUDGET_MS.toFixed(2)} ms/tick, node ${process.version}`,
);
for (const contact of ["ghost", "bump"] as const) {
  const script = recordRace(contact);
  run(contact, script);
  const runs = Array.from({ length: RUNS }, () => run(contact, script));
  const p50s = runs.map((r) => quantile(sortedAsc(r.tickMs), 0.5));
  const p99s = runs.map((r) => quantile(sortedAsc(r.tickMs), 0.99));
  const worst = Math.max(...runs.map((r) => Math.max(...r.tickMs)));
  const over = runs.reduce((n, r) => n + r.tickMs.filter((ms) => ms > BUDGET_MS).length, 0);
  const total = (pick: (r: Run) => number) => runs.reduce((n, r) => n + pick(r), 0);
  console.log(
    `${contact.padEnd(5)} p50 ${median(p50s).toFixed(2)} ms (runs ${range(p50s)})  p99 ${median(p99s).toFixed(2)} ms (runs ${range(p99s)})  worst ${worst.toFixed(2)} ms  ticks over budget ${over}/${RUNS * TICKS}`,
  );
  console.log(
    `      work: ${total((r) => r.events)} events, ${total((r) => r.bumps)} bump events, ${total((r) => r.wipeouts)} wipeouts, ${total((r) => r.finished)} rafts finished, ${(total((r) => r.bytes) / 1e6).toFixed(0)} MB encoded, ${total((r) => r.badRafts)} non-finite rafts (${RUNS} runs)`,
  );
}
