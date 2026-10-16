import { IDLE_INPUT, type SeatInput } from "../sim/types";

/** Anything that can fill a seat: keyboard, gamepad, bot, or (later) a remote player. */
export type InputSource = { read(): SeatInput };

/** Null object for empty seats, so callers never check for "no source". */
export const idleSource: InputSource = { read: () => IDLE_INPUT };

export function createSeats(count: number): InputSource[] {
  return Array.from({ length: count }, () => idleSource);
}

export function readSeats(seats: readonly InputSource[]): SeatInput[] {
  return seats.map((s) => s.read());
}
