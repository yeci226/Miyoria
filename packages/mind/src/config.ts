// `[modules.mind]`: only caps and plumbing. How often she wants to think, what she feels and
// what she does are hers; the numbers here bound the cost and the noise.

import { z } from "zod";

const count = () => z.number().int().nonnegative();
const fraction = () => z.number().min(0).max(1);

/**
 * ```toml
 * [modules.mind]
 * max_calls_per_hour = 12
 * min_interval_secs = 45
 * ```
 */
export const MindConfigSchema = z.object({
  /**
   * Model chain of her Deliberate calls (falls back to `chat` with a warning). How deeply each
   * call reasons is `[llm.reasoning]`'s `appraise` / `plan` / `plan_daily`.
   */
  purpose: z.string().default("mind"),
  /** At most this many Plan calls in any rolling hour (every wake counts). */
  max_calls_per_hour: count().default(12),
  /** At least this long between two Plan calls. */
  min_interval_secs: count().default(45),
  /** Her idle Plan heartbeat (no boredom, no drive gap). */
  heartbeat_mins: z.number().positive().default(15),
  /** The fastest it gets when she is bored or a need is unmet. */
  min_heartbeat_mins: z.number().positive().default(4),
  /** It is never sparser than this (empty Plan runs make it sparser up to here). */
  max_heartbeat_mins: z.number().positive().default(30),
  /** Wakes arriving within this window are planned about together. */
  coalesce_ms: count().default(3000),
  /** One call may take this long. */
  timeout_ms: count().default(90_000),
  /** Output tokens of a Plan call. */
  max_tokens: count().default(3000),
  /** Impulses one Plan may produce; more are dropped. */
  max_intents: count().default(2),
  /** Thoughts kept raw in her journal (the panel's timeline). */
  journal_keep: count().default(200),
  /**
   * Once this many more have piled up, the oldest beyond `journal_keep` are condensed into one
   * digest (LLM purpose `digest_purpose`, or a plain summary when no model may run), so the
   * journal never grows unbounded.
   */
  digest_batch: z.number().int().min(1).default(50),
  /** Digests kept (oldest dropped). */
  digests_keep: count().default(60),
  digest_purpose: z.string().default("summarizer"),
  /** Her local time zone as a UTC offset (her day, the day plan, presence statistics). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /**
   * Without the Arbiter: at least this long between two conversations she starts herself in
   * one voice channel / one text channel or DM. Each one nobody responded to doubles it, up to
   * `self_start_max_backoff` times; a real exchange resets it.
   */
  self_start_gap_voice_secs: count().default(300),
  self_start_gap_text_secs: count().default(600),
  self_start_max_backoff: z.number().int().min(1).default(8),
  /** Topics she raised that nobody picked up are not raised again for this long. */
  stale_topic_mins: count().default(45),
  /**
   * An action that failed (e.g. `game.start` while the game is not running) is not tried again
   * until what it depends on changes, or at most this long.
   */
  blocked_retry_mins: count().default(30),
  /** Prompt contributors asked for what she remembers about the people and place involved. */
  contributors: z.array(z.string()).default(["memory", "watch"]),

  // ---- Appraise
  /** An interaction segment ends after this long without a line (then it is appraised). */
  appraise_quiet_secs: count().default(120),
  /** A segment needs this many lines (hers included) to be appraised. */
  appraise_min_lines: count().default(4),
  /** At most this many Appraise calls in any rolling hour. */
  appraise_max_per_hour: count().default(6),
  appraise_max_tokens: count().default(800),

  // ---- goals and the day plan
  /** Expiry of goals without one (migrated agenda items, followups). */
  goal_default_days: z.number().positive().default(3),
  /** The longest a goal may stay. */
  goal_max_days: z.number().positive().default(14),
  /** A goal whose trigger still fires wakes her again after this long, while it is open. */
  goal_refire_mins: count().default(30),
  /** People at or above this attachment are the ones she cares about (they wake her). */
  cared_attachment: fraction().default(0.3),
  /** Her mood's valence dropping this much since her last plan wakes her. */
  mood_drop: fraction().default(0.25),
  /** Her first Plan from this local hour on is her day plan (`plan_daily`). */
  daily_hour: z.number().int().min(0).max(23).default(6),
});

export type MindConfig = z.output<typeof MindConfigSchema>;

/**
 * Keys of `[modules.mind]` that are gone: her own quiet hours (one owner now: the Arbiter's
 * ledger limits, `quiet_hours.active` makes her heartbeat sparser) and her own voice-lull
 * detector (one cold-channel signal now: world's `channel_quiet`, `[modules.world]
 * voice_quiet_secs`). An old `miyoria.toml` that still sets them loads (they are ignored) with
 * a deprecation warning.
 */
export const DEPRECATED_MIND_KEYS: readonly string[] = [
  "quiet_start_hour",
  "quiet_end_hour",
  "voice_quiet_secs",
];

/** The defaults, optionally overridden. */
export function mindConfig(overrides: Partial<MindConfig> = {}): MindConfig {
  return { ...MindConfigSchema.parse({}), ...overrides };
}
