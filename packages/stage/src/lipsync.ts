// Lip sync: playback levels from the voice node → mouth opening, jaw and vowel shapes.
//
// The voice node streams `{"t": <ms>, "rms": 0..1, "bands": [..]}` to
// `ws://127.0.0.1:7883/levels` while she speaks, paced to the moment each 10 ms window is handed
// to the player. `Levels` places every frame on the Stage clock by its own `t` (arrival only
// anchors a playback), delays it by `latency_ms` (viewers hear the audio later than the player
// takes it) and hands the injection loop everything that became due since the last tick.
//
// `Envelope` turns a level into an opening: dB scale, a slow automatic gain (so quiet lines still
// open the mouth), then attack / release smoothing. `VowelClassifier` turns the band shape into
// A / I / U / E / O weights, which become VTS `VoiceA..VoiceO` / `VoiceSilence` (the model maps
// them to `ParamA..ParamO` / `ParamSilence`).

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { type Clock, systemClock } from "@miyoria/types";
import { z } from "zod";
import { type BoundAddress, formatAddress, HttpServer } from "./net.js";
import { type LevelFrame, parseLevelFrame } from "./protocol.js";
import { approach, clamp } from "./random.js";

const log = getLogger("stage.lipsync");

export const VOWELS = ["a", "i", "u", "e", "o"] as const;
export type Vowel = (typeof VOWELS)[number];

/**
 * Band shapes (dB around their mean) of each vowel, for the voice node's default bands
 * (300 / 550 / 850 / 1300 / 2000 / 3000 Hz after pre-emphasis), from formant-synthesised
 * Japanese female vowels at 180–300 Hz pitch.
 */
export const DEFAULT_VOWEL_TEMPLATES: Readonly<Record<Vowel, readonly number[]>> = {
  a: [-7.8, 2, 9.8, 7.7, -1.2, -10.4],
  i: [11.9, 3.5, -4.3, -9, -4, 1.8],
  u: [8.7, 4.5, -1.8, 0.9, -1.7, -10.7],
  e: [-1, 6.7, 0.2, -5.9, 0.5, -0.4],
  o: [4.4, 11.4, 9.2, 1.3, -9.1, -17.2],
};

const TemplatesSchema = z
  .object({
    a: z.array(z.number()),
    i: z.array(z.number()),
    u: z.array(z.number()),
    e: z.array(z.number()),
    o: z.array(z.number()),
  })
  .partial();

/** `[lipsync]` section of the Stage config. */
export const LipSyncConfigSchema = z.object({
  /** Levels endpoint address. */
  bind: z.string().default("127.0.0.1:7883"),
  /**
   * Delay applied to incoming levels: how much later viewers hear a window than the voice node
   * hands it to the player (Discord / stream buffering).
   */
  latency_ms: z.number().int().nonnegative().default(180),
  /** Without new levels for this long the mouth closes. */
  stale_ms: z.number().int().nonnegative().default(150),
  /** Arrivals this much later than the playback's timeline re-anchor it (the player stalled). */
  resync_ms: z.number().nonnegative().default(60),
  /** How the windows that became due in one tick are combined. */
  aggregate: z.enum(["rms", "max"]).default("rms"),
  /** Levels below this (dBFS) are silence. */
  gate_db: z.number().default(-50),
  /** Dynamic range (dB) under the gain reference that maps to opening 0..1. */
  range_db: z.number().positive().default(26),
  /** Exponent on the 0..1 opening (< 1 opens wider for mid levels). */
  curve: z.number().positive().default(0.85),
  /** How fast the gain reference falls towards quieter speech (ms). */
  agc_ms: z.number().nonnegative().default(2_000),
  /** How fast it rises towards louder speech (ms). */
  agc_attack_ms: z.number().nonnegative().default(150),
  /** Starting gain reference (dBFS): roughly the level of a loud syllable. */
  agc_init_db: z.number().default(-16),
  /** Limits of the gain reference. */
  agc_min_db: z.number().default(-38),
  agc_max_db: z.number().default(-4),
  /** Opening time constant (ms). */
  attack_ms: z.number().nonnegative().default(22),
  /** Closing time constant (ms). */
  release_ms: z.number().nonnegative().default(80),
  /** Largest opening (0..1). */
  max_open: z.number().default(1.0),
  /** `JawOpen` per unit of mouth opening. */
  jaw_gain: z.number().default(0.8),
  /** Vowel weights follow the bands with this time constant (ms). */
  vowel_smooth_ms: z.number().nonnegative().default(45),
  /** How decisively the closest vowel wins (per dB² of distance). */
  vowel_sharpness: z.number().positive().default(0.02),
  /** Scale of `VoiceA..VoiceO`. */
  vowel_gain: z.number().default(1.0),
  /** Band shapes per vowel (dB around their mean); missing vowels keep the defaults. */
  vowel_templates: TemplatesSchema.default({}),
});
export type LipSyncConfig = z.output<typeof LipSyncConfigSchema>;

