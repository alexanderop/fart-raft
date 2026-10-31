import type { Zone } from "../sim/constants.ts";
import type { LevelData, View } from "../sim/types.ts";
import { botSource } from "./bot.ts";
import { gamepadSource, isFarting, type Gamepads } from "./gamepad.ts";
import { CONTROLS, keyboardSource, PLAYER_KEYS, WASD_OR_ARROWS } from "./keyboard.ts";
import {
  createSeats,
  EMPTY_PLAN,
  mergeSources,
  planSeats,
  type InputSource,
  type SeatKind,
  type SeatPlan,
} from "./sources.ts";
import { touchSource } from "./touch.ts";

/**
 * Who drives each seat in a local game. The first `humans` seats are human: they take pads first
 * (connection order), the rest play on keyboard clusters, bots fill what is left, and a pad that
 * presses fart while idle can take over a bot seat mid-race (rule in `planSeats`). Each seat is
 * just an InputSource. `heading` is the camera's forward direction on the water (sim radians).
 * `names[i]` labels human seat `i` (blank keeps "P1"/"You").
 */
export function createSeatDriver(
  humans: number,
  zones: readonly Zone[],
  observe: () => View,
  lvl: LevelData,
  heading: () => number,
  pads: Gamepads,
  names: readonly string[] = [],
) {
  const kinds: SeatKind[] = zones.map((_, i) => (i < humans ? "human" : "bot"));
  const wantsIn = new Set<number>();
  let plan: SeatPlan = EMPTY_PLAN;
  let planKey = "";
  let bots: (InputSource | undefined)[] = [];
  let sources: InputSource[] = createSeats(zones.length);
  let labels: string[] = [];

  const seatOfPad = new Map<number, number>();
  const bot = (i: number) => (bots[i] ??= botSource(i, zones, lvl, observe));

  function rebuild() {
    sources = zones.map((_, i) => {
      const pad = [...plan.pads].find(([, seat]) => seat === i)?.[0];
      if (pad !== undefined) return gamepadSource(pads, () => pad, heading);
      const cluster = plan.keys.get(i);
      if (cluster === undefined) return bot(i);
      const keys = humans === 1 ? WASD_OR_ARROWS : PLAYER_KEYS[cluster]!;
      const kb = keyboardSource(keys, heading);
      // A lone human may be on a phone: the touch stick and button drive the same seat.
      return humans === 1 ? mergeSources(kb, touchSource(heading)) : kb;
    });
    labels = zones.map((_, i) => {
      const onPad = [...plan.pads.values()].includes(i);
      const cluster = plan.keys.get(i);
      const name = names[i]?.trim();
      if (humans === 1 && i === 0) return `${name || "You"}${onPad ? " 🎮" : ""}`;
      if (onPad) return `${name || `P${i + 1}`} · 🎮`;
      return cluster === undefined ? "Bot" : `${name || `P${i + 1}`} · ${CONTROLS[cluster]}`;
    });
  }

  return {
    /** Once per tick, before reading seats: look at the pads and re-plan if they changed. */
    update() {
      pads.poll();
      const connected = pads.connected();
      for (const pad of wantsIn) if (!connected.includes(pad)) wantsIn.delete(pad);
      for (const pad of connected) {
        const state = pads.state(pad);
        if (state && !plan.pads.has(pad) && isFarting(state)) wantsIn.add(pad);
      }
      const next = planSeats(kinds, connected, wantsIn, plan);
      const key = JSON.stringify([[...next.pads], [...next.keys]]);
      plan = next;
      seatOfPad.clear();
      for (const [pad, seat] of plan.pads) seatOfPad.set(pad, seat);
      if (key !== planKey || sources.length === 0) {
        planKey = key;
        rebuild();
      }
    },
    sources: () => sources,
    labels: () => labels,
    /** The pad on this seat, if any. */
    padOf: (seat: number): number | undefined => {
      for (const [pad, s] of seatOfPad) if (s === seat) return pad;
      return undefined;
    },
    claimedPads: (): readonly number[] => [...seatOfPad.keys()],
    /** New race: bots start over, pad and keyboard assignments stay. */
    reset() {
      bots = [];
      rebuild();
    },
  };
}
