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
  // [llm]: the model chain and the reasoning of the calls that are gone.
  "llm.purposes.mind",
  "llm.reasoning.appraise",
  "llm.reasoning.plan",
  "llm.reasoning.plan_daily",
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
