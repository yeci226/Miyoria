// The weekly market's record on the event log (docs/design/v5-play.md §11.4): an auction lot that
// closed (who won it and for how much, or that nobody bid) is one `market.lot_closed`, and a
// lottery week that was drawn (the pot, the prize, what was burned and who won, or that too few
// bought and everyone was refunded) is one `market.lottery_drawn`, each appended in the
// transaction that records it. Money records: the owner's scope, kept like the ledger. Who bid
// and who bought is in the market's own tables; the coins are `economy.posted`.

import { z } from "zod";
import { defineEvent } from "./registry.js";

/** A `market.lot_closed` payload. */
export const LotClosedSchema = z
  .object({
    lot: z.string(),
    /** The local day number it opened on. */
    week: z.number().int(),
    /** `call_name`, `frame`. */
    kind: z.string(),
    /** The winning bid's id, its person and price; all `null` when nobody bid. */
    winner_bid: z.string().nullable(),
    winner: z.string().nullable(),
    price: z.number().int().nullable(),
    bids: z.number().int().nonnegative(),
    bidders: z.number().int().nonnegative(),
    /** The end moved for a bid near it. */
    extended: z.boolean(),
  })
  .meta({ id: "EventsLotClosed" });
export type LotClosedData = z.output<typeof LotClosedSchema>;

/** A `market.lottery_drawn` payload. */
export const LotteryDrawnSchema = z
  .object({
    /** The local day number it was drawn on. */
    week: z.number().int(),
    tickets: z.number().int().nonnegative(),
    buyers: z.number().int().nonnegative(),
    /** Every coin paid for the week's tickets. */
    pot: z.number().int().nonnegative(),
    prize: z.number().int().nonnegative(),
    burned: z.number().int().nonnegative(),
    /** The winner's person; `null` when it was refunded. */
    winner: z.string().nullable(),
    /** Too few bought: no draw, every ticket refunded. */
    refunded: z.boolean(),
  })
  .meta({ id: "EventsLotteryDrawn" });
export type LotteryDrawnData = z.output<typeof LotteryDrawnSchema>;

/** An auction lot closed. */
export const LotClosed = defineEvent({
  type: "market.lot_closed",
  v: 1,
  data: LotClosedSchema,
  scope: "owner",
  tier: "keep",
});

/** A lottery week drawn (or refunded). */
export const LotteryDrawn = defineEvent({
  type: "market.lottery_drawn",
  v: 1,
  data: LotteryDrawnSchema,
  scope: "owner",
  tier: "keep",
});

/** The market's log types. */
export const MARKET_EVENTS = [LotClosed, LotteryDrawn] as const;
