// V3 memory discipline (docs/design/v3-architecture.md §11): the pinned layer and its cap,
// provenance, evidence, present-tense refusal, decay on read, retrieval, and what `forget`
// removes and leaves.

import { CommandRegistry, type InvocationData } from "@miyoria/commands";
import { ServiceRegistry } from "@miyoria/kernel";
import { MockProvider } from "@miyoria/llm";
import type { MemoryRecord, MemoryScope } from "@miyoria/store";
import type { ToolContext } from "@miyoria/tools";
import {
  type AccountRef,
  type ContextKey,
  type EventLog,
  type Handle,
  type HandleDirectory,
  type HandleEntry,
  type LogEvent,
  type LogEventFilter,
  newId,
  type PersonId,
  type PinnedContext,
  type Timestamp,
  timestampMs,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveConfidence,
  FORGET_KEEPS,
  isEventRef,
  lineOf,
  MemoryCommands,
  MemoryEngine,
  MemoryRetriever,
  memoryConfig,
  PinnedReader,
  RememberTool,
  strongerOrigin,
  weakerOrigin,
} from "../src/index.js";
import {
  acct,
  closeAll,
  DAY,
  guildCtx,
  HOUR,
  MINUTE,
  openAreas,
  plus,
  profile,
  router,
  SECOND,
  t0,
} from "./helpers.js";

afterEach(closeAll);

const G1: MemoryScope = { type: "guild", platform: "discord", guild: "g1" };
const CTX = guildCtx("g1", "c1");

// ---- fakes ----------------------------------------------------------------------------------

type Reader = Pick<EventLog, "query" | "get">;

/** An EventLog that keeps what it is given and answers the way the real one does. */
class FakeEvents implements Reader {
  readonly events: LogEvent[] = [];

  say(handle: Handle, name: string, text: string, at: Timestamp, context: ContextKey): LogEvent {
    const event: LogEvent = {
      id: newId(),
      at,
      kind: "observation",
      source: "platform.discord",
      cause: null,
      context,
      person: handle,
      body: {
        observation: {
          source: "platform.discord",
          summary: `${name}:${text}`,
          from: handle,
        },
      },
    };
    this.events.push(event);
    return event;
  }

  async get(id: string): Promise<LogEvent | null> {
    return this.events.find((e) => e.id === id) ?? null;
  }

  async query(filter: LogEventFilter = {}): Promise<LogEvent[]> {
    const key = (c: ContextKey | null) => (c === null ? "" : JSON.stringify(c));
    let out = this.events.filter(
      (e) =>
        (!filter.kinds || filter.kinds.includes(e.kind)) &&
        (!filter.context || key(e.context) === key(filter.context)) &&
        (!filter.person || e.person === filter.person) &&
        (!filter.since || timestampMs(e.at) >= timestampMs(filter.since)) &&
        (!filter.until || timestampMs(e.at) < timestampMs(filter.until)),
    );
    out = [...out].sort((a, b) => timestampMs(a.at) - timestampMs(b.at));
    if (filter.order !== "asc") out.reverse();
    return out.slice(0, filter.limit ?? 100);
  }

  /** Compaction: the event is gone, what pointed at it is not. */
  drop(id: string): void {
    this.events.splice(
      this.events.findIndex((e) => e.id === id),
      1,
    );
  }
}

class FakeHandles implements HandleDirectory {
  readonly entries: HandleEntry[] = [];

