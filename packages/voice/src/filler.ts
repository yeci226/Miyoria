// Filler (墊話, docs/design/v4-plan.md §7.5 item 5): when she was addressed and nothing of hers can
// be heard a while after her turn started, one short sound of hers ("嗯?", "欸~") plays, so the
// silence has an owner. Measured 2026-11-07 to 11-10: speech end to her first sound p50 6.0 s; the
// model alone is rarely under a second, so most answers had a silence of several seconds.
//
// It lives here, not in the agent: this module knows to the millisecond whether anything of hers is
// playing or about to (a line was prepared), whether somebody is talking, and plays audio without
// the scheduler. The agent knows whether she will answer, and says so (`VoiceTurns.expect` once
// attention and the Floor said yes and she was addressed; `settle` when the turn ends). A filler
// is never an action: it is not in her history, the Floor's budget or her share of recent lines,
// and publishes no `voice_playback` (that would commit the turn and close it to new input).
//
// The sounds are synthesized once per voice by the TTS that is there (no other model) and cached
// on disk; they are short, neutral acknowledgements that fit before any answer, a refusal too. A
// laugh or a sigh does not: it would be wrong before most lines, so none is in the default set.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@miyoria/kernel";
import { type AudioBuf, decodeWav, encodeWav } from "@miyoria/speech";
import type { ContextKey, TurnId } from "@miyoria/types";

/** One sound of hers, ready to play. */
export interface FillerClip {
  text: string;
  sampleRate: number;
  samples: Int16Array;
}

/** Below this a sample is silence when the clip is trimmed (about -36 dBFS). */
const TRIM_LEVEL = 500;
/** Kept around the sound when trimming, ms. */
const TRIM_MARGIN_MS = 30;

export interface FillerBankOptions {
  /** Root of the cache; each voice has its own folder. */
  dir: string;
  /** The TTS voice (`VoiceProfile.voice`). */
  voice: string;
  /** The language sent to TTS. */
  language: string;
  lines: readonly string[];
  /** A clip longer than this (after trimming) is not used: the TTS said something else. */
  maxMs: number;
  /** Synthesizes one line, all of it. */
  synthesize(text: string, signal: AbortSignal): Promise<AudioBuf>;
  warn(message: string): void;
}

/** Her filler sounds: read from the cache, synthesized once when missing. */
export class FillerBank {
  readonly #o: FillerBankOptions;
  readonly #clips = new Map<string, FillerClip>();
  /** Lines that came out too long: not asked for again in this run. */
  readonly #rejected = new Set<string>();

  constructor(options: FillerBankOptions) {
    this.#o = options;
  }

