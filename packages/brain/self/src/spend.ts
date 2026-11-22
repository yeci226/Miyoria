// What each session spent on models in the last hour, against its hourly cap (`RunLimits`
// `sessionUsdPerHour` / `sessionTokensPerHour`, `[modules.agent]` `session_usd_per_hour` /
// `session_tokens_per_hour`). Kept in memory: a restart forgets the hour, and the router's daily
// budget still holds.
//
// A step's cost comes from the router's price table. A model without a price cannot be counted
// in USD, so a session that used one in the hour is held to the token cap instead. A cap of 0 is
// no cap on that basis.
//
// A capped stretch: from the first refusal of a session until it is under its cap again. The
// ledger keeps one mark per stretch, so the warning and the notice to someone waiting are given
// once per stretch, not once per message.

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

/** The two caps of a session, as `over` reads them. */
export type HourCap = Pick<RunLimits, "sessionUsdPerHour" | "sessionTokensPerHour">;

/** A session at its hourly cap. */
export interface Capped {
  spent: HourSpend;
  /** The cap of `spent.basis` (USD or tokens). */
  cap: number;
  /** When enough of the hour's spend has aged out to be under the cap, if nothing is added. */
  until: number;
  /** The first refusal of this stretch: the ledger marked it now. */
  first: boolean;
}

/** One capped stretch of a session. */
interface Stretch {
  cap: HourCap;
  /** The notice to someone waiting was claimed in this stretch. */
  noticed: boolean;
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

function sum(list: readonly Spent[]): HourSpend {
  return {
    usd: list.reduce((n, s) => n + (s.usd ?? 0), 0),
    tokens: list.reduce((n, s) => n + s.tokens, 0),
    basis: list.some((s) => s.usd === null) ? "tokens" : "usd",
  };
}

/** The cap `spent` is counted against; 0: none. */
function capOf(spent: HourSpend, cap: HourCap): number {
  return spent.basis === "usd" ? cap.sessionUsdPerHour : cap.sessionTokensPerHour;
}

function reached(spent: HourSpend, cap: HourCap): boolean {
  const limit = capOf(spent, cap);
  if (!(limit > 0)) return false;
  return (spent.basis === "usd" ? spent.usd : spent.tokens) >= limit;
}

/** What of `list` is within the hour before `at`. */
function within(list: readonly Spent[], at: number): Spent[] {
  return list.filter((s) => at - s.at < HOUR_MS && s.at <= at);
}

export class SpendLedger {
  readonly #sessions = new Map<string, Spent[]>();
  readonly #stretches = new Map<string, Stretch>();

  add(session: string, at: number, usd: number | null, usage: Usage): void {
    const list = this.#sessions.get(session) ?? [];
    // Under the cap right before this spend: the stretch it was in has ended.
    const stretch = this.#stretches.get(session);
    if (stretch !== undefined && !reached(sum(within(list, at)), stretch.cap)) {
      this.#stretches.delete(session);
    }
    list.push({ at, usd, tokens: usage.prompt_tokens + usage.completion_tokens });
    this.#sessions.set(session, list);
  }

  /** What `session` spent in the hour before `now`. */
  hour(session: string, now: number): HourSpend {
    const all = this.#sessions.get(session) ?? [];
    const list = all.filter((s) => now - s.at < HOUR_MS);
    if (list.length === 0) this.#sessions.delete(session);
    else if (list.length !== all.length) this.#sessions.set(session, list);
    return sum(list);
  }

  /** Whether `session` reached its hourly cap. */
  over(session: string, now: number, limits: HourCap): boolean {
    return reached(this.hour(session, now), limits);
  }

  /**
   * `session` at its hourly cap at `now`, or `null` when it is under it (which ends its stretch).
   * The first call of a stretch marks it (`first`).
   */
  capped(session: string, now: number, limits: HourCap): Capped | null {
    const spent = this.hour(session, now);
    if (!reached(spent, limits)) {
      this.#stretches.delete(session);
      return null;
    }
    const first = !this.#stretches.has(session);
    if (first) this.#stretches.set(session, { cap: { ...limits }, noticed: false });
    return { spent, cap: capOf(spent, limits), until: this.#under(session, now, limits), first };
  }

  /**
   * Takes the one notice of `session`'s stretch: `true` the first time, `false` after (or when the
   * session is not capped). `releaseNotice` gives it back when it could not be said.
   */
  claimNotice(session: string): boolean {
    const stretch = this.#stretches.get(session);
    if (stretch === undefined || stretch.noticed) return false;
    stretch.noticed = true;
    return true;
  }

  releaseNotice(session: string): void {
    const stretch = this.#stretches.get(session);
    if (stretch !== undefined) stretch.noticed = false;
  }

  /**
   * When `session` is under `limits` again if it spends nothing more: the first moment, from `now`
   * on, at which what is left of the hour is under the cap. What leaves the hour may also change
   * the basis (a call without a price aging out), so each moment is counted as a whole.
   */
  #under(session: string, now: number, limits: HourCap): number {
    const list = within(this.#sessions.get(session) ?? [], now);
    if (!reached(sum(list), limits)) return now;
    const moments = [...new Set(list.map((s) => s.at + HOUR_MS))].sort((a, b) => a - b);
    for (const at of moments) {
      if (!reached(sum(within(list, at)), limits)) return at;
    }
    return moments.at(-1) ?? now;
  }
}
