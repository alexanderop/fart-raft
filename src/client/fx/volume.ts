// Player volume settings: pure rules plus a tiny store that persists them and tells the audio
// graph and every slider on the page when they change. The AudioContext is not needed here, so
// the start menu can set the volume before the first sound plays.

export const VOLUME_KEY = "fart-raft:volume";
export const MUTE_KEY = "fart-raft:muted";
export const DEFAULT_MASTER = 0.8;

/** The three sliders. `farts` and `effects` (everything else) sit under `master`. */
export type Channel = "master" | "farts" | "effects";
export const CHANNELS: readonly Channel[] = ["master", "farts", "effects"];

export type Volume = {
  master: number;
  farts: number;
  effects: number;
  muted: boolean;
  /** Master level that unmuting brings back when the slider was dragged to 0. */
  restore: number;
};

export const DEFAULT_VOLUME: Volume = {
  master: DEFAULT_MASTER,
  farts: 1,
  effects: 1,
  // Sound starts off: the speaker button or M turns it on, and that choice is saved.
  muted: true,
  restore: DEFAULT_MASTER,
};

/** Any input to a level in 0..1, two decimals; junk falls back. */
export function clampLevel(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;
}

/** Stored JSON (or a bare number, as master) plus the old mute flag, back to settings. */
export function parseVolume(raw: string | null, mutedRaw: string | null): Volume {
  const v = { ...DEFAULT_VOLUME, muted: mutedRaw !== "0" };
  if (raw === null) return v;
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return v;
  }
  if (typeof saved === "number") saved = { master: saved };
  if (typeof saved !== "object" || saved === null) return v;
  const s = saved as Partial<Record<keyof Volume, unknown>>;
  v.master = clampLevel(s.master, v.master);
  v.farts = clampLevel(s.farts, v.farts);
  v.effects = clampLevel(s.effects, v.effects);
  v.restore = clampLevel(s.restore, v.master > 0 ? v.master : DEFAULT_MASTER) || DEFAULT_MASTER;
  return v;
}

export function serializeVolume(v: Volume): string {
  return JSON.stringify({
    master: v.master,
    farts: v.farts,
    effects: v.effects,
    restore: v.restore,
  });
}

/** Muted, or master at 0: either way the speaker shows as muted. */
export const isSilent = (v: Volume): boolean => v.muted || v.master === 0;

/** What the master gain node should be (before the graph's own headroom factor). */
export const masterLevel = (v: Volume): number => (v.muted ? 0 : v.master);

/** Speaker icon state. */
export function speakerLevel(v: Volume): "muted" | "low" | "high" {
  if (isSilent(v)) return "muted";
  return v.master < 0.5 ? "low" : "high";
}

/**
 * Move one slider. Raising master above 0 unmutes (dragging up means "I want sound"); any
 * audible master is remembered for unmuting later.
 */
export function setLevel(v: Volume, channel: Channel, value: number): Volume {
  const level = clampLevel(value, v[channel]);
  if (channel !== "master") return { ...v, [channel]: level };
  return {
    ...v,
    master: level,
    muted: level > 0 ? false : v.muted,
    restore: level > 0 ? level : v.restore,
  };
}

/** Mute button / M key. Unmuting a master at 0 brings back the last audible level. */
export function toggleMute(v: Volume): Volume {
  if (!isSilent(v)) return { ...v, muted: true };
  const master = v.master > 0 ? v.master : v.restore > 0 ? v.restore : DEFAULT_MASTER;
  return { ...v, muted: false, master, restore: master };
}

export type VolumeStore = {
  get(): Volume;
  set(channel: Channel, value: number): void;
  toggleMute(): void;
  /** Runs `fn` now and on every change; returns the unsubscribe. */
  subscribe(fn: (v: Volume) => void): () => void;
};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode or blocked storage: the volume just will not persist
  }
}

export function createVolumeStore(): VolumeStore {
  let state = parseVolume(read(VOLUME_KEY), read(MUTE_KEY));
  const listeners = new Set<(v: Volume) => void>();
  const commit = (next: Volume) => {
    state = next;
    write(VOLUME_KEY, serializeVolume(state));
    write(MUTE_KEY, state.muted ? "1" : "0");
    for (const fn of listeners) fn(state);
  };
  return {
    get: () => state,
    set: (channel, value) => commit(setLevel(state, channel, value)),
    toggleMute: () => commit(toggleMute(state)),
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
  };
}
