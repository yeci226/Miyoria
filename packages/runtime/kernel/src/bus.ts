import {
  type AnyEventDefinition,
  type Envelope,
  type EnvelopeOf,
  type EventPayload,
  eventEnvelope,
  type ModuleId,
  type Publish,
  type PublishMetaArgs,
} from "@miyoria/types";
import { getLogger } from "./log.js";
import { type Counter, type MetricsRegistry, metrics } from "./metrics.js";

const log = getLogger("kernel.bus");

/** Per-subscription buffer capacity. */
export const DEFAULT_BUS_CAPACITY = 4096;

/**
 * Matches dotted topics. `"platform.*"` matches every topic under `platform.`, `"*"` matches
 * everything, anything else must match exactly.
 */
export class TopicFilter {
  readonly patterns: readonly string[];

  constructor(patterns: Iterable<string>) {
    this.patterns = [...patterns];
  }

  static all(): TopicFilter {
    return new TopicFilter(["*"]);
  }

  static from(filter: TopicFilterLike): TopicFilter {
    if (filter instanceof TopicFilter) return filter;
    return new TopicFilter(typeof filter === "string" ? [filter] : filter);
  }

  matches(topic: string): boolean {
    return this.patterns.some((p) => {
      if (p === "*") return true;
      if (p.endsWith(".*")) {
        const prefix = p.slice(0, -2);
        return topic.startsWith(prefix) && topic.charAt(prefix.length) === ".";
      }
      return p === topic;
    });
  }
}

/** A filter, one pattern, or a list of patterns. */
export type TopicFilterLike = TopicFilter | string | readonly string[];

export interface SubscribeOptions {
  /** Closes the subscription when aborted. */
  signal?: AbortSignal;
  /** Buffered events before the oldest are dropped. Default `DEFAULT_BUS_CAPACITY`. */
  capacity?: number;
}

/**
 * A stream of matching envelopes. Consume it with `for await` (ends once closed) or `recv()`.
 * Events published after `subscribe()` returns are delivered in order. A slow subscriber that
 * falls more than `capacity` events behind skips the oldest ones (logged as lag).
 */
export class Subscription implements AsyncIterableIterator<Envelope> {
  readonly filter: TopicFilter;
  readonly #capacity: number;
  readonly #queue: Envelope[] = [];
  readonly #waiters: Array<(result: IteratorResult<Envelope>) => void> = [];
  readonly #onClose: () => void;
  readonly #dropped: Counter | undefined;
  #closed = false;
  #lagged = 0;

