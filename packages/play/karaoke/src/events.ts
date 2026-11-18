// Karaoke's event on the event log (`KaraokeScored` of `@miyoria/contracts/events`), appended in
// the transaction that stores the result (`store.ts`). Its scope (the singer's DM) and tier (a
// year) are the definition's.

import { KaraokeScored, type KaraokeScoredData } from "@miyoria/contracts/events";
import type { EventWrite } from "@miyoria/store";
import { newId, type Timestamp } from "@miyoria/types";

/** What karaoke writes to the log as (the module's id). */
export const KARAOKE_SOURCE = "karaoke";

export type { KaraokeScoredData };

export function karaokeScoredWrite(
  data: KaraokeScoredData,
  person: string | null,
  at: Timestamp,
): EventWrite {
  return {
    draft: {
      id: newId(),
      at,
      type: KaraokeScored.type,
      v: KaraokeScored.v,
      person_id: person,
      data,
    },
    source: KARAOKE_SOURCE,
  };
}
