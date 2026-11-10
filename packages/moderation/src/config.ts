import { z } from "zod";
import { RuleSchema } from "./rules.js";

/** `[modules.moderation.input]`: the defence against hostile chat. Durations in ms. */
export const InputConfigSchema = z.object({
  /** `false` turns the input defence off (every message passes, unmarked). */
  enabled: z.boolean().default(true),
  /** More than `flood_max_messages` from one author within `flood_window_ms` is flooding. */
  flood_window_ms: z.number().int().positive().default(10_000),
  flood_max_messages: z.number().int().positive().default(8),
  /** The same text `repeat_max` times within `repeat_window_ms` is spam. */
  repeat_window_ms: z.number().int().positive().default(60_000),
  repeat_max: z.number().int().positive().default(3),
  /** One message longer than this is a wall of text. */
  max_chars: z.number().int().positive().default(2_000),
  /** More mentions than this in one message is mention spam. */
  max_mentions: z.number().int().positive().default(5),
  /** Flagged messages within `strike_window_ms` add up: the limit, then the ignore. */
  strike_window_ms: z.number().int().positive().default(600_000),
  strikes_to_limit: z.number().int().positive().default(2),
  strikes_to_ignore: z.number().int().positive().default(5),
  /** How long a rate limit / an ignore lasts. */
  limit_ms: z.number().int().positive().default(30_000),
  ignore_ms: z.number().int().positive().default(300_000),
  /** Authors tracked at once (oldest forgotten first). */
  max_tracked_authors: z.number().int().positive().default(2_000),
  /** Your own injection patterns (regular expressions over the lowercased text). */
  extra_injection: z.array(z.string()).default([]),
  /** Your own bait patterns. */
  extra_bait: z.array(z.string()).default([]),
});

export type InputConfig = z.output<typeof InputConfigSchema>;

/**
 * `[modules.moderation]`: what she may say and what she listens to.
 *
 * ```toml
 * [modules.moderation]
 * filtered_line = "Filtered."
 * disabled_rules = ["doxxing.ip"]           # switch a default rule off
 * enabled_rules = ["strict.ja.shine"]       # switch an opt-in rule on
 * allow = ["scunthorpe"]                    # phrases cut out of the text before matching
 *
 * [[modules.moderation.rules]]              # your own; the id of a default replaces it
 * id = "mine.spoilers"
 * category = "custom"
 * pattern = "終局之戰的結局"
 * ```
 */
export const ModerationConfigSchema = z.object({
  /** What stands in for blocked text (a written line, a subtitle). */
  filtered_line: z.string().min(1).default("Filtered."),
  /** What stands in for blocked spoken text; empty = `filtered_line`. */
  filtered_voice_line: z.string().default(""),
  /** Start from the shipped rule list. `false` = only `rules` below. */
  defaults: z.boolean().default(true),
  /** Ids of shipped rules to switch off. */
  disabled_rules: z.array(z.string()).default([]),
  /** Ids of shipped opt-in (`strict.*`) rules to switch on. */
  enabled_rules: z.array(z.string()).default([]),
  /** Your rules. */
  rules: z.array(RuleSchema).default([]),
  /** Phrases (plain text, any case) removed from the text before the rules run. */
  allow: z.array(z.string().min(1)).default([]),
  /** Values she must never say (the admin token). Use `${ENV_NAME}` to read one from the environment. */
  secret_values: z.array(z.string()).default([]),
  /** Also protect environment variables named like `*_TOKEN`, `*_SECRET`, `*_API_KEY`, `*_PASSWORD`. */
  protect_env: z.boolean().default(true),
  /** Longest text scanned in one piece (head and tail of a longer one are scanned). */
  max_scan_chars: z.number().int().positive().default(20_000),
  /** How long an outside provider may take in `screenAsync`. */
  provider_timeout_ms: z.number().int().positive().default(800),
  /**
   * A provider that fails or times out: `local` keeps the local rules' verdict (the text went
   * through them already), `block` blocks the text (for a stage where a miss costs more).
   */
  provider_on_failure: z.enum(["local", "block"]).default("local"),
  /** Blocks kept for `recent()`. */
  recent_blocks: z.number().int().positive().default(50),
  input: InputConfigSchema.prefault({}),
});

export type ModerationConfig = z.output<typeof ModerationConfigSchema>;

export function defaultModerationConfig(): ModerationConfig {
  return ModerationConfigSchema.parse({});
}
