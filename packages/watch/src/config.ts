import { z } from "zod";

/**
 * `[modules.watch]`: she watches a friend's Go Live, keeps short notes and speaks up now and
 * then. Off unless `enabled = true`.
 *
 * ```toml
 * [modules.watch]
 * enabled = true
 * snapshot_secs = 30
 * ```
 */
export const WatchConfigSchema = z.object({
  /** Seconds between two looks, counted from the end of the last one. */
  snapshot_secs: z.number().positive().default(30),
  /**
   * How much of each picture the model sees: `high` reads the text on screen (titles, names), `low`
   * (about 512 px, a third of the tokens) does not.
   */
  image_detail: z.enum(["low", "high", "auto"]).default("high"),
  /** Least seconds between two things she says on her own. */
  speak_min_secs: z.number().nonnegative().default(60),
  /** She stays quiet when someone spoke within this many seconds. */
  quiet_secs: z.number().nonnegative().default(10),
  /** Screen notes kept. */
  notes_keep: z.number().int().positive().default(10),
  /** Seconds of stream speech kept. */
  transcript_secs: z.number().positive().default(180),
  /** On her own, a watch lasts at least this long before she switches person. */
  min_watch_secs: z.number().nonnegative().default(180),
  /** Watches started an hour, whoever asked. */
  starts_per_hour: z.number().int().positive().default(6),
  /** Minutes a single watch lasts at most. */
  max_watch_mins: z.number().positive().default(120),
  /** Snapshot failures in a row that end the watch. */
  max_snapshot_failures: z.number().int().positive().default(5),
  /** Hours between two notices to the same person. */
  notice_hours: z.number().nonnegative().default(24),
});
export type WatchConfig = z.output<typeof WatchConfigSchema>;
