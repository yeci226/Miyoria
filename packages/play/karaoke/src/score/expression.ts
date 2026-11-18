// The expression bonus (docs/design/karaoke.md §5.2), kept simple and conservative: each
// technique is counted only where the singing is otherwise on the reference, so a noise track or a
// tone generator earns nothing here. Vibrato is found in the singer's own curve; long tones,
// scoops (しゃくり) and falls (フォール) at the reference's held stretches.

import { mean, type Span } from "./curve.js";

export interface Expression {
  /** Seconds sung with a vibrato of 4.5–8 Hz and 15–100 cents. */
  vibrato_s: number;
  /** Held stretches of a second or more sung on pitch for at least nine frames in ten. */
  long_tones: number;
  /** Notes reached by sliding up from a semitone or more below, where the original does not. */
  scoops: number;
  /** Phrase ends that drop a semitone and a half or more, where the original does not. */
  falls: number;
}

export interface ExpressionInput {
  hz: number;
  ref: readonly (number | null)[];
  /** The singer's frames, aligned with `ref`. */
  sung: readonly (number | null)[];
  /** The octave each frame is compared in (semitones added to the reference). */
  octave: readonly number[];
  toleranceCents: number;
  held: readonly { span: Span; midi: number }[];
}

const VIBRATO_MIN_HZ = 4.5;
const VIBRATO_MAX_HZ = 8;
const VIBRATO_MIN_CENTS = 15;
const VIBRATO_MAX_CENTS = 100;
/** How much of the window's movement a sine at the vibrato's rate must explain. */
const VIBRATO_FIT = 0.6;

/** Cents from the reference `midi` (in the frame's octave) to the sung frame, or `null`. */
function centsAt(input: ExpressionInput, i: number, midi: number): number | null {
  const s = input.sung[i];
  if (s === null || s === undefined) return null;
  return (s - midi - (input.octave[i] ?? 0)) * 100;
}

export function expression(input: ExpressionInput): Expression {
  return {
    vibrato_s: vibratoSeconds(input),
    long_tones: longTones(input),
    scoops: scoops(input),
    falls: falls(input),
  };
}

function vibratoSeconds(input: ExpressionInput): number {
  const { hz, sung } = input;
  const window = Math.round(0.5 * hz);
  const step = Math.max(1, Math.round(0.1 * hz));
  const marked = new Uint8Array(sung.length);
  let start = -1;
  for (let i = 0; i <= sung.length; i++) {
    const voiced = i < sung.length && sung[i] !== null && sung[i] !== undefined;
    if (voiced && start < 0) start = i;
    if (voiced || start < 0) continue;
    for (let s = start; s + window <= i; s += step) {
      if (isVibrato(input, s, window)) marked.fill(1, s, s + window);
    }
    start = -1;
  }
  let n = 0;
  for (let i = 0; i < marked.length; i++) if (marked[i] === 1) n++;
  return n / hz;
}

function isVibrato(input: ExpressionInput, s: number, n: number): boolean {
  const { hz, sung, ref } = input;
  // Only where the singing follows the reference within a semitone.
  const off: number[] = [];
  for (let i = s; i < s + n; i++) {
    const r = ref[i];
    if (r === null || r === undefined) continue;
    const c = centsAt(input, i, r);
    if (c !== null) off.push(Math.abs(c));
  }
  if (off.length < 0.8 * n || mean(off) > 100) return false;
  const x: number[] = [];
  for (let i = s; i < s + n; i++) x.push(((sung[i] as number) - (input.octave[i] ?? 0)) * 100);
  const r = detrend(x);
  const extent = (Math.max(...r) - Math.min(...r)) / 2;
  if (extent < VIBRATO_MIN_CENTS || extent > VIBRATO_MAX_CENTS) return false;
  let energy = 0;
  for (const v of r) energy += v * v;
  if (energy === 0) return false;
  let best = 0;
  for (let f = VIBRATO_MIN_HZ; f <= VIBRATO_MAX_HZ + 1e-9; f += 0.25) {
    let a = 0;
    let b = 0;
    for (let k = 0; k < r.length; k++) {
      const w = (2 * Math.PI * f * k) / hz;
      a += (r[k] as number) * Math.sin(w);
      b += (r[k] as number) * Math.cos(w);
    }
    best = Math.max(best, (2 * (a * a + b * b)) / r.length / energy);
  }
  return best >= VIBRATO_FIT;
}

