// The EventLog (docs/design/v3-architecture.md §5): append-only, one line per fact.
//
// `append` only touches memory: the event goes into the hot window, the write buffer and the
// projections, and a task writes the buffer in one transaction every `flush_ms`. So a slow or
// broken store can never reach a turn or the voice path: `append` does not throw and does not
// wait, and while the store fails the buffer holds on, bounded, dropping its oldest events.

import { errorMessage, getLogger, metrics } from "@miyoria/kernel";
import type { EventLogStore } from "@miyoria/store";
import {
  type CauseChain,
  type Clock,
  contextKeyEquals,
  type EventLog,
  isJsonObject,
  type JsonValue,
  type LogEvent,
  type LogEventFilter,
  type NewLogEvent,
  newId,
  type Observation,
  type ObservationBody,
  type ObserveOptions,
  type ProfileId,
  type Projection,
  systemClock,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";

const log = getLogger("facts");

const appended = metrics.counter("miyoria_facts_events_total", {
  help: "Events appended to the EventLog, by kind.",
  labels: ["kind"],
});
const dropped = metrics.counter("miyoria_facts_events_dropped_total", {
  help: "Events dropped before they reached the store (it kept failing).",
});
// `node:sqlite` is synchronous: a flush holds the event loop, the voice path included, this long.
const flushSeconds = metrics.histogram("miyoria_facts_flush_seconds", {
  help: "How long one write of the EventLog's buffer took.",
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
});

/** Page size of `project`. */
const PROJECT_PAGE = 1_000;
const DEFAULT_LIMIT = 100;
const DEFAULT_CHAIN_DEPTH = 64;
const DEFAULT_EFFECTS = 200;
const DEFAULT_EFFECTS_DEPTH = 32;

/** The key an event is filed under: its observation's, or the one in its body. */
export function attentionOf(event: LogEvent): string | null {
  const body = event.body;
  if (!isJsonObject(body)) return null;
  const fields = isJsonObject(body.observation) ? body.observation : body;
  return typeof fields.attention_key === "string" ? fields.attention_key : null;
}

/** The turn a line's body names (`turn`, or the `turn_outcome` of a turn's result), if any. */
export function turnOf(event: LogEvent): string | null {
  const body = event.body;
  if (!isJsonObject(body)) return null;
  if (typeof body.turn === "string") return body.turn;
  const outcome = body.turn_outcome;
  return isJsonObject(outcome) && typeof outcome.turn === "string" ? outcome.turn : null;
}

/** Whether `event` passes `filter` (paging and order aside, what the store's `query` does). */
export function matchesFilter(event: LogEvent, filter: LogEventFilter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.sources && !filter.sources.includes(event.source)) return false;
  if (filter.context) {
    if (event.context === null || !contextKeyEquals(event.context, filter.context)) return false;
  }
  if (filter.person !== undefined && event.person !== filter.person) return false;
  if (filter.attention_key !== undefined && attentionOf(event) !== filter.attention_key) {
    return false;
  }
  if (filter.turn !== undefined && turnOf(event) !== filter.turn) return false;
  const at = timestampMs(event.at);
  if (filter.since !== undefined && at < timestampMs(filter.since)) return false;
  if (filter.until !== undefined && at >= timestampMs(filter.until)) return false;
  if (filter.before !== undefined && event.id >= filter.before) return false;
  if (filter.after !== undefined && event.id <= filter.after) return false;
  return true;
}

/** Plain JSON, whatever a writer handed in: a bad body must not poison a whole batch. */
function plain(body: JsonValue): JsonValue {
  try {
    return JSON.parse(JSON.stringify(body ?? null)) as JsonValue;
  } catch (error) {
    return { unserializable: errorMessage(error) };
  }
}

export interface EventLogServiceOptions {
  profile: ProfileId;
  /** `null`: the log lives in memory only (the backend has no event log). */
  store: EventLogStore | null;
  clock?: Clock;
  /** Events kept in memory. Default 2000. */
  hotEvents?: number;
  /** Events held for a failing store. Default 20 000. */
  maxBuffer?: number;
}

