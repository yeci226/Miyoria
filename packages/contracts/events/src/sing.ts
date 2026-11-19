// Her songs on the bus (docs/design/v5-contracts.md §3, K12a): the cues the `sing` module
// publishes while she sings (the stage forwards them to the overlay, the avatar and OBS), and the
// song the worker is preparing. Each type is the bus topic it is published on, and its payload is
// that event's data.
//
// Cues and preparation progress are ticks of the stage: ambient observations (`ambient`, folded
// into daily counts after 14 days). No default scope: the video path of a cue is a path on the
// streaming PC, which the session decides who may see.

import { z } from "zod";
import { defineEvent } from "./registry.js";

/** The beat of a song: its tempo and when each beat falls, in ms from the start (sorted). */
export const SongBeatsSchema = z
  .object({ bpm: z.number(), times_ms: z.array(z.number()) })
  .meta({ id: "EventsSongBeats" });

/**
 * A song cue: `sing.cue`. `started`: the song became audible, `video` is the absolute path of its
 * original video on the streaming PC when it has one (with `offset_ms`, how far into the song it
 * already was), `duration_ms` how long it is, `beats` its beat when the worker found one. `line`:
 * a lyrics line starts now (`text` may be empty: an instrumental break). `ended`: the song
 * finished, was stopped or failed (`outcome`).
 */
export const SongCueSchema = z
  .discriminatedUnion("state", [
    z.object({
      state: z.literal("started"),
      song: z.string(),
      title: z.string(),
      video: z.string().optional(),
      offset_ms: z.number().optional(),
      duration_ms: z.number().optional(),
      beats: SongBeatsSchema.optional(),
    }),
    z.object({
      state: z.literal("line"),
      song: z.string(),
      index: z.number(),
      text: z.string(),
    }),
    z.object({ state: z.literal("ended"), song: z.string(), outcome: z.string() }),
  ])
  .meta({ id: "EventsSongCue" });
export type SongCueData = z.output<typeof SongCueSchema>;

/**
 * Every stage the song worker reports (`workers/sing/server.py`), in no order: `queued` (waits for
 * its turn), `resolve`, `download`, `exclusive` / `gpu_wait` (hands the card over, waits for room on
 * it), `separate`, `lead`, `convert`, `convert_backing`, `mix`, `beats`, `lyrics`, `video`, and for a
 * karaoke song `reference`, `encode`, `lyrics_asr`, `lyrics_align`; and the two the `sing` module
 * itself reports: `fetch` (the worker made the song, its audio is on its way to Core) and
 * `unreachable` (the worker stopped answering). The overlay says each in words
 * (`packages/stage/src/link/activity.ts`); a test fails when this list, the worker and those words
 * drift apart. `SongPrepare.stage` stays a plain string: a newer worker may report one not listed.
 */
export const SONG_PREPARE_STAGES = [
  "queued",
  "resolve",
  "download",
  "exclusive",
  "gpu_wait",
  "separate",
  "lead",
  "convert",
  "convert_backing",
  "mix",
  "beats",
  "lyrics",
  "video",
  "reference",
  "encode",
  "lyrics_asr",
  "lyrics_align",
  "fetch",
  "unreachable",
] as const;

/**
 * The song the worker is preparing now, whenever it changes: `sing.prepare`. `no: null`: nothing
 * is being prepared. `stage` is the worker's (`SONG_PREPARE_STAGES`), `progress` that of the whole
 * job (0..1, never backwards while the song stays the same), `exclusive` the job's GPU window
 * (`waiting`, `offloading`, `active`, `reloading`, `done`), `by` who asked for it (untrusted; left
 * out when nobody did).
 */
export const SongPrepareSchema = z
  .object({
    /** Its set list number. */
    no: z.number().nullable(),
    /** Untrusted; `""` until the worker found it. */
    title: z.string(),
    stage: z.string(),
    progress: z.number(),
    exclusive: z.string().nullable(),
    by: z.string().optional(),
  })
  .meta({ id: "EventsSongPrepare" });
export type SongPrepareData = z.output<typeof SongPrepareSchema>;

export const SingCue = defineEvent({
  type: "sing.cue",
  v: 1,
  data: SongCueSchema,
  tier: "ambient",
});

export const SingPrepare = defineEvent({
  type: "sing.prepare",
  v: 1,
  data: SongPrepareSchema,
  tier: "ambient",
});

/** Every song type. */
export const SING_EVENTS = [SingCue, SingPrepare] as const;
