// A room singer's microphone as Core takes it (docs/design/karaoke.md 「做了什麼第四步」): 16 kHz
// mono, G.711 µ-law, one byte a sample (`KARAOKE_STREAM_RATE`). The stream worklet
// (`stream.worklet.ts`) downsamples the context's rate to 16 kHz here and encodes each sample; no
// DOM in this file, the worklet imports it.

/** G.711's bias and the largest 14-bit magnitude it encodes. */
const BIAS = 0x84;
const CLIP = 32_635;

/** One 16-bit sample (−32768..32767) as a µ-law byte (G.711). */
export function mulawFromPcm16(sample: number): number {
  let s = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** A µ-law byte back to a 16-bit sample (G.711). */
export function pcm16FromMulaw(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -sample : sample;
}

/** A float sample (−1..1) as a µ-law byte. */
export function mulawFromFloat(x: number): number {
  return mulawFromPcm16((Number.isFinite(x) ? x : 0) * 32_767);
}

/** Float samples as µ-law bytes. */
export function encodeMulaw(samples: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = mulawFromFloat(samples[i] as number);
  return out;
}

/** µ-law bytes as float samples (for tests and checks). */
export function decodeMulaw(bytes: ArrayLike<number>): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = pcm16FromMulaw(bytes[i] as number) / 32_768;
  return out;
}

/** What the stream worklet posts about every 100 ms. */
export interface StreamPiece {
  /** The first sample's index in the stream (0 = the first sample after it was told to run). */
  index: number;
  /** That sample's context time, in seconds. */
  t: number;
  /** µ-law, 16 kHz mono. */
  bytes: Uint8Array;
}

// ---- downsampling ----------------------------------------------------------------------------

/** Kernel phases (fractional positions between two input samples) and taps per side. */
const PHASES = 64;
const HALF = 16;

/**
 * From the context's rate (48 or 44.1 kHz) down to `outRate`, as samples arrive: a windowed-sinc
 * low-pass (cut a little under the new Nyquist, so nothing above 8 kHz folds back into the voice)
 * read at each output sample's exact place in the input, from a table of 64 phases. A 48 kHz input
 * is three to one and only ever reads phase 0. `push` gives back the output samples that are
 * complete; output sample `n` sits at input sample `n * inRate / outRate` of what was pushed since
 * the start, so its context time is known exactly.
 */
export class Downsampler {
  readonly inRate: number;
  readonly outRate: number;
  /** Input samples per output sample. */
  readonly step: number;
  readonly #taps: Float32Array[];
  /** Input not yet passed by the kernel, oldest first, and the absolute index of its first sample. */
  #buf: Float32Array = new Float32Array(0);
  #bufStart = 0;
  #received = 0;
  /** The next output sample. */
  #next = 0;

  constructor(inRate: number, outRate: number) {
    if (!(inRate > 0) || !(outRate > 0) || outRate > inRate) throw new Error("downsampling only");
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    // Normalised cut-off (cycles per input sample): 90% of the output's Nyquist.
    const fc = (0.9 * outRate) / 2 / inRate;
    this.#taps = Array.from({ length: PHASES }, (_, p) => {
      const frac = p / PHASES;
      const taps = new Float32Array(2 * HALF);
      let sum = 0;
      for (let k = 0; k < 2 * HALF; k++) {
        // Tap k reads input sample floor(pos) - HALF + 1 + k; its distance from pos:
        const x = k - HALF + 1 - frac;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        // Blackman over the kernel's span.
        const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / HALF) + 0.08 * Math.cos((2 * Math.PI * x) / HALF);
        const v = Math.abs(x) >= HALF ? 0 : sinc * w;
        taps[k] = v;
        sum += v;
      }
      for (let k = 0; k < taps.length; k++) taps[k] = (taps[k] as number) / (sum || 1);
      return taps;
    });
  }

  /** Output samples made so far. */
  get produced(): number {
    return this.#next;
  }

  /** Where output sample `n` sits in the input (input samples since the start). */
  inputPosition(n: number): number {
    return n * this.step;
  }

  /** Takes `input` (the next samples) and gives the output samples that are now complete. */
  push(input: ArrayLike<number>): Float32Array {
    const merged = new Float32Array(this.#buf.length + input.length);
    merged.set(this.#buf, 0);
    for (let i = 0; i < input.length; i++) merged[this.#buf.length + i] = input[i] as number;
    this.#received += input.length;
    const out: number[] = [];
    for (;;) {
      const pos = this.#next * this.step;
      let base = Math.floor(pos);
      let phase = Math.round((pos - base) * PHASES);
      if (phase === PHASES) {
        phase = 0;
        base++;
      }
      // The kernel reaches HALF samples past `base`.
      if (base + HALF >= this.#received) break;
      const taps = this.#taps[phase] as Float32Array;
      const first = base - HALF + 1 - this.#bufStart;
      let acc = 0;
      for (let k = 0; k < taps.length; k++) {
        const at = first + k;
        // Before the first sample: silence.
        if (at >= 0) acc += (taps[k] as number) * (merged[at] as number);
      }
      out.push(acc);
      this.#next++;
    }
    // Keep what the next kernel still needs.
    const keepFrom = Math.max(this.#bufStart, Math.floor(this.#next * this.step) - HALF + 1);
    this.#buf = merged.slice(keepFrom - this.#bufStart);
    this.#bufStart = keepFrom;
    return Float32Array.from(out);
  }
}
