// A room singer's microphone, for Core (docs/design/karaoke.md 「做了什麼第四步」): this AudioWorklet
// sits on the same AudioContext as the pitch worklet, so its samples are on the same clock the
// song time is read from. While it runs it downsamples the microphone to 16 kHz mono, encodes each
// sample as µ-law (`mulaw.ts`), and every ~100 ms posts the bytes with the index of their first
// sample in the stream and that sample's context time. The page (`room-stream.ts`) gathers them
// into the chunks it posts. Loaded with `audioWorklet.addModule` from the URL Vite gives for
// `stream.worklet.ts?worker&url`.
//
// Why PCM from a worklet rather than `MediaRecorder` pieces: a recorder's timeslices are not each
// decodable on their own (WebM/Opus pieces need the first one's header; Safari records MP4, whose
// pieces are fragments of one file), so Core could not hand a piece to the worker as it comes; and
// a recorder's clock is its own, while this one is the context's, the same as the pitch track's.

import { Downsampler, encodeMulaw, type StreamPiece } from "./mulaw";

interface WorkletScope {
  sampleRate: number;
  currentFrame: number;
  AudioWorkletProcessor: new () => { readonly port: MessagePort };
  registerProcessor(name: string, ctor: new () => unknown): void;
}

const scope = globalThis as unknown as WorkletScope;

/** The name the page creates the node by. */
const NAME = "miyoria-stream";
/** The stream's rate (`KARAOKE_STREAM_RATE`); a literal here so the worklet bundles nothing else. */
const RATE = 16_000;
/** Output samples per post (~100 ms). */
const POST_EVERY = 1_600;

class StreamProcessor extends scope.AudioWorkletProcessor {
  #running = false;
  #down: Downsampler | null = null;
  /** The context frame of the first input sample. */
  #startFrame = 0;
  #pending: Float32Array[] = [];
  #pendingCount = 0;
  #pendingIndex = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ run?: boolean }>) => {
      if (e.data.run === true) {
        this.#down = null;
        this.#pending = [];
        this.#pendingCount = 0;
        this.#pendingIndex = 0;
        this.#startFrame = -1;
        this.#running = true;
      } else if (e.data.run === false) {
        this.#flush();
        this.#running = false;
        this.#down = null;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.#running) return true;
    const channels = inputs[0];
    const first = channels?.[0];
    if (!first) return true;
    if (this.#down === null) {
      this.#down = new Downsampler(scope.sampleRate, RATE);
      this.#startFrame = scope.currentFrame;
    }
    // Mixed to one channel.
    let mono = first;
    if (channels.length > 1) {
      mono = new Float32Array(first.length);
      for (const ch of channels) for (let i = 0; i < ch.length; i++) mono[i] = (mono[i] as number) + (ch[i] as number) / channels.length;
    }
    const out = this.#down.push(mono);
    if (out.length > 0) {
      if (this.#pendingCount === 0) this.#pendingIndex = this.#down.produced - out.length;
      this.#pending.push(out);
      this.#pendingCount += out.length;
    }
    if (this.#pendingCount >= POST_EVERY) this.#flush();
    return true;
  }

  #flush(): void {
    const down = this.#down;
    if (!down || this.#pendingCount === 0) return;
    const samples = new Float32Array(this.#pendingCount);
    let o = 0;
    for (const p of this.#pending) {
      samples.set(p, o);
      o += p.length;
    }
    const index = this.#pendingIndex;
    const piece: StreamPiece = {
      index,
      t: (this.#startFrame + down.inputPosition(index)) / scope.sampleRate,
      bytes: encodeMulaw(samples),
    };
    this.#pending = [];
    this.#pendingCount = 0;
    this.port.postMessage(piece, [piece.bytes.buffer]);
  }
}

scope.registerProcessor(NAME, StreamProcessor);
