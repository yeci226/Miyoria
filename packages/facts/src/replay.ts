// The log as replay input. An observation keeps the bus event it came from (`origin`), so a slice
// of the log turns back into the lines `packages/replay` reads (`ReplayEntry`: `{at, source,
// event}`, in time order). Which of them count as input stays the replay's call
// (`isReplayInput`); `formatEntry` from `@miyoria/replay` writes them as JSONL.

import type { Event, LogEvent, Timestamp } from "@miyoria/types";
import { observationBody } from "./context.js";

/** The shape of `ReplayEntry` (this package does not depend on the replay). */
export interface ReplayLine {
  at: Timestamp;
  source: string;
  event: Event;
}

/** The bus events behind `events`, oldest first. Lines without an origin have none. */
export function toReplayLines(events: readonly LogEvent[]): ReplayLine[] {
  const lines: ReplayLine[] = [];
  // Ids sort in creation order, also inside one millisecond.
  for (const event of [...events].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const origin = observationBody(event)?.origin;
    if (!origin) continue;
    lines.push({ at: event.at, source: origin.module, event: origin.event as unknown as Event });
  }
  return lines;
}
