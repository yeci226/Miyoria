// `GET /api/facts/events` as the panel asks for it: the filters as lists, the wire as comma strings.

import type { FactEventsQuery } from "@/api/types";

/** The input of `api.rpc.facts.events` for `q`: `kind` and `source` joined by commas. */
export function factEventsInput(q: FactEventsQuery) {
  return {
    query: {
      kind: q.kind?.join(","),
      source: q.source?.join(","),
      turn: q.turn,
      since: q.since,
      until: q.until,
      before: q.before,
      order: q.order,
      limit: q.limit,
    },
  };
}
