// Messages she was asked not to remember ("不要記住這個", `agent.message.excluded`) and people who
// asked to be forgotten: the recorder redacts the message's events and "forget me" a person's
// lines (docs/design/v5-data.md §2.4); memory takes out what was derived from them, and nothing
// that reads the log can get the text back.

import { CommandsModule } from "@miyoria/commands";
import { type LlmRouter, LlmRouterKey, MockProvider } from "@miyoria/llm/llm";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  ServiceRegistry,
  Supervisor,
} from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import {
  EventLogKey,
  Events,
  type IncomingMessage,
  type MessageExcluded,
  type PersonId,
  type Timestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { EventLogService } from "../../facts/src/index.js";
import { notesTables, personSubject } from "../../notes/src/index.js";
import {
  MemoryEngine,
  MemoryEngineKey,
  MemoryModule,
  memoryConfig,
  memoryFilter,
  parseWindow,
} from "../src/index.js";
import { acct, guildCtx, plus, profile, router, t0, tablesOf } from "./helpers.js";

const ctx = guildCtx("g1", "c1");
const OWEN = acct("2");
const AMY = acct("3");
/** Owen as her notes know him. */
const PERSON = "01HOWEN0000000000000000000" as PersonId;

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

function message(id: string, text: string, at: Timestamp, account = OWEN): IncomingMessage {
  return {
    id: { context: ctx, id },
    author: { account, display_name: account === OWEN ? "Owen" : "Amy", is_bot: false },
    text,
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: at,
  };
}

const excludedBody = (id: string): MessageExcluded => ({
  context: ctx,
  message: { context: ctx, id },
  author: OWEN,
  requested_by: OWEN,
  at: new Date(Date.now()).toISOString(),
});

/**
 * A database with two lines of Owen's (and her observations of them, as the facts module
 * writes them: same key, `facts.observation.said`) and an engine reading both.
 */
async function rig(llm: MockProvider | null = null) {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  const log = new EventLogService({ store: store.events });
  const say = (id: string, text: string, at: Timestamp, account = OWEN) => {
    const line = store.chat.message(message(id, text, at, account), {
      self: false,
      source: "platform.discord.bot",
    });
    const name = account === OWEN ? "Owen" : "Amy";
    const seen = log.observe(
      {
        source: "platform.discord",
        silent: false,
        salience: "notable",
        attention_key: `msg:discord:${id}`,
        revision: 1,
        summary: `${name}:${text}`,
        addressed_to_her: false,
        from: name,
        context: ctx,
      },
      { at, speech: true },
    );
    return { line: line?.id ?? "", seen };
  };
  const cat = say("m1", "我養了一隻貓", t0());
  const fine = say("m2", "我喜歡拉麵", plus(t0(), 1000));
  await log.flush();
  const engine = new MemoryEngine(profile(), memoryConfig(), tablesOf(store), {
    people: store.people,
    messages: store.messages,
    settings: store.settings,
    events: log,
    chat: store.chat,
    router: llm ? router(llm) : null,
  });
  /** What the recorder does with `agent.message.excluded`. */
  const redact = (id: string) =>
    store.chat.redactMessage({ context: ctx, id }, "do not remember", "recorder");
  return { store, log, engine, cat, fine, say, redact };
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
    const now = plus(t0(), 5000);
    const alone = await r.engine.store(fact("Owen 養了一隻貓", [r.cat.seen.id]), now);
    const byLine = await r.engine.store(fact("Owen 有寵物，是貓", [`msg:${r.cat.line}`]), now);
    const both = await r.engine.store(
      fact("Owen 喜歡拉麵也養貓", [r.cat.seen.id, r.fine.seen.id]),
      now,
    );
    const bare = await r.engine.store(
      { ...fact("Owen 住台北", []), origin: "unknown" as const },
      now,
    );
    // The memory module may hear the bus before the recorder redacts: the envelopes are found
    // by key either way.
    const gone = await r.engine.excludeMessage(excludedBody("m1"));
    r.redact("m1");
    expect(gone).toEqual({ deleted: 2, trimmed: 1 });
    const ids = (await tablesOf(r.store).list(profile(), memoryFilter(50))).map((x) => x.id);
    expect(ids).toHaveLength(2);
    const kept = await tablesOf(r.store).get((both as { id: string }).id);
    expect(kept?.source_events).toEqual([r.fine.seen.id]);
    expect(alone.type).not.toBe("refused");
    expect(byLine.type).not.toBe("refused");
    expect(bare.type).not.toBe("refused");
  });

  it("are not stored as evidence from then on, after a restart too", async () => {
    const r = await rig();
    r.redact("m1");
    await r.engine.excludeMessage(excludedBody("m1"));
    const refused = await r.engine.store(fact("Owen 養貓", [r.cat.seen.id]), plus(t0(), 9000));
    expect(refused).toEqual({ type: "refused", reason: "no_evidence" });
    const byLine = await r.engine.store(fact("Owen 養貓", [`msg:${r.cat.line}`]), t0());
    expect(byLine).toEqual({ type: "refused", reason: "no_evidence" });
    const stored = await r.engine.store(
      fact("Owen 養貓也喜歡拉麵", [r.cat.seen.id, r.fine.seen.id]),
      t0(),
    );
    expect(stored.type).not.toBe("refused");
    const record = await tablesOf(r.store).get((stored as { id: string }).id);
    expect(record?.source_events).toEqual([r.fine.seen.id]);
    // A new engine knows from the log itself: no list is kept anywhere.
    const second = new MemoryEngine(profile(), memoryConfig(), tablesOf(r.store), {
      settings: r.store.settings,
      chat: r.store.chat,
    });
    expect(await second.store(fact("Owen 有貓", [r.cat.seen.id]), t0())).toEqual({
      type: "refused",
      reason: "no_evidence",
    });
    expect(await r.store.settings.get(profile(), "memory_excluded")).toBeNull();
  });

  it("are left out of consolidation", async () => {
    const llm = new MockProvider("sum").reply("{}");
    const r = await rig(llm);
    r.redact("m1");
    const report = await r.engine.consolidate(ctx, plus(t0(), 60_000));
    expect(report.lines).toBe(1);
    const asked = llm.requests()[0]?.messages[1]?.content ?? "";
    expect(asked).toContain("我喜歡拉麵");
    expect(asked).not.toContain("貓");
    expect(await r.engine.watermark(ctx)).not.toBeNull();
  });

  it("leave the windows of 'just now' and of a person's last words, and the hot window", async () => {
    const r = await rig();
    r.redact("m1");
    const events = await r.log.query({ kinds: ["observation"] });
    expect(parseWindow(events, 0).said.map((s) => s.text)).toEqual(["我喜歡拉麵"]);
    expect(JSON.stringify(r.log.recent(10))).not.toContain("貓");
    // A line of that message still in the EventLog's buffer is stored redacted.
    const again = r.say("m1", "我養了一隻貓", plus(t0(), 99_000));
    await r.log.flush();
    expect(r.store.events.get(again.seen.id)?.envelope.data).toEqual({ redacted: true });
    expect(parseWindow(await r.log.query({ kinds: ["observation"] }), 0).said).toHaveLength(1);
  });

  it("are taken out when the agent says so on the bus", async () => {
    const services = new ServiceRegistry();
    const sup = new Supervisor({ services });
    const r = await rig();
    services.provide("app", StoreKey, r.store);
    services.provide("app", EventLogKey, r.log);
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
      const stored = await engine.store(fact("Owen 養了一隻貓", [r.cat.seen.id]), t0());
      const id = (stored as { id: string }).id;
      // A line of her notes that quotes the message, and one that quotes another.
      const notes = r.store.plugin(notesTables);
      const line = (text: string, quote: string, message_id: string) =>
        notes.add(
          personSubject(PERSON),
          {
            section: "近況",
            text,
            provenance: "told_by_subject",
            scope: { type: "space", space: "s1" },
            evidence: [{ quote, person_id: PERSON, message_id }],
          },
          { author: "segment", segment: { session: "s", seq_from: 1, seq_to: 2 } },
        ).id;
      const cat = line("Owen 養了一隻貓", "我養了一隻貓", "m1");
      const ramen = line("Owen 喜歡拉麵", "我喜歡拉麵", "m2");
      sup.bus.publish("agent", Events.AgentMessageExcluded, excludedBody("m1"));
      const deadline = Date.now() + 5000;
      while ((await tablesOf(r.store).get(id)) !== null || notes.line(cat)?.text !== "") {
        expect(Date.now() < deadline, "not taken out").toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(notes.line(cat)?.evidence[0]).toMatchObject({ quote: "", redacted: true });
      expect(notes.line(ramen)).toMatchObject({ text: "Owen 喜歡拉麵", outdated_at: null });
    } finally {
      await sup.stopAll();
    }
  });
});

