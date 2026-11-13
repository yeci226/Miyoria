// Consolidation with a scripted summarizer, dedupe and forgetting (Rust `tests/consolidation.rs`).

import { contextHash, MockProvider } from "@miyoria/llm";
import type { MemoryRecord, MemoryScope } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  type FollowupSource,
  newId,
  type PersonId,
  type PromptRequest,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  fadedConfidence,
  MemoryContributor,
  memoryConfig,
  memoryFilter,
  PROMPT_KINDS,
  requestScopes,
  rescoped,
  SECTION_TITLE,
  visibleScopes,
  WATERMARK_PREFIX,
} from "../src/index.js";
import {
  acct,
  BACKENDS,
  type Backend,
  closeAll,
  DAY,
  dmCtx,
  type Env,
  env,
  envWith,
  guildCtx,
  HOUR,
  MINUTE,
  plus,
  profile,
  SECOND,
  TableEmbedder,
  t0,
} from "./helpers.js";
import { FakeHandles } from "./recent-helpers.js";

const GUILD_JSON = `{
  "episode": {"summary": "我跟 Owen、Amy 聊了拉麵,Owen 推薦了一家豚骨拉麵店", "importance": 0.6, "emotion": "開心"},
  "facts": [
    {"subject_name": "Owen", "statement": "Owen 最喜歡豚骨拉麵", "importance": 0.7, "confidence": 0.9, "global": false},
    {"subject_name": "Owen", "statement": "Owen 希望我叫他歐文", "importance": 0.9, "confidence": 1.0, "global": true},
    {"subject_name": "self", "statement": "我沒吃過拉麵", "importance": 0.5, "confidence": 1.0, "global": false},
    {"subject_name": "Amy", "statement": "Amy 不吃辣", "importance": 0.05, "confidence": 1.0, "global": false}
  ],
  "self_notes": ["我答應 Amy 下次一起去吃拉麵"],
  "followups": [{"subject_name": "Owen", "about": "問 Owen 期末考考得怎樣", "due_in_hours": 24}]
}`;

const G1: MemoryScope = { type: "guild", platform: "discord", guild: "g1" };

async function guildSetup(
  backend: Backend,
  llm: MockProvider,
  handles: FakeHandles | null = null,
): Promise<[Env, ContextKey, PersonId, PersonId]> {
  const e = await envWith(backend, memoryConfig(), llm, null, handles);
  const owen = await e.person(acct("2"), "Owen");
  const amy = await e.person(acct("3"), "Amy");
  const ctx = guildCtx("g1", "c1");
  const t = t0(-10 * MINUTE);
  await e.log(ctx, acct("2"), "Owen", "我最喜歡豚骨拉麵!叫我歐文就好", t, false);
  await e.log(ctx, acct("3"), "Amy", "我不吃辣喔", plus(t, 5 * SECOND), false);
  await e.log(ctx, acct("1"), "DeepSeek-chan", "好啦好啦,下次一起去", plus(t, 9 * SECOND), true);
  return [e, ctx, owen, amy];
}

function find(records: MemoryRecord[], needle: string): MemoryRecord {
  const r = records.find((x) => x.content.includes(needle));
  if (!r) throw new Error(`no record with ${needle}: ${JSON.stringify(records, null, 2)}`);
  return r;
}

afterEach(closeAll);

