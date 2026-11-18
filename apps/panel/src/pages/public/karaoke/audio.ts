// The page's audio: one AudioContext for the backing track, the click track and the microphone.
// The backing track is fetched as bytes and decoded (no <audio> element, nothing to save), and
// played through Web Audio so song time is the context's clock. The microphone goes into the
// pitch worklet (`pitch.worklet.ts`), whose detections reach the page; when the session allows a
// recording for the official score, it also goes, mixed to one channel, to a `MediaRecorder`
// (`recorder.ts`), sent once at the end. In a room it also goes to the stream worklet
// (`stream.worklet.ts`), which Core is sent from while the song plays (`room-stream.ts`). Nothing
// else of it leaves the browser.
//
// `KaraokeEngine` is what the screens use; `setEngineFactory` swaps it (the dev demo's fake).

import { estimateLatency } from "./latency";
import { heardContextTime } from "./clock";
import type { StreamPiece } from "./mulaw";
import type { Detection } from "./pitch";
import workletUrl from "./pitch.worklet.ts?worker&url";
import { createVoiceRecorder, type RecordingLimits, type VoiceRecorder } from "./recorder";
import streamWorkletUrl from "./stream.worklet.ts?worker&url";

/** The microphone as 16 kHz µ-law pieces on the context's clock, for a room's stream. */
export interface MicStream {
  /** Starts (anew: the stream's first sample is the next one). */
  start(onPiece: (piece: StreamPiece) => void): void;
  /** Stops; what was gathered so far comes first. */
  stop(): void;
}

export interface KaraokeEngine {
  /** The context's time now. */
  now(): number;
  /** The context time of what comes out of the speakers now. */
  heard(): number;
  /** The browser's guess of the device's latency before it is measured, in ms. */
  estimateLatencyMs(): number;
  /** Opens the microphone (asks for it the first time): the device it is, for the latency key. */
  openMic(): Promise<{ deviceId?: string; groupId?: string }>;
  /** The room's level: below twice this nothing is voiced. */
  setFloor(rms: number): void;
  onDetection(fn: (d: Detection) => void): () => void;
  /** Fetches and decodes the backing track: its length in seconds. */
  loadBacking(url: string, signal?: AbortSignal): Promise<number>;
  /** Plays the backing track from `offset` seconds; the context time it starts at. */
  play(offset: number): number;
  /**
   * Plays the backing track so that song time `offset` is rendered at context time `at` (a room's
   * shared start); when `at` has passed it starts a moment from now, that much further in. The
   * context time it starts at and the song time there.
   */
  playAt(at: number, offset: number): { at: number; offset: number };
  stop(): void;
  /** Short beeps at these context times. */
  beeps(at: readonly number[]): void;
  /**
   * A recorder of the microphone, one channel, for the official score; `null` when the microphone
   * is not open or the browser cannot record. `songTime` reads the song's clock (seconds).
   */
  recorder(limits: RecordingLimits, songTime: () => number): VoiceRecorder | null;
  /** The microphone for a room's stream; `null` when it is not open or the browser cannot. */
  micStream(): Promise<MicStream | null>;
  close(): void;
}

/** A decode that failed: the browser cannot play this file. */
export class DecodeError extends Error {
  override readonly name = "DecodeError";
}

const NODE = "miyoria-pitch";
const STREAM_NODE = "miyoria-stream";
/** How soon a start can be scheduled, in seconds. */
const LEAD_S = 0.05;

class WebAudioEngine implements KaraokeEngine {
  readonly #ctx: AudioContext;
  #mic: MediaStream | null = null;
  #micSource: MediaStreamAudioSourceNode | null = null;
  #mono: MediaStreamAudioDestinationNode | null = null;
  #node: AudioWorkletNode | null = null;
  #stream: AudioWorkletNode | null = null;
  #backing: AudioBuffer | null = null;
  #source: AudioBufferSourceNode | null = null;
  readonly #listeners = new Set<(d: Detection) => void>();

  constructor() {
    this.#ctx = new AudioContext({ latencyHint: 0 });
  }

  now(): number {
    return this.#ctx.currentTime;
  }

