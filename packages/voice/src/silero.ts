// Silero VAD, run by the end-of-turn worker over one WebSocket per audio stream.
//
// `Vad.isSpeech` is synchronous and sits on the frame path, so nothing here waits: a frame is sent
// and the decision comes from the newest answer, one or two frames (32 ms each) behind. That lag
// is far below the 200 ms the end of a turn needs. The energy detector runs along on every frame:
// it keeps its noise floor up to date and answers whenever the worker does not.

import WebSocket from "ws";
import type { Vad, VadSettings } from "./vad.js";
import { EnergyVad } from "./vad.js";

/** What the model takes at 16 kHz. */
const FRAME = 512;
const SAMPLE_RATE = 16_000;
/** An answer older than this says nothing about now. */
const STALE_MS = 500;
/** A speaker drops out of speech this far below the threshold (Silero's own hysteresis). */
const RELEASE_MARGIN = 0.15;
/** Frames in flight beyond this are not sent (the worker is behind). */
const MAX_BUFFERED_BYTES = 64 * 1024;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** Just enough of a WebSocket, so tests can stand in for it. */
export interface SileroSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(): void;
  on(event: "open" | "close" | "error", listener: (...args: unknown[]) => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
}

export interface SileroOptions {
  url: string;
  threshold: number;
  now?: () => number;
  connect?: (url: string) => SileroSocket;
}

function vadUrl(url: string): string {
  return `${url.replace(/\/+$/, "").replace(/^http/i, "ws")}/vad`;
}

export class SileroVad implements Vad {
  readonly frameLen = FRAME;
  readonly #o: SileroOptions;
  readonly #now: () => number;
  readonly #connect: (url: string) => SileroSocket;
  readonly #energy = new EnergyVad({ sampleRate: SAMPLE_RATE, frameMs: 32 });
  #socket: SileroSocket | null = null;
  #retryMs = RETRY_MIN_MS;
  #retryAt = 0;
  #closed = false;
  #answeredAt = Number.NEGATIVE_INFINITY;
  #speech = false;

  constructor(options: SileroOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#connect = options.connect ?? ((url) => new WebSocket(url) as unknown as SileroSocket);
    this.#open();
  }

  isSpeech(frame: Int16Array): boolean {
    const energy = this.#energy.isSpeech(frame);
    const socket = this.#socket;
    if (socket === null) {
      if (this.#now() >= this.#retryAt) this.#open();
    } else if (socket.readyState === WebSocket.OPEN) {
      if (socket.bufferedAmount < MAX_BUFFERED_BYTES) {
        socket.send(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
      }
    }
    return this.#now() - this.#answeredAt > STALE_MS ? energy : this.#speech;
  }

  close(): void {
    this.#closed = true;
    this.#socket?.close();
    this.#socket = null;
  }

  #open(): void {
    if (this.#closed) return;
    let socket: SileroSocket;
    try {
      socket = this.#connect(vadUrl(this.#o.url));
    } catch {
      this.#lost(null);
      return;
    }
    this.#socket = socket;
    socket.on("open", () => {
      this.#retryMs = RETRY_MIN_MS;
    });
    socket.on("message", (data) => this.#answer(data));
    socket.on("close", () => this.#lost(socket));
    // `close` follows; without a listener the error would be thrown.
    socket.on("error", () => undefined);
  }

  #answer(data: unknown): void {
    const p = Number(String(data));
    if (!Number.isFinite(p)) return;
    this.#answeredAt = this.#now();
    const threshold = this.#o.threshold;
    this.#speech = this.#speech ? p >= threshold - RELEASE_MARGIN : p >= threshold;
  }

  #lost(socket: SileroSocket | null): void {
    if (socket !== this.#socket && socket !== null) return;
    this.#socket = null;
    this.#retryAt = this.#now() + this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MAX_MS);
  }
}

/** The `silero` engine of `registerVadEngine`. */
export function sileroVad(settings: VadSettings): Vad {
  if (settings.sampleRate !== SAMPLE_RATE) {
    throw new Error(`silero runs at ${SAMPLE_RATE} Hz, not ${settings.sampleRate}`);
  }
  if (settings.url === undefined) throw new Error("no worker url for silero");
  return new SileroVad({ url: settings.url, threshold: settings.sileroThreshold });
}
