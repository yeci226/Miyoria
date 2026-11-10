// Buffered, pull-based audio source for one playback.
//
// Core pushes mono s16le at `sampleRate`; the Discord side pulls 20 ms frames of 48 kHz
// stereo. Resampling happens lazily at pull time, so the WebSocket handler only does an
// O(chunk) copy and the buffer stays at the (smaller) source size.
import { SampleFifo } from "../audio/fifo.js";
import { bytesToInt16, Resampler } from "../audio/resampler.js";

export const OUT_RATE = 48_000;
export const FRAME_MS = 20;
/** Samples per channel in one 20 ms frame at 48 kHz. */
export const FRAME_SAMPLES = 960;
/** Bytes in one frame of interleaved s16le stereo. */
export const FRAME_BYTES = FRAME_SAMPLES * 2 * 2;

export type SourceEndReason = "drained" | "faded" | "stopped" | "starved" | "overflow";

export type WriteResult = "ok" | "ignored" | "overflow";

export type FrameResult =
  // FRAME_BYTES of s16le stereo @ 48 kHz; `levels` (same layout): what lip sync follows instead
  | { kind: "audio"; pcm: Buffer; levels?: Buffer }
  | { kind: "silence" } // underrun: the player should emit a silence frame
  | { kind: "end"; reason: SourceEndReason };

export interface SourceOptions {
  /** Sample rate of the mono PCM being written. */
  sampleRate: number;
  /** Cap on buffered audio, in bytes of source PCM. Exceeding it ends the source with `overflow`. */
  maxBufferBytes: number;
  /** Audio (ms) that must be buffered before {@link PlaybackSource.canStart} is true. */
  prebufferMs: number;
  /** Consecutive underrun time (ms) after which the source gives up with `starved`. */
  maxStarveMs: number;
  /** A paused source that is not resumed within this time (ms) ends as `stopped`. Default 30 000. */
  maxPauseMs?: number;
}

/** A gain that moves linearly toward a target, one 20 ms frame at a time. */
class Ramp {
  value = 1;
  private target = 1;
  private step = 0;

  /** Moves to `target` over `ms` (immediately when `ms <= 0`). */
  set(target: number, ms: number): void {
    this.target = target;
    const frames = Math.max(0, Math.round(ms / FRAME_MS));
    if (frames === 0) this.value = target;
    this.step = frames === 0 ? 0 : Math.abs(target - this.value) / frames;
  }

  /** The gain at the start and at the end of the next frame. */
  advance(): [number, number] {
    const from = this.value;
    if (this.value < this.target) this.value = Math.min(this.target, this.value + this.step);
    else if (this.value > this.target) this.value = Math.max(this.target, this.value - this.step);
    return [from, this.value];
  }
}

export class PlaybackSource {
  private readonly opts: SourceOptions;
  private readonly resampler: Resampler;
  private readonly pending: Int16Array[] = [];
  private pendingSamples = 0;
  private readonly fifo = new SampleFifo(); // mono @ 48 kHz, resampled but not yet framed
  private oddByte: number | undefined;

  private inputEnded = false;
  private flushed = false;
  private starvedFrames = 0;
  private fadeTotal = 0;
  private fadeIdx = 0;
  private pendingEnd: SourceEndReason | undefined;
  private finished: SourceEndReason | undefined;

  private levels: LevelsTrack | undefined;

  /** Ducking: the volume the play was set to (Core's `play_duck`). */
  private readonly duck = new Ramp();
  /** Pausing: fades to 0 and then holds until resumed (Core's `play_pause` / `play_resume`). */
  private readonly hold = new Ramp();
  private paused = false;
  private pausedFrames = 0;

  constructor(opts: SourceOptions) {
    this.opts = opts;
    this.resampler = new Resampler(opts.sampleRate, OUT_RATE);
  }

  /**
   * This play has a levels track (e.g. a song's vocal stem): frames carry it as `levels` and
   * lip sync follows it instead of the audio. Missing levels count as silence.
   */
  enableLevels(): void {
    this.levels ??= new LevelsTrack(this.opts.sampleRate, this.opts.maxBufferBytes);
  }

  /** Appends mono s16le to the levels track (dropped when there is none or it is full). */
  writeLevels(bytes: Uint8Array): void {
    if (this.inputEnded || this.pendingEnd !== undefined || this.finished) return;
    this.levels?.write(bytes);
  }

