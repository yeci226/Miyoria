// DeliveryLedger (docs/design/v3-architecture.md §8): what really reached someone, as a projection
// of the log, so a restart loses nothing.
//
// A line is an `utterance` event. It ends with exactly one of: a `delivered` event (voice playback
// finished, the platform accepted the message) or a `result` event saying it was interrupted,
// failed or cancelled. Only `delivered` counts as said; everything else stays retryable, and a
// retry is a new line with the same `attention_key` and `revision`. The exception is `blocked`:
// moderation replaced the line, so saying it again would only be blocked again. It is not said,
// and that revision can not be claimed any more; something new about it is a new revision.

import {
  type Clock,
  type ContextKey,
  contextKeyEquals,
  type Delivery,
  type DeliveryLedger,
  type EventLog,
  isJsonObject,
  type JsonValue,
  type LogEvent,
  type NewLine,
  type Observation,
  type Projection,
  type SpokenLine,
  similarLines,
  systemClock,
  timestampMs,
  toTimestamp,
  type UndeliveredBody,
  type UndeliveredState,
  type UtteranceBody,
} from "@miyoria/types";
import { observationBody } from "./context.js";

/** What is worth another try. */
const RETRYABLE: readonly string[] = ["interrupted", "failed", "cancelled"];
/** Every way a line ends without being said. */
const UNDELIVERED: readonly string[] = [...RETRYABLE, "blocked"];

const DEFAULT_RECENT = 10;
const DEFAULT_SIMILAR_WINDOW_MS = 30 * 60_000;
/** Lines and deliveries remembered (keys may stay longer). */
const MAX_LINES = 5_000;
const MAX_KEYS = 20_000;

export interface DeliveryLedgerOptions {
  /** How long after a delivery someone speaking counts as answering it. Default 60 s. */
  answerWindowMs?: number;
  clock?: Clock;
}

export class DeliveryLedgerView implements DeliveryLedger, Projection {
  readonly #log: Pick<EventLog, "append">;
  readonly #answerWindowMs: number;
  readonly #clock: Clock;
  /** Every line by id, oldest first. */
  readonly #lines = new Map<string, SpokenLine>();
  /** Deliveries, oldest first. */
  #deliveries: Delivery[] = [];
  /** The delivery of the highest revision of each key. */
  readonly #byKey = new Map<string, Delivery>();
  /** The highest revision of each key that moderation blocked. */
  readonly #blocked = new Map<string, number>();

  constructor(log: Pick<EventLog, "append">, options: DeliveryLedgerOptions = {}) {
    this.#log = log;
    this.#answerWindowMs = options.answerWindowMs ?? 60_000;
    this.#clock = options.clock ?? systemClock;
  }

  // ---- writing ------------------------------------------------------------------------------

