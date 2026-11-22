import { z } from "zod";
import { WorkersHealthSchema } from "./common.js";
import { WorkersKaraokeLyricsOptionsSchema, WorkersKaraokeSongSchema } from "./karaoke.js";

// The song worker (`workers/sing/server.py`). Most of what it answers is read leniently: a field a
// worker predating it does not send, or sends in an unexpected form, falls back to the value after
// `.catch`, so that one odd field never costs her the song. The Python side always sends more than
// is described here; the extra keys are not read by anyone and are left out on purpose.

/** `backing`: what becomes of a song's own backing voices (harmonies, doubles, ad-libs). Each mode is a song of its own in the worker. */
export const WorkersSingBackingSchema = z
  .enum(["keep", "drop", "convert", "acapella"])
  .meta({ id: "WorkersSingBacking" });
export type WorkersSingBacking = z.output<typeof WorkersSingBackingSchema>;

/** The body of `POST /jobs`: exactly one of `query`, `url` and `path`. */
export const WorkersSingJobRequestSchema = z
  .object({
    /** A search (`ytsearch1:`). */
    query: z.string().max(200).nullable().optional(),
    /** A link; only hosts of `SING_URL_HOSTS`. */
    url: z.string().max(500).nullable().optional(),
    /** A path in the worker's song library. */
    path: z.string().max(300).nullable().optional(),
    title: z.string().max(120).nullable().optional(),
    artist: z.string().max(120).nullable().optional(),
    /** Vocal shift in semitones; left out, the worker picks the octave. */
    pitch: z.number().int().min(-24).max(24).nullable().optional(),
    /** Whole-song transposition in semitones (her voice follows); turns the auto key off. */
    key: z.number().int().min(-12).max(12).default(0),
    /** Left out: `keep`. */
    backing: WorkersSingBackingSchema.default("keep"),
    /** Make the song again even when it is cached. */
    force: z.boolean().default(false),
    /** The worker waits for `POST /jobs/{id}/exclusive` before it takes the GPU (she says she is off first). */
    exclusive_ack: z.boolean().default(false),
    /**
     * `cover`: a song in her voice. `karaoke`: the backing track and the reference to sing over
     * (`karaoke.ts`); no conversion, `pitch`, `key` and `backing` are not read.
     */
    purpose: z.enum(["cover", "karaoke"]).default("cover"),
    /** A karaoke job: how its lyrics are checked and aligned; left out, the worker's defaults. */
    karaoke_lyrics: WorkersKaraokeLyricsOptionsSchema.nullable().optional(),
    /**
     * A karaoke job: keep the source's picture as the song's background video (`video.mp4`, at
     * most 720p, no sound). Left out: yes (when the worker has videos on, `SING_VIDEO`).
     */
    karaoke_video: z.boolean().default(true),
  })
  .meta({ id: "WorkersSingJobRequest" });
export type WorkersSingJobRequest = z.output<typeof WorkersSingJobRequestSchema>;
/** What a sender writes: the fields with a default may be left out. */
export type WorkersSingJobRequestIn = z.input<typeof WorkersSingJobRequestSchema>;

/**
 * The body of `POST /gpu/context`: what only Core knows, for the worker's GPU decisions. Sent on
 * every poll; without it for a while the worker assumes people are listening.
 */
export const WorkersSingGpuContextSchema = z
  .object({
    in_voice: z.boolean().default(false),
    /** People in her voice channels who can hear her. */
    listeners: z.number().int().min(0).default(0),
    /** Go Live or OBS is on: there are viewers, however many. */
    live: z.boolean().default(false),
    /** Jobs of songs that are sung as soon as they are ready. */
    urgent: z.array(z.string()).max(200).default([]),
  })
  .meta({ id: "WorkersSingGpuContext" });
export type WorkersSingGpuContext = z.output<typeof WorkersSingGpuContextSchema>;

