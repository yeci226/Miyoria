import type { BusEnvelope } from "@/lib/events";

/** A bus envelope as `GET /api/events` sends it: every key present, `null` when unset. */
export function envelope(type: string, data: unknown, fields: Partial<BusEnvelope> = {}): BusEnvelope {
  return {
    id: "E1",
    at: "2026-11-01T00:00:00Z",
    type,
    v: 1,
    parent: null,
    turn: null,
    session: null,
    space_id: null,
    room_id: null,
    person_id: null,
    account_id: null,
    key: null,
    scope: null,
    source: "agent",
    data: data as BusEnvelope["data"],
    ...fields,
  };
}
