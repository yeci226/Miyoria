// The market's events on the event log (`LotClosed`, `LotteryDrawn` of
// `@miyoria/contracts/events`), each appended in the transaction that records it (`store.ts`).
// Their scope (the owner's) and tier (kept) are the definitions'.

import {
  LotClosed,
  type LotClosedData,
  LotteryDrawn,
  type LotteryDrawnData,
} from "@miyoria/contracts/events";
import type { EventWrite } from "@miyoria/store";
import { newId, type Timestamp } from "@miyoria/types";

/** What the market writes to the log as (the module's id). */
export const MARKET_SOURCE = "market";

export type { LotClosedData, LotteryDrawnData };

export function lotClosedWrite(data: LotClosedData, at: Timestamp): EventWrite {
  return {
    draft: {
      id: newId(),
      at,
      type: LotClosed.type,
      v: LotClosed.v,
      person_id: data.winner,
      data,
    },
    source: MARKET_SOURCE,
  };
}

export function lotteryDrawnWrite(data: LotteryDrawnData, at: Timestamp): EventWrite {
  return {
    draft: {
      id: newId(),
      at,
      type: LotteryDrawn.type,
      v: LotteryDrawn.v,
      person_id: data.winner,
      data,
    },
    source: MARKET_SOURCE,
  };
}
