// An EventLog and a handle directory for the v4 §5 readers, writing events in the shapes the
// `facts` module writes them (packages/facts/src/bus.ts, delivery.ts).

import {
  type AccountRef,
  type ContextKey,
  type ConversationState,
  type ConversationStates,
  contextKeyEquals,
  type Handle,
  type HandleDirectory,
  type HandleEntry,
  type JsonValue,
  type LogEvent,
  type LogEventFilter,
  newId,
  type PersonId,
  type Timestamp,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import { memoryConfig, type RecentConfig } from "../src/index.js";

const asJson = (value: unknown): JsonValue => value as JsonValue;

/** 2026-11-10 00:00 local (+08:00) as UTC ms; `at(11, 7)` is 11:07 local that day. */
export const DAY0_MS = Date.UTC(2026, 10, 9, 16, 0, 0);

export function at(hour: number, minute = 0): Timestamp {
  return toTimestamp(DAY0_MS + (hour * 60 + minute) * 60_000);
}

export const guild = (channel: string, g = "g1"): ContextKey => ({
  platform: "discord",
  scope: g,
  channel,
  kind: "channel",
});
export const voice = (channel: string, g = "g1"): ContextKey => ({
  platform: "discord",
  scope: g,
  channel,
  kind: "voice",
});
export const dm = (channel: string): ContextKey => ({
  platform: "discord",
  scope: null,
  channel,
  kind: "dm",
});

export class FakeLog {
  readonly events: LogEvent[] = [];
  queries = 0;

  say(
    handle: Handle,
    text: string,
    when: Timestamp,
    context: ContextKey,
    options: { addressed?: boolean; voice?: boolean } = {},
  ): LogEvent {
    const source = options.voice ? "voice.asr" : "platform.discord";
    const event: LogEvent = {
      id: newId(),
      at: when,
      kind: "observation",
      source,
      cause: null,
      context,
      person: handle,
      body: asJson({
        observation: {
          source,
          silent: false,
          salience: "notable",
          attention_key: `msg:${newId()}`,
          revision: 1,
          summary: `${handle}:${text}`,
          addressed_to_her: options.addressed ?? false,
          from: handle,
          context,
        },
        buckets: [],
        speech: true,
        origin: {
          module: "discord",
          topic: "platform.message.created",
          event: {
            type: "platform_message_created",
            data: { text, author: { display_name: handle } },
          },
          turn: null,
        },
      }),
    };
    this.events.push(event);
    return event;
  }

  her(said: string, when: Timestamp, context: ContextKey, audience: Handle[] = []): LogEvent {
    const event: LogEvent = {
      id: newId(),
      at: when,
      kind: "delivered",
      source: "delivery.text",
      cause: null,
      context,
      person: null,
      body: asJson({
        attention_key: "k",
        revision: 1,
        channel: context.kind === "voice" ? "voice" : "text",
        context,
        said,
        delivered_at: when,
        audience,
        answered_by: [],
        line: newId(),
      }),
    };
    this.events.push(event);
    return event;
  }

  happen(
    source: string,
    summary: string,
    when: Timestamp,
    key: string,
    context: ContextKey | null = null,
  ): LogEvent {
    const event: LogEvent = {
      id: newId(),
      at: when,
      kind: "observation",
      source,
      cause: null,
      context,
      person: null,
      body: asJson({
        observation: {
          source,
          silent: true,
          salience: "ambient",
          attention_key: key,
          revision: 1,
          summary,
          addressed_to_her: false,
          from: null,
          context,
        },
        buckets: [],
        speech: false,
        origin: null,
      }),
    };
    this.events.push(event);
    return event;
  }

  async query(filter: LogEventFilter = {}): Promise<LogEvent[]> {
    this.queries++;
    let out = this.events.filter(
      (e) =>
        (!filter.kinds || filter.kinds.includes(e.kind)) &&
        (!filter.context || (e.context !== null && contextKeyEquals(e.context, filter.context))) &&
        (filter.person === undefined || e.person === filter.person) &&
        (!filter.since || timestampMs(e.at) >= timestampMs(filter.since)) &&
        (!filter.until || timestampMs(e.at) < timestampMs(filter.until)),
    );
    out = [...out].sort((a, b) => timestampMs(a.at) - timestampMs(b.at));
    if (filter.order !== "asc") out.reverse();
    return out.slice(0, filter.limit ?? 100);
  }

  async get(id: string): Promise<LogEvent | null> {
    return this.events.find((e) => e.id === id) ?? null;
  }
}

export class FakeHandles implements HandleDirectory {
  readonly entries: HandleEntry[] = [];

  add(handle: Handle, person: PersonId, account: AccountRef): this {
    this.entries.push({ handle, person, account, display_name: handle, created_at: at(0) });
    return this;
  }

  ofAccount(account: AccountRef, displayName: string): Handle {
    return this.entries.find((e) => e.account?.id === account.id)?.handle ?? displayName;
  }

  ofPerson(person: PersonId): Handle | null {
    return this.entries.find((e) => e.person === person)?.handle ?? null;
  }

  resolve(handle: Handle): HandleEntry | null {
    return this.entries.find((e) => e.handle === handle) ?? null;
  }

  list(): HandleEntry[] {
    return [...this.entries];
  }
}

export class FakeStates implements ConversationStates {
  readonly states: ConversationState[] = [];

  add(context: ContextKey, recap: string, updated: Timestamp): this {
    this.states.push({
      context,
      updated_at: updated,
      folded_up_to: null,
      folds: 1,
      lines: 10,
      recap,
      notes: {},
    });
    return this;
  }

  get(context: ContextKey): ConversationState | null {
    return this.states.find((s) => contextKeyEquals(s.context, context)) ?? null;
  }

  list(): ConversationState[] {
    return [...this.states];
  }
}

export function recentConfig(overrides: Partial<RecentConfig> = {}): RecentConfig {
  return { ...memoryConfig().recent, cache_secs: 0, ...overrides };
}
