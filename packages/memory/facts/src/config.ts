import { z } from "zod";

/** `[modules.facts]`. */
export const FactsConfigSchema = z.object({
  /** How often the buffered events are written (one transaction per write). */
  flush_ms: z.number().int().positive().default(500),
  /** Events kept in memory for `recent` and fast `get`. */
  hot_events: z.number().int().positive().default(2_000),
  /** Events held for the store while it fails; past this the oldest are dropped. */
  max_buffer: z.number().int().positive().default(20_000),
  /** How far back the projections read the log when the module starts. */
  rebuild_days: z.number().positive().default(7),
  /** How often compaction runs. */
  compact_every_mins: z.number().positive().default(60),
  /** Rows one compaction pass deletes at most (a pass blocks whatever else uses the store). */
  compact_max_rows: z.number().int().positive().default(2_000),
  /**
   * How often the artifact store is swept: expired artifacts are marked deleted and their shares
   * revoked, and rows, blobs and stray files past the store's grace are removed.
   */
  artifact_sweep_hours: z.number().positive().default(24),
  /**
   * How often the transcripts are swept (0: never): entries a compaction summary covers are
   * deleted once past `transcript_covered_days`, and a session nothing was said in for
   * `transcript_idle_days` goes whole. The entries after the summary in use are never swept.
   */
  transcript_sweep_hours: z.number().nonnegative().default(24),
  /** Entries a summary covers are kept this long (the raw lines stay in the event log). */
  transcript_covered_days: z.number().positive().default(30),
  /** A session's whole transcript is deleted after this many days without a line. */
  transcript_idle_days: z.number().positive().default(90),
  /** Ambient observations (tier `ambient`) older than this are folded into per-day counts. */
  fold_after_days: z.number().positive().default(14),
  /** Turn internals and the rest of tier `short` older than this go (0: never). */
  short_days: z.number().nonnegative().default(90),
  /** What people said and her lines (tier `long`) older than this go (0: never). */
  long_days: z.number().nonnegative().default(365),
  /** Entries of an `append-self` bucket. */
  bucket_entries: z.number().int().positive().default(20),
  /** Characters of one bucket entry. */
  bucket_chars: z.number().int().positive().default(400),
  /** How long after a delivery someone speaking counts as answering it. */
  answer_window_secs: z.number().positive().default(60),
  /** A line that got no answer from the outside for this long failed. */
  line_ack_timeout_secs: z.number().positive().default(300),
  /**
   * A game event again after this long is a new revision of it. Keep it equal to
   * `[modules.game] narration_repeat_mins` until the narration stop-gap is gone.
   */
  event_repeat_mins: z.number().positive().default(45),
  /** The same for `hazard_events` (`[modules.game] hazard_repeat_secs`). */
  hazard_repeat_secs: z.number().positive().default(120),
  /** Game events that come and go instead of happening once. */
  hazard_events: z.array(z.string()).default(["damage", "hostile_near", "reflex"]),
  /** Damage at or above this in one hit is notable (a Minecraft heart is 2). */
  big_damage: z.number().positive().default(6),
});

export type FactsConfig = z.output<typeof FactsConfigSchema>;

export function defaultFactsConfig(): FactsConfig {
  return FactsConfigSchema.parse({});
}