export class EventLogService implements EventLog {
  readonly #profile: ProfileId;
  readonly #store: EventLogStore | null;
  readonly #clock: Clock;
  readonly #hotEvents: number;
  readonly #maxBuffer: number;
  /** Newest events by id; a `Map` keeps them in append order. */
  readonly #hot = new Map<string, LogEvent>();
  readonly #projections = new Set<Projection>();
  #buffer: LogEvent[] = [];
  #writing: Promise<void> | null = null;
  #failing = false;

  constructor(options: EventLogServiceOptions) {
    this.#profile = options.profile;
    this.#store = options.store;
    this.#clock = options.clock ?? systemClock;
    this.#hotEvents = options.hotEvents ?? 2_000;
    this.#maxBuffer = options.maxBuffer ?? 20_000;
  }

  /** The last write failed. */
  get failing(): boolean {
    return this.#failing;
  }

  /** Events waiting for the store. */
  get buffered(): number {
    return this.#buffer.length;
  }

  // ---- writing ------------------------------------------------------------------------------

  append(input: NewLogEvent): LogEvent {
    const event: LogEvent = {
      id: input.id ?? newId(),
      at: this.#timestamp(input.at),
      kind: input.kind,
      source: input.source,
      cause: input.cause ?? null,
      context: input.context ?? null,
      person: input.person ?? null,
      body: plain(input.body),
    };
    appended.inc({ kind: event.kind });
    this.#hot.set(event.id, event);
    while (this.#hot.size > this.#hotEvents) {
      const oldest = this.#hot.keys().next().value;
      if (oldest === undefined) break;
      this.#hot.delete(oldest);
    }
    if (this.#store) {
      this.#buffer.push(event);
      this.#trimBuffer();
    }
    for (const projection of this.#projections) this.#feed(projection, event);
    return event;
  }

  /** A time the store can write: one it cannot would fail the whole batch, again and again. */
  #timestamp(at: string | undefined): string {
    return at !== undefined && !Number.isNaN(Date.parse(at)) ? at : toTimestamp(this.#clock.now());
  }

  observe(observation: Observation, options: ObserveOptions = {}): LogEvent {
    const body: ObservationBody = {
      observation,
      buckets: [...(options.buckets ?? [])],
      speech: options.speech ?? false,
      origin: options.origin ?? null,
    };
    return this.append({
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.at !== undefined ? { at: options.at } : {}),
      kind: "observation",
      source: observation.source,
      cause: options.cause ?? null,
      context: observation.context,
      person: options.person !== undefined ? options.person : observation.from,
      body: body as unknown as JsonValue,
    });
  }

