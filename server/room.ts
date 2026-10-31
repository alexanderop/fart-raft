import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Option,
  PubSub,
  Ref,
  Stream,
  SubscriptionRef,
  type Scope,
} from "effect";
import {
  contactOf,
  FRAME_TICKS,
  isTeamMode,
  MAX_NAME,
  MAX_TEAM,
  RECONNECT_GRACE_MS,
  RoomFull,
  ServerMsg,
  startBlocker,
  type CourseName,
  type Roster,
  type RoomMode,
  type Team,
} from "../src/net/protocol.ts";
import { defaultLook, type Look } from "../src/look.ts";
import { crewZones, MAX_CREW, TICK_RATE } from "../src/sim/constants.ts";
import { createSim, snapshot, step } from "../src/sim/sim.ts";
import {
  IDLE_INPUT,
  type Difficulty,
  type LevelData,
  type SeatInput,
  type SimEvent,
  type Snapshot,
} from "../src/sim/types.ts";

/** Who holds a seat, connected or not: kept whole while they are away, so they come back as they were. */
type Holder = { name: string; look: Look; team: Team; token: string; joined: number };
/**
 * Connected. `lease` names the Join stream holding the seat (each Join gets a new one), so a
 * stream that ends after a newer one took the seat leaves it alone. Completing `ended` ends the stream.
 */
type Human = Holder & {
  kind: "human";
  input: SeatInput;
  lease: number;
  ended: Deferred.Deferred<void>;
};
/** Their Join stream ended: the seat is held for RECONNECT_GRACE_MS, then opens up. */
type Away = Holder & { kind: "away"; lease: number };
type Seat = { kind: "empty" } | Human | Away;
/**
 * Who drives one rider for a whole race. Matched to a seat by token, so a leaver's rider idles
 * in the look it started the race with. `raft` is fixed at the start: a later team switch only
 * counts from the next race.
 */
type Rider = { token: string; name: string; look: Look; raft: number };

const NANOS = 1_000_000_000n;
const RATE = BigInt(TICK_RATE);

/**
 * Runs `tick` at the sim's fixed rate on the Effect clock. A timer that fires late is made up
 * by running the missed ticks back to back, so game time tracks the clock instead of drifting.
 */
const everyStep = (tick: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const start = yield* Clock.monotonicTimeNanos;
    let done = 0n;
    while (true) {
      const elapsed = (yield* Clock.monotonicTimeNanos) - start;
      for (const due = (elapsed * RATE) / NANOS; done < due; done++) yield* tick;
      const nextAt = ((done + 1n) * NANOS + RATE - 1n) / RATE;
      yield* Effect.sleep(Duration.nanos(nextAt - elapsed));
    }
  });

export interface Room {
  readonly code: string;
  /**
   * The stream's lifetime is the seat lease: when it ends or is interrupted the seat is held away
   * for RECONNECT_GRACE_MS, then opens up. `resume` takes back the seat that token holds.
   */
  readonly join: (name: string, look?: Look, resume?: string) => Stream.Stream<ServerMsg, RoomFull>;
  /** Gives the token's seat up at once, connected or away. */
  readonly leave: (token: string) => Effect.Effect<void>;
  readonly sendInput: (token: string, input: SeatInput) => Effect.Effect<void>;
  /** Only the host's token starts the race; anything else is ignored. */
  readonly start: (token: string) => Effect.Effect<void>;
  /** Any seated human: a new race with everyone seated now, spectators included. */
  readonly restart: (token: string) => Effect.Effect<void>;
  /** Only the host's token ends the race and returns the room to its lobby; anything else is ignored. */
  readonly toLobby: (token: string) => Effect.Effect<void>;
  /** A seated human's new look: on their seat, and on their rider if they are racing. */
  readonly setLook: (token: string, look: Look) => Effect.Effect<void>;
  /** A seated human's team for the next race; ignored when that team is full. */
  readonly setTeam: (token: string, team: Team) => Effect.Effect<void>;
  /** Only the host's token changes how the next race is raced; anything else is ignored. */
  readonly setMode: (token: string, mode: RoomMode) => Effect.Effect<void>;
  /** Connected humans: an away seat does not keep the room open. */
  readonly humans: Effect.Effect<number>;
}

