// `[modules.mind]`: only caps and plumbing. How often she wants to think, what she feels and
// what she does are hers; the numbers here bound the cost and the noise.

import { z } from "zod";

const count = () => z.number().int().nonnegative();

/**
 * ```toml
 * [modules.mind]
 * max_calls_per_hour = 12
 * min_interval_secs = 45
 * ```
 */
export const MindConfigSchema = z.object({
  /** LLM purpose of her thoughts (thinking per `[llm.thinking]`; falls back to `chat` with a warning). */
  purpose: z.string().default("mind"),
  /** At most this many thoughts in any rolling hour (every trigger counts). */
  max_calls_per_hour: count().default(12),
  /** At least this long between two thoughts. */
  min_interval_secs: count().default(45),
  /** Her heartbeat is never sparser than this (it adapts below it). */
  max_heartbeat_mins: z.number().positive().default(30),
  /** Triggers arriving within this window are thought about together. */
  coalesce_ms: count().default(3000),
  /** One thought may take this long. */
  timeout_ms: count().default(90_000),
  max_tokens: count().default(3000),
  /** Intents acted on per thought; more are dropped. */
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
  /** Her local time zone as a UTC offset (quiet hours). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /**
   * Quiet hours (local, start inclusive, end exclusive; equal = none): her heartbeat is three
   * times sparser and a thought that only her heartbeat woke may not start conversations.
   */
  quiet_start_hour: z.number().int().min(0).max(23).default(1),
  quiet_end_hour: z.number().int().min(0).max(23).default(7),
  /** The voice channel she is in counts as gone quiet after a conversation after this long. */
  voice_quiet_secs: count().default(40),
  /**
   * At least this long between two conversations she starts herself in one voice channel / one
   * text channel or DM. Each one nobody responded to (nobody addressed her there within that
   * time) doubles it, up to `self_start_max_backoff` times; a real exchange resets it.
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
  contributors: z.array(z.string()).default(["memory"]),
});

export type MindConfig = z.output<typeof MindConfigSchema>;

/** The defaults, optionally overridden. */
export function mindConfig(overrides: Partial<MindConfig> = {}): MindConfig {
  return { ...MindConfigSchema.parse({}), ...overrides };
}
