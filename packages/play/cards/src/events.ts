// The cards' events on the event log (`CardDrawn`, `CardTitled` of `@miyoria/contracts/events`):
// a card drawn, with whether the pity decided it and which wished parts it has, and a series
// completed. Each is appended in the transaction that writes the card (`store.ts`), as the heart
// appends `heart.changed` with its row. Their scope (the person's DM) and tier (a year) are the
// definitions'.

import {
  CardDrawn,
  type CardDrawnData,
  CardTitled,
  type CardTitledData,
} from "@miyoria/contracts/events";
import type { EventWrite } from "@miyoria/store";
import { newId, type Timestamp } from "@miyoria/types";

/** What the cards write to the log as (the module's id). */
export const CARDS_SOURCE = "cards";

export const CARDS_DRAWN = CardDrawn.type;
export const CARDS_TITLED = CardTitled.type;

export type { CardDrawnData, CardTitledData };

export function drawnWrite(data: CardDrawnData, at: Timestamp): EventWrite {
  return {
    draft: { id: newId(), at, type: CardDrawn.type, v: CardDrawn.v, person_id: data.person, data },
    source: CARDS_SOURCE,
  };
}

export function titledWrite(data: CardTitledData, at: Timestamp): EventWrite {
  return {
    draft: {
      id: newId(),
      at,
      type: CardTitled.type,
      v: CardTitled.v,
      person_id: data.person,
      data,
    },
    source: CARDS_SOURCE,
  };
}
