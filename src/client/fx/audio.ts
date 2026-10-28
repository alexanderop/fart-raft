import { RAFT_RADIUS, TICK_RATE } from "../../sim/constants.ts";
import type { Pose, SimEvent, Snapshot } from "../../sim/types.ts";
import { isSilent, masterLevel, type Volume, type VolumeStore } from "./volume.ts";

// Everything but the fart is synthesized with the Web Audio API. Farts are recorded CC0 clips
// (public/sounds, see CREDITS.md), with the old synth fart as fallback until they decode. The sim never sees this.

/** Volume changes glide over about this long (setTargetAtTime time constant, s). */
const VOLUME_GLIDE = 0.03;
const MAX_VOICES = 24;
/** Semitone offset of each seat's fart, so players can tell theirs apart. Seats past the table wrap a whole tone higher. */
const SEAT_SEMITONES = [0, 5, -4, 3, -2, 7, -6, 1] as const;
const FART_CLIPS = 12;
const FART_GAIN = 0.75;

/** Pitch factor for any seat index: 1 = the clip's own pitch. */
function seatRate(seat: number): number {
  const lap = Math.floor(seat / SEAT_SEMITONES.length);
  return 2 ** ((SEAT_SEMITONES[seat % SEAT_SEMITONES.length]! + 2 * lap) / 12);
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);

function osc(
  context: AudioContext,
  type: OscillatorType,
  start: number,
  length: number,
  from: number,
  to = from,
) {
  const o = context.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, start);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, start + length);
  o.start(start);
  o.stop(start + length + 0.05);
  return o;
}

/** Attack/decay envelope into `out`. */
function envelope(
  context: AudioContext,
  start: number,
  peak: number,
  attack: number,
  length: number,
  out: AudioNode,
) {
  const g = context.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.linearRampToValueAtTime(peak, start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, start + length);
  g.connect(out);
  return g;
}

/**
 * `volume` owns the player's levels (persisted, shared with the menu and HUD sliders). Farts and
 * everything else run on separate buses so each has its own slider:
 * farts → fartBus ┐
 * sfx, echo, ambience → fxBus ┴→ compressor → master → speakers
 */
