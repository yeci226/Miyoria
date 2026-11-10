import { z } from "zod";

/** `[x0, y0, x1, y1]` on the video frame, each 0..1, origin top-left; `[]` = never chosen. */
const Rect = z.array(z.number().min(0).max(1)).refine(
  (r) => {
    if (r.length === 0) return true;
    const [x0, y0, x1, y1] = r;
    return r.length === 4 && (x0 ?? 1) < (x1 ?? 0) && (y0 ?? 1) < (y1 ?? 0);
  },
  {
    message: "a rect is [x0, y0, x1, y1] in 0..1 with x0 < x1 and y0 < y1, or empty",
  },
);

const HttpUrl = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "must be an http(s) URL" },
);

/** `[modules.live.video]`: her picture from OBS through MediaMTX, and what a touch on it lands on. */
export const LiveVideoConfigSchema = z.object({
  /** Off: no video, the page keeps the drawn figure. */
  enabled: z.boolean().default(false),
  /** Base URL of the path's LL-HLS files, ending with `/`. */
  hls: HttpUrl.refine((u) => u.endsWith("/"), { message: "must end with /" }).default(
    "http://127.0.0.1:8888/live/miyoria/",
  ),
  /** MediaMTX control API, polled to know whether OBS is publishing. */
  api: HttpUrl.default("http://127.0.0.1:9997"),
  /** The MediaMTX path OBS publishes to. */
  path: z.string().min(1).max(200).default("live/miyoria"),
  /**
   * MediaMTX's `hlsCDNSecret` (env `MTX_HLSCDNSECRET`): sent upstream as a Bearer token so its HLS
   * needs no cookies. Required for video: enabled without it stays off (with a warning). Never
   * logged, never sent to a browser.
   */
  secret: z.string().max(512).default(""),
  poll_ms: z.number().int().min(500).max(60_000).default(2_000),
  /** Where her head, face and body are on the frame; face wins over head wins over body. */
  head: Rect.default([0.62, 0.1, 0.88, 0.38]),
  face: Rect.default([0.67, 0.22, 0.83, 0.4]),
  body: Rect.default([0.58, 0.35, 0.92, 1.0]),
});

export type LiveVideoConfig = z.output<typeof LiveVideoConfigSchema>;

/**
 * `[modules.live]`: the live page's feed and its head-pats (docs/design/v4-plan.md §9.2).
 *
 * The feed itself changes nothing about her: it only shows what already happened, so it runs by
 * default and shows her place, activity and face. Her words appear only from channels listed in
 * `channels`, and pats reach her only with `pats = true`.
 *
 * ```toml
 * [modules.live]
 * # Channels (text or voice, by id) whose lines may appear on the page, for anyone to read.
 * channels = ["123456789012345678"]
 * # Members may pat her head from the page; each batch becomes an Observation she may react to.
 * pats = true
 * ```
 */
export const LiveConfigSchema = z.object({
  /**
   * Channel ids (Discord snowflakes) whose lines may be shown. A line from anywhere else (another
   * channel, a thread not listed by its own id, a DM) never reaches the page. Empty: no words at
   * all, only her place, activity and face.
   */
  channels: z
    .array(z.string().regex(/^\d{1,24}$/))
    .max(50)
    .default([]),
  /** Most pages watching at once; one more is turned away until someone leaves. */
  max_viewers: z.number().int().min(1).max(10_000).default(500),
  /**
   * Members may pat her from the page. Off: the page shows the hand as closed and nothing a
   * visitor does reaches her.
   */
  pats: z.boolean().default(false),
  /**
   * How a batch of pats is written. `ambient`: she knows (her working context), and may bring it
   * up when she talks anyway. `notable`: a batch may also ask for the mic, which needs the
   * arbiter to take observations of `live.pat` (see the module's integration note).
   */
  pat_salience: z.enum(["ambient", "notable"]).default("ambient"),
  /** Pats arriving this close after the first one of a batch go into the same Observation. */
  coalesce_secs: z.number().int().min(2).max(600).default(20),
  /** Pats one person may give per minute. */
  per_person_per_minute: z.number().int().min(1).max(120).default(10),
  /** Pats everyone together may give per minute. */
  per_minute: z.number().int().min(1).max(10_000).default(120),
  video: LiveVideoConfigSchema.prefault({}),
});

export type LiveConfig = z.output<typeof LiveConfigSchema>;
