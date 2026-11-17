// What each session spent on models in the last hour (owner decision Q6: 1 USD per session per
// hour). Kept in memory: a restart forgets the hour, and the router's daily budget still holds.
//
// A step's cost comes from the router's price table. A model without a price cannot be counted
// in USD, so a session that used one in the hour is held to the token cap instead.

import { callCost, type Pricing, type Usage } from "@miyoria/llm/llm";
import type { RunLimits } from "./profiles.js";

const HOUR_MS = 3_600_000;

interface Spent {
  at: number;
  /** `null`: the model had no price. */
  usd: number | null;
  tokens: number;
}

export interface HourSpend {
  usd: number;
  tokens: number;
  /** How the cap is counted: `tokens` when a call of the hour had no price. */
  basis: "usd" | "tokens";
}

/** The cost of one call, or `null` when `model` has no price. */
export function stepCost(
  prices: Record<string, Pricing> | undefined,
  model: string | null,
  usage: Usage,
): number | null {
  const price = model === null ? undefined : prices?.[model];
  return price === undefined ? null : callCost(price, usage);
}

export class SpendLedger {
  readonly #sessions = new Map<string, Spent[]>();

  add(session: string, at: number, usd: number | null, usage: Usage): void {
    const list = this.#sessions.get(session) ?? [];
    list.push({ at, usd, tokens: usage.prompt_tokens + usage.completion_tokens });
    this.#sessions.set(session, list);
  }

  /** What `session` spent in the hour before `now`. */
  hour(session: string, now: number): HourSpend {
    const all = this.#sessions.get(session) ?? [];
    const list = all.filter((s) => now - s.at < HOUR_MS);
    if (list.length === 0) this.#sessions.delete(session);
    else if (list.length !== all.length) this.#sessions.set(session, list);
    return {
      usd: list.reduce((n, s) => n + (s.usd ?? 0), 0),
      tokens: list.reduce((n, s) => n + s.tokens, 0),
      basis: list.some((s) => s.usd === null) ? "tokens" : "usd",
    };
  }

  /** Whether `session` reached its hourly cap. */
  over(session: string, now: number, limits: RunLimits): boolean {
    const spent = this.hour(session, now);
    return spent.basis === "usd"
      ? spent.usd >= limits.sessionUsdPerHour
      : spent.tokens >= limits.sessionTokensPerHour;
  }
}
