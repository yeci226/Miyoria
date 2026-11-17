// Hybrid recall, the prompt section and the model tools.

import type { ToolContext } from "@miyoria/llm/tools";
import type { MemoryRecord, MemoryScope } from "@miyoria/store";
import { type AccountRef, type ContextKey, newId, systemClock } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatLines,
  memoryConfig,
  PROMPT_KINDS,
  RecallTool,
  RememberTool,
  spreadCosine,
  visibleScopes,
} from "../src/index.js";
import {
  acct,
  BACKENDS,
  closeAll,
  DAY,
  dmCtx,
  env,
  envWith,
  guildCtx,
  T0_MS,
  TableEmbedder,
  t0,
} from "./helpers.js";

const G1: MemoryScope = { type: "guild", platform: "discord", guild: "g1" };

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

afterEach(closeAll);

describe.each(BACKENDS)("retrieval (%s store)", (backend) => {
  it("ranks_by_text_subject_recency_and_importance", async () => {
    const e = await env(backend);
    const owen = await e.person(acct("2"), "Owen");
    const amy = await e.person(acct("3"), "Amy");
    const now = t0();
    const ramen = await e.add("fact", G1, [owen], "Owen 喜歡拉麵", 0.5, t0(-3 * DAY));
    const cat = await e.add("fact", G1, [amy], "Amy 養了一隻貓", 0.9, t0(-DAY));
    const oldRamen = await e.add("episode", G1, [], "大家去吃拉麵那天下大雨", 0.5, t0(-90 * DAY));
    const newRamen = await e.add("episode", G1, [], "大家又去吃拉麵", 0.5, t0(-DAY));
    const scopes = visibleScopes(guildCtx("g1", "c1"), [acct("2")], [owen]);

    let got = await e.engine.recall(scopes, [owen], "拉麵", PROMPT_KINDS, 8, now);
    const ids = got.map((r) => r.record.id);
    expect(ids[0], "text + subject wins").toBe(ramen);
    expect(ids.indexOf(newRamen), "recency breaks the tie").toBeLessThan(ids.indexOf(oldRamen));
    expect(ids.indexOf(oldRamen)).toBeGreaterThanOrEqual(0);
    expect(ids, "no match and not present").not.toContain(cat);
    for (let i = 1; i < got.length; i++) {
      expect(got[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(got[i]?.score ?? 0);
    }

    // Being about someone present is not enough on its own: "早安" shares nothing with them.
    got = await e.engine.recall(scopes, [owen, amy], "早安", PROMPT_KINDS, 8, now);
    expect(got, "present but unrelated memories are not recalled").toEqual([]);
    // With a word in common they are, and the person who is here ranks first.
    got = await e.engine.recall(scopes, [owen, amy], "你的貓", PROMPT_KINDS, 8, now);
    expect(got.map((r) => r.record.id)).toEqual([cat]);

    // Recalled records are touched; the limit applies.
    got = await e.engine.recall(scopes, [owen], "拉麵", PROMPT_KINDS, 1, now);
    expect(got).toHaveLength(1);
    const touched = await e.rec(ramen);
    expect(touched?.access_count).toBe(2);
    expect(Date.parse(touched?.last_accessed ?? "")).toBe(Date.parse(now));

    // Only the requested kinds come back.
    got = await e.engine.recall(scopes, [owen], "拉麵", ["episode"], 8, now);
    expect(got.every((r) => r.record.kind === "episode")).toBe(true);
  });

  it("vectors_find_matches_without_shared_words", async () => {
    const embedder = new TableEmbedder()
      .with("Owen 喜歡拉麵", [1, 0, 0])
      .with("他愛吃什麼", [0.9, 0.1, 0])
      .with("Amy 討厭下雨", [0, 1, 0]);
    const config = memoryConfig({
      weights: { vector: 1, text: 0, recency: 0, importance: 0, subject: 0 },
      min_score: 0.5,
    });
    const e = await envWith(backend, config, null, embedder);
    const global: MemoryScope = { type: "global" };
    const ramen = await e.add("fact", global, [], "Owen 喜歡拉麵", 0.5, t0());
    await e.add("fact", global, [], "Amy 討厭下雨", 0.5, t0());
    const got = await e.engine.recall([global], [], "他愛吃什麼", PROMPT_KINDS, 8, t0());
    expect(got).toHaveLength(1);
    expect(got[0]?.record.id).toBe(ramen);
    expect(got[0]?.score ?? 0, "cosine ~0.99 scaled by fact confidence").toBeGreaterThan(0.85);
  });

  it("a close vector outranks a record that only shares the words, and a far one is gated", async () => {
    // The trial's failure: cosines sit in a narrow band, so the raw cosine barely moved a record
    // while the record sharing the most words (often about someone else) took the first place.
    const embedder = new TableEmbedder()
      .with("小魚喜歡吃什麼", [1, 0, 0])
      .with("她最愛的食物是拉麵", [0.8, 0.6, 0])
      // Far enough from each other not to be merged as the same memory.
      .with("小魚喜歡打籃球", [0.55, 0, Math.sqrt(1 - 0.55 ** 2)])
      .with("今天的天空很藍", [0.45, -Math.sqrt(1 - 0.45 ** 2), 0]);
    const e = await envWith(backend, memoryConfig(), null, embedder);
    const global: MemoryScope = { type: "global" };
    const ramen = await e.add("self_note", global, [], "她最愛的食物是拉麵", 0.5, t0());
    const ball = await e.add("self_note", global, [], "小魚喜歡打籃球", 0.5, t0());
    const sky = await e.add("self_note", global, [], "今天的天空很藍", 0.5, t0());
    const got = await e.engine.recall([global], [], "小魚喜歡吃什麼", PROMPT_KINDS, 8, t0());
    const ids = got.map((r) => r.record.id);
    // Raw: ramen 0.35·0.80 = 0.28 against ball 0.35·0.55 + 0.25 = 0.44. Spread from the gate
    // (0.5) to the best (0.8): ramen 0.35 against ball 0.35·0.17 + 0.25 = 0.31.
    expect(ids.slice(0, 2)).toEqual([ramen, ball]);
    // No shared word and a cosine under `min_vector` (0.5): not brought up.
    expect(ids).not.toContain(sky);
  });

  it("search_ranks_like_recall_without_touching", async () => {
    const embedder = new TableEmbedder()
      .with("Owen 喜歡拉麵", [1, 0, 0])
      .with("拉麵店開了", [0.8, 0.2, 0])
      .with("提醒 Owen 去吃拉麵", [0.7, 0.3, 0])
      .with("他愛吃什麼", [0.9, 0.1, 0])
      .with("Amy 討厭下雨", [0, 1, 0]);
    const e = await envWith(backend, memoryConfig(), null, embedder);
    const owen = await e.person(acct("2"), "Owen");
    const global: MemoryScope = { type: "global" };
    const ramen = await e.add("fact", global, [owen], "Owen 喜歡拉麵", 0.5, t0());
    const shop = await e.add("episode", G1, [], "拉麵店開了", 0.5, t0());
    const rain = await e.add("fact", global, [], "Amy 討厭下雨", 0.5, t0());
    const followup = await e.add("followup", global, [owen], "提醒 Owen 去吃拉麵", 0.5, t0());
    await e.engine.markDone(followup);

    // Semantic match without shared words; only the given scopes and kinds.
    let got = await e.engine.search([global], "他愛吃什麼", PROMPT_KINDS, 10, t0());
    expect(got[0]?.record.id).toBe(ramen);
    expect(got[0]?.text_score).toBe(0);
    expect(got[0]?.vector_score ?? 0).toBeGreaterThan(0.9);
    expect(got.map((r) => r.record.id)).not.toContain(shop);
    for (let i = 1; i < got.length; i++) {
      expect(got[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(got[i]?.score ?? 0);
    }
    expect(got.at(-1)?.record.id, "least similar last").toBe(rain);

    // Text matches score too; followups already brought up are kept for browsing.
    got = await e.engine.search(
      [global, G1],
      "拉麵",
      ["fact", "episode", "self_note", "followup"],
      10,
      t0(),
    );
    const ids = got.map((r) => r.record.id);
    expect(ids).toEqual(expect.arrayContaining([ramen, shop, followup]));
    expect(got.find((r) => r.record.id === shop)?.text_score ?? 0).toBeGreaterThan(0);
    const recalled = await e.engine.recall([global, G1], [], "拉麵", ["followup"], 10, t0());
    expect(recalled, "recall skips done followups").toEqual([]);

    expect((await e.rec(ramen))?.access_count, "search does not touch").toBe(0);
    expect(await e.engine.search([], "拉麵", PROMPT_KINDS, 10, t0())).toEqual([]);
  });

  it("prompt_lines_have_relative_dates", async () => {
    const e = await env(backend);
    const id = await e.add("fact", { type: "global" }, [], "Owen 喜歡拉麵", 0.5, t0(-3 * DAY));
    const record = await e.rec(id);
    if (!record) throw new Error("missing");
    expect(formatLines([{ record, score: 1 }], t0())).toBe("- Owen 喜歡拉麵(三天前)");
  });

  it("remember_and_recall_tools_respect_scopes", async () => {
    const e = await env(backend);
    const owenAcct = acct("2");
    const owen = await e.person(owenAcct, "Owen");
    const clock = { now: () => T0_MS };
    const remember = new RememberTool(e.engine, clock);
    const recall = new RecallTool(e.engine, clock);
    const dm = toolCtx(dmCtx("d1"), owenAcct);
    const guild = toolCtx(guildCtx("g1", "c1"), owenAcct);

    expect(await remember.call(dm, { content: "Owen 下週三要看牙醫", importance: 0.8 })).toBe(
      "記住了。",
    );
    expect(await remember.call(guild, { content: "Owen 喜歡 Minecraft" })).toBe("記住了。");
    expect(await remember.call(guild, { content: "我答應要學做蛋糕", about: "self" })).toBe(
      "記住了。",
    );
    const again = await remember.call(guild, { content: "Owen 喜歡 Minecraft!" });
    expect(again).toContain("本來就記得");
    await expect(remember.call(guild, {})).rejects.toThrow();

    const records = await e.all();
    const find = (needle: string) => {
      const r = records.find((x) => x.content.includes(needle));
      if (!r) throw new Error(`no ${needle}`);
      return r;
    };
    expect(find("牙醫").scope).toEqual({ type: "dm", account: owenAcct });
    expect(find("牙醫").subjects).toEqual([owen]);
    expect(find("Minecraft").scope).toEqual(G1);
    expect(find("蛋糕").kind).toBe("self_note");
    expect(find("蛋糕").scope).toEqual({ type: "global" });
    // Who said it is recorded, and read back as what they said, not as a fact.
    expect(find("牙醫").source).toEqual({ account: owenAcct, name: "Owen" });

    const inGuild = await recall.call(guild, { query: "牙醫 Minecraft" });
    expect(inGuild).toContain("Minecraft");
    expect(inGuild, "DM note leaked").not.toContain("牙醫");
    const inDm = await recall.call(dm, { query: "牙醫" });
    expect(inDm).toContain("「Owen」說過:Owen 下週三要看牙醫");
    const otherGuild = toolCtx(guildCtx("g2", "c1"), acct("9"));
    expect(await recall.call(otherGuild, { query: "Minecraft 牙醫" })).toBe("想不起來有關的事。");
  });
});

describe("the spread cosine", () => {
  it("runs from the higher of the gate and the farthest neighbour up to the best candidate", () => {
    // A sparse store: its neighbours reach below the gate, so the gate is the floor.
    let spread = spreadCosine(
      [
        [0.8, true],
        [0.2, true],
        [0.6, false],
        [null, false],
      ],
      0.5,
    );
    expect(spread(0.8)).toBe(1);
    expect(spread(0.65)).toBeCloseTo(0.5);
    expect(spread(0.5)).toBe(0);
    expect(spread(0.2)).toBe(0);
    // A crowded one: the farthest of the nearest neighbours is above the gate.
    spread = spreadCosine(
      [
        [0.8, true],
        [0.6, true],
        [0.3, false],
      ],
      0.5,
    );
    expect(spread(0.7)).toBeCloseTo(0.5);
    expect(spread(0.3)).toBe(0);
    // Nothing above the floor (a question nothing answers): the vector adds nothing.
    spread = spreadCosine([[0.45, true]], 0.5);
    expect(spread(0.45)).toBe(0);
    // No store neighbours (vectors computed for text matches only): the gate is the floor.
    spread = spreadCosine([[0.9, false]], 0.5);
    expect(spread(0.7)).toBeCloseTo(0.5);
  });
});

describe("ranking against stored vectors (sqlite store)", () => {
  it("scores_present_peoples_memories_without_decoding_embeddings", async () => {
    const embedder = new TableEmbedder()
      .with("拉麵店開了", [1, 0, 0])
      .with("Owen 喜歡壽司", [0.8, 0.6, 0])
      .with("他愛吃什麼", [1, 0, 0]);
    // One candidate from the search, so Owen's memory comes in through the present-people list
    // and is scored in the engine from its stored vector.
    const config = memoryConfig({ candidate_limit: 1 });
    const e = await envWith("sqlite", config, null, embedder);
    const owen = await e.person(acct("2"), "Owen");
    const global: MemoryScope = { type: "global" };
    await e.add("episode", global, [], "拉麵店開了", 0.5, t0());
    const sushi = await e.add("fact", global, [owen], "Owen 喜歡壽司", 0.5, t0());

    const memories = e.store.memories;
    const listed: MemoryRecord[] = [];
    const list = memories.list.bind(memories);
    memories.list = async (...args) => {
      const records = await list(...args);
      listed.push(...records);
      return records;
    };
    const about = memories.listAbout?.bind(memories);
    expect(about, "the store reads everyone's memories at once").toBeDefined();
    memories.listAbout = async (...args) => {
      const records = (await about?.(...args)) ?? [];
      listed.push(...records);
      return records;
    };
    await e.engine.recall([global], [owen], "他愛吃什麼", PROMPT_KINDS, 1, t0());
    const owens = listed.filter((r) => r.id === sushi);
    expect(owens.length, "Owen's memory was listed").toBeGreaterThan(0);
    for (const record of owens) {
      expect(Object.getOwnPropertyDescriptor(record, "embedding")?.get, "undecoded").toBeDefined();
    }
  });
});

describe("tools", () => {
  it("default to the system clock", async () => {
    const e = await env("fake");
    const remember = new RememberTool(e.engine);
    expect(
      await remember.call(toolCtx(guildCtx("g1", "c1"), acct("2")), { content: "x 喜歡 y" }),
    ).toBe("記住了。");
    const r = (await e.all())[0];
    expect(Math.abs(Date.parse(r?.created_at ?? "") - systemClock.now())).toBeLessThan(60_000);
    expect(remember.spec.name).toBe("remember");
    expect(new RecallTool(e.engine).spec.name).toBe("recall");
  });
});
