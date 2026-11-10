// Voice activity detection.
//
// `EnergyVad` is a small energy + zero-crossing detector with an adaptive noise floor. Model-based
// detectors plug in through `registerVadEngine` (silero.ts: Silero in the end-of-turn worker).

/** Classifies fixed-size frames of 16-bit mono PCM as speech or not. */
export interface Vad {
  /** Frame length in samples this detector expects. */
  readonly frameLen: number;
  /** Whether `frame` (exactly `frameLen` samples) contains speech. */
  isSpeech(frame: Int16Array): boolean;
  /** Lets go of what it holds; the stream it listened to is over. */
  close?(): void;
}

/** Tuning of `EnergyVad`. */
export interface EnergyVadConfig {
  sampleRate: number;
  frameMs: number;
  /** Frames quieter than this (dBFS) are never speech. */
  minSpeechDb: number;
  /** Speech must be this much louder than the noise floor (dB). */
  marginDb: number;
  /**
   * Frames with a zero-crossing rate above this are treated as broadband noise. Unvoiced sounds
   * inside words are bridged by the segmenter.
   */
  maxZcr: number;
  /** Noise floor = minimum frame energy over this window (minimum statistics). */
  floorWindowMs: number;
  /** Floor assumed before the window has filled. */
  initialFloorDb: number;
}

export const DEFAULT_ENERGY_VAD: Readonly<EnergyVadConfig> = Object.freeze({
  sampleRate: 16_000,
  frameMs: 20,
  minSpeechDb: -50,
  marginDb: 10,
  maxZcr: 0.35,
  floorWindowMs: 3_000,
  initialFloorDb: -60,
});

/** Number of sub-blocks the floor window is split into. */
const FLOOR_BLOCKS = 10;
const SILENCE_DB = -100;

/**
 * Energy / zero-crossing VAD with a minimum-statistics noise floor: the floor is the quietest
 * frame of the last few seconds, so steady background noise (fans, hum) stops counting as speech
 * after one window.
 */
export class EnergyVad implements Vad {
  readonly frameLen: number;
  readonly #config: EnergyVadConfig;
  readonly #blockFrames: number;
  /** Minimum energy of each finished block, newest last. */
  readonly #blocks: number[];
  #blockMin = Number.MAX_VALUE;
  #blockCount = 0;

  constructor(config: Partial<EnergyVadConfig> = {}) {
    const c = { ...DEFAULT_ENERGY_VAD, ...config };
    this.#config = c;
    this.frameLen = Math.max(1, Math.floor((c.sampleRate * c.frameMs) / 1000));
    const windowFrames = Math.max(1, Math.floor(c.floorWindowMs / Math.max(1, c.frameMs)));
    this.#blockFrames = Math.max(1, Math.floor(windowFrames / FLOOR_BLOCKS));
    this.#blocks = new Array<number>(FLOOR_BLOCKS).fill(c.initialFloorDb);
  }

  /** Current noise floor estimate in dBFS. */
  noiseFloorDb(): number {
    return Math.min(this.#blockMin, ...this.#blocks);
  }

  #trackFloor(energyDb: number): void {
    this.#blockMin = Math.min(this.#blockMin, energyDb);
    this.#blockCount++;
    if (this.#blockCount >= this.#blockFrames) {
      this.#blocks.shift();
      this.#blocks.push(this.#blockMin);
      this.#blockMin = Number.MAX_VALUE;
      this.#blockCount = 0;
    }
  }

  isSpeech(frame: Int16Array): boolean {
    const e = energyDb(frame);
    const floor = this.noiseFloorDb();
    this.#trackFloor(e);
    if (e < this.#config.minSpeechDb || e < floor + this.#config.marginDb) return false;
    return zeroCrossingRate(frame) <= this.#config.maxZcr;
  }
}

/** RMS level in dBFS (`-100` for digital silence). */
export function energyDb(frame: Int16Array): number {
  if (frame.length === 0) return SILENCE_DB;
  let sum = 0;
  for (const s of frame) sum += s * s;
  const rms = Math.sqrt(sum / frame.length) / 32768;
  return rms <= 1e-5 ? SILENCE_DB : Math.fround(20 * Math.log10(rms));
}

/** Fraction of adjacent sample pairs that change sign. */
export function zeroCrossingRate(frame: Int16Array): number {
  if (frame.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < frame.length; i++) {
    if ((frame[i - 1] as number) >= 0 !== (frame[i] as number) >= 0) crossings++;
  }
  return crossings / (frame.length - 1);
}

// ---- engines ----------------------------------------------------------------------------------

/** Which detector the listener builds for a stream. */
export interface VadSettings {
  engine: "energy" | "silero";
  /** Sample rate of the captured audio (16 kHz from the voice node). */
  sampleRate: number;
  /** `silero_vad.onnx`, for `silero`. */
  sileroModel: string | null;
  /** Speech probability above which a Silero frame is speech. */
  sileroThreshold: number;
  /** The worker that runs the model (`http://127.0.0.1:8006`). */
  url?: string;
}

/** Builds a detector for one stream. */
export type VadFactory = (settings: VadSettings) => Vad;

const engines = new Map<string, VadFactory>();

/**
 * Plugs in a detector engine. The voice module registers `silero` when `vad_engine = "silero"`.
 * The factory returns a `Vad` whose `frameLen` is what the model takes (512 samples at 16 kHz);
 * throwing means this stream uses the energy detector.
 */
export function registerVadEngine(name: string, factory: VadFactory): void {
  engines.set(name, factory);
}

/** The detector for `settings`; the energy detector when the engine is not available. */
export function createVad(settings: VadSettings, onFallback?: (engine: string) => void): Vad {
  if (settings.engine !== "energy") {
    const factory = engines.get(settings.engine);
    if (factory) {
      try {
        return factory(settings);
      } catch {
        // Falls through to the energy detector.
      }
    }
    onFallback?.(settings.engine);
  }
  return new EnergyVad({ sampleRate: settings.sampleRate });
}
