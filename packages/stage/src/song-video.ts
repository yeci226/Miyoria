// The song's original video in OBS while she sings (`song_video` from Core): the media source
// `[stage.obs] song_video_source` gets the file (muted: the stream hears her cover) and is
// restarted when viewers hear the song start, `[stage.lipsync] latency_ms` after the cue like
// her mouth, minus `song_video_lead_ms`. Now and then its position is compared with the song's
// and re-seeked when it drifted more than `song_video_resync_ms`. It plays only when the source
// is an item of the scene it plays in (the `sing` scene the director switches to, else the
// current one); a hidden item is shown for the song and hidden again after.
//
// Paths come from Core: only video files inside `song_video_dir` are played. Nothing here
// throws: OBS being away or refusing a call is logged and the song goes on without a video.

import { stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { Clock } from "@miyoria/types";
import type { Obs, ObsConfig, SceneItem } from "./obs.js";

const log = getLogger("stage.song-video");

/** Song videos as the worker names them. */
const VIDEO_NAME = /^video\.(mp4|m4v|mkv|webm|mov)$/i;
/** First position check after the start, then the interval between checks. */
const FIRST_CHECK_MS = 1_500;
const CHECK_EVERY_MS = 20_000;
/** A late start (a node that connected mid-song) is seeked this soon after the restart. */
const LATE_SEEK_MS = 300;
/** Later than this counts as a late start (a few ms of OBS calls do not). */
const LATE_MS = 100;

/**
 * `path` when it is an existing song video inside `dir` (absolute, `video.<ext>`), else `null`.
 * Windows paths compare without case.
 */
export async function songVideoFile(dir: string, path: string | undefined): Promise<string | null> {
  if (!path || !isAbsolute(path)) return null;
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const full = resolve(path);
  const rel = relative(fold(resolve(dir)), fold(full));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  if (!VIDEO_NAME.test(basename(full))) return null;
  try {
    return (await stat(full)).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** How deep `findSceneItem` looks into scenes nested in the scene (a frame scene around the video). */
const MAX_NESTING = 2;

/**
 * The item showing `source` in `scene`, or in a scene nested in it (e.g. 「唱歌 · 影片」, which
 * frames the video): the scene that holds it and the item. `null` when it is nowhere.
 */
export async function findSceneItem(
  obs: Pick<Obs, "sceneItems">,
  scene: string,
  source: string,
  depth = 0,
): Promise<{ scene: string; item: SceneItem } | null> {
  if (!obs.sceneItems) return null;
  let items: SceneItem[];
  try {
    items = await obs.sceneItems(scene);
  } catch {
    return null; // not a scene
  }
  const item = items.find((i) => i.source === source);
  if (item) return { scene, item };
  if (depth >= MAX_NESTING) return null;
  for (const child of items) {
    const found = await findSceneItem(obs, child.source, source, depth + 1);
    if (found) return found;
  }
  return null;
}

export interface SongVideoDeps {
  /** The OBS connection, `null` while disconnected. */
  obs: () => Obs | null;
  /** OBS's program scene as last seen. */
  currentScene: () => string | null;
  config: ObsConfig;
  /** `[stage.lipsync] latency_ms`. */
  latencyMs: number;
  clock: Clock;
}

export interface SongVideoPlay {
  song: string;
  path?: string;
  offset_ms?: number;
  scene?: string;
}

interface Active {
  song: string;
  source: string;
  /** Stage time at which the video's 0 is on screen. */
  due: number;
  /** An item this song showed (hidden again after). */
  shown: { scene: string; id: number } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class SongVideo {
  readonly #deps: SongVideoDeps;
  /** OBS calls run one at a time, in order. */
  #chain: Promise<void> = Promise.resolve();
  #generation = 0;
  /** The song of the latest `play`. */
  #current: string | null = null;
  #active: Active | null = null;
  readonly #warned = new Set<string>();

  constructor(deps: SongVideoDeps) {
    this.#deps = deps;
  }

  /** Resolves once the queued OBS calls are done (tests). */
  idle(): Promise<void> {
    return this.#chain;
  }

  /** The song whose video is up, if any. */
  playing(): string | null {
    return this.#active?.song ?? null;
  }

  play(msg: SongVideoPlay): void {
    const receivedAt = this.#deps.clock.now();
    const gen = ++this.#generation;
    this.#current = msg.song;
    this.#enqueue(async () => {
      await this.#stop();
      if (gen === this.#generation) await this.#play(msg, receivedAt, gen);
    });
  }

  /** Stops `song`'s video when viewers hear the song end (`latency_ms` later). */
  stop(song: string): void {
    if (this.#current !== song) return;
    this.#current = null;
    const gen = ++this.#generation;
    const timer = setTimeout(() => {
      if (gen === this.#generation) this.#enqueue(() => this.#stop());
    }, this.#deps.latencyMs);
    timer.unref?.();
  }

  /** Stops whatever plays now (the Stage stopping). */
  close(): void {
    this.#generation += 1;
    this.#current = null;
    this.#enqueue(() => this.#stop());
  }

  #enqueue(work: () => Promise<void>): void {
    this.#chain = this.#chain.then(work).catch((error: unknown) => {
      log.warn({ err: errorMessage(error) }, "song video: OBS refused a call");
    });
  }

  #warnOnce(key: string, message: string, fields: Record<string, unknown>): void {
    if (this.#warned.has(key)) {
      log.debug(fields, message);
      return;
    }
    this.#warned.add(key);
    log.warn(fields, message);
  }

  async #play(msg: SongVideoPlay, receivedAt: number, gen: number): Promise<void> {
    const { config, clock } = this.#deps;
    const source = config.song_video_source;
    if (source === null) return;
    const file = await songVideoFile(config.song_video_dir, msg.path);
    if (file === null) {
      log.warn(
        { path: msg.path, dir: config.song_video_dir },
        "not a song video inside song_video_dir; not showing it",
      );
      return;
    }
    const obs = this.#deps.obs();
    if (!obs?.setMediaFile || !obs.mediaAction || !obs.sceneItems) {
      log.debug({ song: msg.song }, "OBS is not connected; the song plays without its video");
      return;
    }
    const top = msg.scene ?? this.#deps.currentScene() ?? (await obs.currentScene());
    const found = await findSceneItem(obs, top, source);
    const scene = found?.scene ?? top;
    const item = found?.item;
    if (!item) {
      this.#warnOnce(
        `scene:${scene}`,
        "the scene has no song video source; the song plays without its video",
        { scene, source },
      );
      return;
    }
    await obs.setMediaFile(source, file);
    const due = receivedAt + this.#deps.latencyMs - (msg.offset_ms ?? 0);
    const active: Active = { song: msg.song, source, due, shown: null, timer: null };
    this.#active = active;
    if (!item.enabled && obs.setSceneItemEnabled) {
      await obs.setSceneItemEnabled(scene, item.id, true);
      active.shown = { scene, id: item.id };
    }
    const wait = due - config.song_video_lead_ms - clock.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    // A stop or another song came in meanwhile (its own #stop clears this one).
    if (gen !== this.#generation) return;
    await obs.mediaAction(source, "restart");
    log.info({ song: msg.song, scene, file }, "playing the song video");
    this.#check(active, wait < -LATE_MS ? LATE_SEEK_MS : FIRST_CHECK_MS);
  }

  /** Compares the video's position with the song's after `ms`, then every `CHECK_EVERY_MS`. */
  #check(active: Active, ms: number): void {
    const resync = this.#deps.config.song_video_resync_ms;
    if (resync <= 0) return;
    active.timer = setTimeout(() => {
      this.#enqueue(async () => {
        if (this.#active !== active) return;
        const obs = this.#deps.obs();
        const cursor = (await obs?.mediaCursor?.(active.source)) ?? null;
        const expected = this.#deps.clock.now() - active.due;
        if (
          obs?.seekMedia &&
          cursor !== null &&
          expected > 0 &&
          Math.abs(cursor - expected) > resync
        ) {
          log.debug({ cursor, expected: Math.round(expected) }, "song video drifted; seeking");
          await obs.seekMedia(active.source, expected);
        }
        if (this.#active === active) this.#check(active, CHECK_EVERY_MS);
      });
    }, ms);
    active.timer.unref?.();
  }

  async #stop(): Promise<void> {
    const active = this.#active;
    this.#active = null;
    if (active === null) return;
    if (active.timer !== null) clearTimeout(active.timer);
    const obs = this.#deps.obs();
    if (!obs) return;
    try {
      await obs.mediaAction?.(active.source, "stop");
      await obs.setMediaFile?.(active.source, "");
      if (active.shown) {
        await obs.setSceneItemEnabled?.(active.shown.scene, active.shown.id, false);
      }
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot stop the song video");
    }
  }
}
