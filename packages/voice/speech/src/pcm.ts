// Turns a raw s16le byte stream into `AudioChunk`s.

import { errorMessage } from "@miyoria/runtime/kernel";
import { type AudioBuf, type AudioChunk, type AudioStream, SpeechError } from "./types.js";

/** One pending odd byte between network chunks. */
export interface Carry {
  byte: number | null;
}

/**
 * Re-frames an arbitrary byte chunk into whole samples.
 *
 * Network chunks can split a 16-bit sample; the odd trailing byte is carried into the next call.
 * Returns `null` when no complete sample is available.
 */
export function decodeChunk(carry: Carry, rate: number, bytes: Uint8Array): AudioBuf | null {
  let start = 0;
  let first: number | null = null;
  if (carry.byte !== null) {
    if (bytes.length === 0) return null;
    first = ((carry.byte | ((bytes[0] as number) << 8)) << 16) >> 16;
    carry.byte = null;
    start = 1;
  }
  const rest = bytes.length - start;
  const pairs = rest >> 1;
  if (rest & 1) carry.byte = bytes[bytes.length - 1] as number;
  const count = pairs + (first === null ? 0 : 1);
  if (count === 0) return null;
  const samples = new Int16Array(count);
  let o = 0;
  if (first !== null) samples[o++] = first;
  for (let i = 0; i < pairs; i++) {
    const at = start + i * 2;
    samples[o++] = (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
  }
  return { sampleRate: rate, samples };
}

/** Aborts its signal after `ms` without `reset()` (the idle / read timeout). */
export class IdleTimer {
  readonly #controller = new AbortController();
  readonly #ms: number;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(ms: number) {
    this.#ms = ms;
    this.reset();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  reset(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#controller.abort(new DOMException(`no data for ${this.#ms} ms`, "TimeoutError"));
    }, this.#ms);
  }

  clear(): void {
    clearTimeout(this.#timer);
  }
}

/**
 * Audio chunks at `rate` from a response body of raw s16le bytes (any split). A trailing odd
 * byte at the end of the stream is dropped. `return()` (e.g. `break` in `for await`) cancels the
 * body right away, even while a read is pending.
 */
class PcmStream implements AsyncIterableIterator<AudioChunk> {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #rate: number;
  readonly #idle: IdleTimer | null;
  readonly #carry: Carry = { byte: null };
  #done = false;

  constructor(body: ReadableStream<Uint8Array>, rate: number, idle: IdleTimer | null) {
    this.#reader = body.getReader();
    this.#rate = rate;
    this.#idle = idle;
  }

  async next(): Promise<IteratorResult<AudioChunk>> {
    while (!this.#done) {
      let chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
      this.#idle?.reset();
      try {
        chunk = await this.#reader.read();
      } catch (error) {
        this.#finish();
        throw new SpeechError(`audio stream failed: ${errorMessage(error)}`, { cause: error });
      } finally {
        this.#idle?.clear();
      }
      if (chunk.done || this.#done) break;
      const audio = decodeChunk(this.#carry, this.#rate, chunk.value);
      if (audio) return { value: audio, done: false };
    }
    this.#finish();
    return { value: undefined, done: true };
  }

  async return(): Promise<IteratorResult<AudioChunk>> {
    this.#finish();
    return { value: undefined, done: true };
  }

  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#idle?.clear();
    this.#reader.cancel().catch(() => undefined);
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

export function pcmStream(
  body: ReadableStream<Uint8Array>,
  rate: number,
  idle: IdleTimer | null = null,
): AudioStream {
  return new PcmStream(body, rate, idle);
}

/** Reads `rate=<n>` from a `Content-Type` such as `audio/L16; rate=24000`. */
export function rateFromContentType(contentType: string): number | null {
  for (const param of contentType.split(";").slice(1)) {
    const eq = param.indexOf("=");
    if (eq < 0) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== "rate") continue;
    return parseU32(
      param
        .slice(eq + 1)
        .trim()
        .replace(/^"+|"+$/g, ""),
    );
  }
  return null;
}

/** Parses an unsigned 32-bit integer: plain decimal digits (optional `+`) within range. */
export function parseU32(text: string): number | null {
  if (!/^\+?\d+$/.test(text)) return null;
  const n = Number(text);
  return n <= 0xffff_ffff ? n : null;
}
