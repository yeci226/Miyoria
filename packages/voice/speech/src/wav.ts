// Minimal WAV (RIFF) codec and a linear resampler for mono 16-bit audio.

import { type AudioBuf, SpeechError } from "./types.js";

const HEADER_LEN = 44;
const U32_MAX = 0xffff_ffff;

function ascii(view: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (view[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Encodes as a canonical 44-byte-header PCM WAV (mono, 16-bit). */
export function encodeWav(audio: AudioBuf): Uint8Array {
  const dataLen = audio.samples.length * 2;
  const rate = audio.sampleRate;
  const out = new Uint8Array(HEADER_LEN + dataLen);
  const v = new DataView(out.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  tag(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, (rate * 2) >>> 0, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, dataLen, true);
  for (let i = 0; i < audio.samples.length; i++) {
    v.setInt16(HEADER_LEN + i * 2, audio.samples[i] as number, true);
  }
  return out;
}

/**
 * Decodes 16-bit PCM WAV, averaging multiple channels down to mono.
 *
 * Unknown chunks are skipped. A `data` chunk whose declared size overruns the buffer (streamed
 * WAVs use 0 or `0xFFFFFFFF`) is clamped to the bytes present.
 */
export function decodeWav(bytes: Uint8Array): AudioBuf {
  if (bytes.length < 12 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WAVE")) {
    throw new SpeechError("not a RIFF/WAVE file");
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  let fmt: { tag: number; channels: number; rate: number; bits: number } | null = null;
  while (pos + 8 <= bytes.length) {
    const size = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (ascii(bytes, pos, "fmt ")) {
      if (body + 16 > bytes.length) throw new SpeechError("truncated fmt chunk");
      fmt = {
        tag: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        rate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (ascii(bytes, pos, "data")) {
      if (!fmt) throw new SpeechError("`data` chunk before `fmt `");
      const { tag, channels, rate, bits } = fmt;
      // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (assumed PCM).
      if ((tag !== 1 && tag !== 0xfffe) || bits !== 16) {
        throw new SpeechError(`unsupported WAV format (tag ${tag}, ${bits} bits); need 16-bit PCM`);
      }
      if (channels === 0) throw new SpeechError("WAV has zero channels");
      const end =
        size === 0 || size === U32_MAX ? bytes.length : Math.min(body + size, bytes.length);
      const frameBytes = channels * 2;
      const frames = Math.floor((end - body) / frameBytes);
      const samples = new Int16Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += v.getInt16(body + f * frameBytes + c * 2, true);
        samples[f] = Math.trunc(sum / channels);
      }
      return { sampleRate: rate, samples };
    }
    pos = body + size + (size & 1); // chunks are word-aligned
  }
  throw new SpeechError("WAV has no `data` chunk");
}

/** Rounds halves away from zero. */
function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Resamples by linear interpolation.
 *
 * Output length is `round(len * target / source)` and output `i` samples the input at
 * `i * source / target`, so the first sample is preserved and the tail holds the last input
 * sample. There is no low-pass filter: downsampling by a large ratio aliases. That is fine for
 * speech (e.g. 24 kHz to 16 kHz); resample whole buffers, not chunk by chunk, to avoid seams.
 */
export function resample(audio: AudioBuf, targetRate: number): AudioBuf {
  if (audio.sampleRate === targetRate || audio.sampleRate === 0 || audio.samples.length === 0) {
    return {
      sampleRate: audio.sampleRate === 0 ? 0 : targetRate,
      samples: audio.samples.slice(),
    };
  }
  const src = audio.samples;
  const ratio = audio.sampleRate / targetRate;
  const outLen = Math.round(src.length / ratio);
  const last = src.length - 1;
  const samples = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    if (idx >= last) {
      samples[i] = src[last] as number;
      continue;
    }
    const frac = pos - idx;
    const a = src[idx] as number;
    const b = src[idx + 1] as number;
    samples[i] = roundHalfAway(a + (b - a) * frac);
  }
  return { sampleRate: targetRate, samples };
}
