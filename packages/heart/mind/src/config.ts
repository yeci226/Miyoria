// `[modules.mind]`: her journal, her goals, her life log and her old timers. The keys of Appraise,
// Plan, her heartbeat and her own starts were removed in phase 4 step 5 (`removed-config.ts`).

import { z } from "zod";

const count = () => z.number().int().nonnegative();

/**
 * ```toml
 * [modules.mind]
 * journal_keep = 200
 * daily_hour = 6
 * ```
 */
export const MindConfigSchema = z.object({
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
  /** Her local time zone as a UTC offset (her day, her goals' times, her life log). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),

  // ---- goals
  /** Expiry of goals without one (migrated agenda items, followups). */
  goal_default_days: z.number().positive().default(3),
  /** The longest a goal may stay. */
  goal_max_days: z.number().positive().default(14),
  /** A goal whose trigger still fires is in her inbox again after this long, while it is open. */
  goal_refire_mins: count().default(30),
  /** Her day starts at this local hour (her life log's day; her initiative's morning). */
  daily_hour: z.number().int().min(0).max(23).default(6),

  // ---- her own life (docs/design/v4-plan.md §8)
  /** Days of her life log kept (`mind:life:<day>`). */
  life_keep_days: z.number().int().min(1).max(60).default(7),
  /** `remind_me`: open timers at most. */
  reminders_max: z.number().int().min(1).default(20),
  /** Open timers one person may have asked her for. */
  reminders_per_person: z.number().int().min(1).default(3),
  /** How far ahead a timer may be set. */
  reminder_max_days: z.number().int().min(1).max(366).default(30),
  /** A due timer stays on the board for the main line this long. */
  reminder_hold_mins: z.number().int().min(1).default(120),
});

export type MindConfig = z.output<typeof MindConfigSchema>;

/** The defaults, optionally overridden. */
export function mindConfig(overrides: Partial<MindConfig> = {}): MindConfig {
  return { ...MindConfigSchema.parse({}), ...overrides };
}
