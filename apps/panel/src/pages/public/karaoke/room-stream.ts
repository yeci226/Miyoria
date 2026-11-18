// What a room singer's browser sends Core while the song plays (docs/design/karaoke.md
// 「做了什麼第四步」): the microphone as µ-law chunks (`ChunkScheduler`, from the stream worklet's
// pieces), and its own detected pitch once a second (`PitchFeed`) for the spectators' lanes and the
// estimate. No DOM here; the singing screen wires them to the engine and the routes.
//
// A chunk says where it is twice: `at`, its first sample's index in the stream (the samples are
// contiguous from 0), and `song_ms`, that sample's song time on the audio clock the pitch track is
// placed by. Samples from before the song's start are not sent. One chunk is in flight at a time;
// what arrives meanwhile waits and goes in the next, at most two seconds a chunk. An answer of
// `estimate` without `relay` (or any failure) stops the stream for the round: Core scores this singer from the
// browser's estimate and the recording kept for the end.

import { encodeTrack, TRACK_HZ, toBase64 } from "@miyoria/play/karaoke/score";
import type { StreamPiece } from "./mulaw";

/** Samples per second of the stream (`KARAOKE_STREAM_RATE`). */
export const STREAM_RATE = 16_000;
/** A chunk is sent once this much is gathered (~400 ms)... */
export const CHUNK_MIN = Math.round(0.4 * STREAM_RATE);
/** ...and holds at most this much (2 s). */
export const CHUNK_MAX = 2 * STREAM_RATE;
/** Behind by more than this (a slow link), the stream is given up. */
export const BACKLOG_MAX = 10 * STREAM_RATE;

/** One POST of `.../audio`. */
export interface AudioChunk {
  /** The first sample's index in the stream. */
  at: number;
  /** That sample's song time, in ms. */
  song_ms: number;
  /** The last chunk. */
  end: boolean;
  bytes: Uint8Array;
}

export type StreamAnswer = "live" | "estimate";

/**
 * What to do after Core's answer to a chunk: keep going while the stream is scored (`live`) or while
 * the voice may go out on her stream (`relay`); stop only when it is neither.
 */
export function answerOf(reply: { stream: "live" | "estimate"; relay?: boolean }): StreamAnswer {
  return reply.stream === "live" || reply.relay === true ? "live" : "estimate";
}
export type ChunkSender = (chunk: AudioChunk) => Promise<StreamAnswer>;

/** `live` sending; `stopped` (Core said `estimate`, or a send failed, or the singer left); `ended`. */
export type StreamState = "live" | "stopped" | "ended";

export class ChunkScheduler {
  readonly #send: ChunkSender;
  readonly #songTimeOf: (contextTime: number) => number;
  #state: StreamState = "live";
  #pending: Uint8Array[] = [];
  #pendingCount = 0;
  /** The song time (s) of the first pending sample. */
  #pendingSong = 0;
  /** Samples sent (the next chunk's `at`). */
  #sent = 0;
  #ending = false;
  #busy = false;
  #settled: () => void = () => {};
  readonly #done: Promise<void>;

  /** `songTimeOf`: a context time as song time (seconds; below 0 before the start). */
  constructor(send: ChunkSender, songTimeOf: (contextTime: number) => number) {
    this.#send = send;
    this.#songTimeOf = songTimeOf;
    this.#done = new Promise((resolve) => {
      this.#settled = resolve;
    });
  }

  get state(): StreamState {
    return this.#state;
  }

  /** Samples sent so far. */
  get sent(): number {
    return this.#sent;
  }

  /** One piece from the worklet. */
  push(piece: StreamPiece): void {
    if (this.#state !== "live" || this.#ending || piece.bytes.length === 0) return;
    let bytes = piece.bytes;
    let song = this.#songTimeOf(piece.t);
    if (song < 0) {
      // Before the start: dropped, up to the first sample at or after song time 0.
      const skip = Math.ceil(-song * STREAM_RATE - 1e-6);
      if (skip >= bytes.length) return;
      bytes = bytes.subarray(skip);
      song += skip / STREAM_RATE;
    }
    if (this.#pendingCount === 0) this.#pendingSong = song;
    this.#pending.push(bytes);
    this.#pendingCount += bytes.length;
    if (this.#pendingCount > BACKLOG_MAX) {
      this.stop();
      return;
    }
    void this.#pump();
  }

  /** The song ended (or 唱完了): what is left goes, the last chunk with `end`. */
  end(): Promise<void> {
    if (this.#state === "live") {
      this.#ending = true;
      void this.#pump();
    }
    return this.#done;
  }

  /** Stops without another word (the singer left, or the round is over). */
  stop(): void {
    this.#settle("stopped");
  }

  #settle(state: StreamState): void {
    if (this.#state !== "live") return;
    this.#state = state;
    this.#pending = [];
    this.#pendingCount = 0;
    this.#settled();
  }

  #take(count: number): AudioChunk {
    const bytes = new Uint8Array(count);
    let o = 0;
    while (o < count) {
      const head = this.#pending[0] as Uint8Array;
      const n = Math.min(head.length, count - o);
      bytes.set(head.subarray(0, n), o);
      o += n;
      if (n === head.length) this.#pending.shift();
      else this.#pending[0] = head.subarray(n);
    }
    const chunk: AudioChunk = {
      at: this.#sent,
      song_ms: Math.max(0, Math.round(this.#pendingSong * 1000)),
      end: false,
      bytes,
    };
    this.#pendingCount -= count;
    this.#pendingSong += count / STREAM_RATE;
    this.#sent += count;
    return chunk;
  }

  async #pump(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#state === "live") {
        if (!this.#ending && this.#pendingCount < CHUNK_MIN) break;
        const last = this.#ending && this.#pendingCount <= CHUNK_MAX;
        const chunk = this.#take(Math.min(CHUNK_MAX, this.#pendingCount));
        chunk.end = last;
        const answer = await this.#send(chunk);
        if (last) {
          this.#settle("ended");
          break;
        }
        if (answer !== "live") this.#settle("stopped");
      }
    } catch {
      this.#settle("stopped");
    } finally {
      this.#busy = false;
    }
  }
}

// ---- the browser's own pitch, once a second ----------------------------------------------------

/** Frames in one post: `track` stays under 4,000 characters of base64. */
export const PITCH_MAX_FRAMES = 2_990;
/** Frames this close to now may still get a detection; they wait for the next post. */
const PITCH_SETTLE_S = 0.1;

/** The detections as 50 Hz frames in song time, posted as they settle (`.../pitch`). */
export class PitchFeed {
  readonly #frames: (number | null)[] = [];
  #sent = 0;

  /** A detection captured at song time `t` (seconds). */
  push(t: number, midi: number | null): void {
    const i = Math.round(t * TRACK_HZ);
    if (i < 0 || !Number.isFinite(i)) return;
    while (this.#frames.length <= i) this.#frames.push(null);
    this.#frames[i] = midi !== null && Number.isFinite(midi) ? midi : null;
  }

  /** The frames settled by song time `now` and not yet sent, or `null` when there are none. */
  take(now: number, final = false): { from: number; track: string } | null {
    const upto = final ? this.#frames.length : Math.floor((now - PITCH_SETTLE_S) * TRACK_HZ);
    if (upto <= this.#sent) return null;
    while (this.#frames.length < upto) this.#frames.push(null);
    const from = this.#sent;
    const to = Math.min(upto, from + PITCH_MAX_FRAMES);
    this.#sent = to;
    return { from, track: toBase64(encodeTrack(this.#frames.slice(from, to))) };
  }
}
