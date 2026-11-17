// Deterministic test signals at 16 kHz.

export const RATE = 16_000;

/** Float to 16-bit sample: truncates toward zero and saturates. */
function toI16(x: number): number {
  const t = Math.trunc(x);
  return Math.max(-32768, Math.min(32767, t));
}

function n(ms: number): number {
  return Math.floor((RATE * ms) / 1000);
}

export function silence(ms: number): Int16Array {
  return new Int16Array(n(ms));
}

/** A sine tone with amplitude `amp` (0..1). */
export function tone(ms: number, hz: number, amp: number): Int16Array {
  return Int16Array.from({ length: n(ms) }, (_, i) => {
    const t = i / RATE;
    return toI16(Math.sin(2 * Math.PI * hz * t) * amp * 32767);
  });
}

/** Speech-like signal: a 180 Hz tone with harmonics, amplitude-modulated at 4 Hz. */
export function voice(ms: number, amp: number): Int16Array {
  return Int16Array.from({ length: n(ms) }, (_, i) => {
    const t = i / RATE;
    const w = 2 * Math.PI * 180 * t;
    const carrier = Math.sin(w) * 0.6 + Math.sin(2 * w) * 0.3 + Math.sin(3 * w) * 0.1;
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    return toI16(carrier * envelope * amp * 32767);
  });
}

const MUL = 6_364_136_223_846_793_005n;
const INC = 1_442_695_040_888_963_407n;

/** Uniform white noise with amplitude `amp` (0..1), from a fixed seed. */
export function noise(ms: number, amp: number, seed: number): Int16Array {
  let state = BigInt.asUintN(64, BigInt(seed) * MUL + 1n);
  return Int16Array.from({ length: n(ms) }, () => {
    state = BigInt.asUintN(64, state * MUL + INC);
    const u = (Number(state >> 33n) / 2 ** 31) * 2 - 1;
    return toI16(u * amp * 32767);
  });
}

export function mix(a: Int16Array, b: Int16Array): Int16Array {
  const len = Math.min(a.length, b.length);
  return Int16Array.from({ length: len }, (_, i) =>
    Math.max(-32768, Math.min(32767, (a[i] as number) + (b[i] as number))),
  );
}

export function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Splits into `size`-sample chunks (like the 20 ms network frames). */
export function* chunks(audio: Int16Array, size: number): Generator<Int16Array> {
  for (let at = 0; at < audio.length; at += size) yield audio.subarray(at, at + size);
}
