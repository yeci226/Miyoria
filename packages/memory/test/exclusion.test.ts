// Messages she was asked not to remember ("不要記住這個", `agent.message.excluded`): what memory
// keeps of the id, and everything that must stop using the text from then on.

import { CommandsModule } from "@miyoria/commands";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  ServiceRegistry,
  Supervisor,
} from "@miyoria/kernel";
import { type LlmRouter, LlmRouterKey, MockProvider } from "@miyoria/llm";
import {
  MemoryRecordStoreKey,
  MessageLogKey,
  PeopleStoreKey,
  SettingsStoreKey,
} from "@miyoria/store";
import {
  customEvent,
  EventLogKey,
  type JsonValue,
  type LogEvent,
  type LogEventFilter,
  MESSAGE_EXCLUDED_TOPIC,
  type MessageExcluded,
  newId,
  type Timestamp,
  timestampMs,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXCLUDED_KEY,
  ExclusionList,
  MAX_EXCLUDED,
  MemoryEngine,
  MemoryEngineKey,
  MemoryModule,
  memoryConfig,
  memoryFilter,
  parseWindow,
} from "../src/index.js";
import { acct, closeAll, guildCtx, openAreas, plus, profile, router, t0 } from "./helpers.js";

afterEach(closeAll);

const ctx = guildCtx("g1", "c1");
const OWEN = acct("2");

/** The observation `facts` writes for a chat message (attention key `msg:<platform>:<id>`). */
function observation(message: string, name: string, text: string, at: Timestamp): LogEvent {
  return {
    id: newId(),
    at,
    kind: "observation",
    source: "platform.discord",
    cause: null,
    context: ctx,
    person: name,
    body: {
      observation: {
        source: "platform.discord",
        silent: false,
        salience: "ambient",
        attention_key: `msg:discord:${message}`,
        revision: 1,
        summary: `${name}:${text}`,
        addressed_to_her: false,
        from: name,
        context: ctx,
      },
      buckets: [],
      speech: true,
      origin: null,
    } as unknown as JsonValue,
  };
}

class Log {
  constructor(readonly events: LogEvent[]) {}
  async query(filter: LogEventFilter = {}): Promise<LogEvent[]> {
    return this.events
      .filter((e) => {
        const body = e.body as { observation?: { attention_key?: string } };
        return (
          (!filter.kinds || filter.kinds.includes(e.kind)) &&
          (!filter.attention_key || body.observation?.attention_key === filter.attention_key) &&
          (!filter.since || timestampMs(e.at) >= timestampMs(filter.since)) &&
          (!filter.until || timestampMs(e.at) < timestampMs(filter.until))
        );
      })
      .slice(0, filter.limit ?? 100);
  }
  async get(id: string): Promise<LogEvent | null> {
    return this.events.find((e) => e.id === id) ?? null;
  }
}

const excludedBody = (id: string): MessageExcluded => ({
  context: ctx,
  message: { context: ctx, id },
  author: OWEN,
  requested_by: OWEN,
  at: new Date(Date.now()).toISOString(),
});

async function rig(llm: MockProvider | null = null) {
  const store = await openAreas("fake");
  const cat = observation("m1", "Owen", "我養了一隻貓", t0());
  const fine = observation("m2", "Owen", "我喜歡拉麵", plus(t0(), 1000));
  const log = new Log([cat, fine]);
  const engine = new MemoryEngine(profile(), memoryConfig(), store.memories, {
    people: store.people,
    messages: store.messages,
    settings: store.settings,
    events: log,
    router: llm ? router(llm) : null,
  });
  const line = async (text: string, at: Timestamp) => {
    const id = newId();
    await store.messages.append({
      id,
      profile: profile(),
      context: ctx,
      author: OWEN,
      author_name: "Owen",
      text,
      is_self: false,
      ts: at,
      turn: null,
    });
    return id;
  };
  return { store, engine, cat, fine, line };
}

const fact = (content: string, source_events: string[]) => ({
  kind: "fact" as const,
  scope: { type: "guild" as const, platform: "discord", guild: "g1" },
  subjects: [],
  content,
  importance: 0.8,
  confidence: 0.9,
  source_context: ctx,
  source: null,
  origin: "told" as const,
  source_events,
  due: null,
});

class LlmStub implements Module {
  readonly manifest = defineManifest("llm", "LLM stub");
  constructor(readonly router: LlmRouter) {}
  async start(ctx: ModuleContext): Promise<void> {
    ctx.provide(LlmRouterKey, this.router);
  }
}

