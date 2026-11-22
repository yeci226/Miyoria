// Playing one song: its 48 kHz mix and converted vocal, already on Core (`audio.ts`), streamed to
// the voice node close to real time (the vocal as the levels track her mouth follows), and the
// lyrics lines sent as cues while it plays. The start cue carries the path of the song's original
// video for the Stage node to show (muted) in OBS.

import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { getLogger } from "@miyoria/runtime/kernel";
import {
  type Clock,
  type PlaybackState,
  type PlayChunk,
  parseSongBeats,
  type SongBeats,
  type SongCue,
  type VoicePlayer,
} from "@miyoria/types";
import { SONG_ID } from "./audio.js";
import type { SingWorker, SongMeta, SongTrack } from "./client.js";
import { type LocalVideoFetcher, songSourceUrl } from "./local-video.js";

const log = getLogger("sing");

export interface PlayerDeps {
  /** One track of the song, from Core (`SongAudio.load`). */
  load: (track: SongTrack, signal: AbortSignal) => Promise<Int16Array>;
  voice: VoicePlayer;
  clock: Clock;
  cue: (cue: SongCue) => void;
  leadMs: number;
  fadeMs: number;
  lyrics: boolean;
  lipSyncVocals: boolean;
  /** The song's video on this machine (absolute), shown while she sings; `null`: none. */
  video: string | null;
}

/** Video names as the worker writes them (`video<ext>`). */
const VIDEO_FILE = /^video\.(mp4|m4v|mkv|webm|mov)$/;

/**
 * The absolute path of `song`'s video in the worker's cache `dir` (`<dir>/<id>/video.mp4`), or
 * `null` when it has none. The id and file name come from the worker, so anything that is not
 * exactly a song dir and a video name, or would land outside `dir`, gives `null`.
 */
export function songVideoPath(dir: string, song: SongMeta): string | null {
  const file = song.video?.file;
  if (!song.has_video || file === undefined || !SONG_ID.test(song.id) || !VIDEO_FILE.test(file)) {
    return null;
  }
  const root = resolve(dir);
  const full = resolve(root, song.id, file);
  const rel = relative(root, full);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : full;
}

/** The song's beat for the cue (ms), when the worker found one. */
export function songBeats(song: SongMeta): SongBeats | null {
  const beats = song.beats;
  if (!beats) return null;
  return parseSongBeats({ bpm: beats.bpm, times_ms: beats.times.map((t) => t * 1000) });
}

/** How long to wait for the node to report a started playback before giving up on lyrics. */
const START_WAIT_MS = 60_000;
const POLL_MS = 50;

/** Resolves after `ms`, or when `signal` aborts (never rejects). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** `mix` in 100 ms chunks, each sent `leadMs` before it is due. */
export async function* paced(
  mix: Int16Array,
  vocals: Int16Array | null,
  rate: number,
  leadMs: number,
  clock: Clock,
  signal: AbortSignal,
): AsyncGenerator<PlayChunk> {
  const step = Math.max(1, Math.floor(rate / 10));
  const t0 = clock.now();
  for (let at = 0; at < mix.length; at += step) {
    if (signal.aborted) return;
    const due = t0 + (at / rate) * 1000 - leadMs;
    const wait = due - clock.now();
    if (wait > 0) await sleep(wait, signal);
    if (signal.aborted) return;
    const samples = mix.subarray(at, at + step);
    if (vocals === null) yield { samples };
    else {
      const levels = new Int16Array(samples.length);
      levels.set(vocals.subarray(at, Math.min(at + step, vocals.length)));
      yield { samples, levels };
    }
  }
}

/**
 * Makes sure the song's video is in `videoDir` (the song worker may run on another machine, so
 * Core fetches it from the worker once). The path to show, or `null` when there is none.
 *
 * `local` (`[modules.sing] video_source = "local"`): the video is first downloaded on this
 * machine from the song's link, and the worker is asked only when that fails (not when `signal`
 * aborted). Only for a song the worker has a video for, and has an `http(s)` link: the worker's
 * word is what tells a source with a video from an audio-only one.
 */