  add(handle: Handle, person: PersonId, account: AccountRef): void {
    this.entries.push({
      handle,
      person,
      account,
      display_name: handle,
      created_at: t0(),
    });
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

interface World {
  engine: MemoryEngine;
  events: FakeEvents;
  handles: FakeHandles;
  owen: PersonId;
  amy: PersonId;
  llm: MockProvider;
  store: Awaited<ReturnType<typeof openAreas>>;
  log(context: ContextKey, who: "owen" | "amy" | "her", text: string, ts: Timestamp): Promise<void>;
}

const ACCOUNTS = { owen: acct("2"), amy: acct("3"), her: acct("1") };
const NAMES = { owen: "Owen", amy: "Amy", her: "DeepSeek-chan" };

async function world(
  reply = "{}",
  config: Parameters<typeof memoryConfig>[0] = {},
  withLog = true,
): Promise<World> {
  const store = await openAreas("fake");
  const llm = new MockProvider("sum").reply(reply);
  const events = new FakeEvents();
  const handles = new FakeHandles();
  const engine = new MemoryEngine(profile(), memoryConfig(config), store.memories, {
    people: store.people,
    messages: store.messages,
    settings: store.settings,
    router: router(llm),
    events: withLog ? events : null,
    handles: withLog ? handles : null,
  });
  const owen = await store.people.upsertAccount(ACCOUNTS.owen, "Owen");
  const amy = await store.people.upsertAccount(ACCOUNTS.amy, "Amy");
  handles.add("Owen", owen, ACCOUNTS.owen);
  handles.add("Amy", amy, ACCOUNTS.amy);
  return {
    engine,
    events,
    handles,
    owen,
    amy,
    llm,
    store,
    async log(context, who, text, ts) {
      await store.messages.append({
        id: newId(),
        profile: profile(),
        context,
        author: ACCOUNTS[who],
        author_name: NAMES[who],
        text,
        is_self: who === "her",
        ts,
        turn: null,
      });
      if (who !== "her") events.say(NAMES[who], NAMES[who], text, ts, context);
    },
  };
}

function toolCtx(context: ContextKey, account: AccountRef): ToolContext {
  return {
    turn: newId(),
    message: { context, id: "m1" },
    context,
    account,
    principal: { kind: "user", requester: account, context, override: false, actor: null },
    priority: "direct",
    signal: new AbortController().signal,
  };
}

/** A record the way an older build wrote it: no origin, no evidence. */
function legacy(_w: World, over: Partial<MemoryRecord>): MemoryRecord {
  const at = t0(-3 * DAY);
  return {
    id: newId(),
    profile: profile(),
    kind: "fact",
    scope: G1,
    subjects: [],
    content: "x",
    tokens: "x",
    embedding: null,
    importance: 0.6,
    confidence: 0.8,
    created_at: at,
    updated_at: at,
    last_accessed: null,
    access_count: 0,
    source_context: null,
    source: null,
    due: null,
    done: false,
    superseded_by: null,
    ...over,
  };
}

const pinnedCtx = (_w: World, present: PersonId[], context = CTX): PinnedContext => ({
  context,
  present,
  accounts: [ACCOUNTS.owen],
  now: t0(),
});

// ---- the pinned layer -----------------------------------------------------------------------

describe("pinned", () => {
  it("is capped in total and per section, and the persona is never pushed out by the rest", async () => {
    const w = await world("{}", { pinned: { max_chars: 100, persona_chars: 60, rules_chars: 60 } });
    const reader = new PinnedReader(w.engine);
    reader.addSource({ key: "persona", lines: () => ["我是一個很愛拉麵的少女".repeat(20)] });
    reader.addSource({ key: "rules", lines: () => ["不可以洩漏別人的私訊", "不可以罵人"] });
    for (let i = 0; i < 5; i++) {
      await w.engine.store(
        {
          kind: "followup",
          scope: G1,
          subjects: [],
          content: `答應 Owen 第 ${i} 件事`,
          importance: 0.5,
          confidence: 1,
          source_context: null,
          origin: "experienced",
          due: t0(HOUR),
        },
        t0(),
      );
    }
    const pinned = await reader.pinned(pinnedCtx(w, []));
    const text = pinned.sections.flatMap((s) => s.lines);
    // Never over the cap, whatever the sources hand over.
    expect(pinned.chars).toBeLessThanOrEqual(100);
    expect([...text.join("")].length).toBeLessThanOrEqual(100);
    expect(pinned.truncated).toBe(true);
    const persona = pinned.sections.find((s) => s.key === "persona");
    expect(persona?.truncated).toBe(true);
    expect([...(persona?.lines.join("") ?? "")].length).toBeLessThanOrEqual(60);
    // Persona and rules come first: they are placed before the commitments use up the room.
    expect(pinned.sections.map((s) => s.key).slice(0, 2)).toEqual(["persona", "rules"]);
  });

  it("holds open commitments and one line per person present, without any search", async () => {
    const w = await world();
    const reader = new PinnedReader(w.engine);
    await w.engine.store(
      {
        kind: "followup",
        scope: G1,
        subjects: [w.owen],
        content: "問 Owen 期末考考得怎樣",
        importance: 0.5,
        confidence: 1,
        source_context: CTX,
        origin: "experienced",
        due: t0(2 * HOUR),
      },
      t0(),
    );
    // A closed one and one nobody can see here are not listed.
    const closed = await w.engine.store(
      {
        kind: "followup",
        scope: G1,
        subjects: [],
        content: "已經問過的事",
        importance: 0.5,
        confidence: 1,
        source_context: CTX,
        origin: "experienced",
        due: t0(HOUR),
      },
      t0(),
    );
    await w.engine.markDone((closed as { id: string }).id);
    await w.engine.store(
      {
        kind: "followup",
        scope: { type: "dm", account: ACCOUNTS.amy },
        subjects: [],
        content: "Amy 私訊裡的承諾",
        importance: 0.5,
        confidence: 1,
        source_context: null,
        origin: "experienced",
        due: t0(HOUR),
      },
      t0(),
    );
    const evidence = ["01EVENT"];
    await w.engine.store(
      {
        kind: "fact",
        scope: G1,
        subjects: [w.owen],
        content: "Owen 喜歡拉麵",
        importance: 0.8,
        confidence: 0.9,
        source_context: CTX,
        source: { account: ACCOUNTS.owen, name: "Owen" },
        origin: "told",
        source_events: evidence,
        due: null,
      },
      t0(),
    );
    await w.engine.store(
      {
        kind: "fact",
        scope: G1,
        subjects: [w.owen],
        content: "Owen 在大學念資工",
        importance: 0.5,
        confidence: 0.9,
        source_context: CTX,
        source: { account: ACCOUNTS.amy, name: "Amy" },
        origin: "told",
        source_events: evidence,
        due: null,
      },
      t0(),
    );

    // Nothing in the request says what is being talked about: no query, so no retrieval.
    const pinned = await reader.pinned(pinnedCtx(w, [w.owen, w.amy]));
    const commitments = pinned.sections.find((s) => s.key === "commitments");
    expect(commitments?.lines).toEqual(["- 問 Owen 期末考考得怎樣"]);
    const people = pinned.sections.find((s) => s.key === "people");
    expect(people?.lines).toHaveLength(1);
    expect(people?.lines[0]).toContain("Owen:");
    expect(people?.lines[0]).toContain("喜歡拉麵");
    // What someone else said about him says so; what he said himself stands plain.
    expect(people?.lines[0]).toContain("(Amy說的)");
    expect(people?.lines[0]).not.toContain("(Owen說的)");
    // Amy has no facts: no line for her. And a DM is not a place the guild can read.
    expect(JSON.stringify(pinned)).not.toContain("私訊裡的承諾");
  });

  it("marks a person line built from memory of unknown origin, and leaves present states out", async () => {
    const w = await world();
    const reader = new PinnedReader(w.engine);
    await w.store.memories.upsert(
      legacy(w, { subjects: [w.owen], content: "Owen 養了一隻貓", tokens: "owen 养 猫" }),
    );
    await w.store.memories.upsert(
      legacy(w, { subjects: [w.owen], content: "Owen 正在直播", tokens: "owen 直播" }),
    );
    const pinned = await reader.pinned(pinnedCtx(w, [w.owen]));
    const line = pinned.sections.find((s) => s.key === "people")?.lines[0] ?? "";
    expect(line).toContain("養了一隻貓(來源不明)");
    expect(line).not.toContain("直播");
  });

  it("reuses a person's line until something is written", async () => {
    const w = await world();
    let now = t0();
    const reader = new PinnedReader(w.engine, { now: () => timestampMs(now) });
    const fact = (content: string) =>
      w.engine.store(
        {
          kind: "fact",
          scope: G1,
          subjects: [w.owen],
          content,
          importance: 0.8,
          confidence: 0.9,
          source_context: CTX,
          origin: "experienced",
          source_events: ["01EVENT"],
          due: null,
        },
        t0(),
      );
    await fact("Owen 喜歡拉麵");
    const first = await reader.pinned(pinnedCtx(w, [w.owen]));
    expect(first.sections.find((s) => s.key === "people")?.lines[0]).toContain("拉麵");
    now = plus(now, SECOND);
    await fact("Owen 討厭香菜");
    const second = await reader.pinned(pinnedCtx(w, [w.owen]));
    expect(second.sections.find((s) => s.key === "people")?.lines[0]).toContain("香菜");
  });

  it("a failing source costs its lines, not the turn", async () => {
    const w = await world();
    const reader = new PinnedReader(w.engine);
    reader.addSource({
      key: "rules",
      lines: () => {
        throw new Error("boom");
      },
    });
    const off = reader.addSource({ key: "persona", lines: () => ["我是少女"] });
    // Off by default: the main line's prompt has the whole persona.
    expect((await reader.pinned(pinnedCtx(w, []))).sections).toEqual([]);
    const wide = await world("{}", { pinned: { persona_chars: 500 } });
    const withPersona = new PinnedReader(wide.engine);
    withPersona.addSource({ key: "persona", lines: () => ["我是少女"] });
    expect((await withPersona.pinned(pinnedCtx(wide, []))).sections.map((s) => s.key)).toEqual([
      "persona",
    ]);
    off();
    expect((await reader.pinned(pinnedCtx(w, []))).sections).toEqual([]);
  });
});

// ---- provenance and evidence ----------------------------------------------------------------

const LINES_JSON = `{
  "episode": {"summary": "我跟 Owen 聊了拉麵", "importance": 0.6, "emotion": "開心"},
  "facts": [
    {"subject_name": "Owen", "statement": "Owen 最喜歡豚骨拉麵", "importance": 0.7, "confidence": 0.9, "global": false, "lines": [1]},
    {"subject_name": "Owen", "statement": "Owen 養了一隻叫麻糬的貓", "importance": 0.8, "confidence": 0.9, "global": false, "lines": [1]}
  ],
  "self_notes": [{"note": "我答應 Owen 下次一起去吃拉麵", "importance": 0.7, "lines": [2]}],
  "followups": []
}`;

async function consolidated(json = LINES_JSON) {
  const w = await world(json);
  await w.log(CTX, "owen", "我最喜歡豚骨拉麵", t0(-10 * MINUTE));
  await w.log(CTX, "her", "好啊,下次一起去吃拉麵", t0(-9 * MINUTE));
  const report = await w.engine.consolidate(CTX, t0());
  return { w, report, records: await w.store.memories.list(profile(), memoryFilterAll()) };
}

function memoryFilterAll() {
  return {
    subject: null,
    scope: null,
    kind: null,
    before: null,
    include_superseded: true,
    limit: 100,
  };
}

describe("provenance and evidence", () => {
  it("every memory says whether she lived it or was told it, and carries its events", async () => {
    const { w, report, records } = await consolidated();
    expect(report.inserted, JSON.stringify(report)).toBe(3);
    const find = (needle: string) => {
      const r = records.find((x) => x.content.includes(needle));
      if (!r) throw new Error(`no ${needle}`);
      return r;
    };
    const owenEvent = w.events.events[0];
    expect(owenEvent).toBeDefined();

    // What Owen said about himself: told, by Owen, resting on his event.
    const likes = find("豚骨");
    expect(likes.origin).toBe("told");
    expect(likes.source).toEqual({ account: ACCOUNTS.owen, name: "Owen" });
    expect(likes.source_events).toEqual([owenEvent?.id]);
    expect(likes.source_events?.every(isEventRef)).toBe(true);

    // What happened in front of her and what she promised: lived.
    const episode = find("聊了拉麵");
    expect(episode.origin).toBe("experienced");
    expect(episode.source_events).toContain(owenEvent?.id);
    const promise = find("答應 Owen");
    expect(promise.origin).toBe("experienced");
    // Her own line has no event in the log (the log keeps what she perceived): it cites the line.
    expect(promise.source_events?.some((r) => r.startsWith("msg:"))).toBe(true);
  });

  it("a fact nothing said is not stored, so a hallucination cannot become her past", async () => {
    const { report, records } = await consolidated();
    expect(report.refusedEvidence).toBe(1);
    expect(records.some((r) => r.content.includes("麻糬"))).toBe(false);
  });

  it("her own lines prove nothing about someone else", async () => {
    const json = `{"facts": [{"subject_name": "Owen", "statement": "Owen 喜歡看恐怖片", "importance": 0.8, "confidence": 0.9, "global": false}]}`;
    const w = await world(json);
    await w.log(CTX, "owen", "今天好累", t0(-10 * MINUTE));
    await w.log(CTX, "her", "Owen 你是不是喜歡看恐怖片啊", t0(-9 * MINUTE));
    const report = await w.engine.consolidate(CTX, t0());
    expect(report.inserted).toBe(0);
    expect(report.refusedEvidence).toBe(1);
  });

  it("without an EventLog the lines cite themselves, and the memory still has a source", async () => {
    const w = await world(LINES_JSON, {}, false);
    await w.log(CTX, "owen", "我最喜歡豚骨拉麵", t0(-10 * MINUTE));
    await w.log(CTX, "her", "好啊,下次一起去吃拉麵", t0(-9 * MINUTE));
    await w.engine.consolidate(CTX, t0());
    const likes = (await w.store.memories.list(profile(), memoryFilterAll())).find((r) =>
      r.content.includes("豚骨"),
    );
    expect(likes?.source_events?.[0]).toMatch(/^msg:/);
  });

  it("store refuses a fact with no evidence, and says why", async () => {
    const w = await world();
    const stored = await w.engine.store(
      {
        kind: "fact",
        scope: G1,
        subjects: [w.owen],
        content: "Owen 是左撇子",
        importance: 0.5,
        confidence: 0.9,
        source_context: null,
        origin: "told",
        due: null,
      },
      t0(),
    );
    expect(stored).toEqual({ type: "refused", reason: "no_evidence" });
    expect(await w.store.memories.list(profile(), memoryFilterAll())).toEqual([]);
    // Experiences and followups are not person facts: they may stand without a cited line.
    const lived = await w.engine.store(
      {
        kind: "episode",
        scope: G1,
        subjects: [],
        content: "大家一起通宵",
        importance: 0.5,
        confidence: 1,
        source_context: null,
        origin: "experienced",
        due: null,
      },
      t0(),
    );
    expect(lived.type).toBe("inserted");
  });

  it("said again with a source, the better provenance wins and the evidence adds up", async () => {
    const w = await world();
    const base = {
      kind: "fact" as const,
      scope: G1,
      subjects: [w.owen],
      content: "Owen 喜歡拉麵",
      importance: 0.5,
      confidence: 0.6,
      source_context: null,
      due: null,
    };
    await w.store.memories.upsert(legacy(w, { ...base, tokens: "owen 喜欢 拉面" }));
    const again = await w.engine.store(
      {
        ...base,
        origin: "told",
        source: { account: ACCOUNTS.owen, name: "Owen" },
        source_events: ["01A"],
      },
      t0(),
    );
    expect(again.type).toBe("reinforced");
    const [record] = await w.store.memories.list(profile(), memoryFilterAll());
    expect(record?.origin).toBe("told");
    expect(record?.source_events).toEqual(["01A"]);
    expect(record?.source?.name).toBe("Owen");
    expect(strongerOrigin("unknown", "told")).toBe("told");
    expect(strongerOrigin("told", "experienced")).toBe("experienced");
    expect(weakerOrigin("experienced", "told")).toBe("told");
    expect(weakerOrigin("unknown", "experienced")).toBe("unknown");
  });

  it("remember keeps only what the person really said, and records the telling", async () => {
    const w = await world();
    const remember = new RememberTool(w.engine, { now: () => timestampMs(t0()) });
    const ctx = toolCtx(CTX, ACCOUNTS.owen);
    const said = w.events.say(
      "Owen",
      "Owen",
      "我下週三要考期末考,記得幫我加油",
      plus(t0(), -MINUTE),
      CTX,
    );

    // Nobody said it: refused, nothing written.
    expect(await remember.call(ctx, { content: "Owen 其實是貓奴" })).toContain("沒有聽到");
    expect(await w.store.memories.list(profile(), memoryFilterAll())).toEqual([]);

    expect(await remember.call(ctx, { content: "Owen 下週三要考期末考" })).toBe("記住了。");
    const [record] = await w.store.memories.list(profile(), memoryFilterAll());
    expect(record?.origin).toBe("told");
    expect(record?.source_events).toEqual([said.id]);
    expect(record?.source?.name).toBe("Owen");

    // What is happening right now is not a memory either.
    w.events.say("Owen", "Owen", "我正在開台", plus(t0(), -SECOND), CTX);
    expect(await remember.call(ctx, { content: "Owen 正在開台" })).toContain("現在的狀態");
  });

  it("lines read by where they come from", () => {
    const now = t0();
    const base = { content: "Owen 喜歡拉麵", created_at: t0(-3 * DAY) };
    expect(lineOf({ ...base, origin: "experienced", said_by: null }, now)).toBe(
      "- Owen 喜歡拉麵(三天前)",
    );
    expect(lineOf({ ...base, origin: "told", said_by: "Amy" }, now)).toBe(
      "- 「Amy」說過:Owen 喜歡拉麵(三天前)",
    );
    expect(lineOf({ ...base, origin: "told", said_by: null }, now)).toBe(
      "- 聽說:Owen 喜歡拉麵(三天前)",
    );
    expect(lineOf({ ...base, origin: "unknown", said_by: null }, now)).toBe(
      "- Owen 喜歡拉麵(三天前,來源不明)",
    );
  });
});

// ---- present-tense state --------------------------------------------------------------------

describe("present-tense state", () => {
  it("never enters long-term memory", async () => {
    const w = await world();
    const note = (content: string, kind: "fact" | "self_note" = "self_note") =>
      w.engine.store(
        {
          kind,
          scope: G1,
          subjects: [],
          content,
          importance: 0.8,
          confidence: 0.9,
          source_context: null,
          origin: "experienced",
          source_events: ["01EVENT"],
          due: null,
        },
        t0(),
      );
    for (const text of [
      "我正在開台",
      "已經開台",
      "直播中,大家快來",
      "Owen 正在打 osu",
      "she is live right now",
    ]) {
      expect(await note(text), text).toEqual({ type: "refused", reason: "present_state" });
    }
    // A lasting fact that mentions 現在 or 目前 is not a state in progress.
    expect((await note("Owen 現在住在台北", "fact")).type).toBe("inserted");
    expect((await note("我答應下次陪 Owen 打 Minecraft")).type).toBe("inserted");
  });

  it("is refused in consolidation too, whatever the summarizer says about its lifetime", async () => {
    const json = `{"self_notes": [
      {"note": "Owen 在打 osu", "importance": 0.8, "valid_hours": 2, "lines": [1]},
      {"note": "我正在下載 Bad Apple", "importance": 0.8, "lines": [1]}
    ]}`;
    const w = await world(json);
    await w.log(CTX, "owen", "我在打 osu,你在下載 Bad Apple", t0(-5 * MINUTE));
    const report = await w.engine.consolidate(CTX, t0());
    expect(report.refusedState).toBe(2);
    expect(report.inserted).toBe(0);
  });

  it("is not recalled from records an older build wrote", async () => {
    const w = await world();
    await w.store.memories.upsert(
      legacy(w, {
        kind: "self_note",
        content: "答應 Owen 玩 Minecraft 並開直播,已經開台",
        tokens: "答应 owen 玩 minecraft 开 直播 已经 开台",
        created_at: t0(-HOUR),
        updated_at: t0(-HOUR),
      }),
    );
    const retriever = new MemoryRetriever(w.engine);
    const got = await retriever.retrieve({
      context: CTX,
      present: [w.owen],
      accounts: [ACCOUNTS.owen],
      text: "Minecraft 直播 開台",
      now: t0(),
    });
    expect(got).toEqual([]);
  });
});

// ---- decay on read and retrieval ------------------------------------------------------------

describe("decay and retrieval", () => {
  it("a fact fades on read, the stored value is untouched, and unknown origin counts for less", async () => {
    const w = await world();
    const config = memoryConfig();
    const made = (over: Partial<MemoryRecord>) => legacy(w, { confidence: 1, ...over });
    const fresh = made({ updated_at: t0(-DAY), origin: "told" });
    const stale = made({ updated_at: t0(-60 * DAY), origin: "told" });
    const unknown = made({ updated_at: t0(-DAY) });
    const episode = made({ kind: "episode", updated_at: t0(-60 * DAY), origin: "experienced" });
    const now = t0();
    expect(effectiveConfidence(config, fresh, now)).toBeCloseTo(1, 6);
    expect(effectiveConfidence(config, stale, now)).toBeCloseTo(0.98 ** 30, 4);
    expect(effectiveConfidence(config, unknown, now)).toBeCloseTo(0.8, 6);
    expect(effectiveConfidence(config, episode, now), "episodes do not fade this way").toBeCloseTo(
      1,
      6,
    );
    expect(stale.confidence).toBe(1);
  });

  it("a faded fact ranks below a fresh one that says the same thing", async () => {
    const w = await world("{}", { min_score: 0 });
    const same = { kind: "fact" as const, importance: 0.6, confidence: 1, origin: "told" as const };
    const stale = legacy(w, {
      ...same,
      id: newId(),
      content: "Owen 喜歡咖哩",
      tokens: "owen 喜欢 咖喱",
      updated_at: t0(-90 * DAY),
      created_at: t0(-90 * DAY),
    });
    const fresh = legacy(w, {
      ...same,
      id: newId(),
      content: "Owen 喜歡咖哩飯",
      tokens: "owen 喜欢 咖喱 饭",
      updated_at: t0(-DAY),
      created_at: t0(-DAY),
    });
    await w.store.memories.upsert(stale);
    await w.store.memories.upsert(fresh);
    const retriever = new MemoryRetriever(w.engine);
    const got = await retriever.retrieve({
      context: CTX,
      present: [],
      text: "咖喱",
      now: t0(),
    });
    expect(got.map((m) => m.id)).toEqual([fresh.id, stale.id]);
    expect(got[0]?.confidence).toBeGreaterThan(got[1]?.confidence ?? 1);
  });

  it("retrieval says where each memory comes from, and format reads it that way", async () => {
    const w = await world();
    await w.engine.store(
      {
        kind: "fact",
        scope: G1,
        subjects: [w.owen],
        content: "Owen 下週三要考期末考",
        importance: 0.8,
        confidence: 0.9,
        source_context: CTX,
        source: { account: ACCOUNTS.owen, name: "Owen" },
        origin: "told",
        source_events: ["01EVENT"],
        due: null,
      },
      t0(-DAY),
    );
    await w.store.memories.upsert(
      legacy(w, { content: "期末考的範圍是第三章", tokens: "期末考 范围 第三章" }),
    );
    const retriever = new MemoryRetriever(w.engine);
    const got = await retriever.retrieve({
      context: CTX,
      present: [w.owen],
      accounts: [ACCOUNTS.owen],
      text: "期末考",
      now: t0(),
    });
    expect(got).toHaveLength(2);
    const told = got.find((m) => m.origin === "told");
    expect(told).toMatchObject({ said_by: "Owen", source_events: ["01EVENT"], kind: "fact" });
    expect(got.find((m) => m.origin === "unknown")?.source_events).toEqual([]);
    const text = retriever.format(got, t0());
    expect(text).toContain("「Owen」說過:Owen 下週三要考期末考");
    expect(text).toContain("來源不明");
  });
});

// ---- forget ---------------------------------------------------------------------------------

describe("forget", () => {
  async function filled() {
    const w = await world();
    const say = (who: "owen" | "amy", text: string) =>
      w.events.say(NAMES[who], NAMES[who], text, t0(-HOUR), CTX);
    const owenSaid = say("owen", "我最喜歡豚骨拉麵");
    const amySaid = say("amy", "我不吃香菜");
    const store = (over: Partial<Parameters<MemoryEngine["store"]>[0]>) =>
      w.engine.store(
        {
          kind: "fact",
          scope: G1,
          subjects: [],
          content: "x",
          importance: 0.7,
          confidence: 0.9,
          source_context: CTX,
          origin: "told",
          due: null,
          ...over,
        },
        t0(),
      );
    // About Owen.
    await store({
      subjects: [w.owen],
      content: "Owen 喜歡拉麵",
      source: { account: ACCOUNTS.owen, name: "Owen" },
      source_events: [owenSaid.id],
    });
    // About Amy, but Owen is the one who said it: derived from his events.
    await store({
      subjects: [w.amy],
      content: "Amy 住在新竹",
      source: { account: ACCOUNTS.owen, name: "Owen" },
      source_events: [owenSaid.id],
    });
    // Her own note, resting on an event of Owen's.
    await store({
      kind: "self_note",
      scope: { type: "global" },
      content: "我答應下次請客吃拉麵",
      origin: "experienced",
      source_events: [owenSaid.id],
    });
    // About Amy, from Amy's own event: not Owen's to forget.
    await store({
      subjects: [w.amy],
      content: "Amy 不吃香菜",
      source: { account: ACCOUNTS.amy, name: "Amy" },
      source_events: [amySaid.id],
    });
    // Nothing ties this to Owen: his events are not in it.
    await store({
      kind: "episode",
      content: "大家一起看了煙火",
      origin: "experienced",
      source_events: [amySaid.id],
    });
    return { w, owenSaid, amySaid };
  }

  const contents = async (w: World) =>
    (await w.store.memories.list(profile(), memoryFilterAll())).map((r) => r.content).sort();

  it("removes what is about a person and what was derived from their events, and only that", async () => {
    const { w, owenSaid } = await filled();
    const report = await w.engine.forget(w.owen, ACCOUNTS.owen, null);
    expect(report).toMatchObject({ about: 1, derived: 2, deleted: 3, unverified: 0 });
    expect(await contents(w)).toEqual(["Amy 不吃香菜", "大家一起看了煙火"]);
    // The log is the evidence: forgetting a memory does not rewrite it.
    expect(await w.events.get(owenSaid.id)).not.toBeNull();
    expect(w.events.events).toHaveLength(2);
  });

  it("with a keyword takes only the matching ones, derived or not", async () => {
    const { w } = await filled();
    const report = await w.engine.forget(w.owen, ACCOUNTS.owen, "新竹");
    expect(report).toMatchObject({ about: 0, derived: 1, deleted: 1 });
    expect((await contents(w)).length).toBe(4);
  });

  it("says what it could not tie to anyone when the event was compacted away", async () => {
    const { w, owenSaid } = await filled();
    w.events.drop(owenSaid.id);
    const report = await w.engine.forget(w.owen, ACCOUNTS.owen, null);
    // The one about Owen goes by its subject; the others rest on a line that is gone, and
    // their `source` (Amy's, from Owen) still ties the told one to him.
    expect(report.about).toBe(1);
    expect(report.derived).toBe(1);
    expect(report.unverified).toBe(1);
    expect(await contents(w)).toEqual(["Amy 不吃香菜", "大家一起看了煙火", "我答應下次請客吃拉麵"]);
  });

  it("finds a person by their display name when there is no handle directory", async () => {
    const w = await world("{}", {}, true);
    const bare = new MemoryEngine(profile(), memoryConfig(), w.store.memories, {
      people: w.store.people,
      events: w.events,
    });
    const said = w.events.say("Owen", "Owen", "我喜歡拉麵", t0(-HOUR), CTX);
    await bare.store(
      {
        kind: "self_note",
        scope: { type: "global" },
        subjects: [],
        content: "我答應請客吃拉麵",
        importance: 0.7,
        confidence: 1,
        source_context: CTX,
        origin: "experienced",
        source_events: [said.id],
        due: null,
      },
      t0(),
    );
    expect((await bare.forget(w.owen, ACCOUNTS.owen, null)).derived).toBe(1);
  });

  it("the command says exactly what goes and what stays", async () => {
    const { w } = await filled();
    const registry = new CommandRegistry();
    new MemoryCommands().install(registry, w.engine, { services: new ServiceRegistry() });
    const data = (path: string[], args: Record<string, string> = {}): InvocationData => ({
      path,
      args,
      invoker: ACCOUNTS.owen,
      invoker_display_name: "Owen",
      context: CTX,
      invoker_is_guild_admin: false,
    });

    const shown = await registry.dispatch(data(["me", "memory", "show"]));
    expect(shown.text).toContain("聽 Owen 說");
    expect(shown.text).toContain("筆證據");
    expect(shown.text).toContain("不是聊天紀錄");
    // It lists what forget would take: the ones derived from his words are marked as such.
    expect(shown.text).toContain("Amy 住在新竹");
    expect(shown.text).toContain("出自你說的話");
    expect(shown.text).not.toContain("不吃香菜");

    const ask = await registry.dispatch(data(["me", "memory", "forget"], { target: "all" }));
    expect(ask.text).toContain("會刪除");
    expect(ask.text).toContain(FORGET_KEEPS);
    expect(ask.text).toContain("事件紀錄");
    expect(ask.text).toContain("/admin memory wipe");

    const exported = await registry.dispatch(data(["me", "memory", "export"]));
    const items = JSON.parse(String(exported.files?.[0]?.data)) as {
      origin: string;
      source_events: string[];
      said_by: string | null;
    }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.origin !== undefined && Array.isArray(i.source_events))).toBe(true);

    const done = await registry.dispatchComponent({
      ...data(["x"]),
      custom_id: "mi:me:memory:forget:all",
      message_id: "m",
      session: null,
    });
    const text = done?.result.type === "update" ? done.result.reply.text : "";
    expect(text).toContain("已讓她忘記關於你的 3 件事");
    expect(text).toContain("其中關於你的 1 件");
    expect(text).toContain("你告訴她或從你的話整理出來的 2 件");
    expect(text).toContain("不會刪除");
    expect(text).toContain("聊天紀錄和事件紀錄");
  });
});