describe("forgetting someone", () => {
  it("redacts their lines and her observations of them, and nobody else's", async () => {
    const r = await rig();
    const amy = r.say("m3", "我是 Amy", plus(t0(), 2000), AMY);
    await r.log.flush();
    // Said just now: still in the EventLog's buffer when they ask.
    const late = r.say("m4", "我住台北", plus(t0(), 3000));
    const person = await r.engine.personOf(OWEN);
    expect(person).not.toBeNull();
    const report = await r.engine.forget(person, OWEN, null);
    // Three chat lines and her three observations of them (one still buffered when asked).
    expect(report.lines).toBe(6);
    const theirs = [r.cat, r.fine, late].flatMap((x) => [x.line, x.seen.id]);
    for (const id of theirs) {
      expect(r.store.events.get(id)?.envelope.data, id).toEqual({ redacted: true });
    }
    expect(r.store.events.get(amy.line)?.envelope.redacted_at).toBeNull();
    expect((await r.store.messages.recent(profile(), ctx, 10)).map((e) => e.text)).toEqual([
      "我是 Amy",
    ]);
    expect(JSON.stringify(r.log.recent(10))).not.toMatch(/貓|拉麵|台北/);
    // A keyword forgets memories, not lines.
    const r2 = await rig();
    const keyword = await r2.engine.forget(await r2.engine.personOf(OWEN), OWEN, "貓");
    expect(keyword.lines).toBeUndefined();
    expect((await r2.store.messages.recent(profile(), ctx, 10)).length).toBe(2);
  });
});