/** The answer to `POST /gpu/context`. */
export const WorkersSingOkSchema = z.object({ ok: z.boolean() }).meta({ id: "WorkersSingOk" });
export type WorkersSingOk = z.output<typeof WorkersSingOkSchema>;

/** A line of lyrics: `t` seconds from the start of the playback. */
export const WorkersSingLyricLineSchema = z
  .object({ t: z.number(), text: z.string() })
  .meta({ id: "WorkersSingLyricLine" });
export type WorkersSingLyricLine = z.output<typeof WorkersSingLyricLineSchema>;

/**
 * A finished song (`meta.json` of the song). Everything about it (title, artist, lyrics) comes
 * from YouTube or lrclib and is untrusted. The worker also sends `lead_split`, `mix`, `engine`,
 * `gpu`, `lyrics_input`, `created_at` and more in the song and in `lyrics` (`provider`,
 * `how`, `confidence`, `checks`, `plain`, ...); nothing reads them here.
 */
export const WorkersSingSongMetaSchema = z
  .object({
    id: z.string(),
    title: z.string().catch(""),
    artist: z.string().nullable().catch(null),
    duration_s: z.number().nullable().catch(null),
    lyrics: z
      .object({
        synced: z.boolean().catch(false),
        lines: z.array(WorkersSingLyricLineSchema).catch([]),
      })
      .nullable()
      .catch(null),
    play: z.object({
      sample_rate: z.number().int().positive(),
      samples: z.number().int().nullable(),
    }),
    /** The pitch decisions (`octave_shift`, `auto_key`, `song_key`, `vocal_shift`, ...). */
    pitch: z.record(z.string(), z.unknown()).catch({}),
    /** Seconds per stage. */
    timings: z.record(z.string(), z.number()).catch({}),
    peak_vram_mb: z.number().nullable().catch(null),
    /** Its original video sits in the song's cache dir as `video.file` (older workers: none). */
    has_video: z.boolean().catch(false),
    video: z.object({ file: z.string() }).nullable().catch(null),
    /**
     * What the song was made from: `kind` (`youtube`, `url`, `library`, `mock`) and its link (`null`
     * for a library file). Untrusted like the rest; older Cores dropped it, so a stored song may
     * have none.
     */
    source: z
      .object({ kind: z.string().catch(""), url: z.string().nullable().catch(null) })
      .nullable()
      .catch(null)
      .optional(),
    /**
     * What became of the song's backing voices: the request's `backing`, or `in_vocal` when
     * there was no lead split, so they stay in the converted vocal (`acapella` has no instrumental).
     */
    backing: z.string().optional().catch(undefined),
    /** Its beat: tempo and beat times in seconds from the start of the playback (older workers: none). */
    beats: z
      .object({ bpm: z.number(), times: z.array(z.number()) })
      .nullable()
      .catch(null)
      .optional(),
  })
  .meta({ id: "WorkersSingSongMeta" });
export type WorkersSingSongMeta = z.output<typeof WorkersSingSongMetaSchema>;

/**
 * Where the worker runs a job and why (`workers/sing/gpu.py`): decided before every GPU stage and
 * again while it runs. `reason` is written for people, and for her. The worker also sends
 * `headroom_mb`, `speech_loaded`, `people`, `urgent` and `steps`; nothing reads them here.
 */
export const WorkersSingGpuStatusSchema = z
  .object({
    policy: z.string().catch("auto"),
    stage: z.string().catch(""),
    /** `share`, `offload`, `exclusive`, `wait`, `cpu` or `give_up`. */
    mode: z.string().nullable().catch(null),
    code: z.string().nullable().catch(null),
    reason: z.string().nullable().catch(null),
    free_mb: z.number().nullable().catch(null),
    total_mb: z.number().nullable().catch(null),
    need_mb: z.number().nullable().catch(null),
    step_s: z.number().nullable().catch(null),
    baseline_s: z.number().nullable().catch(null),
    spilling: z.boolean().catch(false),
    spills: z.number().catch(0),
    waited_s: z.number().catch(0),
    silenced_s: z.number().catch(0),
    /** How long her voice would be gone if it went now, reload included. */
    silence_est_s: z.number().nullable().catch(null),
    silence_max_s: z.number().nullable().catch(null),
  })
  .meta({ id: "WorkersSingGpuStatus" });
