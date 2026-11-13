// Shared test helpers (Rust `src/tests/mod.rs`).

import { LlmRouter, MockProvider, parseModelRef } from "@miyoria/llm";
import {
  type MemoryKind,
  type MemoryRecord,
  type MemoryRecordStore,
  type MemoryScope,
  type MessageLog,
  type PeopleStore,
  type SettingsStore,
  SqliteStore,
} from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  type HandleDirectory,
  type JsonValue,
  newId,
  type PersonId,
  type ProfileId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import {
  type Embedder,
  type MemoryConfig,
  MemoryEngine,
  memoryConfig,
  memoryFilter,
  storedId,
} from "../src/index.js";
import { FakeStore } from "./fake-store.js";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function profile(): ProfileId {
  return "deepseek-chan";
}

export function acct(id: string): AccountRef {
  return { platform: "discord", id };
}

export function guildCtx(guild: string, channel: string): ContextKey {
  return { platform: "discord", scope: guild, channel, kind: "channel" };
}

export function dmCtx(channel: string): ContextKey {
  return { platform: "discord", scope: null, channel, kind: "dm" };
}

export const T0_MS = Date.UTC(2026, 9, 1, 12, 0, 0);

/** 2026-10-01 12:00 UTC, shifted by `deltaMs`. */
export function t0(deltaMs = 0): Timestamp {
  return toTimestamp(T0_MS + deltaMs);
}

/** `ts` shifted by `deltaMs`. */
export function plus(ts: Timestamp, deltaMs: number): Timestamp {
  return toTimestamp(Date.parse(ts) + deltaMs);
}

/**
 * Router whose `summarizer` purpose goes to `summarizer` and `chat` to a provider that always
 * fails (so a wrong purpose is noticed).
 */
export function router(summarizer: MockProvider): LlmRouter {
  return new LlmRouter(
    new Map([
      ["sum", summarizer],
      ["chat", new MockProvider("chat").fail("chat must not be used")],
    ]),
    new Map([
      ["summarizer", [parseModelRef("sum:m")]],
      ["chat", [parseModelRef("chat:m")]],
    ]),
  );
}

/** The storage areas the engine uses. */
export interface Areas {
  messages: MessageLog;
  people: PeopleStore;
  settings: SettingsStore;
  memories: MemoryRecordStore;
  close(): Promise<void>;
}

export type Backend = "fake" | "sqlite";

/** Backends the engine-level tests run against. */
export const BACKENDS: Backend[] = ["fake", "sqlite"];

const open: Areas[] = [];

/** Closes every store opened since the last call (use in `afterEach`). */
export async function closeAll(): Promise<void> {
  for (const areas of open.splice(0)) await areas.close();
}

export async function openAreas(backend: Backend): Promise<Areas> {
  const areas = backend === "sqlite" ? await SqliteStore.open(":memory:") : fakeAreas();
  open.push(areas);
  return areas;
}

function fakeAreas(): Areas {
  const fake = new FakeStore();
  return {
    messages: fake,
    people: fake,
    settings: fake.settings,
    memories: fake,
    close: async () => {},
  };
}

export class Env {
  constructor(
    readonly store: Areas,
    readonly engine: MemoryEngine,
  ) {}

  person(account: AccountRef, name: string): Promise<PersonId> {
    return this.store.people.upsertAccount(account, name);
  }

  async log(
    context: ContextKey,
    author: AccountRef,
    name: string,
    text: string,
    ts: Timestamp,
    isSelf: boolean,
  ): Promise<void> {
    await this.store.messages.append({
      id: newId(),
      profile: profile(),
      context,
      author,
      author_name: name,
      text,
      is_self: isSelf,
      ts,
      turn: null,
    });
  }

  rec(id: string): Promise<MemoryRecord | null> {
    return this.store.memories.get(id);
  }

  setting(key: string): Promise<JsonValue | null> {
    return this.store.settings.get(profile(), key);
  }

  /** Every live (not superseded) record. */
  all(): Promise<MemoryRecord[]> {
    return this.store.memories.list(profile(), memoryFilter(1000));
  }

  async add(
    kind: MemoryKind,
    scope: MemoryScope,
    subjects: PersonId[],
    content: string,
    importance: number,
    at: Timestamp,
  ): Promise<string> {
    const stored = await this.engine.store(
      {
        kind,
        scope,
        subjects,
        content,
        importance,
        confidence: 0.8,
        source_context: null,
        source: null,
        origin: "experienced",
        source_events: kind === "fact" ? ["01TESTEVIDENCE0000000000"] : [],
        due: null,
      },
      at,
    );
    return storedId(stored);
  }
}

export async function envWith(
  backend: Backend,
  config: MemoryConfig,
  llm: MockProvider | null,
  embedder: Embedder | null,
  handles: HandleDirectory | null = null,
): Promise<Env> {
  const store = await openAreas(backend);
  const engine = new MemoryEngine(profile(), config, store.memories, {
    ...(handles ? { handles } : {}),
    people: store.people,
    messages: store.messages,
    settings: store.settings,
    router: llm ? router(llm) : null,
    ...(embedder ? { embedder } : {}),
  });
  return new Env(store, engine);
}

export function env(backend: Backend): Promise<Env> {
  return envWith(backend, memoryConfig(), null, null);
}

/** Embedder returning fixed vectors per text (a near-zero vector otherwise). */
export class TableEmbedder implements Embedder {
  readonly name = "table";
  readonly enabled = true;
  readonly table = new Map<string, number[]>();

  with(text: string, v: number[]): this {
    this.table.set(text, v);
    return this;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => [...(this.table.get(t) ?? [0, 0, 0.01])]);
  }
}
