// Her songs on the bus: the `sing` module publishes `Events.SingCue` while she sings,
// the stage forwards them to the overlay (lyrics as subtitles), the avatar (speaking) and OBS
// (the song's original video, muted, while she sings). `Events.SingPrepare` reports the song the
// worker is preparing, for the overlay's activity line.

import type { SongCueData, SongPrepareData } from "@miyoria/contracts/events";
import { isJsonObject, type JsonValue } from "./json.js";

/** Longest video path a cue carries. */
const MAX_PATH = 1024;
/** Longest song a cue's `duration_ms` describes (a day). */
const MAX_DURATION_MS = 86_400_000;
/** Most beats a cue carries (a 10-minute song at 200 BPM). */
export const MAX_BEATS = 2_000;

/**
 * The beat of a song: its tempo and when each beat falls, in ms from the start of the playback
 * (sorted). She sways and nods with it while she sings.
 */
export interface SongBeats {
  bpm: number;
  times_ms: number[];
}

/** A `SongBeats` from an untyped value (sorted, finite, at most `MAX_BEATS`), or `null`. */
export function parseSongBeats(value: JsonValue | undefined): SongBeats | null {
  if (!isJsonObject(value)) return null;
  const { bpm, times_ms: times } = value;
  if (typeof bpm !== "number" || !Number.isFinite(bpm) || bpm <= 0 || bpm > 400) return null;
  if (!Array.isArray(times)) return null;
  const out: number[] = [];
  for (const t of times) {
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > MAX_DURATION_MS) continue;
    if (out.length > 0 && t <= (out.at(-1) as number)) continue;
    out.push(Math.round(t));
    if (out.length >= MAX_BEATS) break;
  }
  return out.length === 0 ? null : { bpm, times_ms: out };
}

/**
 * (Contract: `SongCueSchema` in @miyoria/contracts/events.)
 * `started`: the song became audible; `video` is the absolute path of its original video on the
 * streaming PC (inside the song worker's data dir) when it has one, and `offset_ms` how far into
 * the song it already was when the cue was sent; `duration_ms` is how long the song is (missing
 * from older publishers); `beats` its beat when the worker found one. `line`: a lyrics line
 * starts now (`text` may be empty: an instrumental break). `ended`: the song finished, was
 * stopped or failed.
 */
export type SongCue = SongCueData;

/** A `SongCue` from an untyped payload, or `null`. */
export function parseSongCue(payload: JsonValue): SongCue | null {
  if (!isJsonObject(payload)) return null;
  const song = typeof payload.song === "string" ? payload.song : null;
  if (song === null) return null;
  switch (payload.state) {
    case "started": {
      const cue: SongCue = {
        state: "started",
        song,
        title: typeof payload.title === "string" ? payload.title : "",
      };
      const { video, offset_ms: offset, duration_ms: duration } = payload;
      if (typeof video === "string" && video !== "" && video.length <= MAX_PATH) {
        cue.video = video;
        cue.offset_ms =
          typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, offset) : 0;
      }
      if (typeof duration === "number" && duration > 0 && duration <= MAX_DURATION_MS) {
        cue.duration_ms = Math.round(duration);
      }
      const beats = parseSongBeats(payload.beats);
      if (beats !== null) cue.beats = beats;
      return cue;
    }
    case "line":
      return {
        state: "line",
        song,
        index: typeof payload.index === "number" ? payload.index : 0,
        text: typeof payload.text === "string" ? payload.text : "",
      };
    case "ended":
      return {
        state: "ended",
        song,
        outcome: typeof payload.outcome === "string" ? payload.outcome : "",
      };
    default:
      return null;
  }
}

/**
 * The song the worker is preparing now (the one furthest along when several are), published by
 * the `sing` module whenever it changes: its set list number, title (untrusted, `""` until the
 * worker found it), the worker's `stage` (`queued`, `resolve`, `download`, `exclusive`,
 * `separate`, `convert`, `mix`, `lyrics`, `video`), `progress` of the whole job (0..1) and
 * `exclusive` (the job's GPU window: `waiting`, `offloading`, `active`, `reloading`, `done` or
 * `null`). `no: null`: nothing is being prepared.
 */
export type SongPrepare = SongPrepareData;

/** A `SongPrepare` from an untyped payload, or `null`. */
export function parseSongPrepare(payload: JsonValue): SongPrepare | null {
  if (!isJsonObject(payload)) return null;
  const { no, title, stage, progress, exclusive, by } = payload;
  if (no !== null && (typeof no !== "number" || !Number.isFinite(no))) return null;
  return {
    no,
    title: typeof title === "string" ? title : "",
    stage: typeof stage === "string" ? stage : "",
    progress:
      typeof progress === "number" && Number.isFinite(progress)
        ? Math.min(Math.max(progress, 0), 1)
        : 0,
    exclusive: typeof exclusive === "string" ? exclusive : null,
    ...(typeof by === "string" && by !== "" ? { by } : {}),
  };
}