/**
 * One race: the sim, the riders it was started with (raft by raft, so `crew` is the sim's flat
 * input order), and the events not yet broadcast. Effect-free.
 */
function newRace(level: LevelData, difficulty: Difficulty, mode: RoomMode, crew: readonly Rider[]) {
  const rafts = isTeamMode(mode) ? [0, 1] : [0];
  const sim = createSim(
    level,
    rafts.map((raft) => crewZones(crew.filter((r) => r.raft === raft).length)),
    { difficulty, contact: contactOf(mode) },
  );
  let pending: SimEvent[] = [];

  return {
    crew,
    /** One fixed tick. Returns the frame to broadcast on every FRAME_TICKS-th tick. */
    tick(table: readonly Seat[]): ServerMsg | undefined {
      // A rider whose human left keeps the race going, idle, until the next restart.
      const inputs = crew.map((r) => {
        const seat = table.find((s) => s.kind === "human" && s.token === r.token);
        return seat?.kind === "human" ? seat.input : IDLE_INPUT;
      });
      pending.push(...step(sim, inputs));
      const latest: Snapshot = snapshot(sim);
      if (latest.tick % FRAME_TICKS !== 0) return undefined;
      const events = pending;
      pending = [];
      return ServerMsg.cases.Frame.make({ snapshot: latest, events });
    },
    free: () => sim.world.free(),
  };
}
type Race = ReturnType<typeof newRace>;

/** Trimmed, single-spaced, at most MAX_NAME characters; blank becomes "Player N". */
export function cleanName(raw: string, seat: number): string {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return name === "" ? `Player ${seat + 1}` : name;
}

const isHeld = (s: Seat): s is Human | Away => s.kind !== "empty";
const holderOf = ({ name, look, team, token, joined }: Holder): Holder => ({
  name,
  look,
  team,
  token,
  joined,
});

/** The connected seat `token` proves, or -1: only a connected player's RPCs count. */
const seatOf = (table: readonly Seat[], token: string) =>
  table.findIndex((s) => s.kind === "human" && s.token === token);
/** The seat `token` holds, connected or away, or -1. */
const heldSeatOf = (table: readonly Seat[], token: string) =>
  table.findIndex((s) => isHeld(s) && s.token === token);

const teamCount = (table: readonly Seat[], team: Team) =>
  table.filter((s) => isHeld(s) && s.team === team).length;

/** The team a newcomer joins: the one with fewer players, Red on a tie. */
const smallerTeam = (table: readonly Seat[]): Team =>
  teamCount(table, 1) < teamCount(table, 0) ? 1 : 0;

const ridersOf = (humans: readonly Holder[], raft: number): Rider[] =>
  humans.map((s) => ({ token: s.token, name: s.name, look: s.look, raft }));

/**
 * Everyone seated, in seat order on raft 0 in co-op; in a team room Red's riders on raft 0 then
 * Blue's on raft 1, each in seat order.
 */
const crewFor = (humans: readonly Holder[], mode: RoomMode): Rider[] =>
  isTeamMode(mode)
    ? [
        ...ridersOf(
          humans.filter((s) => s.team === 0),
          0,
        ),
        ...ridersOf(
          humans.filter((s) => s.team === 1),
          1,
        ),
      ]
    : ridersOf(humans, 0);

const hostOf = (seats: readonly Seat[]): number | null => {
  let host: number | null = null;
  let since = Infinity;
  for (const [i, s] of seats.entries()) {
    if (s.kind === "human" && s.joined < since) [host, since] = [i, s.joined];
  }
  return host;
};

