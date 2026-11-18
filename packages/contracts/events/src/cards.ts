// The cards' record on the event log (docs/design/v5-play.md §2, §6.3): every card she gives is one
// `cards.drawn`, appended in the transaction that writes the `cards_card` row, with whether the
// pity decided its rarity and which wished parts it has; completing a series of the dex is one
// `cards.titled`. Her inbox hears of the ones worth a word (a rare card, the pity, a wish, a title).
//
// About one person, so scoped to her DM with them (`dm`): a card is for the person it was given
// to and never shown in a room. Kept a year (`long`) like the heart's evidence; the cards
// themselves are kept in `cards_card`. The envelope's `person_id` is the card's person.

import { z } from "zod";
import { defineEvent } from "./registry.js";

export const CardRaritySchema = z.enum(["N", "R", "SR", "SSR"]).meta({ id: "EventsCardRarity" });

/** A `cards.drawn` payload: one card given. */
export const CardDrawnSchema = z
  .object({
    /** `MYR-XXXX-XXXX-XXXX`. */
    serial: z.string(),
    person: z.string(),
    /** `daily`, `milestone`, `keepsake`, `drop`. */
    kind: z.string(),
    rarity: CardRaritySchema,
    /** The part ids, in slot order. */
    parts: z.array(z.string()),
    /** Her expression on it (chosen by the relationship). */
    expression: z.string(),
    /** Fish coins it cost. */
    price: z.number().int().nonnegative(),
    /** The pity decided its rarity. */
    pity_hit: z.boolean(),
    /** Cards in a row without SR or better after it. */
    pity_since: z.number().int().nonnegative(),
    /** Wished parts it has, in the wishlist's order. */
    wished: z.array(z.string()),
    /** Parts the person had never had before. */
    new_parts: z.array(z.string()),
  })
  .meta({ id: "EventsCardDrawn" });
export type CardDrawnData = z.output<typeof CardDrawnSchema>;

/** A `cards.titled` payload: a series of the dex completed. */
export const CardTitledSchema = z
  .object({
    person: z.string(),
    series: z.string(),
    /** The title it gave. */
    title: z.string(),
    /** The card that completed it. */
    serial: z.string(),
  })
  .meta({ id: "EventsCardTitled" });
export type CardTitledData = z.output<typeof CardTitledSchema>;

/** One card given. */
export const CardDrawn = defineEvent({
  type: "cards.drawn",
  v: 1,
  data: CardDrawnSchema,
  scope: "dm",
  tier: "long",
});

/** A series of the dex completed. */
export const CardTitled = defineEvent({
  type: "cards.titled",
  v: 1,
  data: CardTitledSchema,
  scope: "dm",
  tier: "long",
});

/** The cards' log types. */
export const CARDS_EVENTS = [CardDrawn, CardTitled] as const;