/** `x` less its least-squares line. */
function detrend(x: readonly number[]): number[] {
  const n = x.length;
  const mx = (n - 1) / 2;
  const my = mean(x);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * ((x[i] as number) - my);
    den += (i - mx) * (i - mx);
  }
  const slope = den === 0 ? 0 : num / den;
  return x.map((v, i) => v - my - slope * (i - mx));
}

function longTones(input: ExpressionInput): number {
  let count = 0;
  for (const { span, midi } of input.held) {
    const len = span.end - span.start;
    if (len < input.hz) continue;
    let hits = 0;
    for (let i = span.start; i < span.end; i++) {
      const c = centsAt(input, i, midi);
      if (c !== null && Math.abs(c) <= input.toleranceCents) hits++;
    }
    if (hits >= 0.9 * len) count++;
  }
  return count;
}

function scoops(input: ExpressionInput): number {
  const { hz, ref, toleranceCents } = input;
  const before = Math.round(0.16 * hz);
  let count = 0;
  for (const { span, midi } of input.held) {
    if (span.end - span.start < Math.round(0.3 * hz)) continue;
    const s = span.start;
    // The original itself slides in: not the singer's technique.
    let originalSlides = false;
    for (let i = Math.max(0, s - before); i < s; i++) {
      const r = ref[i];
      if (r !== null && r !== undefined && (midi - r) * 100 > 80) originalSlides = true;
    }
    if (originalSlides) continue;
    let low = -1;
    for (let i = Math.max(0, s - before); i <= s + Math.round(0.08 * hz); i++) {
      const c = centsAt(input, i, midi);
      if (c !== null && c <= -100) {
        low = i;
        break;
      }
    }
    if (low < 0) continue;
    let prev = centsAt(input, low, midi) as number;
    for (let i = low + 1; i <= s + before && i < input.sung.length; i++) {
      const c = centsAt(input, i, midi);
      if (c === null || c < prev - 25) break;
      if (Math.abs(c) <= toleranceCents) {
        if (i - low >= 2) count++;
        break;
      }
      prev = c;
    }
  }
  return count;
}

function falls(input: ExpressionInput): number {
  const { hz, ref, toleranceCents } = input;
  const after = Math.round(0.2 * hz);
  let count = 0;
  for (const { span, midi } of input.held) {
    if (span.end - span.start < Math.round(0.3 * hz)) continue;
    const e = span.end;
    // Only at the end of a phrase or a note before a rest: the original is silent after it.
    let rest = true;
    for (let i = e; i < Math.min(ref.length, e + 3); i++) if (ref[i] !== null) rest = false;
    if (!rest || e + 3 > ref.length) continue;
    let onPitch = 0;
    for (let i = Math.max(span.start, e - 5); i < e - 1; i++) {
      const c = centsAt(input, i, midi);
      if (c !== null && Math.abs(c) <= toleranceCents) onPitch++;
    }
    if (onPitch < 3) continue;
    let prev = centsAt(input, e - 1, midi);
    if (prev === null) continue;
    let steps = 0;
    let lowest = prev;
    for (let i = e; i < Math.min(input.sung.length, e + after); i++) {
      const c = centsAt(input, i, midi);
      if (c === null || c > prev + 25) break;
      steps++;
      lowest = Math.min(lowest, c);
      prev = c;
    }
    if (steps >= 3 && lowest <= -150) count++;
  }
  return count;
}
