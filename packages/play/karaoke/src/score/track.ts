// A pitch track: one value per frame, a MIDI note number with a fraction or `null` where nothing
// is voiced. Frame `i` of a track at `hz` is the moment `i / hz` seconds into the song. The
// singer's browser detects at 100 Hz; what it sends Core is the compact form below, at 50 Hz, one
// byte per frame (docs/design/karaoke.md §9): 0 = not voiced, otherwise MIDI 24 plus a quarter
// semitone per step, so a four-minute song is about 12 KB.
//
// No DOM and no Node here: the panel and Core both import this folder.

/** Frames per second of the submitted track and of the reference curve. */
export const TRACK_HZ = 50;
/** The MIDI note of byte 1. */
export const TRACK_MIDI_BASE = 24;
/** Steps per semitone. */
export const TRACK_STEPS = 4;
/** The highest MIDI note a byte holds (255). */
export const TRACK_MIDI_TOP = TRACK_MIDI_BASE + 254 / TRACK_STEPS;

export type PitchFrames = readonly (number | null)[];

/** A pitch track: `midi[i]` at `i / hz` seconds from the start of the song. */
export interface PitchTrack {
  hz: number;
  midi: PitchFrames;
}

/** One byte per frame. A value outside what a byte holds (below C1, above D#6) is not voiced. */
export function encodeTrack(midi: PitchFrames): Uint8Array {
  const out = new Uint8Array(midi.length);
  for (let i = 0; i < midi.length; i++) {
    const m = midi[i];
    if (m === null || m === undefined || !Number.isFinite(m)) continue;
    const step = Math.round((m - TRACK_MIDI_BASE) * TRACK_STEPS) + 1;
    if (step < 1 || step > 255) continue;
    out[i] = step;
  }
  return out;
}

export function decodeTrack(bytes: Uint8Array): (number | null)[] {
  const out: (number | null)[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    out[i] = b === 0 ? null : TRACK_MIDI_BASE + (b - 1) / TRACK_STEPS;
  }
  return out;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Map([...ALPHABET].map((ch, i) => [ch, i]));

/** Standard base64 with padding (neither `btoa` nor `Buffer`: the same code on both sides). */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >> 18) & 63];
    out += ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : "=";
  }
  return out;
}

/** The bytes of `text`, or `null` when it is not base64. */
export function fromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "");
  if (clean.length % 4 !== 0) return null;
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const ch = clean[i + j] as string;
      const v = ch === "=" && i + j >= clean.length - pad ? 0 : LOOKUP.get(ch);
      if (v === undefined) return null;
      n = (n << 6) | v;
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/**
 * `track` at `hz`: each output frame takes the mean of the voiced input frames whose moment falls
 * within half a frame of its own (`null` when none is voiced). From 100 Hz to 50 Hz that is the
 * frame before and the frame at the same moment.
 */
export function resampleTrack(track: PitchTrack, hz: number): (number | null)[] {
  if (track.hz === hz) return [...track.midi];
  const n = Math.floor((track.midi.length * hz) / track.hz);
  const out: (number | null)[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const from = Math.ceil(((k - 0.5) / hz) * track.hz - 1e-9);
    const to = Math.ceil(((k + 0.5) / hz) * track.hz - 1e-9);
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, from); j < Math.min(to, track.midi.length); j++) {
      const m = track.midi[j];
      if (m === null || m === undefined) continue;
      sum += m;
      count++;
    }
    out[k] = count === 0 ? null : sum / count;
  }
  return out;
}

/** What `track` becomes once sent: at `TRACK_HZ`, a quarter semitone a step. */
export function asSubmitted(track: PitchTrack): (number | null)[] {
  return decodeTrack(encodeTrack(resampleTrack(track, TRACK_HZ)));
}

/**
 * The singer's detections as they come (`push`, at the song time each was captured, before the
 * latency), on a grid of `hz` frames; a frame not pushed is silent, a frame pushed twice keeps the
 * last. `encode` is what the browser sends: `TRACK_HZ`, one byte a frame, base64.
 */
export class TrackRecorder {
  readonly hz: number;
  readonly #frames: (number | null)[] = [];

  constructor(hz = 100) {
    this.hz = hz;
  }

  push(t: number, midi: number | null): void {
    const i = Math.round(t * this.hz);
    if (i < 0 || !Number.isFinite(i)) return;
    while (this.#frames.length <= i) this.#frames.push(null);
    this.#frames[i] = midi !== null && Number.isFinite(midi) ? midi : null;
  }

  /** Frames from `t` seconds on are dropped (a restart from there, or before a pause). */
  cut(t: number): void {
    this.#frames.length = Math.min(this.#frames.length, Math.max(0, Math.round(t * this.hz)));
  }

  get track(): PitchTrack {
    return { hz: this.hz, midi: [...this.#frames] };
  }

  /** Seconds covered so far. */
  get seconds(): number {
    return this.#frames.length / this.hz;
  }

  encode(): string {
    return toBase64(encodeTrack(resampleTrack(this.track, TRACK_HZ)));
  }
}
