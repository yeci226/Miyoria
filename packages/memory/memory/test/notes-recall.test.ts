// What `recall` and the prompt's memory block read (`notes-recall.ts`): the memory records until the
// rebuild has finished, her notes (scoped documents first, with the precision rules) after it.

import type { ToolContext } from "@miyoria/llm/tools";
import { SqliteStore } from "@miyoria/store";
import {
  type ContextKey,
  type PersonId,
  Principals,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { rankingOf } from "../../notes/src/rank.js";
import type { ScopeResolver } from "../../notes/src/scope.js";
import {
  type NotesStore,
  notesTables,
  personSubject,
  topicSubject,
} from "../../notes/src/store.js";
import { markRebuildStarted, markRebuilt, ulidTime } from "../../notes/src/switch.js";
import { NotesSearch } from "../../notes/src/vectors.js";
import {
  MemoryEngine,
  memoryConfig,
  memoryTables,
  NotesRecall,
  NotesSourceState,
  RECALL_WEAK,
  RecallTool,
} from "../src/index.js";
import { acct, profile } from "./helpers.js";

const OWEN = "01HOWEN0000000000000000000" as PersonId;
const AMY = "01HAMY00000000000000000000" as PersonId;
const SPACE = "01HSPACE000000000000000000";
const ROOM = "01HROOM0000000000000000000";
const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OWEN_ACCOUNT = acct("u-owen");
const inSpace = { type: "space" as const, space: SPACE };

const resolver: ScopeResolver = {
  spaceOf: (_p, guild) => (guild === "g1" ? SPACE : null),
  guildOf: (space) => (space === SPACE ? { platform: "discord", guild: "g1" } : null),
  roomOf: (ctx) => (ctx.channel === "c1" ? ROOM : null),
  contextOf: (room) => (room === ROOM ? CTX : null),
  personOf: (a) => (a.id === "u-owen" ? OWEN : null),
  accountOf: (p) => (p === OWEN ? OWEN_ACCOUNT : null),
};

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function rig(config = memoryConfig()) {
  const store = await SqliteStore.open(":memory:", { plugins: [memoryTables, notesTables] });
  stores.push(store);
  const notes = store.plugin(notesTables) as NotesStore;
  const engine = new MemoryEngine(profile(), config, store.plugin(memoryTables), {
    settings: store.settings,
  });
  const search = new NotesSearch({
    notes,
    index: null,
    ranking: () => rankingOf(config),
    wait: () => ({ text: 0, voice: 0 }),
  });
  const source = new NotesSourceState(store.settings, profile());
  const recall = new NotesRecall({ engine, notes, search, source, resolver });
  return { store, notes, engine, source, recall };
}

type Rig = Awaited<ReturnType<typeof rig>>;

const now = () => toTimestamp(Date.now());

async function episode(r: Rig, content: string, at: Timestamp = now()) {
  await r.engine.store(
    {
      kind: "episode",
      scope: { type: "guild", platform: "discord", guild: "g1" },
      subjects: [OWEN],
      content,
      importance: 0.6,
      confidence: 1,
      source_context: CTX,
      due: null,
      origin: "experienced",
    },
    at,
  );
}

function line(r: Rig, subject: string, text: string, title?: string) {
  return r.notes.add(
    subject,
    { section: "misc", text, provenance: "observed", scope: inSpace, confidence: 0.9 },
    { author: "tool" },
    title,
  );
}

const ask = (text: string, present: PersonId[] = [OWEN]) => ({
  context: CTX,
  accounts: [OWEN_ACCOUNT],
  present,
  text,
  limit: 8,
  now: now(),
});

async function switchOver(r: Rig, startedAt: number, since = Date.now() - 86_400_000) {
  await markRebuildStarted(r.store.settings, profile(), toTimestamp(since), toTimestamp(startedAt));
  await markRebuilt(r.store.settings, profile(), toTimestamp(since), now(), now());
  await r.source.refresh();
}

describe("NotesRecall", () => {
  it("reads the memory records until the rebuild has finished", async () => {
    const r = await rig();
    await episode(r, "Owen 養了一隻貓叫麻糬");
    line(r, personSubject(OWEN), "喜歡吃拉麵", "Owen");
    await r.source.refresh();
    expect(r.source.switched).toBe(false);

    const records = await r.recall.recollect(ask("麻糬"));
    expect(records.source).toBe("records");
    expect(records.memories.map((m) => m.content)).toEqual(["Owen 養了一隻貓叫麻糬"]);
    expect((await r.recall.recollect(ask("拉麵"))).memories).toEqual([]);

    // Started but not finished: still the records.
    await markRebuildStarted(r.store.settings, profile(), now(), now());
    await r.source.refresh();
    expect((await r.recall.recollect(ask("麻糬"))).source).toBe("records");
  });

  it("reads the notes once it has, and only the records written since it began", async () => {
    const r = await rig();
    await episode(r, "Owen 養了一隻貓叫麻糬");
    line(r, personSubject(OWEN), "喜歡吃拉麵", "Owen");
    // The rebuild began after the episode was written: the old consolidation's, left out.
    await switchOver(r, Date.now() + 60_000);
    const notes = await r.recall.recollect(ask("拉麵"));
    expect(notes.source).toBe("notes");
    expect(notes.memories.map((m) => m.content)).toEqual(["Owen:喜歡吃拉麵"]);
    expect((await r.recall.recollect(ask("麻糬"))).memories).toEqual([]);

    // Written after it began (the segment pass, `remember`): read with the lines.
    const later = await rig();
    await switchOver(later, Date.now() - 60_000);
    await episode(later, "Owen 養了一隻貓叫麻糬");
    expect((await later.recall.recollect(ask("麻糬"))).memories.map((m) => m.content)).toEqual([
      "Owen 養了一隻貓叫麻糬",
    ]);
  });

  it("gives the lines of a person's document as profile points once the notes are the source", async () => {
    const r = await rig();
    line(r, personSubject(OWEN), "喜歡吃拉麵", "Owen");
    const where = { context: CTX, accounts: [OWEN_ACCOUNT], present: [OWEN] };
    expect(r.recall.personPoints(OWEN, where)).toBeNull();
    await switchOver(r, Date.now() - 60_000);
    const points = r.recall.personPoints(OWEN, where);
    expect(points?.lines.map((l) => [l.text, l.origin])).toEqual([["喜歡吃拉麵", "experienced"]]);
    const idAt = (ms: number) => `${ulidTime(toTimestamp(ms))}0000000000000000`;
    expect(points?.recordKept(idAt(Date.now()))).toBe(true);
    expect(points?.recordKept(idAt(Date.now() - 3_600_000))).toBe(false);
  });

  it("keeps the episodes older than the rebuild's start date", async () => {
    const r = await rig();
    const long = Date.now() - 10 * 86_400_000;
    await episode(r, "Owen 養了一隻貓叫麻糬", toTimestamp(long));
    await switchOver(r, Date.now() + 60_000, Date.now() - 86_400_000);
    expect((await r.recall.recollect(ask("麻糬"))).memories.map((m) => m.content)).toEqual([
      "Owen 養了一隻貓叫麻糬",
    ]);
  });

  it("finds the lines about the people here and the place before the others", async () => {
    const r = await rig();
    line(r, topicSubject("拉麵店"), "巷口那家拉麵很好吃", "拉麵店");
    line(r, personSubject(AMY), "Amy 覺得拉麵很好吃", "Amy");
    line(r, personSubject(OWEN), "喜歡吃拉麵", "Owen");
    await switchOver(r, Date.now() + 60_000);
    const found = await r.recall.recollect(ask("拉麵很好吃"));
    expect(found.memories.map((m) => m.content)).toEqual([
      "Owen:喜歡吃拉麵",
      expect.stringContaining("拉麵"),
      expect.stringContaining("拉麵"),
    ]);
    // Without Owen here, his line has no head start.
    const away = await r.recall.recollect({ ...ask("拉麵很好吃", []), accounts: [] });
    expect(away.memories[0]?.content).not.toBe("Owen:喜歡吃拉麵");
  });

  it("leaves weak lines out of the prompt, and marks them in `recall`", async () => {
    const config = memoryConfig({ notes_recall: { min_gap: 1 } });
    const r = await rig(config);
    line(r, personSubject(OWEN), "喜歡吃拉麵", "Owen");
    await switchOver(r, Date.now() + 60_000);
    const found = await r.recall.recollect(ask("拉麵"));
    expect(found).toMatchObject({ weak: true, source: "notes" });
    expect(found.memories).toHaveLength(1);
    const block = await r.recall.retrieve({
      context: CTX,
      present: [OWEN],
      accounts: [OWEN_ACCOUNT],
      text: "拉麵",
      now: now(),
    });
    expect(block).toEqual([]);

    const tool = new RecallTool(r.engine, { now: () => Date.now() }, r.recall);
    const ctx: ToolContext = {
      turn: "t1",
      context: CTX,
      account: OWEN_ACCOUNT,
      principal: Principals.user(OWEN_ACCOUNT, CTX),
      message: { context: CTX, id: "m1" },
      priority: "direct",
    } as ToolContext;
    const text = await tool.call(ctx, { query: "拉麵" });
    expect(text).toContain("喜歡吃拉麵");
    expect(text).toContain(RECALL_WEAK);
  });

  it("returns nothing for a question nothing in the notes is about", async () => {
    const r = await rig();
    line(r, personSubject(OWEN), "喜歡吃拉麵", "Owen");
    await switchOver(r, Date.now() + 60_000);
    expect((await r.recall.recollect(ask("明天會下雨嗎"))).memories).toEqual([]);
  });
});
