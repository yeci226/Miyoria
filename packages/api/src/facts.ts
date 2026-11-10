// The fact layer, read-only (docs/design/v3-architecture.md §5, §8): the EventLog with its `cause`
// chains, what she knows right now and what really reached someone. The panel's 意識軸 reads these.
//
// * `GET /api/facts/events`: `kind`, `source` (comma lists), `person`, `attention_key`, `context`
//   (`contextKeyString`, plus `context_kind` when it is not a `channel` / `voice` one), `since`,
//   `until`, `before`, `after`, `order`, `limit`, and `turn`: one turn's lines, which are the ones
//   that name it in their body and whatever those caused (`kind`, `source`, `person`, `context`,
//   `since`, `until`, `order` and `limit` then narrow that; paging and `attention_key` do not).
//   (`GET /api/events` is the live bus stream.)
// * `GET /api/facts/events/:id`, `.../:id/chain` (its causes, oldest first), `.../:id/effects`
//   (what it caused).
// * `GET /api/facts/context`, `GET /api/facts/deliveries`, `GET /api/facts/retryable`.

import {
  type ContextKey,
  type ContextKind,
  contextKeyString,
  DeliveryLedgerKey,
  type EventLog,
  EventLogKey,
  isLogEventKind,
  type LogEvent,
  type LogEventFilter,
  WorkingContextKey,
} from "@miyoria/types";
import { parseContextKeyString } from "./data.js";
import { ApiError } from "./errors.js";
import { json, param, type Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function limitOf(c: ApiContext): number {
  const raw = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
  if (!Number.isFinite(raw)) throw ApiError.badRequest("limit is not a number");
  return Math.min(Math.max(Math.floor(raw), 1), MAX_LIMIT);
}

function listOf(c: ApiContext, name: string): string[] | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function contextOf(c: ApiContext): ContextKey | undefined {
  const raw = c.req.query("context");
  if (raw === undefined || raw === "") return undefined;
  const context = parseContextKeyString(raw);
  if (context === null) throw ApiError.badRequest("context is not a context key");
  const kind = c.req.query("context_kind");
  return kind === undefined ? context : { ...context, kind: kind as ContextKind };
}

function timeOf(c: ApiContext, name: string): string | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return undefined;
  if (Number.isNaN(Date.parse(raw))) throw ApiError.badRequest(`${name} is not a timestamp`);
  return raw;
}

/** The filter of a `GET /api/facts/events` request. */
export function eventFilter(c: ApiContext): LogEventFilter {
  const filter: LogEventFilter = { limit: limitOf(c) };
  const kinds = listOf(c, "kind");
  if (kinds) {
    if (!kinds.every(isLogEventKind)) throw ApiError.badRequest("unknown event kind");
    filter.kinds = kinds;
  }
  const sources = listOf(c, "source");
  if (sources) filter.sources = sources;
  const context = contextOf(c);
  if (context) filter.context = context;
  const since = timeOf(c, "since");
  if (since !== undefined) filter.since = since;
  const until = timeOf(c, "until");
  if (until !== undefined) filter.until = until;
  for (const name of ["person", "attention_key", "turn", "before", "after"] as const) {
    const value = c.req.query(name);
    if (value !== undefined && value !== "") filter[name] = value;
  }
  const order = c.req.query("order");
  if (order === "asc" || order === "desc") filter.order = order;
  return filter;
}

/** Whether `event` passes what `filter` says besides the turn and paging. */
function narrows(event: LogEvent, filter: LogEventFilter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.sources && !filter.sources.includes(event.source)) return false;
  if (filter.person !== undefined && event.person !== filter.person) return false;
  if (filter.context) {
    if (event.context === null) return false;
    if (contextKeyString(event.context) !== contextKeyString(filter.context)) return false;
  }
  const at = Date.parse(event.at);
  if (filter.since !== undefined && at < Date.parse(filter.since)) return false;
  if (filter.until !== undefined && at >= Date.parse(filter.until)) return false;
  return true;
}

/**
 * One turn's lines: those whose body names it, and what they caused, however far down (a delivery
 * ack names the line it acks, not the turn).
 */
async function turnEvents(log: EventLog, filter: LogEventFilter): Promise<LogEvent[]> {
  const named = await log.query({ turn: filter.turn as string, order: "asc", limit: MAX_LIMIT });
  const caused = await Promise.all(named.map((e) => log.effects(e.id, { limit: MAX_LIMIT })));
  const all = new Map<string, LogEvent>();
  for (const e of [...named, ...caused.flat()]) all.set(e.id, e);
  const found = [...all.values()].filter((e) => narrows(e, filter));
  found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (filter.order !== "asc") found.reverse();
  return found.slice(0, filter.limit ?? DEFAULT_LIMIT);
}

export function factRoutes(state: ApiState): Route[] {
  const events = () => state.service(EventLogKey, "facts module");
  const ledger = () => state.service(DeliveryLedgerKey, "facts module");
  return [
    {
      method: "GET",
      path: "/api/facts/events",
      handler: async (c) => {
        const filter = eventFilter(c);
        return json(
          filter.turn === undefined
            ? await events().query(filter)
            : await turnEvents(events(), filter),
        );
      },
    },
    {
      method: "GET",
      path: "/api/facts/events/:id",
      handler: async (c) => {
        const event = await events().get(param(c, "id"));
        if (event === null) throw ApiError.notFound("no such event");
        return json(event);
      },
    },
    {
      method: "GET",
      path: "/api/facts/events/:id/chain",
      handler: async (c) => {
        const chain = await events().chain(param(c, "id"));
        if (chain.events.length === 0) throw ApiError.notFound("no such event");
        return json(chain);
      },
    },
    {
      method: "GET",
      path: "/api/facts/events/:id/effects",
      handler: async (c) => json(await events().effects(param(c, "id"), { limit: limitOf(c) })),
    },
    {
      method: "GET",
      path: "/api/facts/context",
      handler: (c) => json(state.service(WorkingContextKey, "facts module").buckets(contextOf(c))),
    },
    {
      method: "GET",
      path: "/api/facts/deliveries",
      handler: (c) => {
        const context = contextOf(c);
        return json(ledger().recent({ limit: limitOf(c), ...(context ? { context } : {}) }));
      },
    },
    {
      method: "GET",
      path: "/api/facts/retryable",
      handler: (c) => {
        const context = contextOf(c);
        return json(ledger().retryable({ limit: limitOf(c), ...(context ? { context } : {}) }));
      },
    },
  ];
}
