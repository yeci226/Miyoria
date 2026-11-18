// The karaoke scene's sound, the arithmetic of it (docs/design/karaoke.md 「做了什麼第五步」): the
// scene plays the round's backing and the relayed singer's voice into the stream itself. Pure (no
// Web Audio here; src/karaoke-player.ts plays): G.711 µ-law, the backing's raw PCM, and where on
// the audio clock a piece of sound goes.
//
// One clock for everything: song time `s` (seconds) plays at audio-context time `base + s`. The
// base is set from the song clock when the round's sound starts, and set again (the backing
// restarted at the right place) only when the two drift more than `REANCHOR_MS` apart.

/** Sample rate of the relayed voice (`KARAOKE_VOICE_RATE`). */
export const VOICE_RATE = 16_000;
/** The song clock and the audio clock this far apart (ms): the audio starts over at the right place. */
export const REANCHOR_MS = 150;
/** A voice piece further ahead than this (s) is dropped: something is wrong with its time. */
export const VOICE_AHEAD_S = 3;
/** Sound that should already be playing starts this much after now (s), from the right offset. */
export const START_LEAD_S = 0.05;
/** How fast the sound dips under her speech, and comes back after it (s). */
export const DUCK_ATTACK_S = 0.2;
export const DUCK_RELEASE_S = 0.4;

/** One µ-law byte as a sample in -1..1 (ITU-T G.711, the standard expansion). */
function mulawSample(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const magnitude = ((((u & 0x0f) << 3) + 0x84) << exponent) - 0x84;
  return ((u & 0x80) !== 0 ? -magnitude : magnitude) / 32_768;
}

/** Every µ-law byte's sample. */
export const MULAW_TABLE: Float32Array = Float32Array.from({ length: 256 }, (_, i) => mulawSample(i));

/** µ-law bytes as samples. */
export function decodeMulaw(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = MULAW_TABLE[bytes[i] as number] as number;
  return out;
}

/** A sample in -1..1 as a µ-law byte (G.711; the demo makes its voice with it). */
export function encodeMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32_635;
  let x = Math.round(Math.max(-1, Math.min(1, sample)) * 32_767);
  const sign = x < 0 ? 0x80 : 0;
  if (x < 0) x = -x;
  x = Math.min(x, CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (x & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (x >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Base64 as bytes. */
export function base64Bytes(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Bytes as base64. */
export function bytesBase64(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(raw);
}

/** Raw s16le mono (the backing's `pcm`) as samples; a trailing odd byte is dropped. */
export function pcm16le(data: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(data);
  const n = data.byteLength >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32_768;
  return out;
}

/** The base for song time `songMs` sounding at audio time `audioTime`. */
export function anchorBase(audioTime: number, songMs: number): number {
  return audioTime - songMs / 1000;
}

/** The song time (ms) the audio clock is at. */
export function audioSongMs(audioTime: number, base: number): number {
  return (audioTime - base) * 1000;
}

/** Whether the audio has to start over: it is more than `REANCHOR_MS` off the song clock. */
export function needsReanchor(audioMs: number, clockMs: number): boolean {
  return Math.abs(audioMs - clockMs) > REANCHOR_MS;
}

/**
 * Where a sound whose first sample belongs at song time `startS` goes on the audio clock: at its
 * place when that is still ahead (pieces that follow each other then abut to the sample), else
 * from `START_LEAD_S` after now with what is left of it; `null` when nothing of it is left, or it
 * is more than `maxAheadS` ahead.
 */
export function placeSound(input: {
  base: number;
  startS: number;
  duration: number;
  now: number;
  maxAheadS?: number;
}): { when: number; offset: number } | null {
  const at = input.base + input.startS;
  if (at - input.now > (input.maxAheadS ?? Number.POSITIVE_INFINITY)) return null;
  if (at >= input.now) return { when: at, offset: 0 };
  const when = input.now + START_LEAD_S;
  const offset = when - at;
  return offset < input.duration ? { when, offset } : null;
}

/** A gain while she speaks (`duck` of it) or not. */
export function duckedGain(gain: number, duck: number, speaking: boolean): number {
  return speaking ? gain * duck : gain;
}