export function createAudio(volume: VolumeStore) {
  let ctx: AudioContext | null = null;
  let noise: AudioBuffer;
  let sfx: GainNode;
  let fartBus: GainNode;
  let fxBus: GainNode;
  let echo: GainNode;
  let master: GainNode;
  let listener = { x: 0, y: 0, heading: 0 };
  let countdownSecond = 0;
  let voices = 0;
  const clips: AudioBuffer[] = [];
  let lastClip = -1;
  const lastPlayed = new Map<string, number>();

  // ── setup ──────────────────────────────────────────────────────────────

  function build(context: AudioContext) {
    noise = noiseBuffer(context, 2);

    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;

    const v = volume.get();
    master = context.createGain();
    master.gain.value = masterLevel(v);
    compressor.connect(master).connect(context.destination);

    fartBus = context.createGain();
    fartBus.gain.value = v.farts;
    fartBus.connect(compressor);
    fxBus = context.createGain();
    fxBus.gain.value = v.effects;
    fxBus.connect(compressor);

    sfx = context.createGain();
    sfx.connect(fxBus);

    // Feedback delay: the spooky tail on chimes.
    const delay = context.createDelay(1);
    delay.delayTime.value = 0.28;
    const feedback = context.createGain();
    feedback.gain.value = 0.42;
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2400;
    echo = context.createGain();
    echo.connect(delay);
    delay.connect(tone).connect(feedback).connect(delay);
    tone.connect(fxBus);

    startAmbience(context, fxBus);
    loadClips(context);
  }

  /** Fetch and decode the fart clips in the background; each one joins the pool once decoded. */
  function loadClips(context: AudioContext) {
    for (let i = 1; i <= FART_CLIPS; i++) {
      const url = `${import.meta.env.BASE_URL}sounds/fart-${String(i).padStart(2, "0")}.mp3`;
      fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`${res.status} ${url}`);
          return res.arrayBuffer();
        })
        .then((data) => context.decodeAudioData(data))
        .then((buffer) => void clips.push(buffer))
        .catch((err: unknown) => console.warn("fart clip not usable, keeping the synth fart", err));
    }
  }

  function startAmbience(context: AudioContext, out: AudioNode) {
    const bus = context.createGain();
    bus.gain.value = 1;
    bus.connect(out);

    const loop = (offset: number) => {
      const src = context.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.start(0, offset);
      return src;
    };
    const lfo = (rate: number, depth: number, target: AudioParam) => {
      const o = context.createOscillator();
      o.frequency.value = rate;
      const amount = context.createGain();
      amount.gain.value = depth;
      o.connect(amount).connect(target);
      o.start();
    };

    // Water flow: band-limited noise with a slow swell, plus a thin hiss on top.
    const waterBand = context.createBiquadFilter();
    waterBand.type = "bandpass";
    waterBand.frequency.value = 520;
    waterBand.Q.value = 0.6;
    const waterGain = context.createGain();
    waterGain.gain.value = 0.05;
    loop(0.3).connect(waterBand).connect(waterGain).connect(bus);
    lfo(0.23, 0.012, waterGain.gain);
    lfo(0.11, 140, waterBand.frequency);

    const hiss = context.createBiquadFilter();
    hiss.type = "highpass";
    hiss.frequency.value = 3000;
    const hissGain = context.createGain();
    hissGain.gain.value = 0.008;
    loop(1.1).connect(hiss).connect(hissGain).connect(bus);
    lfo(0.17, 0.004, hissGain.gain);

    // Wind: narrow band that wanders and breathes.
    const windBand = context.createBiquadFilter();
    windBand.type = "bandpass";
    windBand.frequency.value = 380;
    windBand.Q.value = 4;
    const windGain = context.createGain();
    windGain.gain.value = 0.03;
    loop(0.7).connect(windBand).connect(windGain).connect(bus);
    lfo(0.06, 220, windBand.frequency);
    lfo(0.09, 0.02, windGain.gain);

    // Drone: a low, slightly detuned fifth that slowly pulses.
    const droneFilter = context.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 260;
    const droneGain = context.createGain();
    droneGain.gain.value = 0.035;
    droneFilter.connect(droneGain).connect(bus);
    for (const [type, freq] of [
      ["sine", 55],
      ["triangle", 82.8],
      ["sine", 110.4],
    ] as const) {
      const o = context.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = context.createGain();
      g.gain.value = freq > 100 ? 0.4 : 1;
      o.connect(g).connect(droneFilter);
      o.start();
    }
    lfo(0.07, 0.02, droneGain.gain);
    lfo(0.05, 60, droneFilter.frequency);
  }

  function ensureContext() {
    if (!ctx) {
      try {
        ctx = new AudioContext();
        build(ctx);
      } catch {
        ctx = null;
        return;
      }
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  }

  // Browsers keep the context suspended until a user gesture: create and resume it on the first one.
  // A touch only counts as a user gesture when the finger lifts (pointerup / touchend), which is
  // what iOS Safari and Android Chrome need to resume audio.
  const gestures = ["pointerdown", "pointerup", "keydown", "touchstart", "touchend"] as const;
  const onGesture = () => {
    ensureContext();
    if (ctx?.state === "running") for (const g of gestures) removeEventListener(g, onGesture, true);
  };
  for (const g of gestures) addEventListener(g, onGesture, true);
  if (navigator.userActivation?.hasBeenActive) ensureContext();

  volume.subscribe((v: Volume) => {
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(masterLevel(v), t, VOLUME_GLIDE);
    fartBus.gain.setTargetAtTime(v.farts, t, VOLUME_GLIDE);
    fxBus.gain.setTargetAtTime(v.effects, t, VOLUME_GLIDE);
  });

  // ── voice helpers ──────────────────────────────────────────────────────

  /** Rate limit: `key` may only play once per `gap` seconds, and never beyond MAX_VOICES at once. */
  function allow(key: string, gap: number): boolean {
    if (!ctx || ctx.state !== "running" || voices >= MAX_VOICES) return false;
    const now = ctx.currentTime;
    if (now - (lastPlayed.get(key) ?? -1) < gap) return false;
    lastPlayed.set(key, now);
    return true;
  }

  /** Count a voice until `source` ends. */
  function track(source: AudioScheduledSourceNode) {
    voices++;
    source.addEventListener("ended", () => voices--, { once: true });
  }

  function noiseSource(context: AudioContext, start: number, length: number) {
    const src = context.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.start(start, rand(0, 1.5));
    src.stop(start + length);
    return src;
  }

  function panned(context: AudioContext, pan: number): AudioNode {
    const p = context.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(fartBus);
    return p;
  }

  // ── sounds ─────────────────────────────────────────────────────────────

  function fart(seat: number, pan: number) {
    if (!ctx || !allow(`fart${seat}`, 0.07)) return;
    if (clips.length > 0) clipFart(ctx, seat, pan);
    else synthFart(seat, pan);
  }

  /** A random recorded clip (never the same one twice in a row), pitched per seat with a little jitter. */
  function clipFart(context: AudioContext, seat: number, pan: number) {
    let pick = Math.floor(Math.random() * clips.length);
    if (pick === lastClip && clips.length > 1) pick = (pick + 1) % clips.length;
    lastClip = pick;
    const src = context.createBufferSource();
    src.buffer = clips[pick]!;
    src.playbackRate.value = seatRate(seat) * rand(0.9, 1.1);
    const gain = context.createGain();
    gain.gain.value = FART_GAIN;
    src.connect(gain).connect(panned(context, pan));
    src.start();
    track(src);
  }

  function synthFart(seat: number, pan: number) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const base = 100 * seatRate(seat) * rand(0.93, 1.07);
    const length = rand(0.26, 0.42);
    const out = panned(ctx, pan);

    const body = ctx.createGain();
    body.gain.value = 0.55;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.setValueAtTime(1400, t);
    lowpass.frequency.exponentialRampToValueAtTime(380, t + length);
    lowpass.Q.value = 2;
    // The flutter: amplitude chopped by a fast LFO gives the wet "brrrp".
    const flutter = ctx.createGain();
    flutter.gain.value = 0.55;
    const flutterLfo = osc(ctx, "square", t, length, rand(34, 58));
    const flutterDepth = ctx.createGain();
    flutterDepth.gain.value = 0.45;
    flutterLfo.connect(flutterDepth).connect(flutter.gain);
    body.connect(lowpass).connect(flutter);
    flutter.connect(envelope(ctx, t, 0.9, 0.012, length, out));

    const saw = osc(ctx, "sawtooth", t, length, base * 1.7, base * 0.5);
    const sawGain = ctx.createGain();
    sawGain.gain.value = 0.7;
    saw.connect(sawGain).connect(body);
    const sub = osc(ctx, "sine", t, length, base, base * 0.45);
    sub.connect(body);

    const hiss = noiseSource(ctx, t, length);
    const hissBand = ctx.createBiquadFilter();
    hissBand.type = "bandpass";
    hissBand.frequency.value = base * 5;
    hissBand.Q.value = 1.1;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.8;
    hiss.connect(hissBand).connect(hissGain).connect(body);

    track(saw);
    // A little spit at the start.
    const pop = osc(ctx, "sine", t, 0.05, 260, 90);
    pop.connect(envelope(ctx, t, 0.35, 0.002, 0.05, out));
  }

  function bump(speed: number) {
    if (!ctx || !allow("bump", 0.08)) return;
    const t = ctx.currentTime;
    const level = Math.max(0.2, Math.min(1, speed / 10));
    const thud = osc(ctx, "sine", t, 0.22, 130, 45);
    thud.connect(envelope(ctx, t, 0.9 * level, 0.004, 0.22, sfx));
    const click = noiseSource(ctx, t, 0.08);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700;
    click.connect(lp).connect(envelope(ctx, t, 0.5 * level, 0.002, 0.08, sfx));
    track(thud);
  }

  function hit() {
    if (!ctx || !allow("hit", 0.4)) return;
    const t = ctx.currentTime;
    const thud = osc(ctx, "sine", t, 0.4, 110, 32);
    thud.connect(envelope(ctx, t, 1, 0.003, 0.4, sfx));
    const crunch = noiseSource(ctx, t, 0.25);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2500, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.25);
    crunch.connect(lp).connect(envelope(ctx, t, 0.7, 0.002, 0.25, sfx));
    // The squeal: a falling, wobbling saw.
    const squeal = osc(ctx, "sawtooth", t + 0.03, 0.55, 1250, 380);
    const wobble = osc(ctx, "sine", t, 0.6, 14);
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 60;
    wobble.connect(wobbleDepth).connect(squeal.frequency);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1400;
    band.Q.value = 0.8;
    squeal.connect(band).connect(envelope(ctx, t + 0.03, 0.4, 0.01, 0.55, sfx));
    track(thud);
  }

  /** Back at the gate: a quick rising "bloop", like popping up out of the water. */
  function respawn() {
    if (!ctx || !allow("respawn", 0.3)) return;
    const t = ctx.currentTime;
    const o = osc(ctx, "sine", t, 0.22, midi(55), midi(79));
    o.connect(envelope(ctx, t, 0.35, 0.01, 0.22, sfx));
    track(o);
  }

  /** Spooky chime: a bell (inharmonic partials) with an echo tail. */
  function bell(freq: number, when: number, level: number) {
    if (!ctx) return;
    const start = ctx.currentTime + when;
    const out = ctx.createGain();
    out.connect(sfx);
    out.connect(echo);
    for (const [ratio, gain, decay] of [
      [1, 1, 1.8],
      [2.76, 0.4, 1.1],
      [5.4, 0.18, 0.6],
    ] as const) {
      const o = osc(ctx, "sine", start, decay, freq * ratio);
      o.connect(envelope(ctx, start, level * gain, 0.004, decay, out));
    }
  }

  function checkpoint() {
    if (!allow("checkpoint", 0.3)) return;
    bell(midi(76), 0, 0.28); // E5
    bell(midi(70), 0.18, 0.24); // Bb5 down a tritone: eerie
    bell(midi(79), 0.4, 0.22);
  }

  function finished() {
    if (!ctx || !allow("finished", 1)) return;
    const t = ctx.currentTime;
    const line: readonly [number, number, number][] = [
      [60, 0, 0.14],
      [64, 0.14, 0.14],
      [67, 0.28, 0.14],
      [72, 0.42, 0.4],
      [67, 0.86, 0.14],
      [72, 1.0, 0.9],
    ];
    for (const [note, offset, length] of line) {
      const start = t + offset;
      for (const [type, detune, level] of [
        ["square", 0, 0.12],
        ["sawtooth", 4, 0.1],
      ] as const) {
        const o = osc(ctx, type, start, length + 0.1, midi(note) * 2 ** (detune / 1200));
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 3200;
        o.connect(lp).connect(envelope(ctx, start, level, 0.01, length + 0.1, sfx));
      }
    }
    // Final chord.
    for (const note of [60, 64, 67, 72]) {
      const start = t + 1.0;
      const o = osc(ctx, "triangle", start, 1.3, midi(note));
      o.connect(envelope(ctx, start, 0.12, 0.02, 1.3, sfx));
      track(o);
    }
    bell(midi(84), 1.0, 0.15);
  }

  function beep(go: boolean) {
    if (!ctx || !allow(go ? "go" : "beep", 0.2)) return;
    const t = ctx.currentTime;
    const length = go ? 0.5 : 0.16;
    const o = osc(ctx, "square", t, length, go ? 880 : 440);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200;
    o.connect(lp).connect(envelope(ctx, t, go ? 0.3 : 0.22, 0.005, length, sfx));
    if (go) {
      const upper = osc(ctx, "square", t, length, 1320);
      upper.connect(lp);
    }
    track(o);
  }

  // ── public API ─────────────────────────────────────────────────────────

  function panOf(x: number, y: number): number {
    // Right of the camera's forward direction in the sim frame (+y is left).
    const rightX = Math.sin(listener.heading);
    const rightY = -Math.cos(listener.heading);
    const side = ((x - listener.x) * rightX + (y - listener.y) * rightY) / RAFT_RADIUS;
    return side * 0.6;
  }

  return {
    onEvent(e: SimEvent) {
      switch (e.type) {
        case "fart":
          fart(e.seat, panOf(e.x, e.y));
          break;
        case "bump":
          bump(e.speed);
          break;
        case "hit":
          hit();
          break;
        case "respawn":
          respawn();
          break;
        case "checkpoint":
          checkpoint();
          break;
        case "finished":
          finished();
          break;
        case "go":
          beep(true);
          break;
      }
    },
    /** Once per frame: countdown beeps follow the phase, panning follows the raft and camera. */
    update(snapshot: Snapshot, heading: number) {
      const raft: Pose = snapshot.raft;
      listener = { x: raft.x, y: raft.y, heading };
      const phase = snapshot.phase;
      if (phase.kind !== "countdown") {
        countdownSecond = 0;
        return;
      }
      const second = Math.ceil(phase.ticksLeft / TICK_RATE);
      if (second !== countdownSecond) {
        countdownSecond = second;
        beep(false);
      }
    },
    /** M key: same as the mute button. Returns whether the game is now silent. */
    toggleMute(): boolean {
      volume.toggleMute();
      return isSilent(volume.get());
    },
    isMuted: () => isSilent(volume.get()),
    /** Current node gains (debug: `__audio.gains()`), undefined before the context exists. */
    gains: () =>
      ctx
        ? { master: master.gain.value, farts: fartBus.gain.value, effects: fxBus.gain.value }
        : undefined,
    /** Decoded fart clips so far (0 means the synth fart plays). */
    clips: () => clips.length,
    /** "none" until the first user gesture creates the context. */
    state: (): AudioContextState | "none" => ctx?.state ?? "none",
  };
}

export type Audio = ReturnType<typeof createAudio>;
