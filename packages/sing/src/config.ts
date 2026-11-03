import { z } from "zod";

/**
 * Permission nodes of the song capabilities and `/queue song ...`. Under `queue.*`, so
 * moderators have all of them; everyday users can request, list and ask her to start one.
 */
export const SingPermissionsSchema = z.object({
  request: z.string().default("queue.song.request"),
  list: z.string().default("queue.song.list"),
  play: z.string().default("queue.song.play"),
  skip: z.string().default("queue.song.skip"),
  stop: z.string().default("queue.song.stop"),
});
export type SingPermissions = z.output<typeof SingPermissionsSchema>;

/**
 * `[modules.sing]`: song requests sung in her voice (the song worker, `workers/sing`).
 *
 * ```toml
 * [modules.sing]
 * url = "http://127.0.0.1:8005"
 * start = "decide"
 * ```
 */
export const SingConfigSchema = z.object({
  /** Song worker base URL. */
  url: z.string().default("http://127.0.0.1:8005"),
  /** HTTP timeout of one worker call (fetching a song's audio gets 10x). */
  timeout_secs: z.number().positive().default(10),
  /** How often preparing songs are checked. */
  poll_ms: z.number().int().positive().default(1500),
  /** Songs preparing or ready at once, and per requester. */
  max_pending: z.number().int().positive().default(10),
  max_pending_per_user: z.number().int().positive().default(2),
  /** Longest song name / link accepted. */
  max_query_chars: z.number().int().positive().default(120),
  /**
   * When a song she agreed to prepare is ready: `decide` = her mind is told and she picks the
   * moment (`sing.play`; songs requested by command or through the request queue are always
   * sung as soon as she is free); `auto` = every ready song is sung as soon as she is free.
   * Without a running mind module, `decide` behaves like `auto`.
   */
  start: z.enum(["decide", "auto"]).default("decide"),
  /** A ready song she has not started is brought up to her again after this long. */
  remind_secs: z.number().nonnegative().default(60),
  /** After this many reminders (while she is in voice) the song starts on its own. */
  max_reminders: z.number().int().nonnegative().default(2),
  /**
   * `/queue song voteskip`: the song she is singing is skipped once this share of the people
   * listening in her voice channel voted (rounded up), and at least `vote_skip_min` votes.
   */
  vote_skip_ratio: z.number().min(0).max(1).default(0.25),
  vote_skip_min: z.number().int().min(1).default(1),
  /**
   * Before a song starts she finishes what she is saying (the turn that started it, then a
   * quiet moment of `quiet_ms`), at most this long.
   */
  announce_max_secs: z.number().nonnegative().default(20),
  quiet_ms: z.number().int().nonnegative().default(700),
  /** How far ahead of real time the song is streamed to the voice node (it buffers a minute). */
  lead_ms: z.number().int().positive().default(2000),
  /**
   * When the worker is set to take the whole GPU while it converts (`SING_OFFLOAD_URLS`: her
   * TTS and ASR go away for a minute or two), she first says she is off to prepare the song (an
   * initiative in her voice channel) and the worker waits until she finished, at most
   * `announce_max_secs`. Off: the worker takes the GPU at once.
   */
  prepare_notice: z.boolean().default(true),
  /** No second notice within this long of the last one (several songs in a row). */
  prepare_notice_gap_secs: z.number().nonnegative().default(180),
  /** Fade-out of a stopped song. */
  fade_ms: z.number().int().nonnegative().default(1500),
  /** Lyrics lines (when the worker found synced lyrics) become overlay subtitles. */
  lyrics: z.boolean().default(true),
  /**
   * While she sings a song with synced lyrics, one card shows the current line: in the channel
   * she last typed in on that server, else her voice channel's text chat.
   */
  lyrics_card: z.boolean().default(false),
  /**
   * The song's original video (when the worker has one) is shown, muted, on the stream while
   * she sings: the start cue carries its path for the Stage node, which plays it in OBS.
   */
  video: z.boolean().default(true),
  /**
   * The song worker's cache (`SING_DATA_DIR`) as the Stage node sees it (same machine),
   * relative to the directory of `miyoria.toml`. Video paths outside it are never sent.
   */
  video_dir: z.string().default("data/songs"),
  /** Her mouth follows the converted vocal stem instead of the whole mix. */
  lip_sync_vocals: z.boolean().default(true),
  /** Finished songs kept in the list. */
  history: z.number().int().nonnegative().default(10),
  /** `[modules.queue]` items of this kind are sung when they are called (`/queue manage next`). */
  queue_kind: z.string().default("song"),
  permissions: SingPermissionsSchema.prefault({}),
});
export type SingConfig = z.output<typeof SingConfigSchema>;

export function defaultSingConfig(): SingConfig {
  return SingConfigSchema.parse({});
}
