// The coin ledger's record on the event log (docs/design/v5-data.md §3.3, decision D8): the
// ledger stays the economy plugin's table with its own constraints, and every row it posts is also
// one `economy.posted` event, appended in the same transaction, so her inbox and the audit view
// see money move without reading the economy's tables.
//
// For the owner (`owner`): who paid what is nobody else's. Kept forever (`keep`), like the ledger.
// The envelope's `person_id` is the wallet's person (none for her purse) and its `key` is
// `ledger:<entry id>`.

import { z } from "zod";
import { defineEvent } from "./registry.js";

/** An `economy.posted` payload: one row of the coin ledger. */
export const EconomyPostedSchema = z
  .object({
    /** The ledger row's id. */
    entry_id: z.string(),
    /** The wallet: a person id, or `self` for her purse. */
    person_id: z.string(),
    /** Positive: earned or refunded; negative: spent. Whole coins. */
    delta: z.number().int(),
    /** `checkin`, `feed`, `refund`, `transfer_out`, ... */
    reason: z.string(),
    /** What it is about: the food and count, the frame, her reason, the refunded row. */
    ref: z.string().nullable(),
    /** The key it counts once under in its wallet, `null` without one. */
    idem_key: z.string().nullable(),
    /** The wallet's balance once the row was written. */
    balance: z.number().int(),
  })
  .meta({ id: "EventsEconomyPosted" });
export type EconomyPostedData = z.output<typeof EconomyPostedSchema>;

/** A row of the coin ledger was written. */
export const EconomyPosted = defineEvent({
  type: "economy.posted",
  v: 1,
  data: EconomyPostedSchema,
  scope: "owner",
  tier: "keep",
});
