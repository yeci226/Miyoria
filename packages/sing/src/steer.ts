// Steer for the set list (docs/design/v3-architecture.md §10.6): changing a song that has not
// started, without starting over. A song is the task: `song:<no>`, open from the request until it
// starts (a song that is playing or over is "too late": changes happen between songs, never in
// the middle of one).
//
// A patch may change:
//
// * `position`: where the song stands among the songs still to sing (1 is next);
// * `next`: `true`, the same as `position: 1`;
// * `key`: the whole-song key in semitones (-6 to 6, as a request may ask).
//
// The song worker bakes the key in when it starts a job: `workers/sing/server.py` reads `req.key`
// once (it is part of the song id, `song_id(source, pitch, key)`), converts the vocals in a single
// `convert(..., shift, ...)` call whose only inputs while it runs are a progress callback and the
// cancel check, and mixes the instrumental with the same key afterwards. So the key cannot change
// in the middle of a conversion: a key change asks the worker for a new job (the downloaded and
// separated stems are cached per source, so only the conversion and the mix run again) and drops
// the old one.

import type { JsonObject, TaskId } from "@miyoria/types";
import type { SongNo } from "./setlist.js";

/** The task id of song `no`. */
export function songTask(no: SongNo): TaskId {
  return `song:${no}`;
}

/** The song number of a task id made by `songTask`, or `null`. */
export function songNo(task: TaskId): SongNo | null {
  const m = /^song:(\d{1,9})$/.exec(task);
  return m === null ? null : Number(m[1]);
}

/** What a steer of a song may change. */
export interface SongPatch {
  key?: number;
  position?: number;
}

/** Smallest and largest key a steer may ask for (the same as `sing.request`). */
export const KEY_RANGE = { min: -6, max: 6 } as const;

/** The patch of a steer, checked; the string is the reason it was refused. */
export function parseSongPatch(patch: JsonObject): SongPatch | string {
  const out: SongPatch = {};
  for (const [name, value] of Object.entries(patch)) {
    switch (name) {
      case "key":
        if (
          !Number.isInteger(value) ||
          (value as number) < KEY_RANGE.min ||
          (value as number) > KEY_RANGE.max
        ) {
          return `key 要是 ${KEY_RANGE.min} 到 ${KEY_RANGE.max} 的整數(半音)`;
        }
        out.key = value as number;
        break;
      case "position":
        if (!Number.isInteger(value) || (value as number) < 1)
          return "position 要是 1 以上的整數(1 是下一首)";
        if (out.position !== undefined) return "position 和 next 不能一起給";
        out.position = value as number;
        break;
      case "next":
        if (value !== true) return "next 只能是 true(要排到下一首)";
        if (out.position !== undefined) return "position 和 next 不能一起給";
        out.position = 1;
        break;
      default:
        return `歌只能改 key、position 或 next,不能改 ${name}`;
    }
  }
  return out.key === undefined && out.position === undefined ? "調整是空的" : out;
}
