// Call caps shared by the modules: per rolling hour, per rolling day, a minimum gap, and the
// LLM budget (degraded = fewer calls, exhausted = none).

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type BudgetState = "ok" | "degraded" | "exhausted";

export interface CapLimits {
  perHour: number | null;
  perDay: number | null;
  minIntervalMs: number;
}

export class CallCap {
  #calls: number[] = [];
  total = 0;

  constructor(readonly limits: CapLimits) {}

  #prune(now: number): number[] {
    this.#calls = this.#calls.filter((t) => now - t < DAY_MS);
    return this.#calls;
  }

  record(now: number): void {
    this.#prune(now).push(now);
    this.total++;
  }

  lastHour(now: number): number {
    return this.#prune(now).filter((t) => now - t < HOUR_MS).length;
  }

  lastDay(now: number): number {
    return this.#prune(now).length;
  }

  last(): number | null {
    return this.#calls.at(-1) ?? null;
  }

  /**
   * Whether a call is allowed now. A degraded budget halves the caps and doubles the gap; an
   * exhausted one allows nothing.
   */
  allows(now: number, budget: BudgetState = "ok"): boolean {
    if (budget === "exhausted") return false;
    const scale = budget === "degraded" ? 0.5 : 1;
    const { perHour, perDay, minIntervalMs } = this.limits;
    if (perHour !== null && this.lastHour(now) >= Math.floor(perHour * scale)) return false;
    if (perDay !== null && this.lastDay(now) >= Math.floor(perDay * scale)) return false;
    const last = this.last();
    const gap = minIntervalMs * (budget === "degraded" ? 2 : 1);
    return last === null || now - last >= gap;
  }
}
