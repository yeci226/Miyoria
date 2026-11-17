// `[modules.arbiter]`: the one rule set for "may she speak / act now" (docs/design/
// v2-architecture.md §3.3). It replaces `[modules.initiative]` (its caps, quiet hours and
// triggers), mind's second quiet hours and the gate's `chat.start` counters. Every limit here is
// written to her ledger, so she plans with it in view.

import { type ContextKey, contextKeyString } from "@miyoria/types";
import { z } from "zod";

const count = () => z.number().int().nonnegative();
const hour = () => z.number().int().min(0).max(23);

/**
 * `[modules.arbiter.floor]` (docs/design/v3-architecture.md §7.2):
 *
 * ```toml
 * [modules.arbiter.floor.budget]
 * window_mins = 10
 * base_lines = 6
 * ```
 *
 * `max_unanswered` stays where it was, in `[modules.arbiter]`.
 */
export const FloorConfigSchema = z.object({
  budget: z
    .object({
      /** The sliding window her own lines are counted in. */
      window_mins: z.number().positive().default(10),
      /** Lines of her own per window. Only what was delivered counts. */
      base_lines: z.number().nonnegative().default(6),
      /** Every line of a person in the window adds this much. */
      per_human_line: z.number().nonnegative().default(1),
      /** Each line nobody answered multiplies the wait before the next one by this. */
      unanswered_backoff: z.number().min(1).default(2),
      /** The wait after the first line nobody answered. */
      backoff_base_secs: count().default(60),
      /** More lines while she performs: announcing songs, playing a game live. */
      performing_bonus: z.number().nonnegative().default(8),
    })
    .prefault({}),
  /** Her own talkativeness and feelings scale `base_lines` at most this far: the owner's cap. */
  max_talk_multiplier: z.number().positive().default(1.5),
  /** One unit of what her feelings lean (`AffectBiases.talkativeness`) moves the budget this much. */
  feeling_weight: z.number().nonnegative().default(1.25),
  /** However she feels, it takes at most this share of `base_lines` away. Never all of it. */
  min_feeling_multiplier: z.number().min(0.1).max(1).default(0.5),
  /** However she feels, it adds at most this much. */
  max_feeling_multiplier: z.number().min(1).default(1.25),
  /** In a text channel, someone who wrote this recently still counts as there. */
  text_presence_mins: z.number().positive().default(30),
  /** A line that never reports back loses the mic after this long. */
  max_hold_secs: z.number().int().positive().default(120),
});
export type FloorConfig = z.output<typeof FloorConfigSchema>;

/**
 * ```toml
 * [modules.arbiter]
 * max_per_day = 12
 * quiet_start_hour = 1
 * quiet_end_hour = 7
 * ```
 */
export const ArbiterConfigSchema = z.object({
  // --- time ---
  /** Her local time zone as minutes east of UTC (quiet hours, "today"). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /** Local hour at which her day rolls over (daily counters, greetings). */
  day_start_hour: hour().default(4),
  /**
   * Quiet hours (local, start inclusive, end exclusive; equal = none). She starts nothing on
   * her own then; answering people, songs she was asked for and task results are not affected.
   * The only quiet hours: mind's own (`[modules.mind]`) follow these while the Arbiter runs.
   */
  quiet_start_hour: hour().default(1),
  quiet_end_hour: hour().default(7),

  // --- her own starts (sources `plan` / `agenda` that make her talk) ---
  /** Her own conversation starts per day, all places together (0 = no cap). */
  max_per_day: count().default(12),
  /** Per text channel, voice channel or DM per day (0 = no cap). */
  max_per_context_per_day: count().default(4),
  /** Aimed at one person per day (was `chat.start` `per_person_per_day`; 0 = no cap). */
  max_per_person_per_day: count().default(4),
  /** Between any two of her own starts (was `chat.start` `cooldown_ms`). */
  min_gap_secs: count().default(60),
  /**
   * Between two starts in one place. Every start nobody picked up doubles it, up to
   * `max_backoff` times; someone engaging with her there resets it.
   */
  gap_text_secs: count().default(600),
  gap_voice_secs: count().default(300),
  max_backoff: z.number().int().min(1).default(8),
  /** One doubling is forgotten per this many hours without a new miss. */
  backoff_decay_hours: z.number().positive().default(24),
  /**
   * Her topic counts as picked up when someone addresses or answers her there within this
   * long after she spoke; otherwise it was ignored (`affect.event` `topic_ignored`).
   */
  reply_window_text_secs: count().default(600),
  reply_window_voice_secs: count().default(300),
  /** Ignored topics are listed to her (and not raised again) this long. */
  stale_topic_mins: count().default(45),
  /**
   * Turns she may start in one place with no person speaking there; then she starts none until
   * someone does (any human message or speech resets it). Besides her own starts this counts game
   * narration and memory followups; `unanswered.ts` says exactly what counts. 0 = no limit.
   */
  max_unanswered: count().default(3),
  /** A capability that was refused or failed is shown as on hold this long. */
  blocked_mins: count().default(30),
  /** After her game was closed, how long she may not start one on her own (0: no hold). */
  game_hold_mins: count().default(60),

  // --- everything that is not an answer ---
  /**
   * Greetings and her own starts wait at least this long after she last spoke there (song
   * announcements, game commentary, followups and notices do not).
   */
  after_speech_text_secs: count().default(5),
  after_speech_voice_secs: count().default(20),
  /** An impulse whose place is busy (a turn in flight, her speech queued) is retried this often. */
  retry_ms: z.number().int().positive().default(3000),
  /** Impulses waiting for their turn at most (the oldest of the lowest priority go first). */
  max_queued: count().default(50),
  /** Ledger entries kept in memory (newest first). */
  ledger_keep: count().default(200),
  /**
   * Contexts that never get anything unprompted from her. Entries match the context's display
   * form (`discord:<guild>:<channel>`, voice contexts with `voice:` before the channel) or its
   * bare channel id.
   */
  disabled_contexts: z.array(z.string()).default([]),

  // The greeting and followup producers' keys (`greeting`, `voice_join`, `followup`,
  // `friend_labels`, `voice_join_min_affinity`, `voice_join_cooldown_secs`,
  // `followup_active_secs`) are no longer read: her own starts are the new runner's.
  /** How long a game's line stays worth saying while the place is busy. */
  impulse_ttl_secs: count().default(120),
  /** How often followups are polled, unanswered topics settled and the state saved. */
  tick_secs: z.number().int().positive().default(30),

  // --- one wish, asked once (`wishes.ts`) ---
  wishes: z
    .object({
      /**
       * A question to someone that is not answered may be raised once more, no sooner than this
       * after she asked; never a second time, and never once they answered.
       */
      followup_hours: z.number().positive().default(12),
      /** What she wanted to ask someone is remembered this long after it was made or closed. */
      keep_hours: z.number().positive().default(48),
    })
    .prefault({}),

  // --- the Floor ---
  floor: FloorConfigSchema.prefault({}),
});
export type ArbiterConfig = z.output<typeof ArbiterConfigSchema>;

/** The defaults, optionally overridden. */
export function arbiterConfig(overrides: Partial<ArbiterConfig> = {}): ArbiterConfig {
  return { ...ArbiterConfigSchema.parse({}), ...overrides };
}

/** Whether `context` is on the opt-out list. */
export function isContextDisabled(config: ArbiterConfig, context: ContextKey): boolean {
  if (config.disabled_contexts.length === 0) return false;
  const display = contextKeyString(context);
  return config.disabled_contexts.some((d) => d === display || d === context.channel);
}
