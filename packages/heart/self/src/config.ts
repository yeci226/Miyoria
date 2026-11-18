import { z } from "zod";

const rate = () => z.number().nonnegative();
const unit = () => z.number().min(0).max(1);
const count = () => z.number().int().nonnegative();

/** How fast each drive rises on its own (share of the remaining gap to 1, per hour). */
const RiseSchema = z.object({
  social: rate().default(0.08),
  play: rate().default(0.05),
  attention: rate().default(0.04),
  curiosity: rate().default(0.05),
  esteem: rate().default(0.04),
  /**
   * About 16 minutes from full (0) to wanting food again (0.15) and
   * about 20 more per bowl of rice after that, so a busy channel can feed her several times an
   * hour (2026-11-09: at 0.25 she was full after a bowl or two and stayed so for 40 minutes);
   * talking does not fill her (`turn_hunger`).
   */
  hunger: rate().default(0.6),
  /** Toward how much she cares about the one she cares about most (nobody: it fades). */
  longing: rate().default(0.12),
});

/** How much events satisfy drives (subtracted, 0..1). */
const SatisfySchema = z.object({
  /** She finished a turn (said something): `social`. */
  turn_social: unit().default(0.06),
  /** ...and `boredom`. */
  turn_boredom: unit().default(0.1),
  /** ...and a little `attention`. */
  turn_attention: unit().default(0.02),
  /**
   * ...and `hunger` (she got to spend some tokens). 0 by default: with dozens of replies an hour it
   * kept her at 0, always full, and every feed was refused.
   */
  turn_hunger: unit().default(0),
  /** Someone talked to her directly: `attention`. */
  addressed_attention: unit().default(0.04),
  /** Something was said around her (a message in a channel, a line in voice): `boredom`. */
  ambient_boredom: unit().default(0.01),
  /** A salient change in the world: `boredom`... */
  salient_boredom: unit().default(0.05),
  /** ...and `curiosity`. */
  salient_curiosity: unit().default(0.02),
  /** While she plays a game: `play` (and `boredom`) per hour. */
  playing_per_hour: rate().default(0.5),
  /** While she is live: `attention` per hour. */
  streaming_per_hour: rate().default(0.5),
  /** While she is live, `rest` rises this much per hour. */
  streaming_rest_per_hour: rate().default(0.1),
  /** The one she cares about most talked to her: `longing`. */
  crush_message_longing: unit().default(0.12),
  /** The one she cares about most is in her voice channel: `longing` per hour. */
  crush_together_per_hour: rate().default(0.6),
});

/**
 * `[modules.self.emotions]`: the shared knobs of her emotions. How fast each one rises and
 * fades is her temperament (the code's defaults and the profile's `[temperament]`).
 */
const EmotionsSchema = z.object({
  /** Emotions below this are forgotten. */
  floor: unit().default(0.03),
  /** Emotions at or above this are noticeable: they show in prompts and in what she shows. */
  notice: unit().default(0.2),
  /** At most this many emotions in a prompt. */
  prompt_max: count().default(3),
  /** Someone she cares about away this long is news when they are back. */
  missing_after_hours: z.number().positive().default(20),
  /** The longing drive turns into 想念 this much per day (before her temperament). */
  missing_per_day: rate().default(0.35),
  /** Someone she cares about talking to others this many times, never to her... */
  jealousy_lines: count().default(3),
  /** ...within this window stirs 嫉妒. */
  jealousy_window_mins: z.number().positive().default(15),
  /** `social` above this turns into 寂寞, up to `lonely_per_hour` at the top. */
  lonely_social: unit().default(0.75),
  lonely_per_hour: rate().default(0.15),
  /** `hunger` / `esteem` above this grumbles as 不甘心, up to `unmet_per_hour` at the top. */
  unmet_level: unit().default(0.8),
  unmet_per_hour: rate().default(0.08),
  /** Praise this soon after a song counts as the song praised (得意). */
  song_praise_mins: z.number().nonnegative().default(10),
  /**
   * All emotions together may be stirred at most this much in any 10 minutes (habituation and
   * the saturating stir already shape each one; this stops a burst from filling every
   * emotion). 0 = unlimited.
   */
  budget_per_10min: z.number().nonnegative().default(0.9),
  /** One `self.feel` event moves an emotion at most this much. */
  max_event_nudge: unit().default(0.5),
  /** Samples kept for charts (`SelfState.history`), one every `history_every_mins`. */
  history_every_mins: z.number().positive().default(5),
  history_keep: count().default(288),
});

/**
 * `[modules.self.mood]`: the mood is derived (baseline shaped by the hour, her emotions, her
 * unmet drives), never stored.
 */
const MoodSchema = z.object({
  /** How much energy drops at the deepest point of the night (0..1). */
  night_dip: z.number().min(0).max(1).default(0.4),
  /** How much her emotions move the mood (0 = only baseline, rhythm and drives). */
  emotion_weight: z.number().nonnegative().default(1),
  /** Publish `affect.changed` once the mood or her strongest emotions moved this much. */
  publish_threshold: z.number().positive().default(0.05),
});

/**
 * `[modules.self]` config section. Every field has a default.
 *
 * ```toml
 * [modules.self]
 * boredom_per_hour = 0.15
 * [modules.self.rise_per_hour]
 * social = 0.08
 * ```
 */
export const SelfConfigSchema = z.object({
  /** Background tick: drift, expiry, saving. */
  tick_secs: count().default(60),
  /** Remember her state across restarts (needs `SettingsStoreKey`). */
  persist: z.boolean().default(true),
  /** Boredom rises this fast without anything happening (share of the gap, per hour). */
  boredom_per_hour: rate().default(0.15),
  /** `rest` drifts toward `1 - energy` of her mood with this half-life. */
  rest_half_life_mins: z.number().positive().default(90),
  rise_per_hour: RiseSchema.prefault({}),
  satisfy: SatisfySchema.prefault({}),
  emotions: EmotionsSchema.prefault({}),
  mood: MoodSchema.prefault({}),
  /** Starting value of every drive (first run, or after a wipe); `longing` starts at 0. */
  initial_drive: unit().default(0.3),
  initial_boredom: unit().default(0.2),
  initial_initiative: unit().default(0.5),
  /** Longest a talkativeness setting may last (she can always set it again). */
  max_talkativeness_hours: z.number().positive().default(24),
  /** Open agenda items kept; adding more drops the oldest. */
  max_open_agenda: count().default(8),
  /**
   * Longest an agenda item stays open (days); one without an expiry gets this one. Long-lived
   * vague goals ("practise staying quiet for two weeks") piled up and steered her for days.
   */
  max_agenda_days: z.number().positive().default(3),
  /** Done / dropped / expired agenda items kept for the panel. */
  keep_closed_agenda: count().default(20),
  /** Her local time zone as a UTC offset (times in the prompt section, local days). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
});

export type SelfConfig = z.output<typeof SelfConfigSchema>;
export type EmotionsConfig = SelfConfig["emotions"];

/** The defaults, optionally overridden. */
export function selfConfig(overrides: Partial<SelfConfig> = {}): SelfConfig {
  return { ...SelfConfigSchema.parse({}), ...overrides };
}
