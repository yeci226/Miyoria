import { z } from "zod";

const count = () => z.number().int().nonnegative();

/**
 * `[modules.social]` config section. Every field has a default.
 *
 * ```toml
 * [modules.social]
 * daily_affinity_cap = 8.0
 * appraisal_every_lines = 8
 * ```
 */
export const SocialConfigSchema = z.object({
  /** Max affinity gained (and, separately, lost) per person per day through appraisal. */
  daily_affinity_cap: z.number().default(8),
  /** Max trust gained (and lost) per person per day through appraisal. */
  daily_trust_cap: z.number().default(5),
  /** The n-th event of the same kind on one day is worth `repeat_decay^n`. */
  repeat_decay: z.number().default(0.5),
  /** People tagged `owner` always have this trust. */
  owner_trust: z.number().default(100),
  /** People tagged `owner` never drop below this affinity. */
  owner_affinity_floor: z.number().default(30),
  /** Trust of someone she just met. */
  default_trust: z.number().default(10),
  /** Her local time zone as a UTC offset, for "days" and familiarity. */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /**
   * Familiarity per line a person says (times its depth, see `lineDepth`; slows toward 100):
   * it grows with how much and how deeply people interact, not a point per day.
   */
  familiarity_per_line: z.number().nonnegative().default(0.15),
  /** Days without contact before familiarity starts to decay. */
  familiarity_grace_days: z.number().int().default(7),
  /** Familiarity lost per day without contact after the grace period. */
  familiarity_decay_per_day: z.number().default(0.5),
  /** Ask the LLM once a context collected this many new lines from people. */
  appraisal_every_lines: count().default(8),
  /** ...or once a context with new lines was quiet this long. */
  appraisal_idle_secs: z.number().int().default(90),
  /** Lines of a context kept for appraisal (older ones are dropped). */
  appraisal_max_lines: count().default(30),
  /**
   * A line counts as said to her when she spoke in the context this recently (besides
   * mentions, replies, DMs and her names).
   */
  direct_window_secs: z.number().int().default(45),
  /** Refresh her notes about someone after this many of their lines... */
  notes_every_lines: count().default(40),
  /** ...but at most this often per person. */
  notes_min_interval_hours: z.number().int().default(12),
  /** Background tick: idle appraisals, notes, flushing interaction counts. */
  tick_secs: count().default(15),
  /** Accounts the authorizer treats as owners get the `owner` tag. */
  auto_owner_tag: z.boolean().default(true),
  /** LLM purpose used for appraisal and notes. */
  llm_purpose: z.string().default("fast"),
});

export type SocialConfig = z.output<typeof SocialConfigSchema>;

/**
 * Keys of `[modules.social]` that are gone: `prompt_max_people` sized her `在場的人` section,
 * which the agent renders itself now (v2 §3.5). Still loads, with a warning.
 */
export const DEPRECATED_SOCIAL_KEYS: readonly string[] = ["prompt_max_people"];

/** The defaults (`SocialConfig::default()`), optionally overridden. */
export function socialConfig(overrides: Partial<SocialConfig> = {}): SocialConfig {
  return { ...SocialConfigSchema.parse({}), ...overrides };
}
