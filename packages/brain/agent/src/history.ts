// Context she did not see live: how many earlier lines a place she has no transcript of starts
// with (the text runner fetches them from the platform and the message log).

import type { Agent } from "./runtime.js";

/** How many earlier messages a cold place fetches. */
export function backfillLimit(agent: Agent): number {
  const cfg = agent.config;
  return Math.min(cfg.history.backfill, cfg.prompt_history, cfg.history_limit);
}
