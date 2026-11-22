import { setting, settingGroups } from "@miyoria/runtime/kernel";
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
 *
 * `url` and `fallback_urls` are read by Core's wiring, not by the module: they become the static
 * entries `sing`, `sing.fallback.1`, ... of the endpoint registry, in this order, and the module
 * uses the registry's `sing` endpoints. Neither has a default address any more.
 */
export const SingConfigSchema = z
  .object({
    /** Song worker base URL (a static registry entry). Not set: the workers come from hostd. */
    url: z.string().optional(),
    /**
     * More song workers, tried in this order when `url` does not answer (its computer is off, or
     * off the tailnet): new songs go to the first one that answers, and a song stays with the
     * worker that made it. E.g. `url` = a friend's GPU over Tailscale, `fallback_urls` = the
     * worker on this machine (`docs/sing-remote-host.md`). The same address twice is used once.
     */
    fallback_urls: z.array(z.url()).default([]),
    /**
     * With `fallback_urls`: an unreachable worker is passed over this long before it is tried
     * again, and a song whose worker is still unreachable after this long is made on the next one.
     */
    fallback_retry_secs: z.number().positive().default(30),
    /** HTTP timeout of one worker call (files are bounded by `fetch_stall_secs` instead). */
    timeout_secs: z.number().positive().default(10),
    /**
     * A file from the worker (a song's audio or video, a karaoke song's files) is given up when no
     * byte of it came for this long, however long the whole file takes on a slow link.
     */
    fetch_stall_secs: z.number().positive().default(30),
    /**
     * Where Core keeps the songs' audio once the worker made them (relative to the directory of
     * `miyoria.toml`): a song is ready once its audio is here, and is sung from here. A worker on
     * this machine (`video_dir`) is read in place instead. While a worker answers, the songs it
     * made are copied here too (within `audio_cache_mb`, none pushed out for them); while none
     * answers, she can still sing the songs here (her prompt lists them), only no new ones.
     */
    audio_dir: z.string().default("data/song-audio"),
    /**
     * The budget of `audio_dir` in MB (a minute of song is about 6 MB, 12 with the vocals): the
     * songs sung longest ago go first, never one still in the set list.
     */
    audio_cache_mb: z.number().positive().default(2048),
    /** How often preparing songs are checked. */
    poll_ms: z.number().int().positive().default(1500),
    /** Songs preparing or ready at once, and per requester. */
    max_pending: z.number().int().positive().default(10),
    max_pending_per_user: z
      .number()
      .int()
      .positive()
      .default(2)
      .meta(
        setting({
          kind: "number",
          label: "每人同時幾首",
          help: "一個人同時在準備或等著唱的歌最多幾首",
          group: "songs",
        }),
      ),
    /** Longest song name / link accepted. */
    max_query_chars: z.number().int().positive().default(120),
    /**
     * When a song she agreed to prepare is ready: `decide` = her mind is told and she picks the
     * moment (`sing.play`; songs requested by command or through the request queue are always
     * sung as soon as she is free); `auto` = every ready song is sung as soon as she is free.
     * Without a running mind module, `decide` behaves like `auto`.
     */
    start: z
      .enum(["decide", "auto"])
      .default("decide")
      .meta(
        setting({
          kind: "select",
          label: "準備好的歌",
          labels: { decide: "她挑時機", auto: "空下來就唱" },
          group: "songs",
        }),
      ),
    /** A ready song she has not started is brought up to her again after this long. */
    remind_secs: z.number().nonnegative().default(60),
    /** After this many reminders (while she is in voice) the song starts on its own. */
    max_reminders: z.number().int().nonnegative().default(2),
    /**
     * While she plays a game, a ready song does not start on its own (songs from the request
     * queue included; an owner's command still does): she is reminded every `busy_remind_secs`
     * and picks the moment, and only after `busy_max_wait_mins` it starts anyway.
     */
    busy_remind_secs: z.number().positive().default(300),
    busy_max_wait_mins: z.number().positive().default(20),
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
    /**
     * A song that starts on its own waits this long for the Arbiter's word on her opening line (the
     * turn that says it, which it then waits for, or a refusal); past it the line is expired, the
     * song starts and nothing is said late.
     */
    opening_window_ms: z.number().int().positive().default(6000),
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
     * The song's original video (when the worker has one) is shown, muted, on the stream while
     * she sings: the start cue carries its path for the Stage node, which plays it in OBS.
     */
    video: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "播原曲影片",
          help: "唱歌時在直播畫面靜音播放原曲的影片",
          group: "songs",
        }),
      ),
    /**
     * The song worker's cache (`SING_DATA_DIR`) as the Stage node sees it (same machine),
     * relative to the directory of `miyoria.toml`. Video paths outside it are never sent.
     */
    video_dir: z.string().default("data/songs"),
    /**
     * Where Core gets a song's video: `worker` = from the song worker that made it (over its link,
     * slow when the worker is on another machine); `local` = Core downloads it from the song's
     * link itself with yt-dlp (`ytdlp_path`), and asks the worker only when that fails. Either
     * way only songs the worker found a video for get one (audio-only sources stay without).
     */
    video_source: z.enum(["worker", "local"]).default("worker"),
    /** The yt-dlp executable for `video_source = "local"` (a name on PATH or a full path). */
    ytdlp_path: z.string().min(1).default("yt-dlp"),
    /** `video_source = "local"`: the tallest video taken, and no file over this many MB. */
    video_max_height: z.number().int().positive().default(1080),
    video_max_mb: z.number().int().positive().default(300),
    /** Her mouth follows the converted vocal stem instead of the whole mix. */
    lip_sync_vocals: z.boolean().default(true),
    /**
     * Songs she prepares for herself (`practice`, v4 §8.1) at once. They are never sung on their
     * own and do not count toward anyone's limit.
     */
    max_practice: z.number().int().nonnegative().default(2),
    /**
     * Song clips for the party game that guesses songs (`SongClipsKey`): off = the game is off.
     * `clip_wait_ms`: a clip starts after she finished the line she is saying, or this long after
     * it was asked for if she says nothing. `clip_refresh_secs`: how often the worker's library is
     * read again.
     */
    clips: z.boolean().default(true),
    clip_wait_ms: z.number().int().nonnegative().default(1500),
    clip_refresh_secs: z.number().positive().default(60),
    /** Finished songs kept in the list. */
    history: z.number().int().nonnegative().default(10),
    /** `[modules.queue]` items of this kind are sung when they are called (`/queue manage next`). */
    queue_kind: z.string().default("song"),
    permissions: SingPermissionsSchema.prefault({}),
  })
  .meta(settingGroups([{ id: "songs", label: "點歌" }]));
export type SingConfig = z.output<typeof SingConfigSchema>;
