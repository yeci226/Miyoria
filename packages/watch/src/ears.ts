import type { StreamHearing } from "@miyoria/voice/voice";
import { DEFAULT_ENERGY_VAD, DEFAULT_SEGMENTER, EnergyVad, Segmenter } from "@miyoria/voice/voice";

/** Loudness the stream audio is brought to. */
export const TARGET_RMS = 3000;
/** Most the audio is amplified. */
export const MAX_GAIN = 32;
/** Below this smoothed loudness the audio is left as it is (it is only noise). */
export const SILENCE_RMS = 10;

const SMOOTHING = 0.05;

/**
 * Brings quiet stream audio up to a level the ASR copes with. `state.rms` is a smoothed loudness
 * carried from frame to frame. Samples are clipped, never wrapped; `frame` is not changed.
 */
export function boost(frame: Int16Array, state: { rms: number }): Int16Array {
  let sum = 0;
  for (const s of frame) sum += s * s;
  const rms = frame.length === 0 ? 0 : Math.sqrt(sum / frame.length);
  state.rms += (rms - state.rms) * SMOOTHING;
  const gain =
    state.rms < SILENCE_RMS ? 1 : Math.min(MAX_GAIN, TARGET_RMS / Math.max(state.rms, 1e-9));
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    // Int16Array would wrap on its own, so clamp first.
    out[i] = Math.max(-32768, Math.min(32767, Math.round((frame[i] as number) * gain)));
  }
  return out;
}

/**
 * Reads stream audio (16 kHz mono), splits it into utterances and hands each to `transcribe`
 * without waiting for the one before it, so a slow ASR never holds up reading (`Hearing` drops
 * what it has no room for). A failing `transcribe` is ignored. Returns when the audio ends or
 * `signal` aborts.
 */
export async function listenTo(
  audio: AsyncIterable<Int16Array>,
  hearing: Pick<StreamHearing, "transcribe">,
  onLine: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const vad = new EnergyVad({ ...DEFAULT_ENERGY_VAD, sampleRate: 16_000 });
  const segmenter = new Segmenter(vad, { ...DEFAULT_SEGMENTER, sampleRate: 16_000 });
  const level = { rms: 0 };
  const pending = new Set<Promise<void>>();

  const hand = (samples: Int16Array): void => {
    const p = (async () => {
      try {
        const text = await hearing.transcribe(samples, signal);
        if (text !== null && text.trim() !== "" && !signal.aborted) onLine(text);
      } catch {
        // One bad segment must not stop the listening.
      }
    })();
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  const aborted = new Promise<"aborted">((resolve) => {
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  const it = audio[Symbol.asyncIterator]();
  try {
    while (!signal.aborted) {
      const read = it.next();
      read.catch(() => {}); // when the abort wins, a later failure of this read is not ours
      const next = await Promise.race([read, aborted]);
      if (next === "aborted" || next.done) break;
      for (const u of segmenter.push(boost(next.value, level))) hand(u.samples);
    }
    if (!signal.aborted) {
      const last = segmenter.finish();
      if (last) hand(last.samples);
      await Promise.race([Promise.allSettled([...pending]), aborted]);
    }
  } finally {
    // The iterator may be stuck in a read; closing it is best effort.
    void Promise.resolve(it.return?.()).catch(() => {});
  }
}
