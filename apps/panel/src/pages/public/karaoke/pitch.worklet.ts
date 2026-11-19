// The pitch detector's AudioWorklet: the microphone's samples go into a ring buffer, and every
// 10 ms (480 samples at 48 kHz) the newest window is run through the detector and posted to the
// page with the context time of the window's middle. Loaded with `audioWorklet.addModule` from the
// URL Vite gives for `pitch.worklet.ts?worker&url` (bundled with pitchy, its own file).
//
// The microphone's audio stays here and in the page: only the posted numbers leave this file.

import { type Detection, mcleodDetector, rms, voicedNext } from "./pitch";

/** The part of the AudioWorkletGlobalScope used here (TypeScript ships no types for it). */
interface WorkletScope {
  sampleRate: number;
  currentFrame: number;
  AudioWorkletProcessor: new () => { readonly port: MessagePort };
  registerProcessor(name: string, ctor: new () => unknown): void;
}

const scope = globalThis as unknown as WorkletScope;

/** The name the page creates the node by. */
const NAME = "miyoria-pitch";

class PitchProcessor extends scope.AudioWorkletProcessor {
  readonly #detector = mcleodDetector(2048);
  readonly #ring = new Float32Array(this.#detector.size);
  readonly #frame = new Float32Array(this.#detector.size);
  readonly #hop = Math.max(1, Math.round(scope.sampleRate / 100));
  #write = 0;
  #filled = 0;
  #sinceHop = 0;
  #floor = 0.002;
  /** The last window's note (`null`: it was not voiced), for the hysteresis of `voicedNext`. */
  #before: number | null = null;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ floor?: number }>) => {
      if (typeof e.data.floor === "number" && e.data.floor > 0) this.#floor = e.data.floor;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const size = this.#ring.length;
    for (let i = 0; i < input.length; i++) {
      this.#ring[this.#write] = input[i] as number;
      this.#write = (this.#write + 1) % size;
    }
    this.#filled = Math.min(size, this.#filled + input.length);
    this.#sinceHop += input.length;
    if (this.#sinceHop < this.#hop || this.#filled < size) return true;
    this.#sinceHop -= this.#hop;
    if (this.#sinceHop > this.#hop) this.#sinceHop = 0;

    // The window, oldest sample first.
    const tail = size - this.#write;
    this.#frame.set(this.#ring.subarray(this.#write), 0);
    this.#frame.set(this.#ring.subarray(0, this.#write), tail);

    const sr = scope.sampleRate;
    const end = scope.currentFrame + input.length;
    const level = rms(this.#frame, size - this.#hop, size);
    const windowRms = rms(this.#frame);
    const estimate = this.#detector.detect(this.#frame, sr);
    const midi = voicedNext(estimate, windowRms, this.#floor, this.#before);
    this.#before = midi;
    const detection: Detection = {
      t: (end - size / 2) / sr,
      midi,
      clarity: estimate.clarity,
      rms: windowRms,
      level,
      levelT: (end - this.#hop / 2) / sr,
    };
    this.port.postMessage(detection);
    return true;
  }
}

scope.registerProcessor(NAME, PitchProcessor);