export function defaultLipSyncConfig(): LipSyncConfig {
  return LipSyncConfigSchema.parse({});
}

const toDb = (rms: number): number => 20 * Math.log10(Math.max(rms, 1e-6));

/**
 * Level → mouth opening: dB, an automatic gain reference that follows her loudness over a couple
 * of seconds (fast up, slow down), then attack / release smoothing.
 */
export class Envelope {
  readonly #c: LipSyncConfig;
  readonly #max: number;
  #ref: number;
  #value = 0;

  constructor(config: LipSyncConfig) {
    this.#c = config;
    this.#max = clamp(config.max_open, 0, 1);
    this.#ref = clamp(config.agc_init_db, config.agc_min_db, config.agc_max_db);
  }

  /** The gain reference (dBFS). */
  reference(): number {
    return this.#ref;
  }

  /** Opening for one level at the current reference, before smoothing. */
  target(rms: number): number {
    if (!Number.isFinite(rms) || rms <= 0) return 0;
    const db = toDb(rms);
    if (db < this.#c.gate_db) return 0;
    const range = Math.max(this.#c.range_db, 1);
    const x = clamp((db - (this.#ref - range)) / range, 0, 1);
    return x ** this.#c.curve * this.#max;
  }

  /** Advances by `dtMs` towards the opening for `rms` (`null`: no audio). */
  update(rms: number | null, dtMs: number): number {
    const level = rms !== null && Number.isFinite(rms) ? rms : 0;
    const db = toDb(level);
    // Only speech moves the reference: pauses keep her level for the next line.
    if (level > 0 && db >= this.#c.gate_db) {
      const tau = db > this.#ref ? this.#c.agc_attack_ms : this.#c.agc_ms;
      this.#ref = clamp(approach(this.#ref, db, dtMs, tau), this.#c.agc_min_db, this.#c.agc_max_db);
    }
    const target = this.target(level);
    const tau = target > this.#value ? this.#c.attack_ms : this.#c.release_ms;
    this.#value = approach(this.#value, target, dtMs, tau);
    if (this.#value < 1e-3) this.#value = 0;
    return this.#value;
  }

  value(): number {
    return this.#value;
  }

  /** Closes the mouth (the gain reference is kept). */
  reset(): void {
    this.#value = 0;
  }
}

/** Vowel weights, summing to 1. */
export type VowelWeights = Record<Vowel, number>;

const evenWeights = (): VowelWeights => ({ a: 0.2, i: 0.2, u: 0.2, e: 0.2, o: 0.2 });

/** Nearest-template classifier over the band shape (gain-independent). */
export class VowelClassifier {
  readonly #templates: [Vowel, readonly number[]][];
  readonly #sharpness: number;

  constructor(config: LipSyncConfig) {
    this.#templates = VOWELS.map((v) => [
      v,
      config.vowel_templates[v] ?? DEFAULT_VOWEL_TEMPLATES[v],
    ]);
    this.#sharpness = config.vowel_sharpness;
  }

  /** Soft weights for one band vector (`null` when it cannot be classified). */
  classify(bands: readonly number[]): VowelWeights | null {
    if (bands.length === 0 || !bands.every((b) => Number.isFinite(b) && b >= 0)) return null;
    const db = bands.map((b) => 10 * Math.log10(b * b + 1e-12));
    const mean = db.reduce((s, x) => s + x, 0) / db.length;
    const shape = db.map((x) => x - mean);
    const dist: [Vowel, number][] = [];
    for (const [v, t] of this.#templates) {
      if (t.length !== shape.length) return null;
      let d = 0;
      for (let k = 0; k < shape.length; k++) d += ((shape[k] as number) - (t[k] as number)) ** 2;
      dist.push([v, d]);
    }
    const best = Math.min(...dist.map(([, d]) => d));
    const w = evenWeights();
    let sum = 0;
    for (const [v, d] of dist) {
      w[v] = Math.exp(-this.#sharpness * (d - best));
      sum += w[v];
    }
    for (const v of VOWELS) w[v] /= sum;
    return w;
  }
}

/** The vowel with the largest weight. */
export function dominantVowel(w: VowelWeights): Vowel {
  let best: Vowel = "a";
  for (const v of VOWELS) if (w[v] > w[best]) best = v;
  return best;
}

/** Mouth parameters for one frame. */
export interface Mouth {
  /** `MouthOpen`, 0..1. */
  open: number;
  /** `JawOpen`, 0..1. */
  jaw: number;
  /**
   * `VoiceA..VoiceO` (weights × opening × `vowel_gain`), or `null` without band data (an older
   * voice node): then the vowel inputs are not driven.
   */
  vowels: VowelWeights | null;
  /** `VoiceSilence`, 0..1. */
  silence: number;
  /** Smoothed vowel weights (sum 1), for mouth-shape offsets. */
  weights: VowelWeights;
}

/** `Envelope` for the opening plus smoothed vowel weights from the bands. */
export class MouthShaper {
  readonly #config: LipSyncConfig;
  readonly #envelope: Envelope;
  readonly #classifier: VowelClassifier;
  #weights: VowelWeights = evenWeights();
  #hasBands = false;

  constructor(config: LipSyncConfig) {
    this.#config = config;
    this.#envelope = new Envelope(config);
    this.#classifier = new VowelClassifier(config);
  }

  envelope(): Envelope {
    return this.#envelope;
  }

  update(sample: LevelSample | null, dtMs: number): Mouth {
    const open = this.#envelope.update(sample?.rms ?? null, dtMs);
    const heard = sample !== null && this.#envelope.target(sample.rms) > 0.05;
    if (sample?.bands && sample.bands.length > 0) {
      this.#hasBands = true;
      const w = heard ? this.#classifier.classify(sample.bands) : null;
      if (w) {
        for (const v of VOWELS) {
          this.#weights[v] = approach(this.#weights[v], w[v], dtMs, this.#config.vowel_smooth_ms);
        }
      }
    }
    return this.#mouth(open);
  }

  #mouth(open: number): Mouth {
    const gain = this.#config.vowel_gain;
    const vowels = this.#hasBands ? evenWeights() : null;
    if (vowels) for (const v of VOWELS) vowels[v] = clamp(this.#weights[v] * open * gain, 0, 1);
    return {
      open,
      jaw: clamp(open * this.#config.jaw_gain, 0, 1),
      vowels,
      silence: clamp(1 - open * 1.5, 0, 1),
      weights: { ...this.#weights },
    };
  }

  reset(): Mouth {
    this.#envelope.reset();
    return this.#mouth(0);
  }
}

/** What became due in one tick. */
export interface LevelSample {
  /** Combined level (`aggregate`). */
  rms: number;
  /** Combined band RMS, or `null` without band data. */
  bands: number[] | null;
}

interface Queued {
  /** Timeline the frame belongs to (`-1`: placed by arrival, `t` is then a clock time). */
  epoch: number;
  t: number;
  rms: number;
  bands: number[] | null;
}

/**
 * Recent level frames, shared between the levels endpoint and the injection loop.
 *
 * A frame is due at `anchor + t + latency_ms`, where `anchor` is the Stage time of its
 * timeline's `t = 0`. A timeline starts with the first frame of a playback (or when `t` goes
 * back), and again when frames arrive more than `resync_ms` later than it says (the player
 * stalled and the voice node re-timed). Within a timeline the anchor moves earlier whenever a
 * frame arrives earlier than expected: the least delayed frame is the best estimate, the others
 * were held up by jitter. Due times are computed when frames are taken, so moving the anchor
 * moves every queued frame of that timeline with it. Frames without `t` are placed by arrival.
 */
export class Levels {
  readonly #delayMs: number;
  readonly #staleMs: number;
  readonly #resyncMs: number;
  readonly #aggregate: "rms" | "max";
  #queue: Queued[] = [];
  #epoch = 0;
  /** Anchor of the current timeline (`null` before the first frame). */
  #anchor: number | null = null;
  /** Anchors of the timelines that still have queued frames. */
  readonly #anchors = new Map<number, number>();
  #lastT = -1;
  /** The last sample handed out and when its newest frame was due. */
  #held: { sample: LevelSample; due: number } | null = null;

  constructor(config: LipSyncConfig) {
    this.#delayMs = config.latency_ms;
    this.#staleMs = Math.max(config.stale_ms, 1);
    this.#resyncMs = Math.max(config.resync_ms, 1);
    this.#aggregate = config.aggregate;
  }

  #newTimeline(anchor: number): void {
    this.#epoch += 1;
    this.#anchor = anchor;
    this.#anchors.set(this.#epoch, anchor);
  }

  /** Records one frame received at `now` (clock ms). */
  push(frame: LevelFrame | number, now: number): void {
    const f: LevelFrame = typeof frame === "number" ? { rms: frame } : frame;
    const rms = Number.isFinite(f.rms) ? clamp(f.rms, 0, 1) : 0;
    const bands =
      f.bands && f.bands.length > 0 && f.bands.every((b) => Number.isFinite(b))
        ? f.bands.map((b) => Math.max(b, 0))
        : null;
    if (f.t === undefined || !Number.isFinite(f.t)) {
      this.#queue.push({ epoch: -1, t: now, rms, bands });
    } else {
      const offset = now - f.t;
      const anchor = this.#anchor;
      if (anchor === null || f.t === 0 || f.t < this.#lastT - 5) this.#newTimeline(offset);
      else if (offset > anchor + this.#resyncMs) this.#newTimeline(offset);
      else if (offset < anchor) {
        this.#anchor = offset;
        this.#anchors.set(this.#epoch, offset);
      }
      this.#lastT = f.t;
      this.#queue.push({ epoch: this.#epoch, t: f.t, rms, bands });
    }
    // About 4 s at 10 ms per frame.
    if (this.#queue.length > 400) this.#queue.splice(0, this.#queue.length - 400);
  }

  #due(q: Queued): number {
    const base = q.epoch < 0 ? 0 : (this.#anchors.get(q.epoch) ?? 0);
    return base + q.t + this.#delayMs;
  }

  /** Forgets everything (playback stopped). */
  clear(): void {
    this.#queue = [];
    this.#held = null;
    this.#anchor = null;
    this.#anchors.clear();
    this.#lastT = -1;
  }

  /**
   * Everything that became due by `now`, combined; the last sample again while it is fresh;
   * `null` once stale.
   */
  take(now: number): LevelSample | null {
    let i = 0;
    let sumSq = 0;
    let max = 0;
    let newest = 0;
    let bandSq: number[] | null = null;
    let bandFrames = 0;
    while (i < this.#queue.length) {
      const q = this.#queue[i] as Queued;
      const due = this.#due(q);
      if (due > now) break;
      sumSq += q.rms * q.rms;
      max = Math.max(max, q.rms);
      newest = Math.max(newest, due);
      if (q.bands) {
        if (!bandSq || bandSq.length !== q.bands.length) {
          bandSq = q.bands.map(() => 0);
          bandFrames = 0;
        }
        for (let k = 0; k < q.bands.length; k++) {
          bandSq[k] = (bandSq[k] as number) + (q.bands[k] as number) ** 2;
        }
        bandFrames += 1;
      }
      i++;
    }
    if (i > 0) {
      this.#queue.splice(0, i);
      // Timelines without queued frames are done (the current one stays).
      for (const epoch of this.#anchors.keys()) {
        if (epoch !== this.#epoch && !this.#queue.some((q) => q.epoch === epoch)) {
          this.#anchors.delete(epoch);
        }
      }
      const rms = this.#aggregate === "max" ? max : Math.sqrt(sumSq / i);
      const bands = bandSq ? bandSq.map((s) => Math.sqrt(s / bandFrames)) : null;
      this.#held = { sample: { rms, bands }, due: newest };
      return this.#held.sample;
    }
    const held = this.#held;
    if (held && now - held.due <= this.#staleMs) return held.sample;
    return null;
  }

  /** The level to show at `now` (`take(now)?.rms ?? 0`). */
  current(now: number): number {
    return this.take(now)?.rms ?? 0;
  }
}

export interface ServeResult {
  addr: BoundAddress;
  /** Settles once the server stopped (after `signal` aborted). */
  done: Promise<void>;
}

/** Serves `GET /levels` (WebSocket) on `bind` until `signal` aborts. */
export async function serveLevels(
  bind: string,
  levels: Levels,
  signal: AbortSignal,
  clock: Clock = systemClock,
): Promise<ServeResult> {
  const server = await HttpServer.listen(bind, "the lip-sync levels endpoint", {
    ws: [
      {
        path: "/levels",
        maxPayload: 1 << 16,
        onConnection(ws) {
          log.debug("levels client connected");
          ws.on("message", (data, isBinary) => {
            if (isBinary) return;
            try {
              levels.push(parseLevelFrame(JSON.parse(data.toString())), clock.now());
            } catch (error) {
              log.debug({ err: errorMessage(error) }, "invalid level frame");
            }
          });
          ws.on("close", () => log.debug("levels client disconnected"));
          ws.on("error", () => {});
        },
      },
    ],
  });
  log.info({ addr: formatAddress(server.address) }, "lip-sync levels endpoint listening");
  return { addr: server.address, done: closeOnAbort(server, signal) };
}

/** Closes `server` once `signal` aborts. */
export function closeOnAbort(server: HttpServer, signal: AbortSignal, graceMs = 0): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = () => {
      void server.close(graceMs).then(resolve);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}
