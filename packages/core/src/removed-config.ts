// Config keys that were read once and are not any more. A file that still holds one loads as
// before (the schemas drop keys they do not name); Core names the ones it finds in one warning
// at start, so nobody keeps tuning a value that does nothing.

import type { Config } from "@miyoria/runtime/kernel";

/**
 * Dotted paths. A path that ends at a table stands for the whole table (`modules.agent.attention`
 * is every key under it); a path inside a table that is itself still read names one key.
 */
export const REMOVED_CONFIG_KEYS: readonly string[] = [
  "core.pipeline",
  "llm.thinking",
  // [modules.agent]: the old brain's turn.
  ...[
    "runner",
    "max_tool_steps",
    "tool_timeout_ms",
    "max_tool_result_chars",
    "history_after_fold",
    "time_gap_ms",
    "tools_enabled",
    "seed",
    "budget_notice_interval_ms",
    "attention",
  ].map((key) => `modules.agent.${key}`),
  ...["gray_low", "max_share_of_recent"].map((key) => `modules.agent.voice.${key}`),
  ...[
    "prompt_tokens",
    "history_lines",
    "history_chars",
    "history_trim",
    "history_floor",
    "entry_chars",
    "loop_tools",
    "loop_calls",
    "loop_round_chars",
    "loop_budget_ms",
    "voice_loop_budget_ms",
    "people_refresh_mins",
    "trace_chars",
    "trace_result_chars",
    "traces",
    "tool_chars",
    "tool_arg_chars",
    "recent_lines",
    "proposals",
    "first_token_timeout_ms",
    "reasoning_first_token_timeout_ms",
    "fallback_gap_ms",
  ].map((key) => `modules.agent.mainline.${key}`),
  ...[
    "max_running",
    "max_queued",
    "max_steps",
    "calls_per_step",
    "max_minutes",
    "max_tokens",
    "tools",
    "tool_timeout_ms",
    "tool_result_chars",
    "transcript_chars",
    "initiative",
    "initiative_steps",
  ].map((key) => `modules.agent.work.${key}`),
  ...["tool_text_reask", "promise_commit", "claims", "prohibition_write"].map(
    (key) => `modules.agent.corrections.${key}`,
  ),
  ...["looks_per_hour", "question_secs", "topic_gap_mins", "close_affinity"].map(
    (key) => `modules.agent.rhythm.${key}`,
  ),
  // [modules.mind]
  "modules.mind.max_intents",
  "modules.mind.daily_posts",
  // [modules.reflect]: the daily reflection's bonds part (phase 4: one reflection per person).
  "modules.reflect.max_bonds",
  // [modules.social]: the module is gone (phase 4 step 5); who people are is module `heart`'s,
  // whose `auto_owner_tag` replaces the one key still meant.
  "modules.social",
  // [modules.self]: her feelings about people are the heart's (phase 4 step 5).
  "modules.self.emotions.care_affinity",
  "modules.self.heart",
  "modules.self.bond",
  "modules.self.max_feeling_chars",
  // [modules.world]: who she cares about is the heart's 在意.
  "modules.world.care_min_affinity",
  "modules.world.care_min_familiarity",
  // [modules.mind]: Appraise, Plan, the heartbeat and her own starts are gone (phase 4 step 5).
  ...[
    "purpose",
    "max_calls_per_hour",
    "min_interval_secs",
    "heartbeat_mins",
    "min_heartbeat_mins",
    "max_heartbeat_mins",
    "coalesce_ms",
    "timeout_ms",
    "max_tokens",
    "self_start_gap_voice_secs",
    "self_start_gap_text_secs",
    "self_start_max_backoff",
    "stale_topic_mins",
    "blocked_retry_mins",
    "contributors",
    "appraise_quiet_secs",
    "appraise_min_lines",
    "appraise_max_per_hour",
    "appraise_max_tokens",
    "cared_attachment",
    "mood_drop",
    "game_share",
  ].map((key) => `modules.mind.${key}`),
  // [modules.party]: the quiz, the word chain and the story chain are gone (phase 5 step 6).
  ...[
    "quiz_rounds",
    "quiz_answer_secs",
    "chain_idle_secs",
    "story_turn_secs",
    "story_max_lines",
    "story_line_chars",
  ].map((key) => `modules.party.${key}`),
  // [llm]: the model chain and the reasoning of the calls that are gone.
  "llm.purposes.mind",
  "llm.reasoning.appraise",
  "llm.reasoning.plan",
  "llm.reasoning.plan_daily",
  // [modules.economy]: phase 5 slims what coins are for; each feature sold off takes its keys.
  // Letters.
  "modules.economy.letter",
  // Buying an expression for her (her own purse still buys one for herself).
  "modules.economy.expression_cooldown_s",
  // Deals (a snack promised for a task), their trust cost and the owed meal that followed.
  ...[
    "deal_due_s",
    "deal_timeout_s",
    "deals_per_day",
    "deal_sweep_s",
    "deal_kept_trust",
    "broken_trust",
    "broken_affinity",
    "broken_growth",
    "broken_cap",
    "owe_days",
  ].map((key) => `modules.economy.${key}`),
  // Commissions (paying her to write a poem, a name, a tool, a song, a line of voice).
  ...[
    "commission_prices",
    "commissions_per_day",
    "commissions_open",
    "commission_days",
    "commission_share",
  ].map((key) => `modules.economy.${key}`),
  // Her weekly shop (titles and collectibles on a shelf that changed every week).
  ...["shop_catalog", "shop_slots", "shop_her_share"].map((key) => `modules.economy.${key}`),
  // The global hunger limit for feeding, replaced by a per-person one (feed_hunger_cap).
  "modules.economy.full_below",
  // Song tickets and dedications (extras on a song request).
  ...["song_ticket", "song_tickets_per_day", "dedication", "dedications_per_day"].map(
    (key) => `modules.economy.${key}`,
  ),
  // Goal pledges (the crowdfunding goals people pledged coins to).
  ...["goal_max_target", "goal_max_days", "goal_pledge_max", "goal_keep_days"].map(
    (key) => `modules.economy.${key}`,
  ),
  // Drawing collectibles (the album, the odds, the pity and giving spares), replaced by the cards
  // plugin's daily card and dex.
  ...[
    "draw_price",
    "draws_per_day",
    "rarity_weights",
    "draw_pity",
    "item_gifts_per_day",
    "collection_series",
  ].map((key) => `modules.economy.${key}`),
  // Re-drawing a card and picking its picture (paid card extras).
  ...["card_reroll", "card_rerolls_per_day", "card_pose", "card_poses_per_day"].map(
    (key) => `modules.economy.${key}`,
  ),
];

/** The removed paths `config` still holds, in the order of `REMOVED_CONFIG_KEYS`. */
export function removedConfigKeys(config: Config): string[] {
  return REMOVED_CONFIG_KEYS.filter((path) => config.section(path) !== undefined);
}

/** One warning naming every removed key the file still holds; none when it holds none. */
export function warnRemovedKeys(config: Config, warn: (message: string) => void): string[] {
  const found = removedConfigKeys(config);
  if (found.length > 0) {
    warn(`config keys no longer read, ignored: ${found.map((p) => `\`${p}\``).join(", ")}`);
  }
  return found;
}