export type WorkersSingGpuStatus = z.output<typeof WorkersSingGpuStatusSchema>;

/**
 * One job. The worker also sends `request`, `created_at`, `started_at`, `finished_at`, `video`
 * (`{state, progress, error}` while the video is fetched), `exclusive_info` and `yielded`; nothing
 * reads them here.
 */
export const WorkersSingJobSchema = z
  .object({
    id: z.string(),
    state: z.enum(["queued", "running", "done", "failed", "cancelled"]),
    /** `resolve`, `download`, `exclusive`, `separate`, `convert`, `mix`, `lyrics`, `video`, ... */
    stage: z.string().catch(""),
    progress: z.number().catch(0),
    error: z.string().nullable().catch(null),
    song_id: z.string().nullable().catch(null),
    cached: z.boolean().catch(false),
    /** Place in the queue; `null` when it is not waiting. */
    position: z.number().nullable().catch(null),
    source: z
      .object({ title: z.string().catch(""), artist: z.string().nullable().catch(null) })
      .nullable()
      .catch(null),
    /** The song's meta, once the job is `done`. */
    song: WorkersSingSongMetaSchema.nullable().catch(null),
    /**
     * The job has the GPU to itself (the TTS / ASR workers offloaded): `waiting` for our go,
     * `offloading`, `active`, `reloading`, `done`; `shared`: it runs next to them, speech goes on;
     * `null` when it does not need it (older workers: always `null`).
     */
    exclusive: z
      .enum(["waiting", "offloading", "active", "reloading", "done", "shared"])
      .nullable()
      .catch(null),
    gpu: WorkersSingGpuStatusSchema.nullable().catch(null),
    /** A karaoke job (`purpose: "karaoke"`) once it is `done`: its karaoke song (`song_id` stays `null`). */
    karaoke: WorkersKaraokeSongSchema.nullable().catch(null).optional(),
  })
  .meta({ id: "WorkersSingJob" });
export type WorkersSingJob = z.output<typeof WorkersSingJobSchema>;

/** The answer to `POST /jobs`, `GET /jobs/{id}`, `DELETE /jobs/{id}` and `POST /jobs/{id}/exclusive`. */
export const WorkersSingJobReplySchema = z
  .object({ job: WorkersSingJobSchema })
  .meta({ id: "WorkersSingJobReply" });
export type WorkersSingJobReply = z.output<typeof WorkersSingJobReplySchema>;

/** The answer to `GET /jobs`, newest first. */
export const WorkersSingJobsReplySchema = z
  .object({ jobs: z.array(WorkersSingJobSchema) })
  .meta({ id: "WorkersSingJobsReply" });
export type WorkersSingJobsReply = z.output<typeof WorkersSingJobsReplySchema>;

/** The answer to `GET /songs`: the finished songs, newest first. */
export const WorkersSingSongsReplySchema = z
  .object({ songs: z.array(WorkersSingSongMetaSchema) })
  .meta({ id: "WorkersSingSongsReply" });
export type WorkersSingSongsReply = z.output<typeof WorkersSingSongsReplySchema>;

/** The answer to `GET /songs/{id}`. */
export const WorkersSingSongReplySchema = z
  .object({ song: WorkersSingSongMetaSchema })
  .meta({ id: "WorkersSingSongReply" });
export type WorkersSingSongReply = z.output<typeof WorkersSingSongReplySchema>;

/** The body of `POST /songs/{id}/lyrics` (it may be left out): look the lyrics up again, without new audio. */
export const WorkersSingLyricsRequestSchema = z
  .object({
    /** The owner's own reading of the song, tried first. */
    title: z.string().max(200).nullable().optional(),
    artist: z.string().max(200).nullable().optional(),
    /** Ask the language model again instead of using its cached answer. */
    fresh: z.boolean().default(false),
  })
  .meta({ id: "WorkersSingLyricsRequest" });
