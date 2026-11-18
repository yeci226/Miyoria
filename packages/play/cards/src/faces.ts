// The words on a card nobody asked for at the counter (`CardFacesKey`): a milestone card is issued
// when the heart says a bond entered a new tier, with no member page open and no session to take a
// name from. The api module, which writes a daily card's words (what the member page shows, her
// line passed by moderation and naming nobody else), provides it; without it a milestone card goes
// out with the person's name only (`module.ts`). A keepsake card's line comes through it too, later
// than the card (`module.ts`, `CardService.writeKeepsakeLines`).

import { type PersonId, serviceKey } from "@miyoria/types";
import type { CardFace, CardField, CardRelationship } from "./store.js";

/** What a card is given for, as she is told when she writes it. */
export type CardOccasion =
  | {
      kind: "milestone";
      /** The tier entered (its bare name: 好朋友, 知心). */
      tier: string;
      /**
       * The shared memory the tier rests on, as she quoted it when she anchored it (from 知心 up,
       * docs/design/v5-heart.md H4); `null` below that, or for a tier the migration grandfathered.
       */
      scene: string | null;
    }
  | {
      /**
       * The keepsake of someone who knew her before the cards (P5): issued with facts only, her
       * line for it written later (`CardService.writeKeepsakeLines`).
       */
      kind: "keepsake";
      /** What the card already says of them (since when, what they were, their old cards). */
      facts: readonly CardField[];
    };

/** The words and the relationship a card shows. */
export interface OccasionFace {
  face: CardFace;
  relationship: CardRelationship;
}

export interface CardFaces {
  /**
   * The face of a card for `person` on `occasion`, with her words when she can write them; `null`
   * when no card should name them now (someone she will not say anything about, or nobody she can
   * find an account of).
   */
  face(person: PersonId, occasion: CardOccasion): Promise<OccasionFace | null>;
  /**
   * The words on card `serial` changed after it was issued (her line on a keepsake): whatever
   * picture of the whole card is kept goes. Optional.
   */
  rewritten?(serial: string): void;
}

export const CardFacesKey = serviceKey<CardFaces>("CardFaces");
