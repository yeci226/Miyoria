// v4 §5.4 and §5.6: retrieval over the turn, and one profile per person.

import type { AffectState, KnowledgeBase, PersonCard, PersonId, Timestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryEngine,
  MemoryRetriever,
  memoryConfig,
  Profiles,
  type RecentDeps,
  RecentLog,
  storedId,
  Threads,
  viewerFor,
} from "../src/index.js";
import { closeAll, openAreas, profile } from "./helpers.js";
import { at, dm, FakeHandles, FakeLog, guild, recentConfig } from "./recent-helpers.js";

afterEach(closeAll);

const S = "Sora";
const pS = "person-sora";
const pT = "person-tomo";

async function setup(options: { card?: Partial<PersonCard>; knowledge?: string } = {}) {
  const store = await openAreas("fake");
  const log = new FakeLog();
  const handles = new FakeHandles()
    .add(S, pS, { platform: "discord", id: "s" })
    .add("Tomo", pT, { platform: "discord", id: "t" });
  const config = memoryConfig();
  const engine = new MemoryEngine(profile(), config, store.memories, {
    people: store.people,
    settings: store.settings,
    events: log,
    handles,
  });
  const recent = recentConfig();
  const deps: RecentDeps = {
    config: () => recent,
    handles: () => handles,
    access: () => null,
    states: () => null,
    utcOffsetMinutes: 480,
  };
  const window = new RecentLog(
    () => recent,
    () => log,
  );
  const threads = new Threads(
    window,
    () => recent,
    () => handles,
    (w, win) => viewerFor(w, win, deps),
  );
  const card: PersonCard | null =
    options.card === undefined
      ? null
      : {
          person: pS,
          handle: S,
          call_name: null,
          affinity: 30,
          trust: 50,
          familiarity: 40,
          attachment: 0.3,
          emotions: {},
          feeling: "",
          label: "朋友",
          level: 30,
          owner: false,
          blocked: false,
          last_seen: null,
          last_together: null,
          updated_at: at(0),
          ...options.card,
        };
  const affect = { card: (p: PersonId) => (p === pS ? card : null) } as unknown as AffectState;
  const kb = {
    render: () => options.knowledge ?? "",
  } as unknown as KnowledgeBase;
  const profiles = new Profiles(engine, window, threads, deps, {
    config: () => config.profiles,
    affect: () => affect,
    social: () => null,
    knowledge: () => kb,
    events: () => log,
    handles: () => handles,
  });
  const fact = async (content: string, importance: number, when: Timestamp) =>
    storedId(
      await engine.store(
        {
          kind: "fact",
          scope: { type: "person", person: pS },
          subjects: [pS],
          content,
          importance,
          confidence: 0.9,
          source_context: null,
          source: null,
          origin: "experienced",
          source_events: ["01TESTEVIDENCE0000000000"],
          due: null,
        },
        when,
      ),
    );
  return { engine, log, profiles, fact, store };
}

