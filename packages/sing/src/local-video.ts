// A song's video downloaded by Core itself (`[modules.sing] video_source = "local"`): yt-dlp,
// run on this machine, fetches the source's own video from its link, picked the way the song
// worker picks it (`fetch_video` in `workers/sing/engine.py`). A worker on a friend's machine
// sends a 20–90 MB video over a link that may carry well under a megabit; the source's site gives
// it to this machine in seconds.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { SongMeta } from "./client.js";
import type { SingConfig } from "./config.js";

/** The longest a download may take, from start to the file in place. */
export const LOCAL_VIDEO_TIMEOUT_MS = 5 * 60_000;
/** How much of yt-dlp's stderr a failure quotes (its last characters). */
const STDERR_TAIL = 600;
/** How long a killed yt-dlp is waited for before its temp dir is removed anyway. */
const KILL_WAIT_MS = 5_000;

/** The part of a child process this module uses (tests give a fake one). */
export interface VideoProcess {
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
}

/** Starts `command` with `args`, never through a shell. */
export type VideoSpawner = (command: string, args: readonly string[]) => VideoProcess;

/** The default spawner: the real process, stdin and stdout ignored, stderr read. */
export const spawnVideoProcess: VideoSpawner = (command, args): ChildProcess =>
  spawn(command, [...args], {
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

export interface LocalVideoOptions {
  /** The yt-dlp executable (`[modules.sing] ytdlp_path`). */
  ytdlpPath: string;
  maxHeight: number;
  maxMb: number;
  spawn?: VideoSpawner;
  timeoutMs?: number;
}

/** Fetches `url`'s video into `dest`; resolves with its size in bytes. */
export type LocalVideoFetcher = (url: string, dest: string, signal: AbortSignal) => Promise<number>;

/**
 * The local fetcher `[modules.sing]` asks for: `null` with `video_source = "worker"` (the
 * default), so nothing is ever spawned then.
 */
export function localVideoFetcher(
  cfg: Pick<SingConfig, "video_source" | "ytdlp_path" | "video_max_height" | "video_max_mb">,
  spawner?: VideoSpawner,
): LocalVideoFetcher | null {
  if (cfg.video_source !== "local") return null;
  const options: LocalVideoOptions = {
    ytdlpPath: cfg.ytdlp_path,
    maxHeight: cfg.video_max_height,
    maxMb: cfg.video_max_mb,
    ...(spawner === undefined ? {} : { spawn: spawner }),
  };
  return (url, dest, signal) => downloadVideo(url, dest, options, signal);
}

/** The song's link when it is an `http:` / `https:` URL, else `null`. */
export function songSourceUrl(song: SongMeta): string | null {
  const url = song.source?.url;
  return typeof url === "string" && isHttpUrl(url) ? url : null;
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * yt-dlp's arguments: video only, H.264 up to `maxHeight` first, then any codec at that height,
 * then a combined format, nothing over `maxMb`, remuxed into mp4, written as `<dir>/video.<ext>`.
 * The URL comes after `--`, so it is never read as an option.
 */
export function ytdlpArgs(url: string, dir: string, maxHeight: number, maxMb: number): string[] {
  const size = `[filesize<?${maxMb}M]`;
  const format = [
    `bv[height<=${maxHeight}][vcodec^=avc1]${size}`,
    `bv[height<=${maxHeight}]${size}`,
    `b[height<=${maxHeight}]${size}`,
  ].join("/");
  return [
    "--no-playlist",
    "--quiet",
    "--no-warnings",
    "--no-progress",
    "--no-mtime",
    "--format",
    format,
    "--max-filesize",
    `${maxMb}M`,
    "--remux-video",
    "mp4",
    "--output",
    join(dir, "video.%(ext)s"),
    "--",
    url,
  ];
}

/**
 * Downloads `url`'s video with yt-dlp into `dest` (an mp4): into a temp dir next to it first, then
 * renamed into place, so `dest` is either the whole file or absent. The temp dir is removed
 * whatever happens. Rejects when the URL is not `http(s)`, yt-dlp is missing or fails, it made no
 * mp4, it took longer than the timeout, or `signal` aborted (yt-dlp is killed, with the signal's
 * reason).
 */
export async function downloadVideo(
  url: string,
  dest: string,
  options: LocalVideoOptions,
  signal: AbortSignal,
): Promise<number> {
  if (!isHttpUrl(url)) throw new Error(`not an http(s) link: ${url.slice(0, 200)}`);
  signal.throwIfAborted();
  const parent = dirname(dest);
  await mkdir(parent, { recursive: true });
  const tmp = await mkdtemp(join(parent, `.${basename(dest)}-`));
  try {
    await run(
      options.ytdlpPath,
      ytdlpArgs(url, tmp, options.maxHeight, options.maxMb),
      options.spawn ?? spawnVideoProcess,
      options.timeoutMs ?? LOCAL_VIDEO_TIMEOUT_MS,
      signal,
    );
    signal.throwIfAborted();
    const made = (await readdir(tmp)).filter((f) => f.toLowerCase().endsWith(".mp4"));
    const file = made.includes("video.mp4") ? "video.mp4" : made[0];
    if (file === undefined) {
      throw new Error(
        `yt-dlp made no mp4 (none fits ${options.maxMb} MB / ${options.maxHeight}p?)`,
      );
    }
    await rename(join(tmp, file), dest);
    return (await stat(dest)).size;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Runs the process to its end; rejects on a failure, the timeout or `signal`. */
function run(
  command: string,
  args: readonly string[],
  spawner: VideoSpawner,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stderr = "";
    let stopped: unknown = null;
    let settled = false;
    let killWait: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killWait);
      signal.removeEventListener("abort", onAbort);
      if (error === null) resolve();
      else reject(error);
    };
    const stop = (why: unknown) => {
      if (stopped !== null || settled) return;
      stopped = why;
      child.kill("SIGKILL");
      // Its files are removed once it is gone; one that does not go is not waited for forever.
      killWait = setTimeout(() => finish(why), KILL_WAIT_MS);
    };
    const onAbort = () => stop(signal.reason ?? new Error("aborted"));
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    let child: VideoProcess;
    try {
      child = spawner(command, args);
    } catch (error) {
      reject(spawnError(command, error));
      return;
    }
    const timer = setTimeout(
      () => stop(new Error(`yt-dlp took longer than ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    child.once("error", (error) => finish(stopped ?? spawnError(command, error)));
    child.once("close", (code) => {
      if (stopped !== null) finish(stopped);
      else if (code === 0) finish(null);
      else {
        const tail = stderr.trim();
        finish(new Error(`yt-dlp exited with ${code ?? "a signal"}${tail ? `: ${tail}` : ""}`));
      }
    });
  });
}

function spawnError(command: string, error: unknown): Error {
  if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
    return new Error(
      `${command} was not found: install yt-dlp or set [modules.sing] ytdlp_path to its executable`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
