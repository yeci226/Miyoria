import { z } from "zod";

const secs = () => z.number().int().nonnegative();

/**
 * `[modules.world]` config section. Every field has a default.
 *
 * ```toml
 * [modules.world]
 * game_interests = ["Minecraft"]
 * ```
 */
export const WorldConfigSchema = z.object({
  /** Her local time zone as a UTC offset (time of day, weekdays). */
  utc_offset_minutes: z
    .number()
    .int()
    .default(8 * 60),
  /**
   * Servers whose presence, voice states and members she follows; empty = every server the bot
   * is in. Each server's data only ever shows up in that server's conversations.
   */
  guilds: z.array(z.string()).default([]),
  /** Background tick: quiet channels, pending salient events. */
  tick_secs: secs().default(5),
  /** Channel activity is measured over this window. */
  activity_window_secs: secs().default(600),
  /** A channel is lively with this many messages in the window... */
  lively_messages: secs().default(8),
  /** ...from at least this many people. */
  lively_authors: secs().default(2),
  /** Voice conversation (transcribed utterances) is measured over this window. */
  voice_activity_window_secs: secs().default(300),
  /**
   * A voice channel counts as lively (people are talking: never "quiet") with this many
   * utterances in the window, or with anyone speaking within the last `voice_quiet_secs`.
   */
  voice_lively_lines: secs().default(6),
  /** No utterance for this long and a voice channel is not lively from that alone. */
  voice_quiet_secs: secs().default(40),
  /** A lively channel without messages for this long went quiet. */
  quiet_after_secs: secs().default(300),
  /** A mention counts as salient when she has not spoken in that context for this long. */
  away_secs: secs().default(600),
  /** Game names she is interested in, besides the profile's `interests`. */
  game_interests: z.array(z.string()).default([]),
  /** Repeats of the same salient change within this window are merged into one event. */
  coalesce_ms: secs().default(5_000),
  /** The same change (same person, same kind) is not reported again within this time. */
  cooldown_secs: secs().default(900),
  /** At most this many `world.salient` events per minute. */
  max_salient_per_minute: secs().default(6),
  /** Text contexts tracked at once (the least recent are forgotten). */
  max_channels: secs().default(200),
  /** Add the `world` prompt section. */
  prompt: z.boolean().default(true),
  /** People listed in the prompt section. */
  prompt_max_people: secs().default(8),
});

export type WorldConfig = z.output<typeof WorldConfigSchema>;

/** The defaults, optionally overridden. */
export function worldConfig(overrides: Partial<WorldConfig> = {}): WorldConfig {
  return { ...WorldConfigSchema.parse({}), ...overrides };
}