  /** @internal Created by `EventBus.subscribe`. */
  constructor(filter: TopicFilter, capacity: number, onClose: () => void, dropped?: Counter) {
    this.filter = filter;
    this.#capacity = capacity;
    this.#onClose = onClose;
    this.#dropped = dropped;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** @internal */
  deliver(envelope: Envelope): void {
    if (this.#closed || !this.filter.matches(envelope.type)) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: envelope, done: false });
      return;
    }
    if (this.#queue.length >= this.#capacity) {
      this.#queue.shift();
      this.#lagged++;
      this.#dropped?.inc();
    }
    this.#queue.push(envelope);
  }

  /** The next matching envelope, or `null` once the subscription is closed. */
  async recv(): Promise<Envelope | null> {
    const result = await this.next();
    return result.done ? null : result.value;
  }

  /** The next buffered envelope without waiting, or `null` when none is buffered. */
  tryRecv(): Envelope | null {
    this.#reportLag();
    return this.#queue.shift() ?? null;
  }

  #reportLag(): void {
    if (this.#lagged > 0) {
      log.warn({ skipped: this.#lagged }, "event subscriber lagged");
      this.#lagged = 0;
    }
  }

  next(): Promise<IteratorResult<Envelope>> {
    this.#reportLag();
    const value = this.#queue.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Stops delivery; pending and future `next()` calls finish. Buffered events are dropped. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
    this.#onClose();
  }

  return(): Promise<IteratorResult<Envelope>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

// The publish hook: tests only. The repository's test setup (`vitest.bus-check.ts`) installs one
// that checks every published payload against its schema (K12a in docs/design/v5-contracts.md).
// It is honoured only when the process is a Vitest run (`VITEST` set when this module loads);
// anywhere else `setBusPublishHook` throws and `publishEnvelope` skips it on a constant. Its state
// sits on a global symbol so that every copy of this module in a process sees the same hook.

/** Sees every envelope published on any bus while installed. */
export interface BusPublishHook {
  /** Called before delivery. Must not throw; whatever it throws is dropped. */
  published(envelope: Envelope): void;
}

/** Whether this process is a test run. Read once, so production pays one constant check. */
const IN_TEST_RUN = typeof process !== "undefined" && process.env.VITEST !== undefined;

const HOOK_STATE = Symbol.for("miyoria.kernel.bus.publishHook");

interface PublishHookState {
  hook: BusPublishHook | null;
  /** Topics a test publishes on purpose that no schema covers (made-up topics). */
  exempt: TopicFilter[];
}

function hookState(): PublishHookState {
  const global = globalThis as { [HOOK_STATE]?: PublishHookState };
  global[HOOK_STATE] ??= { hook: null, exempt: [] };
  return global[HOOK_STATE];
}

function runPublishHook(envelope: Envelope): void {
  const state = (globalThis as { [HOOK_STATE]?: PublishHookState })[HOOK_STATE];
  if (state?.hook == null) return;
  const topic = envelope.type;
  if (state.exempt.some((filter) => filter.matches(topic))) return;
  try {
    state.hook.published(envelope);
  } catch {
    // The publisher must not notice the hook.
  }
}

/**
 * Installs the publish hook (`null` removes it). Tests only: throws outside a Vitest run, so
 * production code cannot switch it on.
 */
export function setBusPublishHook(hook: BusPublishHook | null): void {
  if (!IN_TEST_RUN) {
    throw new Error("the bus publish hook is for tests only: this process is not a Vitest run");
  }
  hookState().hook = hook;
}

/** The installed publish hook, if any. */
export function busPublishHook(): BusPublishHook | null {
  return IN_TEST_RUN ? hookState().hook : null;
}

/**
 * Keeps matching topics away from the publish hook until `clearBusCheckExemptions` (the test
 * setup calls it after each test file). For a test that publishes made-up topics on purpose:
 * `exemptFromBusCheck("test.*")` at the top of the file. Does nothing outside a Vitest run.
 */
export function exemptFromBusCheck(filter: TopicFilterLike): void {
  if (IN_TEST_RUN) hookState().exempt.push(TopicFilter.from(filter));
}

/** Ends every `exemptFromBusCheck`. */
export function clearBusCheckExemptions(): void {
  if (IN_TEST_RUN) hookState().exempt = [];
}

/** Distinct topic prefixes counted before the rest collapse into `"other"`. */
const MAX_TOPIC_PREFIXES = 64;

/** First segment of a dotted topic (`platform.message.created` -> `platform`). */
export function topicPrefix(topic: string): string {
  const dot = topic.indexOf(".");
  return dot < 0 ? topic : topic.slice(0, dot);
}

export interface EventBusOptions {
  capacity?: number;
  /** Where publish / drop counts go. Default: the process-wide `metrics`. */
  metrics?: MetricsRegistry;
}

/** In-process publish / subscribe bus. Publishing never blocks and never fails. */
export class EventBus {
  readonly #subscriptions = new Set<Subscription>();
  readonly #capacity: number;
  readonly #published: Counter;
  readonly #dropped: Counter;

  constructor(options: EventBusOptions = {}) {
    this.#capacity = options.capacity ?? DEFAULT_BUS_CAPACITY;
    const registry = options.metrics ?? metrics;
    this.#published = registry.counter("miyoria_bus_events_published_total", {
      help: "Events published on the bus, by the first segment of the topic.",
      labels: ["prefix"],
      maxSeries: MAX_TOPIC_PREFIXES,
    });
    this.#dropped = registry.counter("miyoria_bus_events_dropped_total", {
      help: "Events dropped because a subscriber fell more than its capacity behind.",
    });
  }

  /** Publishes an envelope made elsewhere and returns it: subscribers receive this same object. */
  publishEnvelope(envelope: Envelope): Envelope {
    if (IN_TEST_RUN) runPublishHook(envelope);
    this.#published.inc({ prefix: topicPrefix(envelope.type) });
    // No subscribers is not an error.
    for (const sub of this.#subscriptions) sub.deliver(envelope);
    return envelope;
  }

  /**
   * Publishes one event of `definition` from `source` in a fresh envelope and returns it:
   * `bus.publish("discord", Events.PlatformTyping, { context, account }, { turn })`. A family
   * takes the concrete type in `meta.type` (`{ type: "worklane.task.done" }`).
   */
  publish<D extends AnyEventDefinition>(
    source: ModuleId,
    definition: D,
    data: EventPayload<D>,
    ...meta: PublishMetaArgs<D>
  ): EnvelopeOf<D> {
    const envelope = eventEnvelope(source, definition, data, ...meta);
    this.publishEnvelope(envelope);
    return envelope;
  }

  /** `publish` by definition with `source` fixed, for the parts a module hands it to. */
  publisher(source: ModuleId): Publish {
    return (definition, data, ...meta) => {
      this.publish(source, definition, data, ...meta);
    };
  }

  subscribe(filter: TopicFilterLike, options: SubscribeOptions = {}): Subscription {
    const { signal } = options;
    const onAbort = () => sub.close();
    const sub: Subscription = new Subscription(
      TopicFilter.from(filter),
      options.capacity ?? this.#capacity,
      () => {
        this.#subscriptions.delete(sub);
        signal?.removeEventListener("abort", onAbort);
      },
      this.#dropped,
    );
    this.#subscriptions.add(sub);
    if (signal?.aborted) sub.close();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return sub;
  }

  /** Number of open subscriptions (diagnostics). */
  get subscriberCount(): number {
    return this.#subscriptions.size;
  }

  /** Closes every subscription (shutdown). */
  close(): void {
    for (const sub of [...this.#subscriptions]) sub.close();
  }
}
