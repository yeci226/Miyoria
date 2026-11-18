// Her live picture on a card (docs/design/cards.md §6): `CardPortrait` drawn with her Live2D model
// by the card studio (`tools/card-studio`), from what the card drew (`portrait-spec.ts`).
//
// The studio is not a dependency of this package: it needs Live2D's own files (`vendor/`, not in
// git), a build and a browser, which only a machine that renders cards has. Its Node build
// (`<studio>/dist/node/render.js`) is loaded from its folder at the first picture. Anything missing
// (the folder, its build, Live2D's files, the model, Edge or Chrome) makes rendering unavailable:
// one warning, and every card falls back to the fixed portraits (`render` answers `null`). Nothing
// here throws to the caller.
//
// - One browser, started on the first picture and kept warm; closed after an idle half hour.
// - One picture at a time (the studio's queue); at most `MAX_WAITING` wait, more get `null`.
// - A picture that takes longer than the timeout answers `null`; the studio closes that browser.
// - Pictures are kept on disk by the hash of what they are drawn from (the spec, the model file and
//   this file's `RENDER_VERSION`), so a card is rendered once and its picture survives restarts;
//   the folder is kept under `portrait_cache_max_mb`, the pictures used longest ago going first
//   (`portrait-cache.ts`), since any of them can be rendered again.
// - Three failures in a row pause rendering for ten minutes; one warning, not one per card.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CardPortrait, PortraitInput } from "./portrait.js";
import { cacheBytes, PortraitCache, type SweepResult } from "./portrait-cache.js";
import { type PortraitSpec, portraitSpec } from "./portrait-spec.js";

/** Bump to draw every kept picture again after the look of the pictures changes. */
export const RENDER_VERSION = "1";

/** The cap of the kept pictures when none is given (`portrait_cache_max_mb`'s default). */
export const DEFAULT_CACHE_MB = 2048;

/** Pictures that may wait behind the one being drawn. */
const MAX_WAITING = 4;
const FAILURES_TO_PAUSE = 3;
const PAUSE_MS = 10 * 60_000;
const IDLE_MS = 30 * 60_000;

/** The studio's Node build, relative to its folder. */
export const STUDIO_ENTRY = "dist/node/render.js";

/** The part of the studio's `CardStudio` used here. */
export interface Studio {
  render(spec: PortraitSpec & { model: string }): Promise<Uint8Array>;
  stop(): Promise<void>;
}

/** What the studio's Node build exports. */
export interface StudioModule {
  CardStudio: new (options: {
    modelDir: string;
    channel?: string;
    executablePath?: string;
    timeoutMs?: number;
  }) => Studio;
  missingFiles(options: { modelDir: string }): string | null;
}

interface Log {
  warn(fields: object, message: string): void;
  info(fields: object, message: string): void;
  debug(fields: object, message: string): void;
}

export interface Live2dPortraitOptions {
  /** The card studio's folder. */
  studioDir: string;
  /** Her model's `.model3.json`. */
  model: string;
  /** Where pictures are kept. */
  cacheDir: string;
  /** Most bytes the kept pictures may take; default `DEFAULT_CACHE_MB` megabytes. */
  cacheMaxBytes?: number;
  /** Longest wait for one picture. */
  timeoutMs: number;
  /** `msedge` or `chrome` (playwright-core's channels). */
  channel?: string;
  /** A browser executable instead of a channel. */
  executablePath?: string;
  log: Log;
  /** Loads the studio (tests give a fake one). */
  loadStudio?: (entry: string) => Promise<StudioModule>;
  /** Replaces `Date.now` (tests). */
  now?: () => number;
}

const importStudio = async (entry: string) =>
  (await import(pathToFileURL(entry).href)) as StudioModule;

/** The hash a picture is kept under. */
export function portraitKey(spec: PortraitSpec, model: string): string {
  return createHash("sha256")
    .update(RENDER_VERSION)
    .update("\0")
    .update(model)
    .update("\0")
    .update(JSON.stringify(spec))
    .digest("hex");
}

/** Errors as one short line. */
function reason(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? error.name) : String(error);
}