  #feed(projection: Projection, event: LogEvent): void {
    try {
      projection.apply(event);
    } catch (error) {
      log.warn({ err: errorMessage(error), event: event.id }, "a projection failed on an event");
    }
  }

  #trimBuffer(): void {
    const excess = this.#buffer.length - this.#maxBuffer;
    if (excess <= 0) return;
    this.#buffer.splice(0, excess);
    dropped.inc({}, excess);
    log.warn({ dropped: excess }, "the event log is dropping events: the store keeps failing");
  }

  flush(): Promise<void> {
    this.#writing ??= this.#write().finally(() => {
      this.#writing = null;
    });
    return this.#writing;
  }

  async #write(): Promise<void> {
    const store = this.#store;
    if (!store) return;
    while (this.#buffer.length > 0) {
      const batch = this.#buffer;
      this.#buffer = [];
      const started = performance.now();
      try {
        await store.append(this.#profile, batch);
        flushSeconds.observe({}, (performance.now() - started) / 1000);
        if (this.#failing) log.info("the event log reaches its store again");
        this.#failing = false;
      } catch (error) {
        this.#buffer = [...batch, ...this.#buffer];
        this.#trimBuffer();
        if (!this.#failing) log.warn({ err: errorMessage(error) }, "cannot write the event log");
        this.#failing = true;
        return;
      }
    }
  }

  // ---- reading ------------------------------------------------------------------------------

  recent(limit = DEFAULT_LIMIT): LogEvent[] {
    return [...this.#hot.values()].slice(-Math.max(limit, 0));
  }

  async get(id: string): Promise<LogEvent | null> {
    const hot = this.#hot.get(id);
    if (hot) return hot;
    if (!this.#store) return null;
    try {
      await this.flush();
      return await this.#store.get(this.#profile, id);
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot read the event log");
      return null;
    }
  }

  #fromHot(filter: LogEventFilter): LogEvent[] {
    const found = [...this.#hot.values()].filter((e) => matchesFilter(e, filter));
    const ordered = filter.order === "asc" ? found : found.reverse();
    return ordered.slice(0, Math.max(filter.limit ?? DEFAULT_LIMIT, 0));
  }

  async query(filter: LogEventFilter = {}): Promise<LogEvent[]> {
    if (!this.#store) return this.#fromHot(filter);
    try {
      await this.flush();
      return await this.#store.query(this.#profile, filter);
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot read the event log; answering from memory");
      return this.#fromHot(filter);
    }
  }

  async chain(id: string, options: { maxDepth?: number } = {}): Promise<CauseChain> {
    const maxDepth = options.maxDepth ?? DEFAULT_CHAIN_DEPTH;
    const events: LogEvent[] = [];
    const seen = new Set<string>();
    let next: string | null = id;
    while (next !== null) {
      if (seen.has(next) || events.length >= maxDepth) {
        return { events: events.reverse(), complete: false };
      }
      seen.add(next);
      const event: LogEvent | null = await this.get(next);
      if (!event) return { events: events.reverse(), complete: false };
      events.push(event);
      next = event.cause;
    }
    return { events: events.reverse(), complete: true };
  }

  async #effectsOf(causes: readonly string[], limit: number): Promise<LogEvent[]> {
    const fromHot = () =>
      [...this.#hot.values()]
        .filter((e) => e.cause !== null && causes.includes(e.cause))
        .slice(0, limit);
    if (!this.#store) return fromHot();
    try {
      await this.flush();
      return await this.#store.effectsOf(this.#profile, causes, limit);
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot read the event log; answering from memory");
      return fromHot();
    }
  }

  async effects(
    id: string,
    options: { limit?: number; maxDepth?: number } = {},
  ): Promise<LogEvent[]> {
    const limit = options.limit ?? DEFAULT_EFFECTS;
    const maxDepth = options.maxDepth ?? DEFAULT_EFFECTS_DEPTH;
    const found = new Map<string, LogEvent>();
    let frontier = [id];
    for (let depth = 0; depth < maxDepth && frontier.length > 0 && found.size < limit; depth++) {
      const level = await this.#effectsOf(frontier, limit - found.size);
      frontier = [];
      for (const event of level) {
        if (found.has(event.id) || event.id === id) continue;
        found.set(event.id, event);
        frontier.push(event.id);
      }
    }
    return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async project(
    projection: Projection,
    from?: Omit<LogEventFilter, "limit" | "order">,
  ): Promise<() => void> {
    let last = from?.after;
    if (from) {
      for (;;) {
        const page = await this.query({
          ...from,
          ...(last !== undefined ? { after: last } : {}),
          order: "asc",
          limit: PROJECT_PAGE,
        });
        for (const event of page) this.#feed(projection, event);
        last = page.at(-1)?.id ?? last;
        if (page.length < PROJECT_PAGE) break;
      }
      // What came in while the last page was read. From here on nothing awaits.
      for (const event of this.#hot.values()) {
        if (last !== undefined && event.id <= last) continue;
        if (matchesFilter(event, from)) this.#feed(projection, event);
      }
    }
    this.#projections.add(projection);
    return () => {
      this.#projections.delete(projection);
    };
  }
}