describe("excluded messages", () => {
  it("delete what rested on that message alone and trim what has other evidence too", async () => {
    const r = await rig();
    const lineId = await r.line("我養了一隻貓", t0());
    const now = plus(t0(), 5000);
    const alone = await r.engine.store(fact("Owen 養了一隻貓", [r.cat.id]), now);
    const byLine = await r.engine.store(fact("Owen 有寵物，是貓", [`msg:${lineId}`]), now);
    const both = await r.engine.store(fact("Owen 喜歡拉麵也養貓", [r.cat.id, r.fine.id]), now);
    const bare = await r.engine.store(
      { ...fact("Owen 住台北", []), origin: "unknown" as const },
      now,
    );
    const gone = await r.engine.excludeMessage(excludedBody("m1"));
    expect(gone).toEqual({ deleted: 2, trimmed: 1 });
    const ids = (await r.store.memories.list(profile(), memoryFilter(50))).map((x) => x.id);
    expect(ids).toHaveLength(2);
    const kept = await r.store.memories.get(
      both.type === "refused" ? "" : (both as { id: string }).id,
    );
    expect(kept?.source_events).toEqual([r.fine.id]);
    expect(alone.type).not.toBe("refused");
    expect(byLine.type).not.toBe("refused");
    expect(bare.type).not.toBe("refused");
  });

  it("are not stored as evidence from then on", async () => {
    const r = await rig();
    await r.engine.excludeMessage(excludedBody("m1"));
    const refused = await r.engine.store(fact("Owen 養貓", [r.cat.id]), plus(t0(), 9000));
    expect(refused).toEqual({ type: "refused", reason: "no_evidence" });
    const stored = await r.engine.store(fact("Owen 養貓也喜歡拉麵", [r.cat.id, r.fine.id]), t0());
    expect(stored.type).not.toBe("refused");
    const record = await r.store.memories.get((stored as { id: string }).id);
    expect(record?.source_events).toEqual([r.fine.id]);
  });

  it("are left out of consolidation, even when the log has no event for the line", async () => {
    const llm = new MockProvider("sum").reply("{}");
    const r = await rig(llm);
    await r.line("我養了一隻貓", t0());
    await r.line("我喜歡拉麵", plus(t0(), 1000));
    await r.engine.excludeMessage(excludedBody("m1"));
    // Another line with the same words in the same place, written after the exclusion, is the
    // same message to her: it is not told either.
    await r.line("我養了一隻貓", plus(t0(), 2000));
    const report = await r.engine.consolidate(ctx, plus(t0(), 60_000));
    expect(report.lines).toBe(3);
    const asked = llm.requests()[0]?.messages[1]?.content ?? "";
    expect(asked).toContain("我喜歡拉麵");
    expect(asked).not.toContain("貓");
    expect(await r.engine.watermark(ctx)).not.toBeNull();
  });

  it("leave the windows of 'just now' and of a person's last words", async () => {
    const r = await rig();
    await r.engine.excludeMessage(excludedBody("m1"));
    const window = parseWindow([r.cat, r.fine], 0, r.engine.exclusions);
    expect(window.said.map((s) => s.text)).toEqual(["我喜歡拉麵"]);
    // An observation made later from the same message (a re-fetch, a replay) is the same message.
    const again = observation("m1", "Owen", "我養了一隻貓", plus(t0(), 99_000));
    expect(parseWindow([again], 0, r.engine.exclusions).said).toEqual([]);
    expect(parseWindow([again], 0).said).toHaveLength(1);
  });

  it("survive a restart, and the list is bounded", async () => {
    const r = await rig();
    await r.engine.excludeMessage(excludedBody("m1"));
    const second = new MemoryEngine(profile(), memoryConfig(), r.store.memories, {
      settings: r.store.settings,
    });
    expect(second.exclusions.hasRef(r.cat.id)).toBe(false);
    await second.loadExclusions();
    expect(second.exclusions.hasRef(r.cat.id)).toBe(true);
    expect(second.exclusions.hasMessage("discord", "m1")).toBe(true);
    expect(second.exclusions.hasLine(ctx, "Owen", "我養了一隻貓")).toBe(true);
    // The text itself is not what is kept.
    expect(JSON.stringify(await r.store.settings.get(profile(), EXCLUDED_KEY))).not.toContain("貓");

    const list = new ExclusionList();
    for (let i = 0; i < MAX_EXCLUDED + 20; i++) {
      list.add({ c: "k", key: `msg:discord:${i}`, refs: [`r${i}`], hashes: [], at: i });
    }
    expect(list.size).toBe(MAX_EXCLUDED);
    expect(list.hasRef("r0")).toBe(false);
    expect(list.hasRef(`r${MAX_EXCLUDED + 19}`)).toBe(true);
  });

  it("are taken out when the agent says so on the bus", async () => {
    const services = new ServiceRegistry();
    const sup = new Supervisor({ services });
    const store = await openAreas("fake");
    const cat = observation("m1", "Owen", "我養了一隻貓", t0());
    services.provide("app", MemoryRecordStoreKey, store.memories);
    services.provide("app", MessageLogKey, store.messages);
    services.provide("app", PeopleStoreKey, store.people);
    services.provide("app", SettingsStoreKey, store.settings);
    services.provide("app", EventLogKey, new Log([cat]) as never);
    await sup.register(new LlmStub(router(new MockProvider("sum").reply("{}"))), null, true);
    await sup.register(new CommandsModule(), { owners: ["discord:1"] }, true);
    await sup.register(
      new MemoryModule(profile()),
      { tick_secs: 1, forgetting: { enabled: false } },
      true,
    );
    await sup.startAll();
    try {
      const engine = services.require(MemoryEngineKey);
      const stored = await engine.store(fact("Owen 養了一隻貓", [cat.id]), t0());
      const id = (stored as { id: string }).id;
      sup.bus.publish(
        "agent",
        customEvent(MESSAGE_EXCLUDED_TOPIC, excludedBody("m1") as unknown as JsonValue),
      );
      const deadline = Date.now() + 5000;
      while ((await store.memories.get(id)) !== null) {
        expect(Date.now() < deadline, "not taken out").toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(engine.exclusions.hasMessage("discord", "m1")).toBe(true);
    } finally {
      await sup.stopAll();
    }
  });
});