export type WorkersSingLyricsRequest = z.output<typeof WorkersSingLyricsRequestSchema>;

/** The answer to `POST /songs/{id}/lyrics`. The lyrics come without their lines. */
export const WorkersSingLyricsReplySchema = z
  .object({
    found: z.boolean(),
    /** Found: what the song had before. */
    previous: z
      .object({ provider: z.string().nullable(), track: z.string().nullable() })
      .optional(),
    /** Not found: whether the song kept the lyrics it had. */
    kept: z.boolean().optional(),
    /** The song's `lyrics` without `lines`; `null` when it has none. */
    lyrics: z.record(z.string(), z.unknown()).nullable().optional(),
    /** Found: how many lines the new lyrics have. */
    lines: z.number().int().optional(),
  })
  .meta({ id: "WorkersSingLyricsReply" });
export type WorkersSingLyricsReply = z.output<typeof WorkersSingLyricsReplySchema>;

/** The body of `POST /cache/prune` (it may be left out; `?dry_run=true` does the same). */
export const WorkersSingPruneRequestSchema = z
  .object({
    /** Only say what would go. */
    dry_run: z.boolean().default(false),
  })
  .meta({ id: "WorkersSingPruneRequest" });
export type WorkersSingPruneRequest = z.output<typeof WorkersSingPruneRequestSchema>;

/** One entry of the worker's own song folder. */
export const WorkersSingLibraryEntrySchema = z
  .object({
    /** Relative to the library folder. */
    path: z.string(),
    title: z.string(),
    artist: z.string().nullable(),
    /** A folder that already has `vocals.*` and `instrumental.*`. */
    split: z.boolean(),
  })
  .meta({ id: "WorkersSingLibraryEntry" });
export type WorkersSingLibraryEntry = z.output<typeof WorkersSingLibraryEntrySchema>;

/** The answer to `GET /library`. */
export const WorkersSingLibrarySchema = z
  .object({ entries: z.array(WorkersSingLibraryEntrySchema) })
  .meta({ id: "WorkersSingLibrary" });
export type WorkersSingLibrary = z.output<typeof WorkersSingLibrarySchema>;

/** `GET /health` of the song worker. */
export const WorkersSingHealthSchema = WorkersHealthSchema.extend({
  model: z.string().optional(),
  device: z.string().optional(),
  /** The engine (`SING_BACKEND`): `seed-vc` by default, `mock` in tests. */
  backend: z.string().optional(),
  /** A job is running. */
  busy: z.boolean().optional(),
  /** Jobs waiting. */
  queued: z.number().int().optional(),
  /** Allocated by the process (torch), in MB; left out without CUDA. */
  vram_allocated_mb: z.number().optional(),
  gpu: z
    .object({
      /** `yield` (default), `auto`, `share`, `wait` or `offload` (`SING_GPU_POLICY`). */
      policy: z.string(),
      policy_source: z.string().optional(),
      cuda: z.boolean(),
      total_mb: z.number().nullable(),
      free_mb: z.number().nullable(),
      headroom_mb: z.number().nullable().optional(),
      /** What Core last said (`POST /gpu/context`). */
      audience: z.object({
        in_voice: z.boolean(),
        listeners: z.number(),
        live: z.boolean(),
        age_s: z.number().nullable(),
        fresh: z.boolean(),
      }),
      /** What the worker has learned about this card. */
      learned: z.record(z.string(), z.unknown()),
      /** The running job's decision; `null` when none runs. */
      job: WorkersSingGpuStatusSchema.nullable(),
    })
    .optional(),
}).meta({ id: "WorkersSingHealth" });
export type WorkersSingHealth = z.output<typeof WorkersSingHealthSchema>;
