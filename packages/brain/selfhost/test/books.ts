// The delivery ledger and the Floor on one log kept in memory: each event goes to both as it is
// written, as the event log's projections see it.

import { DeliveryLedgerView } from "@miyoria/memory/facts";
import {
  type LogEvent,
  type NewLogEvent,
  newId,
  type Projection,
  toTimestamp,
} from "@miyoria/types";
import { FloorConfigSchema, FloorCore } from "../../arbiter/src/index.js";

export interface Books {
  ledger: DeliveryLedgerView;
  floor: FloorCore;
  events: LogEvent[];
}

/** `extra` projections see every event too (the wish book). */
export function books(
  floor: Record<string, unknown> = {},
  maxUnanswered = 3,
  extra: Projection[] = [],
): Books {
  const events: LogEvent[] = [];
  const projections: Projection[] = [...extra];
  const log = {
    append(input: NewLogEvent): LogEvent {
      const event: LogEvent = {
        id: input.id ?? newId(),
        at: input.at ?? toTimestamp(Date.now()),
        kind: input.kind,
        source: input.source,
        cause: input.cause ?? null,
        context: input.context ?? null,
        person: input.person ?? null,
        body: input.body,
      };
      events.push(event);
      for (const p of projections) p.apply(event);
      return event;
    },
  };
  const ledger = new DeliveryLedgerView(log);
  const core = new FloorCore(FloorConfigSchema.parse(floor), maxUnanswered, {
    now: () => Date.now(),
    ledger: () => ledger,
    log: () => log,
  });
  projections.push(ledger, core);
  return { ledger, floor: core, events };
}