export class Live2dPortrait implements CardPortrait {
  readonly #o: Live2dPortraitOptions;
  readonly #now: () => number;
  /** Why it cannot render at all (told once); `null` while it may. */
  #unavailable: string | null = null;
  #studio: Promise<Studio> | null = null;
  #modelId: string | null = null;
  #waiting = 0;
  #failures = 0;
  #pausedUntil = 0;
  #idle: NodeJS.Timeout | null = null;
  readonly #inflight = new Map<string, Promise<Uint8Array | null>>();
  readonly #cache: PortraitCache;
  #closed = false;

  constructor(options: Live2dPortraitOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#cache = new PortraitCache({
      dir: options.cacheDir,
      maxBytes: options.cacheMaxBytes ?? cacheBytes(DEFAULT_CACHE_MB),
      log: options.log,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /**
   * Checks what can be checked without a browser (the studio's build, Live2D's files, the model),
   * telling once why rendering is unavailable. Whether it is.
   */
  check(): boolean {
    if (this.#unavailable !== null) return false;
    const entry = join(this.#o.studioDir, STUDIO_ENTRY);
    if (this.#o.model === "") {
      // Not set up on this machine: the usual case, not a fault.
      this.#markUnavailable("no model is set ([modules.cards] portrait_model)", "info");
      return false;
    }
    let why: string | null = null;
    if (!existsSync(this.#o.model)) why = `the model ${this.#o.model} does not exist`;
    else if (!existsSync(entry)) {
      why = `the card studio is not built (${entry}; see tools/card-studio/vendor.md)`;
    }
    if (why !== null) this.#markUnavailable(why);
    return why === null;
  }

  /** Why rendering is off for good (until the module restarts); `null` when it is on. */
  get unavailable(): string | null {
    return this.#unavailable;
  }

  #markUnavailable(why: string, level: "warn" | "info" = "warn"): void {
    if (this.#unavailable !== null) return;
    this.#unavailable = why;
    this.#o.log[level](
      { reason: why },
      "card portraits: Live2D rendering unavailable; cards use the fixed portraits",
    );
  }

  /** Her picture for a card, from disk when it was drawn before; `null`: use a fixed portrait. */
  async render(input: PortraitInput): Promise<Uint8Array | null> {
    if (this.#closed || !this.check()) return null;
    let spec: PortraitSpec;
    let key: string;
    try {
      spec = portraitSpec(input);
      key = portraitKey(spec, this.#modelIdentity());
    } catch (error) {
      this.#o.log.debug({ err: reason(error) }, "card portraits: cannot make a spec");
      return null;
    }
    const file = join(this.#o.cacheDir, `${key}.png`);
    const kept = await this.#cache.read(file);
    if (kept !== null) return kept;
    const running = this.#inflight.get(key);
    if (running !== undefined) return running;
    if (this.#now() < this.#pausedUntil) return null;
    if (this.#waiting >= MAX_WAITING) return null;
    const work = this.#draw(spec, file).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, work);
    return work;
  }

  /** The model file and when it last changed: a new model draws every picture again. */
  #modelIdentity(): string {
    if (this.#modelId === null) {
      const stat = statSync(this.#o.model);
      this.#modelId = `${resolve(this.#o.model)}|${stat.size}|${Math.floor(stat.mtimeMs)}`;
    }
    return this.#modelId;
  }

  async #draw(spec: PortraitSpec, file: string): Promise<Uint8Array | null> {
    this.#waiting++;
    try {
      const studio = await this.#start();
      if (studio === null) return null;
      const drawn = await this.#withDeadline(
        studio.render({ ...spec, model: encodeURIComponent(basename(this.#o.model)) }),
      );
      // The studio gives a Buffer; answer a plain Uint8Array, as a kept picture is.
      const png = new Uint8Array(drawn.buffer, drawn.byteOffset, drawn.byteLength);
      await this.#cache.keep(file, png);
      this.#succeeded();
      return png;
    } catch (error) {
      // No browser to start is not a passing failure: rendering is off until a restart.
      if (error instanceof Error && error.name === "BrowserUnavailable") {
        this.#markUnavailable(reason(error));
      } else {
        this.#failed(error);
      }
      return null;
    } finally {
      this.#waiting--;
      this.#touch();
    }
  }

  /** The studio's own timeout covers drawing; this one covers waiting in its queue as well. */
  #withDeadline<T>(work: Promise<T>): Promise<T> {
    const ms = this.#o.timeoutMs * (MAX_WAITING + 1);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error(`no picture after ${ms} ms`)), ms);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  #start(): Promise<Studio | null> {
    if (!this.#studio) {
      const entry = join(this.#o.studioDir, STUDIO_ENTRY);
      this.#studio = (async () => {
        let mod: StudioModule;
        try {
          mod = await (this.#o.loadStudio ?? importStudio)(entry);
        } catch (error) {
          throw new Unavailable(`cannot load the card studio: ${reason(error)}`);
        }
        const modelDir = dirname(resolve(this.#o.model));
        const missing = mod.missingFiles({ modelDir });
        if (missing !== null) throw new Unavailable(missing);
        return new mod.CardStudio({
          modelDir,
          timeoutMs: this.#o.timeoutMs,
          ...(this.#o.channel ? { channel: this.#o.channel } : {}),
          ...(this.#o.executablePath ? { executablePath: this.#o.executablePath } : {}),
        });
      })();
      this.#studio.catch((error) => {
        this.#studio = null;
        if (error instanceof Unavailable) this.#markUnavailable(error.message);
      });
    }
    return this.#studio.catch(() => null);
  }

  /**
   * Keeps the kept pictures under the cap (`portrait-cache.ts`): at start, and by itself after
   * each picture written.
   */
  sweepCache(): Promise<SweepResult> {
    return this.#cache.sweep();
  }

  #succeeded(): void {
    if (this.#failures >= FAILURES_TO_PAUSE) {
      this.#o.log.info({}, "card portraits: rendering again");
    }
    this.#failures = 0;
  }

  #failed(error: unknown): void {
    this.#failures++;
    const why = reason(error);
    if (this.#failures === 1) {
      this.#o.log.warn(
        { err: why },
        "card portraits: a picture failed; this card uses a fixed portrait",
      );
    } else {
      this.#o.log.debug({ err: why, failures: this.#failures }, "card portraits: a picture failed");
    }
    if (this.#failures === FAILURES_TO_PAUSE) {
      this.#pausedUntil = this.#now() + PAUSE_MS;
      this.#o.log.warn(
        { err: why, minutes: PAUSE_MS / 60_000 },
        "card portraits: paused after failures in a row; cards use the fixed portraits",
      );
    } else if (this.#failures > FAILURES_TO_PAUSE) {
      this.#pausedUntil = this.#now() + PAUSE_MS;
    }
  }

  /** Closes the browser after a while without pictures. */
  #touch(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      this.#idle = null;
      if (this.#waiting === 0) void this.#stopStudio();
    }, IDLE_MS);
    this.#idle.unref?.();
  }

  async #stopStudio(): Promise<void> {
    const studio = this.#studio;
    this.#studio = null;
    const s = await studio?.catch(() => null);
    await s?.stop().catch(() => undefined);
  }

  /** Closes the browser; `render` answers `null` from now on. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    await this.#stopStudio();
  }
}

/** The `portrait*` keys of `[modules.cards]` (`config.ts`). */
export interface PortraitConfig {
  portrait: "live2d" | "fixed";
  portrait_model: string;
  portrait_studio: string;
  portrait_cache: string;
  portrait_cache_max_mb: number;
  portrait_browser: "msedge" | "chrome";
  portrait_timeout_secs: number;
}

/**
 * The portrait `[modules.cards]` asks for, its paths resolved against `cwd` (the working folder,
 * like every other path in the config); `null` for `portrait = "fixed"` or when it cannot render
 * here (said once in the log). Either way with `live2d` the kept pictures are brought under the
 * cap now, in the background: a cap lowered while nothing renders still holds.
 */
export function livePortrait(
  config: PortraitConfig,
  log: Log,
  cwd = process.cwd(),
): Live2dPortrait | null {
  if (config.portrait !== "live2d") return null;
  const portrait = new Live2dPortrait({
    studioDir: resolve(cwd, config.portrait_studio),
    model: config.portrait_model === "" ? "" : resolve(cwd, config.portrait_model),
    cacheDir: resolve(cwd, config.portrait_cache),
    cacheMaxBytes: cacheBytes(config.portrait_cache_max_mb),
    timeoutMs: config.portrait_timeout_secs * 1000,
    channel: config.portrait_browser,
    log,
  });
  void portrait.sweepCache();
  return portrait.check() ? portrait : null;
}

/** The studio says it cannot run on this machine (missing files): not a passing failure. */
class Unavailable extends Error {
  override readonly name = "Unavailable";
}