  open(line: NewLine): string {
    const body: UtteranceBody = {
      attention_key: line.attention_key,
      revision: line.revision,
      channel: line.channel,
      said: line.said,
      audience: [...(line.audience ?? [])],
      turn: line.turn ?? null,
    };
    const event = this.#log.append({
      kind: "utterance",
      source: line.source ?? "delivery",
      cause: line.cause ?? null,
      context: line.context,
      body: body as unknown as JsonValue,
    });
    return event.id;
  }

  ack(id: string): Delivery | null {
    const line = this.#lines.get(id);
    if (!line) return null;
    if (line.state === "delivered") return this.#delivery(id);
    if (line.state !== "pending") return null;
    const delivery: Delivery = {
      attention_key: line.attention_key,
      revision: line.revision,
      channel: line.channel,
      context: line.context,
      said: line.said,
      delivered_at: toTimestamp(this.#clock.now()),
      audience: [...line.audience],
      answered_by: [],
      line: id,
    };
    this.#log.append({
      kind: "delivered",
      source: `delivery.${line.channel}`,
      cause: id,
      context: line.context,
      body: delivery as unknown as JsonValue,
    });
    return this.#delivery(id);
  }

  undelivered(id: string, state: UndeliveredState, reason: string | null = null): void {
    const line = this.#lines.get(id);
    if (line?.state !== "pending") return;
    const body: UndeliveredBody = {
      line: id,
      attention_key: line.attention_key,
      revision: line.revision,
      delivery: state,
      reason,
    };
    this.#log.append({
      kind: "result",
      source: `delivery.${line.channel}`,
      cause: id,
      context: line.context,
      body: body as unknown as JsonValue,
    });
  }

  /** Lines older than `olderThanMs` that nobody answered for ended without being delivered. */
  expire(olderThanMs: number, reason: string): number {
    const before = this.#clock.now() - olderThanMs;
    let expired = 0;
    for (const line of [...this.#lines.values()]) {
      if (line.state !== "pending" || timestampMs(line.at) > before) continue;
      this.undelivered(line.line, "failed", reason);
      expired++;
    }
    return expired;
  }

  // ---- reading ------------------------------------------------------------------------------

  #delivery(line: string): Delivery | null {
    for (let i = this.#deliveries.length - 1; i >= 0; i--) {
      const d = this.#deliveries[i] as Delivery;
      if (d.line === line) return structuredClone(d);
    }
    return null;
  }

  delivered(key: string, revision?: number): Delivery | null {
    const delivery = this.#byKey.get(key);
    if (!delivery) return null;
    if (revision !== undefined && delivery.revision < revision) return null;
    return structuredClone(delivery);
  }

  mayClaim(observation: Pick<Observation, "attention_key" | "revision" | "salience">): boolean {
    if (observation.salience === "ambient") return false;
    if ((this.#blocked.get(observation.attention_key) ?? 0) >= observation.revision) return false;
    return this.delivered(observation.attention_key, observation.revision) === null;
  }

  saidLately(
    text: string,
    options: { context?: ContextKey; withinMs?: number } = {},
  ): Delivery | null {
    const since = this.#clock.now() - (options.withinMs ?? DEFAULT_SIMILAR_WINDOW_MS);
    for (let i = this.#deliveries.length - 1; i >= 0; i--) {
      const d = this.#deliveries[i] as Delivery;
      if (timestampMs(d.delivered_at) < since) return null;
      if (options.context && !contextKeyEquals(d.context, options.context)) continue;
      if (similarLines(text, d.said)) return structuredClone(d);
    }
    return null;
  }

  recent(options: { context?: ContextKey; limit?: number } = {}): Delivery[] {
    const { context, limit = DEFAULT_RECENT } = options;
    const out: Delivery[] = [];
    for (let i = this.#deliveries.length - 1; i >= 0 && out.length < limit; i--) {
      const d = this.#deliveries[i] as Delivery;
      if (!context || contextKeyEquals(d.context, context)) out.push(structuredClone(d));
    }
    return out;
  }

  retryable(options: { context?: ContextKey; limit?: number } = {}): SpokenLine[] {
    const { context, limit = DEFAULT_RECENT } = options;
    const seen = new Set<string>();
    const out: SpokenLine[] = [];
    for (const line of [...this.#lines.values()].reverse()) {
      if (out.length >= limit) break;
      if (!RETRYABLE.includes(line.state)) continue;
      if (context && !contextKeyEquals(line.context, context)) continue;
      const id = `${line.attention_key}#${line.revision}`;
      if (seen.has(id) || this.delivered(line.attention_key, line.revision) !== null) continue;
      seen.add(id);
      out.push(structuredClone(line));
    }
    return out;
  }

  line(id: string): SpokenLine | null {
    const line = this.#lines.get(id);
    return line ? structuredClone(line) : null;
  }

  // ---- the projection -----------------------------------------------------------------------

  apply(event: LogEvent): void {
    switch (event.kind) {
      case "utterance":
        this.#opened(event);
        break;
      case "delivered":
        this.#acked(event);
        break;
      case "result":
        this.#failed(event);
        break;
      case "observation":
        this.#spoke(event);
        break;
      default:
        break;
    }
  }

  #opened(event: LogEvent): void {
    if (event.context === null || !isJsonObject(event.body)) return;
    const body = event.body as unknown as UtteranceBody;
    this.#lines.set(event.id, {
      line: event.id,
      attention_key: body.attention_key,
      revision: body.revision,
      channel: body.channel,
      context: event.context,
      said: body.said,
      audience: body.audience,
      turn: body.turn,
      state: "pending",
      at: event.at,
      settled_at: null,
      reason: null,
    });
    while (this.#lines.size > MAX_LINES) {
      const oldest = this.#lines.keys().next().value;
      if (oldest === undefined) break;
      this.#lines.delete(oldest);
    }
  }

  #acked(event: LogEvent): void {
    if (!isJsonObject(event.body)) return;
    const delivery = structuredClone(event.body) as unknown as Delivery;
    const line = this.#lines.get(delivery.line);
    if (line) {
      line.state = "delivered";
      line.settled_at = delivery.delivered_at;
    }
    this.#deliveries.push(delivery);
    if (this.#deliveries.length > MAX_LINES) this.#deliveries = this.#deliveries.slice(-MAX_LINES);
    const known = this.#byKey.get(delivery.attention_key);
    if (!known || known.revision <= delivery.revision) {
      this.#byKey.delete(delivery.attention_key);
      this.#byKey.set(delivery.attention_key, delivery);
    }
    while (this.#byKey.size > MAX_KEYS) {
      const oldest = this.#byKey.keys().next().value;
      if (oldest === undefined) break;
      this.#byKey.delete(oldest);
    }
  }

  #failed(event: LogEvent): void {
    if (!isJsonObject(event.body) || typeof event.body.delivery !== "string") return;
    const body = event.body as unknown as UndeliveredBody;
    const line = this.#lines.get(body.line);
    if (line?.state !== "pending" || !UNDELIVERED.includes(body.delivery)) return;
    line.state = body.delivery;
    line.settled_at = event.at;
    line.reason = body.reason;
    if (body.delivery !== "blocked") return;
    const known = this.#blocked.get(body.attention_key) ?? 0;
    this.#blocked.delete(body.attention_key);
    this.#blocked.set(body.attention_key, Math.max(known, body.revision));
    while (this.#blocked.size > MAX_KEYS) {
      const oldest = this.#blocked.keys().next().value;
      if (oldest === undefined) break;
      this.#blocked.delete(oldest);
    }
  }

  /** Someone said something where she was just heard. */
  #spoke(event: LogEvent): void {
    const body = observationBody(event);
    if (body?.speech !== true) return;
    const { from, context } = body.observation;
    if (from === null || context === null) return;
    const at = timestampMs(event.at);
    for (let i = this.#deliveries.length - 1; i >= 0; i--) {
      const d = this.#deliveries[i] as Delivery;
      const since = at - timestampMs(d.delivered_at);
      if (since > this.#answerWindowMs) return;
      if (since < 0 || !contextKeyEquals(d.context, context)) continue;
      if (!d.answered_by.includes(from)) d.answered_by.push(from);
    }
  }
}