  /** Why the source ended, once {@link readFrame} has returned `end`. */
  get endReason(): SourceEndReason | undefined {
    return this.finished;
  }

  get inputDone(): boolean {
    return this.inputEnded;
  }

  /** Buffered, not yet played audio in milliseconds. */
  get bufferedMs(): number {
    return (this.pendingSamples / this.opts.sampleRate + this.fifo.length / OUT_RATE) * 1000;
  }

  /** Approximate memory held, in bytes of source-rate PCM. */
  private get bufferedBytes(): number {
    return this.pendingSamples * 2 + Math.ceil((this.fifo.length * this.opts.sampleRate) / OUT_RATE) * 2;
  }

  canStart(): boolean {
    return this.inputEnded || this.pendingEnd !== undefined || this.bufferedMs >= this.opts.prebufferMs;
  }

  /**
   * Appends mono s16le PCM at the source rate.
   *  - `ok`: buffered.
   *  - `ignored`: the source already ended / is stopping, the data is dropped.
   *  - `overflow`: the buffer limit was exceeded; buffered audio is discarded and the source
   *    will end with `overflow`.
   */
  write(bytes: Uint8Array): WriteResult {
    if (this.inputEnded || this.pendingEnd !== undefined || this.finished) return "ignored";
    let data = bytes;
    if (this.oddByte !== undefined) {
      const joined = new Uint8Array(bytes.byteLength + 1);
      joined[0] = this.oddByte;
      joined.set(bytes, 1);
      data = joined;
      this.oddByte = undefined;
    }
    if (data.byteLength & 1) {
      this.oddByte = data[data.byteLength - 1];
      data = data.subarray(0, data.byteLength - 1);
    }
    if (data.byteLength === 0) return "ok";
    if (this.bufferedBytes + data.byteLength > this.opts.maxBufferBytes) {
      this.pending.length = 0;
      this.pendingSamples = 0;
      this.fifo.clear();
      this.pendingEnd = "overflow";
      return "overflow";
    }
    const samples = bytesToInt16(data);
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    return "ok";
  }

  /** No more input: play what is buffered, then end with `drained`. */
  end(): void {
    this.inputEnded = true;
  }

  /** Ramp the volume to zero over `ms`, then end with `faded`. `ms <= 0` aborts immediately. */
  fadeOut(ms: number): void {
    if (this.finished || this.pendingEnd !== undefined) return;
    if (ms <= 0) {
      this.abort();
      return;
    }
    if (this.fadeTotal > 0) return; // already fading
    this.fadeTotal = Math.max(1, Math.round(ms / FRAME_MS));
    this.fadeIdx = 0;
  }

  /** Sets the volume to `gain` (0..1) over `ms`; it stays until changed. */
  setGain(gain: number, ms: number): void {
    if (this.finished) return;
    this.duck.set(Math.min(1, Math.max(0, gain)), ms);
  }

  /** Fades out over `ms`, then holds the audio (buffered, not consumed) until {@link resume}. */
  pause(ms: number): void {
    if (this.finished || this.paused) return;
    this.paused = true;
    this.pausedFrames = 0;
    this.hold.set(0, ms);
  }

