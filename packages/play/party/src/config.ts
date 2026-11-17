import { z } from "zod";

/**
 * Permission nodes of the party tools for the person she plays with (`user` principals). Everyday
 * users have `chat.talk`, so anyone she talks with can play; a role without it cannot get her to
 * start or run a game.
 */
export const PartyPermissionsSchema = z.object({
  start: z.string().default("chat.talk"),
  host: z.string().default("chat.talk"),
  play: z.string().default("chat.talk"),
});
export type PartyPermissions = z.output<typeof PartyPermissionsSchema>;

/**
 * Coins for the people who played, through `PartyRewardsKey` when someone provides it. A finished
 * game pays `coins_per_point` per point, at most `max_coins` per person, and only when at least
 * `min_players` people took part (so nobody farms coins alone with her).
 */
export const PartyRewardsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  coins_per_point: z.number().int().nonnegative().default(2),
  max_coins: z.number().int().nonnegative().default(20),
  min_players: z.number().int().min(1).default(2),
});

/**
 * `[modules.party]`: party games in voice (docs/design/v4-plan.md §9.1). Nothing starts on its
 * own: a game only begins when she calls `party_start`, so the module is on by default.
 *
 * ```toml
 * [modules.party]
 * quiz_rounds = 10
 * ```
 */
export const PartyConfigSchema = z.object({
  /** Questions in a quiz unless she asks for another number. */
  quiz_rounds: z.number().int().min(1).max(50).default(10),
  /** Seconds to answer a quiz question before the answer is given. */
  quiz_answer_secs: z.number().int().min(5).default(40),
  /** Songs in a song-guessing game unless she asks for another number. */
  song_rounds: z.number().int().min(1).max(30).default(8),
  /** Seconds to guess a song after its clip started. */
  song_answer_secs: z.number().int().min(5).default(60),
  /** How long the clip of a song is. */
  clip_secs: z.number().int().min(3).max(60).default(15),
  /** Word chains: nobody continues for this long and the chain is broken. */
  chain_idle_secs: z.number().int().min(5).default(45),
  /** Story chain: seconds for the person whose turn it is before the next one goes. */
  story_turn_secs: z.number().int().min(5).default(60),
  /** Story chain: lines until the story is done. */
  story_max_lines: z.number().int().min(2).max(60).default(12),
  /** Longest line of a story kept (characters). */
  story_line_chars: z.number().int().min(10).max(400).default(80),
  /** Turtle soup: minutes before the bottom is given. */
  soup_mins: z.number().min(1).default(15),
  /** The model chain that judges turtle-soup questions (`[llm.purposes]`; unset: the chat chain). */
  judge_purpose: z.string().default("party"),
  judge_timeout_ms: z.number().int().positive().default(8000),
  /** Nobody said anything that reached the game for this long: the game ends. */
  idle_mins: z.number().min(1).default(6),
  /** Nobody but her in the channel for this long: the game ends (a reconnect is not leaving). */
  empty_grace_secs: z.number().int().nonnegative().default(30),
  rewards: PartyRewardsConfigSchema.prefault({}),
  permissions: PartyPermissionsSchema.prefault({}),
});
export type PartyConfig = z.output<typeof PartyConfigSchema>;

export function defaultPartyConfig(): PartyConfig {
  return PartyConfigSchema.parse({});
}