  /** The clips ready to play, in the order of `lines`. */
  clips(): FillerClip[] {
    return this.#o.lines.flatMap((l) => {
      const clip = this.#clips.get(l);
      return clip === undefined ? [] : [clip];
    });
  }

  /** The cache file of a line. */
  path(text: string): string {
    const hash = createHash("sha256")
      .update(`${this.#o.language}\u0000${text}`)
      .digest("hex")
      .slice(0, 16);
    return join(this.#o.dir, safeName(this.#o.voice), `${hash}.wav`);
  }

  /**
   * Reads what the cache has and synthesizes what it does not, one line at a time. Returns how
   * many lines are still missing (a TTS that failed is asked again on the next call).
   */
  async load(signal: AbortSignal): Promise<number> {
    let missing = 0;
    for (const text of this.#o.lines) {
      if (signal.aborted) break;
      if (this.#clips.has(text) || this.#rejected.has(text)) continue;
      const file = this.path(text);
      let audio: AudioBuf | null = null;
      try {
        audio = decodeWav(new Uint8Array(await readFile(file)));
      } catch {
        audio = null;
      }
      if (audio === null) {
        try {
          audio = trim(await this.#o.synthesize(text, signal));
          await mkdir(join(this.#o.dir, safeName(this.#o.voice)), { recursive: true });
          await writeFile(file, encodeWav(audio));
          await writeFile(file.replace(/\.wav$/, ".txt"), text, "utf8");
        } catch (error) {
          if (!signal.aborted)
            this.#o.warn(`filler "${text}" not synthesized: ${errorMessage(error)}`);
          missing++;
          continue;
        }
      }
      const ms = (audio.samples.length * 1000) / Math.max(1, audio.sampleRate);
      if (audio.samples.length === 0 || ms > this.#o.maxMs) {
        this.#rejected.add(text);
        this.#o.warn(`filler "${text}" is ${Math.round(ms)} ms long: not used`);
        continue;
      }
      this.#clips.set(text, { text, sampleRate: audio.sampleRate, samples: audio.samples });
    }
    return missing;
  }
}

/** A folder name from a voice name. */
function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_") || "voice";
}

/** The clip without the silence TTS puts around it (a filler is late enough as it is). */
export function trim(audio: AudioBuf): AudioBuf {
  const s = audio.samples;
  let a = 0;
  while (a < s.length && Math.abs(s[a] as number) < TRIM_LEVEL) a++;
  let b = s.length;
  while (b > a && Math.abs(s[b - 1] as number) < TRIM_LEVEL) b--;
  if (a >= b) return { sampleRate: audio.sampleRate, samples: new Int16Array(0) };
  const margin = Math.floor((TRIM_MARGIN_MS * audio.sampleRate) / 1000);
  return {
    sampleRate: audio.sampleRate,
    samples: s.slice(Math.max(0, a - margin), Math.min(s.length, b + margin)),
  };
}

export interface FillerDeps {
  /** Called on the first `expect`: get the sounds ready (they are read or made once). */
  load?(): void;
  now(): number;
  /** How long after a turn started a silence gets a filler. */
  afterMs: number;
  clips(): readonly FillerClip[];
  /**
   * Whether nothing of hers plays or is on its way in `guild` since `since` (no line prepared or
   * started, no song, no emergency stop): a filler would then stand alone.
   */
  quiet(guild: string, since: number): boolean;
  /** Somebody is talking in `guild` right now. */
  talking(guild: string): boolean;
  /** The speech of `turn` was stopped by somebody talking over her. */
  stopped(guild: string, turn: TurnId): boolean;
  /** Plays `clip` for `turn`; resolves when it is over. */
  play(context: ContextKey, turn: TurnId, clip: FillerClip): Promise<void>;
  /** Uniform in [0, 1). */
  random(): number;
  /** Why a filler did not play (debug). */
  skipped?(turn: TurnId, reason: string): void;
}

interface Armed {
  context: ContextKey;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Turns waiting for their filler moment; past this the oldest is let go. */
const MAX_ARMED = 16;

/** Decides when a filler plays, and which. */
export class Filler {
  readonly #d: FillerDeps;
  readonly #armed = new Map<TurnId, Armed>();
  /** The last filler per guild: never the same twice in a row. */
  readonly #last = new Map<string, string>();

  constructor(deps: FillerDeps) {
    this.#d = deps;
  }

  /** `turn` will answer somebody: a filler plays `afterMs` after `startedAt` if it is still quiet. */
  expect(context: ContextKey, turn: TurnId, startedAt: number): void {
    this.#d.load?.();
    if (context.scope === null || this.#armed.has(turn)) return;
    const wait = Math.max(0, startedAt + this.#d.afterMs - this.#d.now());
    const timer = setTimeout(() => this.#fire(turn), wait);
    (timer as { unref?: () => void }).unref?.();
    this.#armed.set(turn, { context, startedAt, timer });
    while (this.#armed.size > MAX_ARMED) {
      const oldest = this.#armed.keys().next().value;
      if (oldest === undefined) break;
      this.settle(oldest);
    }
  }

  /** `turn` is over or says nothing: no filler for it. */
  settle(turn: TurnId): void {
    const armed = this.#armed.get(turn);
    if (armed === undefined) return;
    clearTimeout(armed.timer);
    this.#armed.delete(turn);
  }

  /** Forgets every turn (module stop). */
  close(): void {
    for (const turn of [...this.#armed.keys()]) this.settle(turn);
  }

  #fire(turn: TurnId): void {
    const armed = this.#armed.get(turn);
    this.#armed.delete(turn);
    if (armed === undefined) return;
    const guild = armed.context.scope as string;
    const d = this.#d;
    const why = this.#unwanted(guild, turn, armed.startedAt);
    if (why !== null) {
      d.skipped?.(turn, why);
      return;
    }
    const last = this.#last.get(guild);
    const choices = d.clips().filter((c) => c.text !== last);
    if (choices.length === 0) {
      // With a single sound, the next silence may have it again.
      this.#last.delete(guild);
      d.skipped?.(turn, "no filler that is not the last one");
      return;
    }
    const clip = choices[Math.min(choices.length - 1, Math.floor(d.random() * choices.length))];
    if (clip === undefined) return;
    this.#last.set(guild, clip.text);
    void d.play(armed.context, turn, clip).catch((error: unknown) => {
      d.skipped?.(turn, `playing failed: ${errorMessage(error)}`);
    });
  }

  /** Why no filler should play for `turn` now (`null`: it should). */
  #unwanted(guild: string, turn: TurnId, startedAt: number): string | null {
    const d = this.#d;
    // Her first sentence came in time, she is speaking already, or a song has the channel.
    if (!d.quiet(guild, startedAt)) return "her line is on its way";
    if (d.talking(guild)) return "somebody is talking";
    if (d.stopped(guild, turn)) return "she was stopped";
    return null;
  }
}
