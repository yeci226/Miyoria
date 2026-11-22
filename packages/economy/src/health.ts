// The economy's health table (docs/design/v4-plan.md §10): per day, how many coins were issued (what
// people earned for being with her and playing) against how many were recovered (what they spent
// on her and on the shop), and whether, over the last week, less than `health_warn_ratio` of what
// was issued came back, which is what inflation looks like before anyone feels it.
//
// The numbers come from the ledger, the single source of truth; this only adds them up. The ledger
// store answers `dailyTotals` with one `GROUP BY` (`LedgerStatsStore`, provided by the app); with
// none, the table says it is not available rather than inventing numbers.

import { CARD_REASONS, EXCHANGE_REASONS, KARAOKE_REASONS, MARKET_REASONS } from "@miyoria/types";
import type { EconomyService } from "./economy.js";
import { type LedgerDayTotal, LedgerStatsKey, type LedgerStatsStore } from "./records.js";
import { DANMAKU_REASON, DANMAKU_REFUND_REASON } from "./types.js";
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
  // Karaoke rooms (docs/design/karaoke.md 「做了什麼第四步」): a round's winner and its finishers.
  KARAOKE_REASONS.prize,
  KARAOKE_REASONS.finish,
  // The exchange's real instruments: a sale mints the position's value back (the house pays).
  EXCHANGE_REASONS.mint,
];

/** Reasons that take coins out for good: they were spent on something that does not give them back. */
export const RECOVERED_REASONS: readonly string[] = [
  "feed",
  // A gift named in words (gifts.ts): burned but for her share; one she said no to is refunded.
  "gift",
  "screen_message",
  "dedication",
  "draw", // drawing collectibles, removed: the days before still count
  "shop",
  "room",
  "commission",
  "transfer_fee",
  CARD_REASONS.daily,
  // The weekly market (docs/design/v5-play.md §11.4): the song priority ticket, lottery tickets and
  // the price of a won lot are burned. A bid's hold is neither: it is given back or becomes a win.
  MARKET_REASONS.songPriority,
  MARKET_REASONS.lotteryTicket,
  MARKET_REASONS.auctionWon,
  // A danmaku line is burned (docs/design/v5-play.md §11.6); one the overlay did not show comes back.
  DANMAKU_REASON,
  // Opening a karaoke room is burned; a room that sang no round through gives it back.
  KARAOKE_REASONS.room,
  // The exchange's fees, tax and carry are burned (docs/design/exchange.md §3). What goes into
  // its vault is neither issued nor recovered: it comes back out when people sell.
  EXCHANGE_REASONS.fee,
  // A real buy burns its coins into the position; a loss past the margin is burned too.
  EXCHANGE_REASONS.burn,
  EXCHANGE_REASONS.loss,
];

/**
 * Reasons that give back part of what a recovered reason took: a daily card or a song priority
 * ticket that was refunded, lottery tickets refunded in a week with too few buyers, the
 * lottery prize (the share of the tickets that goes back to a person; the rest stays burned), and
 * a danmaku line the overlay did not show.
 */
export const GIVEN_BACK_REASONS: readonly string[] = [
  CARD_REASONS.refund,
  MARKET_REASONS.songPriorityRefund,
  MARKET_REASONS.lotteryRefund,
  MARKET_REASONS.lotteryPrize,
  DANMAKU_REFUND_REASON,
  KARAOKE_REASONS.roomRefund,
  EXCHANGE_REASONS.feeBack,
  EXCHANGE_REASONS.burnBack,
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
      // A daily card that could not be written gave its coins back: they were not recovered. So do
      // the market's refunds and its lottery prize.
      if (GIVEN_BACK_REASONS.includes(r.reason)) day.recovered -= r.positive;
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
