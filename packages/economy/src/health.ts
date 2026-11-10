// The economy's health table (docs/design/v4-plan.md §10): per day, how many coins were issued (what
// people earned for being with her and playing) against how many were recovered (what they spent
// on her and on the shop), and whether, over the last week, less than `health_warn_ratio` of what
// was issued came back, which is what inflation looks like before anyone feels it.
//
// The numbers come from the ledger, the single source of truth; this only adds them up. The ledger
// store answers `dailyTotals` with one `GROUP BY` (`LedgerStatsStore`, provided by the app); with
// none, the table says it is not available rather than inventing numbers.

import type { LedgerDayTotal } from "@miyoria/store";
import { LedgerStatsKey, type LedgerStatsStore } from "@miyoria/store";
import type { EconomyService } from "./economy.js";
import type { HealthView } from "./v2-types.js";

export { type LedgerDayTotal, LedgerStatsKey, type LedgerStatsStore };

/** Reasons that put new coins into the economy: nothing was spent for them. */
export const ISSUED_REASONS: readonly string[] = [
  "checkin",
  "talked",
  "voice",
  "song",
  "her_gift",
  "quest",
  "play",
  "achievement",
];

/** Reasons that take coins out for good: they were spent on something that does not give them back. */
export const RECOVERED_REASONS: readonly string[] = [
  "feed",
  "letter",
  "expression",
  "screen_message",
  "dedication",
  "draw",
  "shop",
  "room",
  "commission",
];

const WEEK = 7;

export class Health {
  constructor(private readonly e: EconomyService) {}

  async view(): Promise<HealthView> {
    const c = this.e.config;
    const stats = this.e.services.get(LedgerStatsKey);
    if (!stats) {
      return {
        available: false,
        days: [],
        week: { issued: 0, recovered: 0, ratio: null },
        warn: null,
      };
    }
    const today = this.e.today();
    const first = today - c.health_days + 1;
    const rows = await stats.dailyTotals(
      this.e.profile,
      this.e.dayStart(first),
      c.utc_offset_minutes,
    );
    const days = new Map<number, { issued: number; recovered: number }>();
    for (let d = first; d <= today; d++) days.set(d, { issued: 0, recovered: 0 });
    for (const r of rows) {
      const day = days.get(r.day);
      if (!day) continue;
      if (ISSUED_REASONS.includes(r.reason)) day.issued += r.positive;
      if (RECOVERED_REASONS.includes(r.reason)) day.recovered += r.negative;
    }
    const list = [...days.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, t]) => ({
        day,
        date: this.e.dayStart(day),
        issued: t.issued,
        recovered: t.recovered,
        ratio: t.issued > 0 ? Math.round((t.recovered / t.issued) * 100) / 100 : null,
      }));
    const last = list.slice(-WEEK);
    const issued = last.reduce((n, d) => n + d.issued, 0);
    const recovered = last.reduce((n, d) => n + d.recovered, 0);
    const ratio = issued > 0 ? Math.round((recovered / issued) * 100) / 100 : null;
    const warn =
      ratio !== null && ratio < c.health_warn_ratio
        ? `這個禮拜發出去 ${issued} ${c.currency}，只收回 ${recovered}（${Math.round(ratio * 100)}%），低於 ${Math.round(c.health_warn_ratio * 100)}%：幣在變多，通貨膨脹中，考慮調低賺的或加新的用途`
        : null;
    return { available: true, days: list, week: { issued, recovered, ratio }, warn };
  }
}
