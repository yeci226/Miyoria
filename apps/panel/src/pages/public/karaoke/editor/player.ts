// The reference editor's playback: the song's backing track (the only audio Core keeps of a song;
// the lead vocal is not kept, so the editor plays the reference curve as a plain tone instead, 參考音),
// from any point, a stretch or a loop, at 0.5×, 0.75× or 1× without changing the pitch (a media
// element keeps the pitch when slowed; Web Audio's buffer source would not). The track is fetched
// once as bytes; its loudness, a hundred values a second, is drawn under the line.

/** What the editor plays through; `setPlayerFactory` swaps it (a test's fake). */
export interface EditorPlayer {
  /** Fetches the backing: its length (s) and its loudness envelope (`ENVELOPE_HZ`, 0..1). */
  load(url: string, signal?: AbortSignal): Promise<{ duration: number; envelope: Float32Array }>;
  /** Plays from `from` to `to` (`null`: to the end), again from `from` when `loop`. */
  play(from: number, to: number | null, loop: boolean): void;
  /** Stops where it is. */
  stop(): void;
  /** Song time now (s). */
  time(): number;
  playing(): boolean;
  setRate(rate: number): void;
  /** The reference curve as a tone while playing (`null`: off). */
  setTone(curve: { hz: number; start: number; midi: readonly (number | null)[] } | null): void;
  close(): void;
}

/** Values of the loudness envelope per second. */
export const ENVELOPE_HZ = 100;
/** How often a stretch's end and the tone are looked at, in ms. */
const TICK_MS = 15;

class MediaPlayer implements EditorPlayer {
  readonly #audio = new Audio();
  #url: string | null = null;
  #to: number | null = null;
  #from = 0;
  #loop = false;
  #timer = 0;
  #ctx: AudioContext | null = null;
  #osc: OscillatorNode | null = null;
  #gain: GainNode | null = null;
  #curve: { hz: number; start: number; midi: readonly (number | null)[] } | null = null;

  constructor() {
    this.#audio.preload = "auto";
    this.#audio.preservesPitch = true;
  }

  async load(url: string, signal?: AbortSignal) {
    const res = await fetch(url, { credentials: "same-origin", signal });
    if (!res.ok) throw new Error(res.status === 404 ? "伴唱帶拿不到" : `伴唱帶拿不到(${res.status})`);
    const bytes = await res.arrayBuffer();
    if (this.#url) URL.revokeObjectURL(this.#url);
    this.#url = URL.createObjectURL(new Blob([bytes], { type: res.headers.get("content-type") ?? "audio/mp4" }));
    this.#audio.src = this.#url;
    let envelope = new Float32Array();
    let duration = 0;
    try {
      const ctx = new OfflineAudioContext(1, 1, 48_000);
      const buffer = await ctx.decodeAudioData(bytes);
      duration = buffer.duration;
      envelope = envelopeOf(buffer);
    } catch {
      // No envelope: the line is drawn without it.
    }
    if (duration === 0) {
      await new Promise<void>((resolve) => {
        if (Number.isFinite(this.#audio.duration)) return resolve();
        this.#audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
        this.#audio.addEventListener("error", () => resolve(), { once: true });
      });
      duration = Number.isFinite(this.#audio.duration) ? this.#audio.duration : 0;
    }
    return { duration, envelope };
  }

  play(from: number, to: number | null, loop: boolean): void {
    this.#from = Math.max(0, from);
    this.#to = to;
    this.#loop = loop && to !== null;
    this.#audio.currentTime = this.#from;
    void this.#audio.play().catch(() => undefined);
    this.#toneOn();
    window.clearInterval(this.#timer);
    this.#timer = window.setInterval(() => this.#tick(), TICK_MS);
  }

  stop(): void {
    window.clearInterval(this.#timer);
    this.#timer = 0;
    this.#audio.pause();
    this.#toneLevel(0);
  }

  time(): number {
    return this.#audio.currentTime;
  }

  playing(): boolean {
    return !this.#audio.paused;
  }

  setRate(rate: number): void {
    this.#audio.playbackRate = rate;
  }

  setTone(curve: { hz: number; start: number; midi: readonly (number | null)[] } | null): void {
    this.#curve = curve;
    if (curve === null) this.#toneLevel(0);
    else if (this.playing()) this.#toneOn();
  }

  close(): void {
    this.stop();
    this.#audio.removeAttribute("src");
    this.#audio.load();
    if (this.#url) URL.revokeObjectURL(this.#url);
    this.#url = null;
    void this.#ctx?.close().catch(() => undefined);
    this.#ctx = null;
  }

  #tick(): void {
    const t = this.#audio.currentTime;
    if (this.#to !== null && t >= this.#to) {
      if (this.#loop) {
        this.#audio.currentTime = this.#from;
      } else {
        this.stop();
        return;
      }
    }
    if (this.#audio.paused) {
      this.stop();
      return;
    }
    const curve = this.#curve;
    if (curve === null || this.#osc === null || this.#ctx === null) return;
    const m = curve.midi[Math.round((t - curve.start) * curve.hz)];
    if (m === null || m === undefined) {
      this.#toneLevel(0);
    } else {
      this.#osc.frequency.setTargetAtTime(440 * 2 ** ((m - 69) / 12), this.#ctx.currentTime, 0.01);
      this.#toneLevel(0.12);
    }
  }

  #toneOn(): void {
    if (this.#curve === null) return;
    if (this.#ctx === null) {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      this.#ctx = ctx;
      this.#osc = osc;
      this.#gain = gain;
    }
    if (this.#ctx.state === "suspended") void this.#ctx.resume();
  }

  #toneLevel(level: number): void {
    if (this.#gain === null || this.#ctx === null) return;
    this.#gain.gain.setTargetAtTime(level, this.#ctx.currentTime, 0.015);
  }
}

/** The loudness of `buffer`, `ENVELOPE_HZ` values a second, scaled so the loudest is 1. */
export function envelopeOf(buffer: { sampleRate: number; length: number; numberOfChannels: number; getChannelData(c: number): Float32Array }): Float32Array {
  const hop = Math.max(1, Math.round(buffer.sampleRate / ENVELOPE_HZ));
  const out = new Float32Array(Math.ceil(buffer.length / hop));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  let top = 0;
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    let n = 0;
    for (let s = i * hop; s < Math.min(buffer.length, (i + 1) * hop); s += 4) {
      for (const data of channels) {
        const v = data[s] ?? 0;
        sum += v * v;
        n++;
      }
    }
    const rms = n === 0 ? 0 : Math.sqrt(sum / n);
    out[i] = rms;
    top = Math.max(top, rms);
  }
  if (top > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) / top;
  return out;
}

let factory: () => EditorPlayer = () => new MediaPlayer();

export function createPlayer(): EditorPlayer {
  return factory();
}

/** Replaces the playback (a test's fake). */
export function setPlayerFactory(make: () => EditorPlayer): void {
  factory = make;
}