describe("person profiles", () => {
  it("print last seen, last topic, the card and points, retrieved ones left out", async () => {
    const t = await setup({
      card: { feeling: "很可靠", stance: "會吐槽他", call_name: "小空" },
      knowledge: "#abc123 人物卡「Sora」\n  生日: 3/14",
    });
    const ramen = await t.fact("Sora 喜歡拉麵", 0.8, at(-48));
    await t.fact("Sora 在準備面試", 0.7, at(-48));
    // Yesterday evening in voice, then today again.
    t.log.say(S, "我先下線了", at(-3, 30), guild("lobby"));
    t.log.say(S, "早安", at(10, 0), guild("lobby"));
    const where = { context: guild("lobby"), present: [pS], talking_with: [pS], now: at(10, 1) };
    const [p] = await t.profiles.profiles(where, { exclude: [ramen] });
    expect(p).toMatchObject({
      handle: S,
      label: "朋友",
      level: 30,
      call_name: "小空",
      feeling: "很可靠",
      stance: "會吐槽他",
      last_seen: at(-3, 30),
      last_topic: "Sora說:「我先下線了」",
    });
    expect(p?.points.map((x) => x.text)).toEqual(["Sora 在準備面試", "生日: 3/14"]);
    const text = await t.profiles.render(where, 1000, { exclude: [ramen] });
    expect(text).toBe(
      "- Sora:朋友(好感 Lv.30);你叫他「小空」;上次見面:昨天 21:30,這裡;上次聊:Sora說:「我先下線了」;你覺得:很可靠;你的相處方式:會吐槽他;重點:Sora 在準備面試;生日: 3/14",
    );
  });

  it("carry her questions to the person she is talking with, and keep their DM private", async () => {
    const t = await setup({ card: {} });
    t.log.her("上次面試結果怎麼樣?", at(11, 7), dm("dm-s"), [S]);
    t.log.say(S, "還不錯", at(11, 22), dm("dm-s"));
    const talking = { context: guild("lobby"), present: [pS], talking_with: [pS], now: at(12, 12) };
    const text = await t.profiles.render(talking, 2000);
    expect(text).toContain("上次聊:Sora說:「還不錯」(私訊裡的事,只給你知道,不要在這裡引用或透露)");
    expect(text).toContain("  · 你問過 Sora「上次面試結果怎麼樣?」");
    // Present, but she is talking with someone else: nothing from their DM.
    const other = await t.profiles.render({ ...talking, talking_with: [pT] }, 2000);
    expect(other).not.toContain("面試");
    expect(other).not.toContain("還不錯");
  });

  it("prefer her own episode as the last topic", async () => {
    const t = await setup();
    await t.engine.store(
      {
        kind: "episode",
        scope: { type: "person", person: pS },
        subjects: [pS],
        content: "和 Sora 聊了期末考的準備",
        importance: 0.5,
        confidence: 0.9,
        source_context: null,
        origin: "experienced",
        due: null,
      },
      at(-20),
    );
    t.log.say(S, "嗨", at(10, 0), guild("lobby"));
    const [p] = await t.profiles.profiles({
      context: guild("lobby"),
      present: [pS],
      now: at(10, 1),
    });
    expect(p?.last_topic).toBe("和 Sora 聊了期末考的準備");
    expect(p?.questions).toEqual([]);
  });
});

describe("retrieval over the turn", () => {
  it("a short reply recalls through the lines before it", async () => {
    const t = await setup();
    await t.fact("Sora 喜歡拉麵", 0.4, at(-24));
    const scopes = [{ type: "person" as const, person: pS }];
    expect(await t.engine.recall(scopes, [pS], "好啊", ["fact"], 8, at(0))).toEqual([]);
    const got = await t.engine.recall(scopes, [pS], "好啊", ["fact"], 8, at(0), undefined, {
      context: "Tomo: 晚餐去吃拉麵嗎",
    });
    expect(got.map((r) => r.record.content)).toEqual(["Sora 喜歡拉麵"]);
  });

  it("brings the key points of the person she talks with, not of everyone present", async () => {
    const t = await setup();
    await t.fact("Sora 下週三要考期末考", 0.9, at(-2));
    await t.fact("Sora 喜歡藍色", 0.2, at(-2));
    const scopes = [{ type: "person" as const, person: pS }];
    const present = await t.engine.recall(scopes, [pS], "好啊", ["fact"], 8, at(0));
    expect(present).toEqual([]);
    const talking = await t.engine.recall(scopes, [pS], "好啊", ["fact"], 8, at(0), undefined, {
      people: [pS],
    });
    expect(talking.map((r) => r.record.content)).toEqual(["Sora 下週三要考期末考"]);
  });

  it("a person named in the talk counts as a shared word", async () => {
    const t = await setup();
    await t.fact("她很會畫畫", 0.9, at(-2));
    const scopes = [{ type: "person" as const, person: pS }];
    const got = await t.engine.recall(scopes, [], "Sora 最近怎樣", ["fact"], 8, at(0));
    expect(got.map((r) => r.record.content)).toEqual(["她很會畫畫"]);
  });

  it("the retriever reads recent and talking_with of a turn query", async () => {
    const t = await setup();
    await t.fact("Sora 喜歡拉麵", 0.4, at(-24));
    const retriever = new MemoryRetriever(t.engine);
    const base = { context: guild("lobby"), present: [pS], text: "好啊", now: at(0) };
    expect(await retriever.retrieve(base)).toEqual([]);
    const got = await retriever.retrieve({ ...base, recent: ["Tomo: 吃拉麵嗎"] });
    expect(got.map((m) => m.content)).toEqual(["Sora 喜歡拉麵"]);
  });
});
