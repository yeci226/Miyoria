// The failure guard: after an action fails, the low-level move / mine actions are withheld for a
// while, so the next decision has to change method (plan with `obtain`, explore, craft what is
// missing) or goal instead of sending the same `mine` again. Pure; times are epoch ms.

import type { GameConfig } from "./config.js";

export interface FailureGuard {
  /** Actions withheld until `until`. */
  actions: string[];
  until: number;
  /** Why (the failure, first line), for her prompt and the trace. */
  why: string;
  /** A withheld proposal already asked for a quick new decision (only once per guard). */
  nudged: boolean;
}

type GuardConfig = Pick<GameConfig, "failure_guard_secs" | "guarded_actions">;

/** The guard a failure starts; `null` when it is turned off. */
export function guardAfter(cfg: GuardConfig, why: string, now: number): FailureGuard | null {
  if (cfg.failure_guard_secs <= 0 || cfg.guarded_actions.length === 0) return null;
  return {
    actions: [...cfg.guarded_actions],
    until: now + cfg.failure_guard_secs * 1000,
    why,
    nudged: false,
  };
}

/** The guard while it lasts, else `null`. */
export function activeGuard(guard: FailureGuard | null, now: number): FailureGuard | null {
  return guard !== null && now < guard.until ? guard : null;
}

/** Whether `action` is withheld right now. */
export function withheld(guard: FailureGuard | null, action: string, now: number): boolean {
  return activeGuard(guard, now)?.actions.includes(action) ?? false;
}

/**
 * The guard after `action` succeeded: a different (not withheld) action that worked means she
 * changed method, which ends it.
 */
export function afterSuccess(
  guard: FailureGuard | null,
  action: string,
  now: number,
): FailureGuard | null {
  const g = activeGuard(guard, now);
  return g && !g.actions.includes(action) ? null : g;
}

/** Prompt line while the guard lasts (the failure text is game data; the caller escapes it). */
export function guardNote(guard: FailureGuard | null, now: number): string | null {
  const g = activeGuard(guard, now);
  if (!g) return null;
  const secs = Math.max(1, Math.ceil((g.until - now) / 1000));
  return `暫時不能用 ${g.actions.join("、")}(還有 ${secs} 秒):上一個動作失敗了(${g.why})。換個方法(例如 obtain 缺的東西、explore)或換個目標,不要重試同一件事。`;
}
