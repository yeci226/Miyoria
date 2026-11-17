// Which store her memory is read from and written to on an installation (v5-brain.md, Q10). The
// owner kept the old records and has her memory rebuilt into the notes from the event log; until
// that rebuild has run here, the notes hold only what the importer moved in, so she would wake up
// with an almost empty memory. The state is a setting the rebuild writes, never guessed from what
// the tables hold:
//
// - `started_at`: the first time `miyoria memory rebuild --apply` began here. Kept across
//   interrupted runs, so it is when the rebuild's own writes began.
// - `done_at`: when a run handled every segment of its plan. From then on the notes are the
//   source: the segment pass runs live, the old consolidation stops, and recall reads the notes.
// - `upto`: the time of the newest chat line the finished plan read. The live pass starts after
//   it in a session it has not read yet, so a line is not passed twice.
//
// A memory record whose id was made at `started_at` or later was written by the rebuild or by a
// live writer after it (record ids are ULIDs, which begin with the time they were made); an older
// one is the old consolidation's or older (`writtenSince`).

import type { SettingsStore } from "@miyoria/store";
import {
  isJsonObject,
  type ProfileId,
  type Timestamp,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";

/** The setting that holds `RebuildState`. */
export const REBUILD_STATE_KEY = "notes:rebuild";

export interface RebuildState {
  started_at: Timestamp;
  /** The rebuild's `since`. */
  since: Timestamp;
  done_at: Timestamp | null;
  upto: Timestamp | null;
}

/** The rebuild's state here; `null`: it never started. */
export async function rebuildState(
  settings: Pick<SettingsStore, "get">,
  profile: ProfileId,
): Promise<RebuildState | null> {
  const value = await settings.get(profile, REBUILD_STATE_KEY);
  if (!isJsonObject(value) || typeof value.started_at !== "string") return null;
  const at = (v: unknown): Timestamp | null =>
    typeof v === "string" && Number.isFinite(Date.parse(v)) ? toTimestamp(Date.parse(v)) : null;
  const started = at(value.started_at);
  if (started === null) return null;
  return {
    started_at: started,
    since: at(value.since) ?? started,
    done_at: at(value.done_at),
    upto: at(value.upto),
  };
}

function stored(state: RebuildState) {
  return {
    started_at: state.started_at,
    since: state.since,
    done_at: state.done_at,
    upto: state.upto,
  };
}

/** Records that a rebuild run begins at `now`; an earlier start is kept. */
export async function markRebuildStarted(
  settings: Pick<SettingsStore, "get" | "set">,
  profile: ProfileId,
  since: Timestamp,
  now: Timestamp,
): Promise<RebuildState> {
  const old = await rebuildState(settings, profile);
  const state: RebuildState = old ?? { started_at: now, since, done_at: null, upto: null };
  if (old === null) await settings.set(profile, REBUILD_STATE_KEY, stored(state));
  return state;
}

/** Records that a run finished its whole plan, which read chat lines up to `upto`. */
export async function markRebuilt(
  settings: Pick<SettingsStore, "get" | "set">,
  profile: ProfileId,
  since: Timestamp,
  upto: Timestamp,
  now: Timestamp,
): Promise<RebuildState> {
  const old = await rebuildState(settings, profile);
  const state: RebuildState = {
    started_at: old?.started_at ?? now,
    since: old?.since ?? since,
    done_at: now,
    upto:
      old !== null && old.upto !== null && timestampMs(old.upto) > timestampMs(upto)
        ? old.upto
        : upto,
  };
  await settings.set(profile, REBUILD_STATE_KEY, stored(state));
  return state;
}

/** Whether the notes are the source (`done_at` is set). */
export const switched = (state: RebuildState | null): boolean =>
  state !== null && state.done_at !== null;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The first 10 characters of a ULID made at `at` (its time part). */
export function ulidTime(at: Timestamp): string {
  let ms = Math.max(0, Math.floor(timestampMs(at)));
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = (CROCKFORD[ms % 32] as string) + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

/** Whether a record with ULID `id` was made at `at` or later. */
export function writtenSince(id: string, at: Timestamp): boolean {
  return id.slice(0, 10).toUpperCase() >= ulidTime(at);
}