  heard(): number {
    return heardContextTime(this.#ctx, performance.now());
  }

  estimateLatencyMs(): number {
    return estimateLatency(this.#ctx);
  }

  async openMic(): Promise<{ deviceId?: string; groupId?: string }> {
    if (this.#ctx.state === "suspended") await this.#ctx.resume();
    if (!this.#mic) {
      this.#mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      await this.#ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(this.#ctx, NODE, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (e: MessageEvent<Detection>) => {
        for (const fn of this.#listeners) fn(e.data);
      };
      this.#micSource = this.#ctx.createMediaStreamSource(this.#mic);
      this.#micSource.connect(node);
      // Connected so the graph pulls it; it writes silence.
      node.connect(this.#ctx.destination);
      this.#node = node;
    }
    const settings = this.#mic.getAudioTracks()[0]?.getSettings() ?? {};
    return { deviceId: settings.deviceId, groupId: settings.groupId };
  }

  setFloor(rms: number): void {
    this.#node?.port.postMessage({ floor: rms });
  }

  onDetection(fn: (d: Detection) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  async loadBacking(url: string, signal?: AbortSignal): Promise<number> {
    const res = await fetch(url, { credentials: "same-origin", signal });
    if (!res.ok) throw new Error(res.status === 404 ? "伴唱帶的連結過期了" : "伴唱帶拿不到");
    const bytes = await res.arrayBuffer();
    try {
      this.#backing = await this.#ctx.decodeAudioData(bytes);
    } catch {
      throw new DecodeError("這個瀏覽器播不了伴唱帶(AAC),請用電腦版的 Chrome 或 Edge");
    }
    return this.#backing.duration;
  }

  play(offset: number): number {
    this.stop();
    if (!this.#backing) throw new Error("伴唱帶還沒準備好");
    if (this.#ctx.state === "suspended") void this.#ctx.resume();
    const source = this.#ctx.createBufferSource();
    source.buffer = this.#backing;
    source.connect(this.#ctx.destination);
    const at = this.#ctx.currentTime + 0.12;
    source.start(at, Math.max(0, offset));
    this.#source = source;
    return at;
  }

  playAt(at: number, offset: number): { at: number; offset: number } {
    this.stop();
    if (!this.#backing) throw new Error("伴唱帶還沒準備好");
    if (this.#ctx.state === "suspended") void this.#ctx.resume();
    let when = at;
    let from = offset;
    const earliest = this.#ctx.currentTime + LEAD_S;
    if (when < earliest) {
      from += earliest - when;
      when = earliest;
    }
    const source = this.#ctx.createBufferSource();
    source.buffer = this.#backing;
    source.connect(this.#ctx.destination);
    source.start(when, Math.max(0, from));
    this.#source = source;
    return { at: when, offset: from };
  }

  stop(): void {
    if (!this.#source) return;
    try {
      this.#source.stop();
    } catch {
      // Already stopped.
    }
    this.#source.disconnect();
    this.#source = null;
  }

  beeps(at: readonly number[]): void {
    for (const t of at) {
      const osc = this.#ctx.createOscillator();
      const gain = this.#ctx.createGain();
      osc.frequency.value = 1320;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      osc.connect(gain).connect(this.#ctx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
    }
  }

  recorder(limits: RecordingLimits, songTime: () => number): VoiceRecorder | null {
    if (!this.#micSource) return null;
    if (!this.#mono) {
      // The microphone mixed down to one channel on the context's own clock.
      const mono = this.#ctx.createMediaStreamDestination();
      mono.channelCount = 1;
      mono.channelCountMode = "explicit";
      mono.channelInterpretation = "speakers";
      this.#micSource.connect(mono);
      this.#mono = mono;
    }
    return createVoiceRecorder(this.#mono.stream, limits, songTime);
  }

  async micStream(): Promise<MicStream | null> {
    if (!this.#micSource) return null;
    if (!this.#stream) {
      try {
        await this.#ctx.audioWorklet.addModule(streamWorkletUrl);
        const node = new AudioWorkletNode(this.#ctx, STREAM_NODE, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        this.#micSource?.connect(node);
        // Connected so the graph pulls it; it writes silence.
        node.connect(this.#ctx.destination);
        this.#stream = node;
      } catch {
        return null;
      }
    }
    const node = this.#stream;
    return {
      start: (onPiece) => {
        node.port.onmessage = (e: MessageEvent<StreamPiece>) => onPiece(e.data);
        node.port.postMessage({ run: true });
      },
      stop: () => node.port.postMessage({ run: false }),
    };
  }

  close(): void {
    this.stop();
    this.#listeners.clear();
    for (const track of this.#mic?.getTracks() ?? []) track.stop();
    this.#mic = null;
    this.#micSource?.disconnect();
    this.#micSource = null;
    this.#mono = null;
    this.#node?.disconnect();
    this.#node = null;
    this.#stream?.disconnect();
    this.#stream = null;
    void this.#ctx.close().catch(() => undefined);
  }
}

let factory: () => KaraokeEngine = () => new WebAudioEngine();

export function createEngine(): KaraokeEngine {
  return factory();
}

/** Replaces the audio (the dev demo's fake, or a test's). */
export function setEngineFactory(make: () => KaraokeEngine): void {
  factory = make;
}
