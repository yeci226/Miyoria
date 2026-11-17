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
// * `GET /api/facts/deliveries`: what really reached someone.

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
} from "@miyoria/types";
import { os } from "./contract.js";
import { parseContextKeyString } from "./data.js";
import { ApiError } from "./errors.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** A value of the query string; a number only when a caller of the typed client passed one. */
type Raw = string | number | undefined;

function limitOf(raw: Raw): number {
  const n = Number(raw ?? DEFAULT_LIMIT);
  if (!Number.isFinite(n)) throw ApiError.badRequest("limit is not a number");
  return clampLimit(n);
}

function clampLimit(limit: number = DEFAULT_LIMIT): number {
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

function listOf(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function contextOf(query: { context?: string; context_kind?: string }): ContextKey | undefined {
  const raw = query.context;
  if (raw === undefined || raw === "") return undefined;
  const context = parseContextKeyString(raw);
  if (context === null) throw ApiError.badRequest("context is not a context key");
  const kind = query.context_kind;
  return kind === undefined ? context : { ...context, kind: kind as ContextKind };
}

function timeOf(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (Number.isNaN(Date.parse(raw))) throw ApiError.badRequest(`${name} is not a timestamp`);
  return raw;
}

/** The filter of a `GET /api/facts/events` request. */
function eventFilter(query: {
  kind?: string;
  source?: string;
  person?: string;
  attention_key?: string;
  context?: string;
  context_kind?: string;
  since?: string;
  until?: string;
  before?: string;
  after?: string;
  order?: string;
  turn?: string;
  limit?: Raw;
}): LogEventFilter {
  const filter: LogEventFilter = { limit: limitOf(query.limit) };
  const kinds = listOf(query.kind);
  if (kinds) {
    if (!kinds.every(isLogEventKind)) throw ApiError.badRequest("unknown event kind");
    filter.kinds = kinds;
  }
  const sources = listOf(query.source);
  if (sources) filter.sources = sources;
  const context = contextOf(query);
  if (context) filter.context = context;
  const since = timeOf("since", query.since);
  if (since !== undefined) filter.since = since;
  const until = timeOf("until", query.until);
  if (until !== undefined) filter.until = until;
  for (const name of ["person", "attention_key", "turn", "before", "after"] as const) {
    const value = query[name];
    if (value !== undefined && value !== "") filter[name] = value;
  }
  const order = query.order;
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

/** The fact routes on the route table (`@miyoria/contracts/api`). */
export const factsRpc = {
  events: os.facts.events.handler(async ({ input, context }) => {
    const filter = eventFilter(input.query);
    const log = context.state.service(EventLogKey, "facts module");
    return filter.turn === undefined ? await log.query(filter) : await turnEvents(log, filter);
  }),
  event: os.facts.event.handler(async ({ input, context }) => {
    const event = await context.state.service(EventLogKey, "facts module").get(input.params.id);
    if (event === null) throw ApiError.notFound("no such event");
    return event;
  }),
  chain: os.facts.chain.handler(async ({ input, context }) => {
    const chain = await context.state.service(EventLogKey, "facts module").chain(input.params.id);
    if (chain.events.length === 0) throw ApiError.notFound("no such event");
    return chain;
  }),
  effects: os.facts.effects.handler(async ({ input, context }) => {
    const log = context.state.service(EventLogKey, "facts module");
    return log.effects(input.params.id, { limit: clampLimit(input.query.limit) });
  }),
  deliveries: os.facts.deliveries.handler(({ input, context }) => {
    const ledger = context.state.service(DeliveryLedgerKey, "facts module");
    const where = contextOf(input.query);
    return ledger.recent({
      limit: limitOf(input.query.limit),
      ...(where ? { context: where } : {}),
    });
  }),
};
