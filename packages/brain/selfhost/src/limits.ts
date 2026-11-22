// The hourly cap of a conversation as its place sets it: `[modules.agent]` `session_usd_per_hour`
// and `session_tokens_per_hour`, a room's own value, then its channel's, its Space's, the cluster's
// (`AgentHandle.configAt`). Read per run, so a place's new value counts from its next run.

import type { ContextKey } from "@miyoria/types";
import type { Agent } from "../../agent/src/index.js";
import type { HourCap } from "../../self/src/index.js";

/** The runner's `sessionUsdPerHour` / `sessionTokensPerHour` of a run at `context`. */
export function hourCap(agent: Agent, context: ContextKey): HourCap {
  const config = agent.handle.configAt(context);
  return {
    sessionUsdPerHour: config.session_usd_per_hour,
    sessionTokensPerHour: config.session_tokens_per_hour,
  };
}
