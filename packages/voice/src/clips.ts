// Optional clips of what people said, for the two decisions that need real audio: which ASR hears
// her name (workers/asr/compare_names.py) and what Smart Turn's threshold should be
// (workers/turn/calibrate.py). Only consenting speakers ever reach this, only with `clip_dir` set.
//
//   <dir>/utterances/<time>-<id>.wav + .txt   an accepted utterance and its transcript
//   <dir>/turn/ended/<time>-<id>.wav          what Smart Turn saw when the turn really ended
//   <dir>/turn/resumed/<time>-<id>.wav        what it saw when the speaker went on
//
// Writing happens in the background: a slow disk must not slow down the voice path, and a failing
// one costs a clip, nothing else.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@miyoria/kernel";
import { encodeWav } from "@miyoria/speech";

export type ClipKind = "utterance" | "ended" | "resumed";

const FOLDER: Record<ClipKind, readonly string[]> = {
  utterance: ["utterances"],
  ended: ["turn", "ended"],
  resumed: ["turn", "resumed"],
};

/** Clips written per run at most, so a forgotten switch does not fill the disk. */
const MAX_CLIPS = 5_000;

export class ClipRecorder {
  readonly #dir: string;
  readonly #warn: (message: string) => void;
  #saved = 0;
  #next = 0;

  constructor(dir: string, warn: (message: string) => void) {
    this.#dir = dir;
    this.#warn = warn;
  }

  /** Fire and forget. `text` goes next to the clip. */
  save(kind: ClipKind, samples: Int16Array, sampleRate: number, text: string | null = null): void {
    if (this.#saved >= MAX_CLIPS) return;
    this.#saved++;
    const name = `${Date.now()}-${this.#next++}`;
    void this.#write(kind, name, samples, sampleRate, text);
  }

  async #write(
    kind: ClipKind,
    name: string,
    samples: Int16Array,
    sampleRate: number,
    text: string | null,
  ): Promise<void> {
    try {
      const dir = join(this.#dir, ...FOLDER[kind]);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${name}.wav`), encodeWav({ sampleRate, samples }));
      if (text !== null) await writeFile(join(dir, `${name}.txt`), text, "utf8");
    } catch (error) {
      this.#warn(`could not save a voice clip: ${errorMessage(error)}`);
    }
  }
}
