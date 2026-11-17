// One timeout policy for playing a game (v2 §1.7, §3.8), from the inside out. Each layer gives
// up strictly after the layer it wraps, so the inner one always reports first and with the more
// specific reason; nothing is "settled" by a sleep.
//
// | # | layer | where | default |
// |---|---|---|---|
// | 1 | one request to the game (adapter → mod) | adapter `request_timeout_ms` | 10 s |
// | 2 | one control call: observe / start / cancel through the executor | `[modules.game] tool_timeout_secs` | 20 s |
// | 3 | the host's RPC backstop for the same calls | `[modules.extensions] call_timeout_ms` | 30 s |
// | 4 | a task (goal) runs at most its `budget_s`; the executor ends it with `timeout` | the goal's `budget_s`, else `task_budget_secs` (≤ `max_goal_secs`) | 240 s |
// | 5 | the host fails a task that did not report its end | `budget_s` + `[modules.extensions] task_grace_ms` | + 5 s |
// | 6 | a goal (possibly several tasks) is given up | `max_goal_secs` | 600 s |
//
// Starting the game is its own chain: the `launch` task's budget is `launch_wait_secs` (240 s),
// inside the ActivityManager's `game_timeout_ms` (300 s) for the whole `game.start`.
// One decision of the model (`llm_timeout_secs`, 30 s) is not part of the game chain; a decision
// only picks a goal and returns.
//
// Waiting for a survival reflex to end is no separate timeout any more: inside a task it is
// bounded by the task's budget (its signal).

/** Defaults of the layers outside `[modules.game]` (documented above). */
export const OUTER_DEFAULTS = {
  /** Adapter → mod request (Minecraft `request_timeout_ms`). */
  bridgeRequestMs: 10_000,
  /** The host's `call_timeout_ms`. */
  rpcCallMs: 30_000,
  /** The host's `task_grace_ms`. */
  taskGraceMs: 5_000,
  /** The ActivityManager's `game_timeout_ms`. */
  activityGameMs: 300_000,
} as const;

/** The values the policy orders (ms). */
export interface TimeoutValues {
  bridgeRequestMs: number;
  controlMs: number;
  rpcCallMs: number;
  taskBudgetMs: number;
  taskGraceMs: number;
  maxGoalMs: number;
  launchMs: number;
  activityGameMs: number;
}

/** The game config fields the policy reads. */
export interface GameTimeoutConfig {
  tool_timeout_secs: number;
  task_budget_secs: number;
  max_goal_secs: number;
  launch_wait_secs: number;
}

/** The ordered values for `cfg` (outer layers at their defaults unless given). */
export function timeoutValues(
  cfg: GameTimeoutConfig,
  outer: Partial<typeof OUTER_DEFAULTS> = {},
): TimeoutValues {
  const o = { ...OUTER_DEFAULTS, ...outer };
  return {
    bridgeRequestMs: o.bridgeRequestMs,
    controlMs: cfg.tool_timeout_secs * 1000,
    rpcCallMs: o.rpcCallMs,
    taskBudgetMs: Math.min(cfg.task_budget_secs, cfg.max_goal_secs) * 1000,
    taskGraceMs: o.taskGraceMs,
    maxGoalMs: cfg.max_goal_secs * 1000,
    launchMs: cfg.launch_wait_secs * 1000,
    activityGameMs: o.activityGameMs,
  };
}

/**
 * Where the order is broken (`[]`: fine). Each entry names the two layers, inner first; the
 * module logs them at start.
 */
export function timeoutViolations(v: TimeoutValues): string[] {
  const pairs: [string, number, string, number][] = [
    ["bridge request", v.bridgeRequestMs, "control call (tool_timeout_secs)", v.controlMs],
    ["control call (tool_timeout_secs)", v.controlMs, "host RPC (call_timeout_ms)", v.rpcCallMs],
    ["host RPC (call_timeout_ms)", v.rpcCallMs, "task budget (task_budget_secs)", v.taskBudgetMs],
    ["task budget", v.taskBudgetMs + v.taskGraceMs, "goal limit (max_goal_secs)", v.maxGoalMs],
    ["launch (launch_wait_secs)", v.launchMs, "game start (game_timeout_ms)", v.activityGameMs],
  ];
  return pairs
    .filter(([, inner, , outer]) => !(inner < outer))
    .map(([a, inner, b, outer]) => `${a} ${inner} ms should be shorter than ${b} ${outer} ms`);
}