describe.each(BACKENDS)("consolidation (%s store)", (backend) => {
  it("consolidates_guild_conversation", async () => {
    const llm = new MockProvider("sum").reply(GUILD_JSON);
    const [e, ctx, owen, amy] = await guildSetup(backend, llm);
    const now = t0();
    const report = await e.engine.consolidate(ctx, now);
    expect(report.lines).toBe(3);
    expect(report.malformed).toBe(false);
    expect(report.inserted, JSON.stringify(report)).toBe(6);
    expect(report.skipped, "trivial Amy fact dropped").toBe(1);

    // The summarizer was asked for JSON with her lines labelled 「我」.
    const reqs = llm.requests();
    expect(reqs).toHaveLength(1);
    const req = reqs[0];
    if (!req) throw new Error("no request");
    expect(req.json_mode).toBe(true);
    const session = req.session ?? "";
    expect(session).toBe(`miyoria-deepseek-chan-memory-${contextHash(ctx)}`);
    expect(session).not.toContain("g1");
    const user = req.messages[1]?.content ?? "";
    expect(user).toContain("我: 好啦好啦,下次一起去");
    expect(user).toContain("Owen: 我最喜歡豚骨拉麵");
    expect(req.messages[0]?.content).toContain("第一人稱");

    const records = await e.all();
    const ep = find(records, "聊了拉麵");
    expect(ep.kind).toBe("episode");
    expect(ep.scope).toEqual(G1);
    expect(ep.content).toContain("開心");
    expect([...ep.subjects].sort()).toEqual([owen, amy].sort());

    const likes = find(records, "最喜歡豚骨拉麵");
    expect(likes.kind).toBe("fact");
    expect([likes.scope, likes.subjects]).toEqual([G1, [owen]]);

    const name = find(records, "歐文");
    expect(name.scope).toEqual({ type: "person", person: owen });

    const me = find(records, "沒吃過拉麵");
    expect([me.kind, me.scope]).toEqual(["self_note", { type: "global" }]);
    expect(me.subjects).toEqual([]);

    const promise = find(records, "答應 Amy");
    expect(promise.kind).toBe("self_note");
    expect(promise.subjects, "names in notes become subjects").toEqual([amy]);
    expect(promise.scope, "a note about one person alone is theirs").toEqual({
      type: "person",
      person: amy,
    });

    const followup = find(records, "期末考");
    expect(followup.kind).toBe("followup");
    expect(Date.parse(followup.due ?? "")).toBe(Date.parse(plus(now, 24 * HOUR)));
    expect(followup.source_context).toEqual(ctx);
    expect(records.some((r) => r.content.includes("不吃辣"))).toBe(false);

    // The watermark is persisted; nothing new means no LLM call.
    const key = `${WATERMARK_PREFIX}discord:g1:c1`;
    expect(await e.setting(key)).not.toBeNull();
    expect(await e.engine.watermarkedContexts()).toEqual([ctx]);
    const again = await e.engine.consolidate(ctx, now);
    expect(again.lines).toBe(0);
    expect(llm.requests()).toHaveLength(1);

    // New lines only: the summarizer sees just the new one.
    await e.log(ctx, acct("2"), "Owen", "我明天要考期末考", plus(now, SECOND), false);
    await e.log(ctx, acct("3"), "Amy", "加油", plus(now, 2 * SECOND), false);
    const third = await e.engine.consolidate(ctx, plus(now, MINUTE));
    expect(third.lines).toBe(2);
    const user2 = llm.requests()[1]?.messages[1]?.content ?? "";
    expect(user2).toContain("期末考");
    expect(user2).not.toContain("不吃辣");
    // Same JSON again: what the new lines still back is reinforced, nothing is duplicated, and
    // the facts and notes none of the new lines say are refused as unevidenced.
    expect(third.inserted, JSON.stringify(third)).toBe(0);
    expect(third.reinforced).toBe(2);
    expect(third.refusedEvidence).toBe(4);
    expect(await e.all()).toHaveLength(records.length);
  });

  // 2026-11-09: a note written in the server about a card someone posted there was global, so in
  // another person's DM she thanked that person for it.
  it("server_notes_about_others_never_reach_a_dm", async () => {
    const json = `{
      "self_notes": [
        {"note": "我答應 Amy 下次一起去吃拉麵", "importance": 0.8},
        {"note": "我答應 Amy 和 Owen 下次一起去吃拉麵", "importance": 0.8},
        {"note": "有人幫我做了一張拉麵卡片", "importance": 0.8},
        {"note": "我沒吃過拉麵", "importance": 0.8}
      ]
    }`;
    const llm = new MockProvider("sum").reply(json);
    const handles = new FakeHandles();
    const [e, ctx, owen, amy] = await guildSetup(backend, llm, handles);
    const cara = await e.person(acct("4"), "Cara");
    handles.add("Owen", owen, acct("2")).add("Amy", amy, acct("3")).add("Cara", cara, acct("4"));
    await e.log(
      ctx,
      acct("3"),
      "Amy",
      "我做了一張拉麵卡片給你,下次和 Owen 一起去吃",
      t0(-MINUTE),
      false,
    );
    await e.engine.consolidate(ctx, t0());
    const records = await e.all();
    const amyOnly = find(records, "答應 Amy 下次");
    expect([amyOnly.scope, amyOnly.subjects], "about Amy alone").toEqual([
      { type: "person", person: amy },
      [amy],
    ]);
    expect(find(records, "Amy 和 Owen").scope, "about two people").toEqual(G1);
    expect(find(records, "有人幫我").scope, "someone, unnamed, is still someone").toEqual(G1);
    expect(find(records, "沒吃過拉麵").scope, "about her alone").toEqual({ type: "global" });

    const dmOf = (n: string, person: PersonId) => ({
      scopes: visibleScopes(dmCtx(`d-${n}`), [acct(n)], [person]),
      person,
    });
    const recallIn = async (dm: ReturnType<typeof dmOf>) =>
      (await e.engine.recall(dm.scopes, [dm.person], "拉麵", PROMPT_KINDS, 20, t0())).map(
        (r) => r.record.content,
      );
    const owenDm = dmOf("2", owen);
    const amyDm = dmOf("3", amy);
    const caraDm = dmOf("4", cara);
    const shows = (got: string[], note: string) => got.some((c) => c.includes(note));

    // Written now: the note about Amy alone comes back in her DM, not in anyone else's.
    expect(shows(await recallIn(amyDm), "答應 Amy 下次")).toBe(true);
    for (const dm of [owenDm, caraDm]) {
      const got = await recallIn(dm);
      expect(shows(got, "我沒吃過拉麵"), "about her alone, everywhere").toBe(true);
      expect(shows(got, "答應 Amy 下次")).toBe(false);
    }
    for (const dm of [owenDm, amyDm, caraDm]) {
      const got = await recallIn(dm);
      for (const leak of ["Amy 和 Owen", "有人幫我"]) expect(shows(got, leak), leak).toBe(false);
    }

    // Written before this, still global, then moved: they read the same before and after.
    const old = async (content: string, subjects: PersonId[]) =>
      e.engine.store(
        {
          kind: "self_note",
          scope: { type: "global" },
          subjects,
          content,
          importance: 0.8,
          confidence: 1,
          source_context: ctx,
          origin: "experienced",
          source_events: [],
          due: null,
        },
        t0(-HOUR),
      );
    await old("我懷疑 Amy 的拉麵是泡麵", [amy]);
    await old("我說過 Owen 的拉麵最好吃", []);
    await old("我說 Owen 和 Amy 的拉麵一樣難吃", [owen, amy]);
    await old("我收下了大家送的拉麵貼圖", []);
    await old("我收藏了一個拉麵碗", []);
    const expected = (got: string[]) => ({
      amy: shows(got, "Amy 的拉麵是泡麵"),
      owen: shows(got, "Owen 的拉麵最好吃"),
      both: shows(got, "一樣難吃"),
      everyone: shows(got, "大家送的"),
      self: shows(got, "拉麵碗"),
    });
    const before = {
      owen: expected(await recallIn(owenDm)),
      amy: expected(await recallIn(amyDm)),
      cara: expected(await recallIn(caraDm)),
    };
    expect(before).toEqual({
      owen: { amy: false, owen: true, both: false, everyone: false, self: true },
      amy: { amy: true, owen: false, both: false, everyone: false, self: true },
      cara: { amy: false, owen: false, both: false, everyone: false, self: true },
    });

    // The migration (scripts/rescope-self-notes.ts) moves them by `rescoped`.
    const names = [
      { name: "Owen", person: owen },
      { name: "Amy", person: amy },
      { name: "Cara", person: cara },
    ];
    for (const record of await e.all()) {
      if (record.kind !== "self_note" || record.scope.type !== "global") continue;
      const to = rescoped(e.engine.config, record, names);
      if (to !== null) await e.engine.records.upsert({ ...record, ...to });
    }
    const moved = await e.all();
    expect(find(moved, "Owen 的拉麵最好吃").scope).toEqual({ type: "person", person: owen });
    expect(find(moved, "Owen 的拉麵最好吃").subjects, "named only, now tagged").toEqual([owen]);
    expect(find(moved, "一樣難吃").scope).toEqual(G1);
    expect(find(moved, "大家送的").scope).toEqual(G1);
    expect(find(moved, "拉麵碗").scope).toEqual({ type: "global" });
    expect({
      owen: expected(await recallIn(owenDm)),
      amy: expected(await recallIn(amyDm)),
      cara: expected(await recallIn(caraDm)),
    }).toEqual(before);

    // In the server, with both there, they are all there.
    const here = visibleScopes(ctx, [acct("2"), acct("3")], [owen, amy]);
    const all = (await e.engine.recall(here, [owen, amy], "拉麵", PROMPT_KINDS, 30, t0())).map(
      (r) => r.record.content,
    );
    for (const note of ["答應 Amy 下次", "Amy 和 Owen", "有人幫我", "Amy 的拉麵", "一樣難吃"]) {
      expect(shows(all, note), note).toBe(true);
    }

    // Another server, with both there too: none of g1's notes about anyone. A note about Amy is
    // hers in g1 and in her DM, never in a server it was not written in.
    const g2 = visibleScopes(guildCtx("g2", "c9"), [acct("2"), acct("3")], [owen, amy]);
    const elsewhere = (await e.engine.recall(g2, [owen, amy], "拉麵", PROMPT_KINDS, 30, t0())).map(
      (r) => r.record.content,
    );
    for (const note of [
      "答應 Amy 下次",
      "Amy 的拉麵",
      "Owen 的拉麵最好吃",
      "Amy 和 Owen",
      "有人幫我",
      "一樣難吃",
    ]) {
      expect(shows(elsewhere, note), note).toBe(false);
    }
  });

  it("an old global note about someone stays in its server before it is moved too", async () => {
    const e = await env(backend);
    const amy = await e.person(acct("3"), "Amy");
    const ctx = guildCtx("g1", "c1");
    await e.engine.store(
      {
        kind: "self_note",
        scope: { type: "global" },
        subjects: [amy],
        content: "我懷疑 Amy 的拉麵是泡麵",
        importance: 0.8,
        confidence: 1,
        source_context: ctx,
        origin: "experienced",
        source_events: [],
        due: null,
      },
      t0(-HOUR),
    );
    const recallIn = async (where: ContextKey, n: string) =>
      (
        await e.engine.recall(
          visibleScopes(where, [acct(n)], [amy]),
          [amy],
          "拉麵",
          PROMPT_KINDS,
          5,
          t0(),
        )
      ).length;
    expect(await recallIn(ctx, "3"), "its server").toBe(1);
    expect(await recallIn(dmCtx("d-amy"), "3"), "her DM").toBe(1);
    expect(await recallIn(guildCtx("g2", "c9"), "3"), "another server").toBe(0);
  });

  it("followups_are_due_and_can_be_marked_done", async () => {
    const llm = new MockProvider("sum").reply(GUILD_JSON);
    const [e, ctx, owen] = await guildSetup(backend, llm);
    await e.engine.consolidate(ctx, t0());
    const source: FollowupSource = e.engine;
    expect(await source.due(profile(), t0())).toEqual([]);
    const due = await source.due(profile(), t0(25 * HOUR));
    expect(due).toHaveLength(1);
    const first = due[0];
    if (!first) throw new Error("no followup");
    expect(first.person).toBe(owen);
    expect(first.context).toEqual(ctx);
    expect(first.about).toContain("期末考");
    await source.markDone(first.id);
    expect(await source.due(profile(), t0(3 * DAY))).toEqual([]);
    await expect(source.markDone("not-an-id")).rejects.toThrow();
    await expect(source.markDone(newId())).rejects.toThrow();
  });

  it("dm_memories_never_surface_elsewhere", async () => {
    const json = `{
      "episode": {"summary": "Owen 私下跟我說他暗戀 Amy", "importance": 0.9, "emotion": "緊張"},
      "facts": [
        {"subject_name": "Owen", "statement": "Owen 暗戀 Amy", "importance": 0.9, "confidence": 0.9, "global": false},
        {"subject_name": "Owen", "statement": "Owen 的本名是劉歐文", "importance": 0.9, "confidence": 1.0, "global": true}
      ],
      "self_notes": [{"note": "我答應 Owen 幫他保守暗戀 Amy 的秘密", "importance": 0.9}],
      "followups": [{"subject_name": "Owen", "about": "問 Owen 有沒有跟 Amy 告白", "due_in_hours": 1}]
    }`;
    const llm = new MockProvider("sum").reply(json);
    const e = await envWith(backend, memoryConfig(), llm, null);
    const owenAcct = acct("2");
    const owen = await e.person(owenAcct, "Owen");
    const amyAcct = acct("3");
    const amy = await e.person(amyAcct, "Amy");
    const dm = dmCtx("d-owen");
    await e.log(dm, owenAcct, "Owen", "跟你說個秘密,我暗戀 Amy", t0(-5 * MINUTE), false);
    await e.log(dm, owenAcct, "Owen", "我的本名是劉歐文", t0(-4 * MINUTE), false);
    const report = await e.engine.consolidate(dm, t0());
    expect(report.inserted).toBe(5);
    const dmScope: MemoryScope = { type: "dm", account: owenAcct };
    expect((await e.all()).every((r) => JSON.stringify(r.scope) === JSON.stringify(dmScope))).toBe(
      true,
    );

    const query = "Owen Amy 暗戀 秘密 告白 本名 劉歐文";
    const present = [owen, amy];
    for (const ctx of [guildCtx("g1", "c1"), guildCtx("g2", "c9"), dmCtx("d-amy")]) {
      const accounts: AccountRef[] = ctx.kind === "dm" ? [amyAcct] : [owenAcct, amyAcct];
      const scopes = visibleScopes(ctx, accounts, present);
      const got = await e.engine.recall(scopes, present, query, PROMPT_KINDS, 20, t0());
      expect(got, JSON.stringify(ctx)).toEqual([]);
    }
    // Followups from the DM point back to the DM.
    const due = await e.engine.due(profile(), t0(90 * MINUTE));
    expect(due[0]?.context).toEqual(dm);

    // In the DM itself she remembers everything.
    const scopes = visibleScopes(dm, [owenAcct], [owen]);
    const got = await e.engine.recall(scopes, [owen], query, PROMPT_KINDS, 20, t0());
    expect(got).toHaveLength(4);

    // The prompt contributor in a guild channel with both present adds nothing.
    const contributor = new MemoryContributor(e.engine);
    const request: PromptRequest = {
      profile: profile(),
      turn: newId(),
      context: guildCtx("g1", "c1"),
      participants: [
        { account: owenAcct, display_name: "Owen", person: owen },
        { account: amyAcct, display_name: "Amy", person: amy },
      ],
      speakers: [owenAcct],
      query,
      recent: [],
      voice: false,
      now: t0(),
    };
    expect(requestScopes(request).every((s) => s.type !== "dm")).toBe(true);
    expect(await contributor.contribute(request)).toEqual([]);

    // Same request in the DM: the section is there.
    const inDm: PromptRequest = {
      ...request,
      context: dm,
      participants: request.participants.slice(0, 1),
    };
    const sections = await contributor.contribute(inDm);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe(SECTION_TITLE);
    expect(sections[0]?.body).toContain("暗戀");
  });

  it("malformed_output_is_retried_then_carried_once_then_skipped", async () => {
    const bad = "抱歉,我無法完成這個請求。";
    const llm = new MockProvider("sum")
      .reply(bad)
      .reply(bad) // pass 1 and its retry: carried over
      .reply(bad)
      .reply(bad) // pass 2 and its retry: dropped
      .reply(
        `{"facts": [42, {"subject_name": "Owen"}, {"subject_name": "Owen", "statement": "Owen 養了一隻貓", "importance": 0.6}], "episode": 5}`,
      );
    const e = await envWith(backend, memoryConfig(), llm, null);
    await e.person(acct("2"), "Owen");
    const ctx = guildCtx("g1", "c1");
    await e.log(ctx, acct("2"), "Owen", "嗨", t0(-9 * MINUTE), false);
    let report = await e.engine.consolidate(ctx, t0());
    expect(report.malformed).toBe(true);
    expect(await e.all()).toEqual([]);
    expect(llm.requests()).toHaveLength(2);
    // Carried over: the watermark stayed, so the same line is offered again with the next batch.
    expect(await e.engine.watermark(ctx)).toBeNull();

    await e.log(ctx, acct("2"), "Owen", "你好嗎", t0(-8 * MINUTE), false);
    report = await e.engine.consolidate(ctx, t0());
    expect([report.lines, report.malformed]).toEqual([2, true]);
    const carriedPrompt = llm.requests()[2]?.messages[1]?.content ?? "";
    expect(carriedPrompt).toContain("嗨");
    expect(carriedPrompt).toContain("你好嗎");
    // Failed again: skipped now, so a bad batch cannot grow forever.
    expect(await e.engine.watermark(ctx)).not.toBeNull();
    expect((await e.engine.consolidate(ctx, t0())).lines).toBe(0);

    await e.log(ctx, acct("2"), "Owen", "我家有貓", t0(), false);
    report = await e.engine.consolidate(ctx, t0());
    expect(report.malformed).toBe(false);
    expect([report.inserted, report.skipped], JSON.stringify(report)).toEqual([1, 3]);
    expect(llm.requests()).toHaveLength(5);
  });

  it("bad_first_reply_is_repaired_by_one_corrective_retry", async () => {
    const llm = new MockProvider("sum").reply("我整理好了,但不知道怎麼寫").reply(GUILD_JSON);
    const [e, ctx] = await guildSetup(backend, llm);
    const report = await e.engine.consolidate(ctx, t0());
    expect(report.malformed).toBe(false);
    expect(report.inserted).toBe(6);
    const reqs = llm.requests();
    expect(reqs).toHaveLength(2);
    const retry = reqs[1];
    expect(retry?.json_mode).toBe(true);
    expect(retry?.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(retry?.messages[3]?.content).toContain("JSON");
    expect(await e.engine.watermark(ctx)).not.toBeNull();
  });

  it("truncated_reply_is_retried_with_a_bigger_budget", async () => {
    const llm = new MockProvider("sum")
      .events([
        { type: "text_delta", text: `{"facts": [{"subject_name": "Owen", "stat` },
        { type: "done", finish_reason: "length", usage: null },
      ])
      .reply(GUILD_JSON);
    const [e, ctx] = await guildSetup(backend, llm);
    const report = await e.engine.consolidate(ctx, t0());
    expect(report.malformed).toBe(false);
    const reqs = llm.requests();
    expect(reqs[1]?.max_tokens).toBe(8000);
  });

  it("parseable_fenced_reply_needs_no_retry", async () => {
    const fenced = `好的:
\`\`\`json
${GUILD_JSON.replace(/\}$/, ",}")}
\`\`\``;
    const llm = new MockProvider("sum").reply(fenced);
    const [e, ctx] = await guildSetup(backend, llm);
    const report = await e.engine.consolidate(ctx, t0());
    expect(report.malformed).toBe(false);
    expect(llm.requests()).toHaveLength(1);
  });

  it("llm_failure_keeps_lines_for_retry", async () => {
    const llm = new MockProvider("sum").fail("down");
    const e = await envWith(backend, memoryConfig(), llm, null);
    const ctx = guildCtx("g1", "c1");
    await e.log(ctx, acct("2"), "Owen", "記得我喜歡貓", t0(), false);
    await expect(e.engine.consolidate(ctx, t0())).rejects.toThrow();
    expect(await e.engine.watermark(ctx)).toBeNull();

    // Only her own lines: nothing to ask, watermark advances.
    const quiet = guildCtx("g1", "c2");
    await e.log(quiet, acct("1"), "me", "有人嗎", t0(), true);
    expect((await e.engine.consolidate(quiet, t0())).lines).toBe(1);
    expect(await e.engine.watermark(quiet)).not.toBeNull();

    const none = await env(backend);
    await expect(none.engine.consolidate(ctx, t0()), "no router").rejects.toThrow();
  });

  it("dedupe_reinforces_and_supersedes", async () => {
    const oldText = "Owen 喜歡拉麵";
    const newText = "Owen 現在比較喜歡沾麵";
    const embedder = new TableEmbedder()
      .with(oldText, [1, 0, 0])
      .with("owen 喜歡拉麵!", [1, 0, 0])
      .with(newText, [0.95, 0.31, 0])
      .with("Owen 討厭下雨", [0, 1, 0]);
    const e = await envWith(backend, memoryConfig(), null, embedder);
    const owen = await e.person(acct("2"), "Owen");
    const first = await e.add("fact", G1, [owen], oldText, 0.5, t0());
    const before = await e.rec(first);

    // Near-identical text: reinforced in place.
    const again = await e.engine.store(
      {
        kind: "fact",
        scope: G1,
        subjects: [owen],
        content: "owen 喜歡拉麵!",
        importance: 0.7,
        confidence: 0.6,
        source_context: null,
        origin: "told",
        source_events: ["01TESTEVIDENCE0000000000"],
        due: null,
      },
      t0(DAY),
    );
    expect(again).toEqual({ type: "reinforced", id: first });
    const after = await e.rec(first);
    expect(after?.confidence ?? 0).toBeGreaterThan(before?.confidence ?? 1);
    expect(Math.abs((after?.importance ?? 0) - 0.7)).toBeLessThan(1e-6);
    expect(Date.parse(after?.updated_at ?? "")).toBe(Date.parse(t0(DAY)));

    // Similar by vector: the new one supersedes the old one.
    const next = await e.engine.store(
      {
        kind: "fact",
        scope: G1,
        subjects: [owen],
        content: newText,
        importance: 0.5,
        confidence: 0.8,
        source_context: null,
        origin: "told",
        source_events: ["01TESTEVIDENCE0000000000"],
        due: null,
      },
      t0(2 * DAY),
    );
    if (next.type !== "superseded") throw new Error(`expected supersede, got ${next.type}`);
    expect(next.old).toBe(first);
    const oldRec = await e.rec(next.old);
    expect(oldRec?.superseded_by).toBe(next.new);
    const live = await e.all();
    expect(live).toHaveLength(1);
    expect(live[0]?.content).toBe(newText);
    expect(live[0]?.confidence ?? 0).toBeGreaterThanOrEqual(after?.confidence ?? 1);

    // Different subject, scope or meaning: a separate record.
    await e.add("fact", G1, [], newText, 0.5, t0());
    await e.add("fact", { type: "global" }, [owen], newText, 0.5, t0());
    await e.add("fact", G1, [owen], "Owen 討厭下雨", 0.5, t0());
    expect(await e.all()).toHaveLength(4);
  });

  it("maintenance_prunes_and_forgets_what_faded", async () => {
    const e = await env(backend);
    const owen = await e.person(acct("2"), "Owen");
    const now = t0();
    const old = t0(-60 * DAY);
    const global: MemoryScope = { type: "global" };
    const trivial = await e.add("episode", global, [], "我們聊了天氣", 0.1, old);
    const important = await e.add("episode", global, [], "Owen 生日派對", 0.9, old);
    const stale = await e.add("fact", global, [owen], "Owen 住台北", 0.5, old);
    const fresh = await e.add("fact", global, [owen], "Owen 養貓", 0.5, t0(-DAY));
    const staleRec = await e.rec(stale);
    if (!staleRec) throw new Error("missing");
    const faint: MemoryRecord = {
      ...staleRec,
      id: newId(),
      content: "Owen 好像會彈吉他",
      confidence: 0.1,
    };
    await e.store.memories.upsert(faint);

    const report = await e.engine.maintain(now);
    expect(report.pruned).toBe(1);
    expect(report.decayed, "still fading, not rewritten").toBe(1);
    expect(report.forgotten).toBe(1);
    expect(await e.rec(trivial)).toBeNull();
    expect(await e.rec(important)).not.toBeNull();
    expect(await e.rec(faint.id)).toBeNull();

    // Decay happens on read: the stored value is what was last written ...
    expect((await e.rec(stale))?.confidence).toBeCloseTo(0.8, 6);
    // ... and the confidence she trusts it with fades 2% a day after 30 idle days.
    const config = memoryConfig();
    const kept = (await e.rec(stale)) as MemoryRecord;
    expect(fadedConfidence(config, kept, now)).toBeCloseTo(0.8 * 0.98 ** 30, 4);
    expect(fadedConfidence(config, kept, t0(10 * DAY))).toBeCloseTo(0.8 * 0.98 ** 40, 4);
    expect(fadedConfidence(config, (await e.rec(fresh)) as MemoryRecord, now)).toBeCloseTo(0.8, 6);
    expect(await e.engine.lastMaintenanceRun()).toBe(now);

    // Past the point where it fades below the threshold, maintenance deletes it.
    await e.engine.maintain(t0(120 * DAY));
    expect(await e.rec(stale)).toBeNull();
    const listed = await e.store.memories.list(profile(), memoryFilter(10, { kind: "episode" }));
    expect(listed).toHaveLength(1);
  });
});