/**
 * A room starts in the lobby: players join and see each other, nothing is simulated. The host's
 * Start creates the race with everyone seated (away ones too) as its crew (split by team in a team
 * room, which needs a rider on both); a mid-race joiner watches until a restart rebuilds the
 * crew; from then on it ticks at 60 Hz while at least one connected human is seated. A seat whose
 * Join stream ends is held away for RECONNECT_GRACE_MS: a Join that resumes its token takes it
 * back, rider and all.
 * Physics must be initialised (`initPhysics`) before the race starts. Lives as long as its scope.
 */
export const makeRoom = (
  code: string,
  course: CourseName,
  level: LevelData,
  difficulty: Difficulty,
  initialMode: RoomMode,
): Effect.Effect<Room, never, Scope.Scope> =>
  Effect.gen(function* () {
    // No bots online: a race's crew is exactly the humans seated when it starts.
    const empty: Seat = { kind: "empty" };
    const seats = yield* Ref.make<readonly Seat[]>(Array.from({ length: MAX_CREW }, () => empty));
    const race = yield* Ref.make<Race | undefined>(undefined);
    const modeRef = yield* Ref.make(initialMode);
    const scope = yield* Effect.scope;
    let joins = 0;
    let leases = 0;

    const rosterOf = (
      table: readonly Seat[],
      current: Race | undefined,
      mode: RoomMode,
    ): Roster => ({
      code,
      course,
      difficulty,
      mode,
      seats: table.map((s) =>
        isHeld(s) ? { name: s.name, look: s.look, team: s.team, away: s.kind === "away" } : null,
      ),
      host: hostOf(table),
      started: current !== undefined,
      crew: (current?.crew ?? []).map((r) => {
        const seat = heldSeatOf(table, r.token);
        const holder = table[seat];
        const look = holder && isHeld(holder) ? holder.look : r.look;
        return { name: r.name, seat: seat < 0 ? null : seat, look, raft: r.raft };
      }),
    });
    const roster = yield* SubscriptionRef.make(
      rosterOf(yield* Ref.get(seats), undefined, initialMode),
    );
    const publishRoster = Effect.gen(function* () {
      yield* SubscriptionRef.set(
        roster,
        rosterOf(yield* Ref.get(seats), yield* Ref.get(race), yield* Ref.get(modeRef)),
      );
    });

    // Sliding: a slow client loses old frames instead of stalling the room.
    const frames = yield* Effect.acquireRelease(PubSub.sliding<ServerMsg>(4), PubSub.shutdown);
    yield* Effect.addFinalizer(() => Ref.get(race).pipe(Effect.map((r) => r?.free())));

    const tick = Effect.gen(function* () {
      const current = yield* Ref.get(race);
      const table = yield* Ref.get(seats);
      // Nobody connected: hold the race where it is until someone comes back.
      if (!current || !table.some((s) => s.kind === "human")) return;
      const frame = current.tick(table);
      if (frame) yield* PubSub.publish(frames, frame);
    });
    yield* Effect.forkScoped(everyStep(tick));

    const crewOf = (table: readonly Seat[], mode: RoomMode): Rider[] =>
      crewFor(table.filter(isHeld), mode);

    /** A new race for everyone seated now, or undefined while a team room lacks a rider on a team. */
    const freshRace = Effect.gen(function* () {
      const table = yield* Ref.get(seats);
      const mode = yield* Ref.get(modeRef);
      if (startBlocker(rosterOf(table, undefined, mode)) !== null) return undefined;
      return newRace(level, difficulty, mode, crewOf(table, mode));
    });

    /** The seat a Join holds, and the stream it displaced (a resume of a seat still connected). */
    type Claim = {
      seat: number;
      token: string;
      lease: number;
      displaced?: Deferred.Deferred<void>;
    };

    /**
     * Takes back the seat `resume` holds, connected or away, as it was; else the first empty one.
     * The token lives only in the page that joined, so a resume of a seat the server still sees
     * connected is that page back on a new socket before the old one timed out: the newest wins.
     */
    const claimSeat = (
      name: string,
      look: Look | undefined,
      resume: string | undefined,
      ended: Deferred.Deferred<void>,
    ) =>
      Ref.modify(seats, (table) => {
        const lease = leases++;
        const back = resume === undefined ? -1 : heldSeatOf(table, resume);
        const was = table[back];
        if (was && isHeld(was)) {
          const human: Human = { ...holderOf(was), kind: "human", input: IDLE_INPUT, lease, ended };
          const displaced = was.kind === "human" ? was.ended : undefined;
          const claim: Claim = { seat: back, token: was.token, lease, displaced };
          return [Option.some(claim), table.with(back, human)] as const;
        }
        const free = table.findIndex((s) => s.kind === "empty");
        if (free < 0) return [Option.none<Claim>(), table] as const;
        const human: Human = {
          kind: "human",
          name: cleanName(name, free),
          look: look ?? defaultLook(free),
          team: smallerTeam(table),
          token: crypto.randomUUID(),
          joined: joins++,
          input: IDLE_INPUT,
          lease,
          ended,
        };
        const claim: Claim = { seat: free, token: human.token, lease };
        return [Option.some(claim), table.with(free, human)] as const;
      }).pipe(
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(new RoomFull()), onSome: Effect.succeed }),
        ),
        Effect.tap((claim) =>
          claim.displaced ? Deferred.succeed(claim.displaced, undefined) : Effect.void,
        ),
        Effect.tap(() => publishRoster),
      );

    /** Empties `seat` if it still matches; a no-op otherwise, so a late or repeated call is harmless. */
    const vacate = (seat: number, still: (s: Seat) => boolean) =>
      Ref.modify(seats, (table) => {
        const s = table[seat];
        return s && still(s)
          ? ([true, table.with(seat, empty)] as const)
          : ([false, table] as const);
      }).pipe(Effect.flatMap((changed) => (changed ? publishRoster : Effect.void)));

    /** The lease's stream ended: hold its seat away, and open it up after the grace unless it came back. */
    const goAway = Effect.fnUntraced(function* ({ seat, lease }: Claim) {
      const away = yield* Ref.modify(seats, (table) => {
        const s = table[seat];
        if (s?.kind !== "human" || s.lease !== lease) return [false, table] as const;
        return [
          true,
          table.with(seat, { ...holderOf(s), kind: "away", lease } satisfies Away),
        ] as const;
      });
      if (!away) return;
      yield* publishRoster;
      const stillAway = (s: Seat) => s.kind === "away" && s.lease === lease;
      yield* Effect.forkIn(
        Effect.sleep(RECONNECT_GRACE_MS).pipe(Effect.andThen(vacate(seat, stillAway))),
        scope,
      );
    });

    const join = (name: string, look?: Look, resume?: string) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const ended = yield* Deferred.make<void>();
          const claim = yield* Effect.acquireRelease(claimSeat(name, look, resume, ended), goAway);
          const subscription = yield* PubSub.subscribe(frames);
          const rosters = SubscriptionRef.changes(roster).pipe(
            Stream.map((r) => ServerMsg.cases.Roster.make({ roster: r })),
          );
          const welcome = ServerMsg.cases.Welcome.make({ seat: claim.seat, token: claim.token });
          return Stream.make(welcome).pipe(
            Stream.concat(Stream.merge(rosters, Stream.fromSubscription(subscription))),
            Stream.interruptWhen(Deferred.await(ended)),
          );
        }),
      );

    const leave = Effect.fn("Room.leave")(function* (token: string) {
      const left = yield* Ref.modify(seats, (table) => {
        const seat = heldSeatOf(table, token);
        const s = table[seat];
        return s && isHeld(s)
          ? ([s, table.with(seat, empty)] as const)
          : ([undefined, table] as const);
      });
      if (!left) return;
      if (left.kind === "human") yield* Deferred.succeed(left.ended, undefined);
      yield* publishRoster;
    });

    const sendInput = Effect.fn("Room.sendInput")(function* (token: string, input: SeatInput) {
      // Only a seated human's own token counts: a stray message must not steer anyone else.
      // A spectator's input is stored too, but no rider reads it until they're in a race.
      yield* Ref.update(seats, (table) => {
        const seat = seatOf(table, token);
        const human = table[seat];
        return human?.kind === "human" ? table.with(seat, { ...human, input }) : table;
      });
    });

    const start = Effect.fn("Room.start")(function* (token: string) {
      const table = yield* Ref.get(seats);
      const host = hostOf(table);
      if (host === null || seatOf(table, token) !== host || (yield* Ref.get(race))) return;
      const fresh = yield* freshRace;
      if (!fresh) return;
      // One modify: a second Start can never swap in a race between the check and the set.
      const started = yield* Ref.modify(race, (current) =>
        current === undefined ? ([true, fresh] as const) : ([false, current] as const),
      );
      if (started) yield* publishRoster;
      else fresh.free();
    });

    const restart = Effect.fn("Room.restart")(function* (token: string) {
      const table = yield* Ref.get(seats);
      if (seatOf(table, token) < 0 || !(yield* Ref.get(race))) return;
      const fresh = yield* freshRace;
      if (!fresh) return;
      // One modify: two Restarts each get their own old race, so none is freed twice.
      const old = yield* Ref.modify(race, (current) =>
        current === undefined ? ([undefined, current] as const) : ([current, fresh] as const),
      );
      if (!old) {
        fresh.free();
        return;
      }
      old.free();
      yield* publishRoster;
    });

    const toLobby = Effect.fn("Room.toLobby")(function* (token: string) {
      const table = yield* Ref.get(seats);
      const host = hostOf(table);
      if (host === null || seatOf(table, token) !== host) return;
      // One modify: two ToLobbys each see the race once, so none is freed twice.
      const old = yield* Ref.getAndSet(race, undefined);
      if (!old) return;
      old.free();
      // Held keys from the race must not steer the next one before its player sends fresh input.
      yield* Ref.update(seats, (t) =>
        t.map((s) => (s.kind === "human" ? { ...s, input: IDLE_INPUT } : s)),
      );
      yield* publishRoster;
    });

    const setLook = Effect.fn("Room.setLook")(function* (token: string, look: Look) {
      const changed = yield* Ref.modify(seats, (table) => {
        const seat = seatOf(table, token);
        const human = table[seat];
        if (human?.kind !== "human") return [false, table] as const;
        return [true, table.with(seat, { ...human, look })] as const;
      });
      if (changed) yield* publishRoster;
    });

    const setTeam = Effect.fn("Room.setTeam")(function* (token: string, team: Team) {
      const changed = yield* Ref.modify(seats, (table) => {
        const seat = seatOf(table, token);
        const human = table[seat];
        if (human?.kind !== "human" || human.team === team) return [false, table] as const;
        const full = teamCount(table, team) >= MAX_TEAM;
        return full
          ? ([false, table] as const)
          : ([true, table.with(seat, { ...human, team })] as const);
      });
      if (changed) yield* publishRoster;
    });

    const setMode = Effect.fn("Room.setMode")(function* (token: string, mode: RoomMode) {
      const table = yield* Ref.get(seats);
      const host = hostOf(table);
      if (host === null || seatOf(table, token) !== host) return;
      yield* Ref.set(modeRef, mode);
      yield* publishRoster;
    });

    const humans = Ref.get(seats).pipe(
      Effect.map((table) => table.filter((s) => s.kind === "human").length),
    );

    return {
      code,
      join,
      leave,
      sendInput,
      start,
      restart,
      toLobby,
      setLook,
      setTeam,
      setMode,
      humans,
    };
  });