  /** Continues a paused source, fading in over `ms`. */
  resume(ms: number): void {
    if (this.finished || !this.paused) return;
    this.paused = false;
    this.pausedFrames = 0;
    this.hold.set(1, ms);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Stop right away (next pull returns `end: stopped`). */
  abort(): void {
    if (this.finished) return;
    this.pending.length = 0;
    this.pendingSamples = 0;
    this.fifo.clear();
    this.pendingEnd = "stopped";
  }

  /** Pulls one 20 ms frame. Never throws; never blocks. */
  readFrame(): FrameResult {
    if (this.finished) return { kind: "end", reason: this.finished };
    if (this.pendingEnd !== undefined) return this.finish(this.pendingEnd);

    // Held: faded out completely, nothing is consumed until Core resumes (or gives up).
    if (this.paused && this.hold.value === 0) {
      this.pausedFrames++;
      if (this.pausedFrames * FRAME_MS > (this.opts.maxPauseMs ?? 30_000)) return this.finish("stopped");
      return { kind: "silence" };
    }

    this.fill(FRAME_SAMPLES);

    let mono: Int16Array | undefined;
    if (this.fifo.length >= FRAME_SAMPLES) {
      mono = this.fifo.take(FRAME_SAMPLES);
    } else if (this.inputEnded && this.pending.length === 0) {
      if (!this.flushed) {
        this.flushed = true;
        this.fifo.push(this.resampler.flush());
      }
      if (this.fifo.length > 0) {
        const rest = this.fifo.take(this.fifo.length);
        mono = new Int16Array(FRAME_SAMPLES); // zero padded last frame
        mono.set(rest);
      } else {
        return this.finish("drained");
      }
    }

    if (!mono) {
      if (this.fadeTotal > 0) return this.finish("faded"); // nothing left to fade
      this.starvedFrames++;
      if (this.starvedFrames * FRAME_MS > this.opts.maxStarveMs) return this.finish("starved");
      return { kind: "silence" };
    }
    this.starvedFrames = 0;

    let g0 = 1;
    let g1 = 1;
    if (this.fadeTotal > 0) {
      g0 = 1 - this.fadeIdx / this.fadeTotal;
      this.fadeIdx++;
      g1 = 1 - this.fadeIdx / this.fadeTotal;
      if (this.fadeIdx >= this.fadeTotal) this.pendingEnd = "faded";
    }

    const [p0, p1] = this.hold.advance();
    const [d0, d1] = this.duck.advance();
    g0 *= p0 * d0;
    g1 *= p1 * d1;

    const pcm = stereoFrame(mono, g0, g1);
    if (!this.levels) return { kind: "audio", pcm };
    return { kind: "audio", pcm, levels: stereoFrame(this.levels.take(FRAME_SAMPLES), g0, g1) };
  }

  private finish(reason: SourceEndReason): FrameResult {
    this.finished = reason;
    this.pending.length = 0;
    this.pendingSamples = 0;
    this.fifo.clear();
    this.levels?.clear();
    return { kind: "end", reason };
  }

  /** Resample pending input until the FIFO holds at least `need` samples (or input runs out). */
  private fill(need: number): void {
    const ratio = this.opts.sampleRate / OUT_RATE;
    while (this.fifo.length < need && this.pending.length > 0) {
      const wantIn = Math.max(16, Math.ceil((need - this.fifo.length) * ratio) + 4);
      const head = this.pending[0] as Int16Array;
      let chunk: Int16Array;
      if (head.length <= wantIn) {
        chunk = head;
        this.pending.shift();
      } else {
        chunk = head.subarray(0, wantIn);
        this.pending[0] = head.subarray(wantIn);
      }
      this.pendingSamples -= chunk.length;
      this.fifo.push(this.resampler.process(chunk));
    }
  }
}

/** One 20 ms frame of interleaved stereo from mono, with a linear gain ramp `g0` → `g1`. */
function stereoFrame(mono: Int16Array, g0: number, g1: number): Buffer {
  const out = Buffer.allocUnsafe(FRAME_BYTES);
  const step = (g1 - g0) / FRAME_SAMPLES;
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const g = g0 + step * i;
    let s = Math.round((mono[i] ?? 0) * g);
    s = s > 32767 ? 32767 : Math.max(s, -32768);
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}

/**
 * The levels track of a play: mono at the play's rate, resampled to 48 kHz and taken frame by
 * frame alongside the audio. Core sends each levels frame right before its audio frame, so the
 * two stay aligned; what is missing reads as silence, what overflows is dropped.
 */
class LevelsTrack {
  private readonly resampler: Resampler;
  private readonly fifo = new SampleFifo();
  private oddByte: number | undefined;

  constructor(
    sampleRate: number,
    private readonly maxBytes: number,
  ) {
    this.resampler = new Resampler(sampleRate, OUT_RATE);
  }

  write(bytes: Uint8Array): void {
    let data = bytes;
    if (this.oddByte !== undefined) {
      const joined = new Uint8Array(bytes.byteLength + 1);
      joined[0] = this.oddByte;
      joined.set(bytes, 1);
      data = joined;
      this.oddByte = undefined;
    }
    if (data.byteLength & 1) {
      this.oddByte = data[data.byteLength - 1];
      data = data.subarray(0, data.byteLength - 1);
    }
    if (data.byteLength === 0 || this.fifo.length * 2 + data.byteLength > this.maxBytes) return;
    this.fifo.push(this.resampler.process(bytesToInt16(data)));
  }

  /** `n` samples, zero padded. */
  take(n: number): Int16Array {
    const got = this.fifo.take(n);
    if (got.length === n) return got;
    const out = new Int16Array(n);
    out.set(got);
    return out;
  }

  clear(): void {
    this.fifo.clear();
  }
}
