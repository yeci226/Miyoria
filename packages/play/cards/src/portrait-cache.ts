// The pictures `live2d.ts` keeps on disk (docs/design/cards.md §6), bounded: about a megabyte per
// card, so without a cap the folder grows forever. Every picture can be rendered again from its
// card, so past `[modules.cards] portrait_cache_max_mb` the ones used longest ago are deleted.
//
// - What "used" means is the file's modified time, moved to now each time a picture is read
//   (`read`). Access times are not kept on every Windows volume (and are off on many), so they are
//   not relied on; the files themselves are the index, and it survives restarts.
// - A sweep runs at start and after each picture written, one at a time (a sweep asked for while
//   one runs runs again after it). It lists the folder, adds up the pictures and deletes the oldest
//   until the total is under the cap.
// - A picture being read or written in this process is never deleted (`#held`): a sweep skips it,
//   and the next sweep finds it again. A file another process holds open and that cannot be
//   deleted (Windows) is skipped the same way.
// - Temporary files of a write that never finished (a stop mid-write) go once an hour old.
// - Nothing here throws to the caller: a cache that cannot be read or swept is only a slower one.

import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const MB = 1024 * 1024;
/** A temporary file this old is a write that never finished. */
const STALE_TMP_MS = 60 * 60_000;

interface Log {
  info(fields: object, message: string): void;
  debug(fields: object, message: string): void;
}

export interface PortraitCacheOptions {
  dir: string;
  /** Most bytes the pictures may take. */
  maxBytes: number;
  log: Log;
  /** Replaces `Date.now` (tests). */
  now?: () => number;
}

/** What one sweep did. */
export interface SweepResult {
  /** Pictures deleted. */
  deleted: number;
  /** Bytes the pictures take after it. */
  bytes: number;
}

/** `portrait_cache_max_mb` as bytes. */
export const cacheBytes = (mb: number): number => mb * MB;

export class PortraitCache {
  readonly #o: PortraitCacheOptions;
  readonly #now: () => number;
  /** Files being read or written now, with how many times each. */
  readonly #held = new Map<string, number>();
  #sweeping: Promise<SweepResult> | null = null;
  #again = false;

  constructor(options: PortraitCacheOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  get dir(): string {
    return this.#o.dir;
  }

  /** A kept picture, marked used now; `null` when it is not kept. */
  async read(file: string): Promise<Uint8Array | null> {
    return this.#holding(file, async () => {
      const kept = await readFile(file).catch(() => null);
      if (kept === null) return null;
      const at = new Date(this.#now());
      await utimes(file, at, at).catch(() => undefined);
      return new Uint8Array(kept);
    });
  }

  /** Writes a picture (whole or not at all), then sweeps. */
  async keep(file: string, png: Uint8Array): Promise<void> {
    await this.#holding(file, async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(tmp, png);
        await rename(tmp, file);
      } catch (error) {
        this.#o.log.debug({ err: String(error), file }, "card portraits: cannot keep a picture");
      }
    });
    void this.sweep();
  }

  /** Deletes the pictures used longest ago until the folder is under the cap. */
  sweep(): Promise<SweepResult> {
    if (this.#sweeping !== null) {
      this.#again = true;
      return this.#sweeping;
    }
    const run = (async () => {
      let result = await this.#sweepOnce();
      while (this.#again) {
        this.#again = false;
        result = await this.#sweepOnce();
      }
      return result;
    })().finally(() => {
      this.#sweeping = null;
    });
    this.#sweeping = run;
    return run;
  }

  async #sweepOnce(): Promise<SweepResult> {
    const { dir, maxBytes, log } = this.#o;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return { deleted: 0, bytes: 0 };
    }
    const pictures: { file: string; size: number; used: number }[] = [];
    for (const name of names) {
      const file = join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info === null || !info.isFile()) continue;
      if (name.endsWith(".tmp")) {
        if (this.#now() - info.mtimeMs > STALE_TMP_MS) await unlink(file).catch(() => undefined);
        continue;
      }
      if (name.endsWith(".png")) pictures.push({ file, size: info.size, used: info.mtimeMs });
    }
    let bytes = pictures.reduce((sum, p) => sum + p.size, 0);
    let deleted = 0;
    if (bytes > maxBytes) {
      pictures.sort((a, b) => a.used - b.used || (a.file < b.file ? -1 : 1));
      for (const p of pictures) {
        if (bytes <= maxBytes) break;
        if (this.#held.has(p.file)) continue;
        try {
          await unlink(p.file);
        } catch (error) {
          // Gone already counts as gone; held open elsewhere stays for a later sweep.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        }
        bytes -= p.size;
        deleted += 1;
      }
      log.info(
        { deleted, mb: Math.round(bytes / MB), max_mb: Math.round(maxBytes / MB) },
        "card portraits: the pictures used longest ago were deleted to keep under the cap",
      );
    }
    return { deleted, bytes };
  }

  /**
   * Keeps `file` from being deleted until the answer is called (once): while it is read, written
   * or served from disk.
   */
  hold(file: string): () => void {
    this.#held.set(file, (this.#held.get(file) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.#held.get(file) ?? 1) - 1;
      if (left <= 0) this.#held.delete(file);
      else this.#held.set(file, left);
    };
  }

  async #holding<T>(file: string, run: () => Promise<T>): Promise<T> {
    const release = this.hold(file);
    try {
      return await run();
    } finally {
      release();
    }
  }
}
