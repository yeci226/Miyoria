// The log as replay input. An observation keeps the bus event it came from (`origin`), so a slice
// of the log turns back into the lines `tools/replay` reads (`ReplayEntry`: one bus envelope per
// line, in time order). Which of them count as input stays the replay's call (`isReplayInput`);
// `formatEntry` from `@miyoria/runtime/replay-log` writes them as JSONL.
//
// A line is the envelope as far as the observation keeps it: its id and time (the observation's
// own), the event's type, version and payload (`origin.event`), the publishing module and the
// turn. The rest is `null`: the observation's `cause` is the writer's, not the event's `parent`,
// and the place fields were never kept.

import { type BusEnvelopeJson, isJsonObject, type LogEvent } from "@miyoria/types";
import { observationBody } from "./context.js";

/** The shape of `ReplayEntry` (this package does not depend on the replay). */
export type ReplayLine = BusEnvelopeJson;

/** The bus events behind `events`, oldest first. Lines without an origin have none. */
export function toReplayLines(events: readonly LogEvent[]): ReplayLine[] {
  const lines: ReplayLine[] = [];
  // Ids sort in creation order, also inside one millisecond.
  for (const event of [...events].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const origin = observationBody(event)?.origin;
    if (!origin || !isJsonObject(origin.event)) continue;
    const { type, v, data } = origin.event;
    if (typeof type !== "string" || typeof v !== "number" || data === undefined) continue;
    lines.push({
      id: event.id,
      at: event.at,
      type,
      v,
      parent: null,
      turn: origin.turn,
      session: null,
      space_id: null,
      room_id: null,
      person_id: null,
      account_id: null,
      key: null,
      scope: null,
      source: origin.module,
      data,
    });
  }
  return lines;
}