export async function ensureVideo(
  worker: SingWorker,
  videoDir: string | null,
  song: SongMeta,
  signal: AbortSignal,
  local: LocalVideoFetcher | null = null,
): Promise<string | null> {
  if (videoDir === null) return null;
  const path = songVideoPath(videoDir, song);
  const file = song.video?.file;
  if (path === null || file === undefined) return null;
  try {
    await access(path);
    return path;
  } catch {
    // not here yet: fetch it
  }
  const url = local === null || !path.endsWith(".mp4") ? null : songSourceUrl(song);
  if (local !== null && url !== null) {
    const t0 = performance.now();
    try {
      const bytes = await local(url, path, signal);
      const seconds = Math.round((performance.now() - t0) / 100) / 10;
      log.info({ song: song.id, bytes, seconds }, "song video fetched locally");
      return path;
    } catch (error) {
      if (signal.aborted) return null;
      log.warn(
        { song: song.id, err: String(error) },
        "song video not fetched locally: asking the worker",
      );
    }
  }
  try {
    await worker.download(song.id, file, path, signal);
    return path;
  } catch (error) {
    if (!signal.aborted) log.warn({ song: song.id, err: String(error) }, "song video not fetched");
    return null;
  }
}

/**
 * Sings `song` in `guild`'s voice channel and resolves with how it ended. Aborting `signal`
 * fades it out (a skip or stop). Throws when the audio cannot be read or played
 * (`SongAudioMissingError` when it is not on Core).
 */
export async function singSong(
  d: PlayerDeps,
  song: SongMeta,
  guild: string,
  signal: AbortSignal,
): Promise<PlaybackState> {
  const rate = song.play.sample_rate;
  const [mix, vocals] = await Promise.all([
    d.load("play_mix.pcm", signal),
    d.lipSyncVocals ? d.load("play_vocals.pcm", signal) : Promise.resolve(null),
  ]);
  const video = d.video;
  if (signal.aborted) return "interrupted";
  const streaming = new AbortController();
  const handle = await d.voice.play(
    guild,
    rate,
    paced(mix, vocals, rate, d.leadMs, d.clock, AbortSignal.any([signal, streaming.signal])),
    { levels: vocals !== null },
  );
  const onAbort = () => handle.stop(d.fadeMs);
  // A stop that came while the playback was being set up fires no event any more.
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const lyricsDone = new AbortController();
  const durationMs = Math.round((mix.length / rate) * 1000);
  const lyrics = cueLyrics(
    d,
    song,
    durationMs,
    video,
    handle,
    AbortSignal.any([signal, lyricsDone.signal]),
  );
  try {
    return await handle.wait();
  } finally {
    signal.removeEventListener("abort", onAbort);
    streaming.abort();
    lyricsDone.abort();
    await lyrics;
  }
}

/**
 * Waits for the playback to start, then publishes `started` (with the song's length,
 * `durationMs`) and each lyrics line on time.
 */
async function cueLyrics(
  d: PlayerDeps,
  song: SongMeta,
  durationMs: number,
  video: string | null,
  handle: { state(): PlaybackState | null },
  signal: AbortSignal,
): Promise<void> {
  const waitUntil = d.clock.now() + START_WAIT_MS;
  while (handle.state() === null && !signal.aborted && d.clock.now() < waitUntil) {
    await sleep(POLL_MS, signal);
  }
  if (signal.aborted || handle.state() !== "started") return;
  const startedAt = d.clock.now();
  const beats = songBeats(song);
  d.cue({
    state: "started",
    song: song.id,
    title: song.title,
    ...(video === null ? {} : { video, offset_ms: 0 }),
    duration_ms: durationMs,
    ...(beats === null ? {} : { beats }),
  });
  const lines = d.lyrics && song.lyrics?.synced ? song.lyrics.lines : [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    await sleep(startedAt + line.t * 1000 - d.clock.now(), signal);
    if (signal.aborted) return;
    d.cue({ state: "line", song: song.id, index: i, text: line.text });
  }
}
