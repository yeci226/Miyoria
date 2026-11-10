// Memory and followup freshness (docs/design/v2-architecture.md §1.9 「一直卡在很久以前的事」,
// §3.9): a real minimum score, episodes that fade in days, present people that need a text
// match, present-tense notes that expire, followups that close, and a gag that cannot fill
// every recall.

import { MockProvider } from "@miyoria/llm";
import type { MemoryScope } from "@miyoria/store";
import { newId } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  expired,
  expiryOf,
  MemoryError,
  memoryConfig,
  memoryFilter,
  PROMPT_KINDS,
  RepeatDamper,
  recency,
  recencyTau,
  tokenString,
  visibleScopes,
  wordingTtlHours,
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
  HOUR,
  MINUTE,
  profile,
  t0,
} from "./helpers.js";

const G1: MemoryScope = { type: "guild", platform: "discord", guild: "g1" };
const config = memoryConfig();

afterEach(closeAll);

describe("defaults", () => {
  it("min score is a real threshold and episodes fade in days", () => {
    expect(config.min_score).toBe(0.25);
    expect(config.episode_recency_tau_days).toBeLessThan(config.recency_tau_days);
    const day = recency(t0(-DAY), t0(), recencyTau(config, "episode"));
    const week = recency(t0(-7 * DAY), t0(), recencyTau(config, "episode"));
    expect(day).toBeLessThan(0.6);
    expect(week).toBeLessThan(0.02);
    // A fact of the same age has hardly faded.
    expect(recency(t0(-7 * DAY), t0(), recencyTau(config, "fact"))).toBeGreaterThan(0.55);
  });
});

describe.each(BACKENDS)("recall freshness (%s store)", (backend) => {
  it("a weak match is not recalled any more (min score 0.25)", async () => {
    const e = await env(backend);
    // Shares one of four words, written two weeks ago, unimportant.
    const weak = await e.add(
      "episode",
      G1,
      [],
      "那天大家聊到拉麵還有電影和天氣",
      0.2,
      t0(-14 * DAY),
    );
    const strong = await e.add(
      "fact",
      G1,
      [],
      "拉麵 咖哩 鐵板 燒肉 都是 Owen 愛吃的",
      0.8,
      t0(-HOUR),
    );
    const scopes = visibleScopes(guildCtx("g1", "c1"), [acct("2")], []);
    const got = await e.engine.recall(scopes, [], "拉麵 咖哩 鐵板 燒肉", PROMPT_KINDS, 8, t0());
    const ids = got.map((r) => r.record.id);
    expect(ids).toContain(strong);
    expect(ids).not.toContain(weak);
    for (const r of got) expect(r.score).toBeGreaterThanOrEqual(0.25);
  });

  it("an episode a few days old ranks below a same-age fact and below yesterday's episode", async () => {
    const e = await env(backend);
    const oldEpisode = await e.add(
      "episode",
      G1,
      [],
      "大家一起打 Minecraft 蓋房子",
      0.5,
      t0(-4 * DAY),
    );
    const oldFact = await e.add("fact", G1, [], "Owen 常常打 Minecraft 蓋房子", 0.5, t0(-4 * DAY));
    const newEpisode = await e.add(
      "episode",
      G1,
      [],
      "大家一起打 Minecraft 挖礦",
      0.5,
      t0(-2 * HOUR),
    );
    const scopes = visibleScopes(guildCtx("g1", "c1"), [acct("2")], []);
    const got = await e.engine.recall(scopes, [], "Minecraft", PROMPT_KINDS, 8, t0());
    const ids = got.map((r) => r.record.id);
    expect(ids.indexOf(newEpisode)).toBeLessThan(ids.indexOf(oldFact));
    expect(ids.indexOf(oldFact)).toBeLessThan(
      ids.indexOf(oldEpisode) === -1 ? 99 : ids.indexOf(oldEpisode),
    );
  });

  it("memories about a present person need a text match to be recalled", async () => {
    const e = await env(backend);
    const owen = await e.person(acct("2"), "Owen");
    const unrelated = await e.add("fact", G1, [owen], "Owen 的生日在三月", 0.9, t0(-HOUR));
    const related = await e.add("fact", G1, [owen], "Owen 昨天在打 Minecraft", 0.9, t0(-HOUR));
    const scopes = visibleScopes(guildCtx("g1", "c1"), [acct("2")], [owen]);

    // Everyone who is here, eight slots, none of it about what is being said: nothing.
    expect(await e.engine.recall(scopes, [owen], "晚餐吃什麼", PROMPT_KINDS, 8, t0())).toEqual([]);
    const got = await e.engine.recall(scopes, [owen], "要不要打 Minecraft", PROMPT_KINDS, 8, t0());
    expect(got.map((r) => r.record.id)).toEqual([related]);
    expect(got.map((r) => r.record.id)).not.toContain(unrelated);
  });

  it("a present person's memory is recalled when the embedding is close", async () => {
    const { TableEmbedder } = await import("./helpers.js");
    const embedder = new TableEmbedder()
      .with("Owen 愛吃拉麵", [1, 0, 0])
      .with("他想吃什麼", [0.95, 0.05, 0])
      .with("今天天氣", [0, 1, 0]);
    const e = await envWith(backend, memoryConfig(), null, embedder);
    const owen = await e.person(acct("2"), "Owen");
    const ramen = await e.add("fact", G1, [owen], "Owen 愛吃拉麵", 0.9, t0(-HOUR));
    const scopes = visibleScopes(guildCtx("g1", "c1"), [acct("2")], [owen]);
    const close = await e.engine.recall(scopes, [owen], "他想吃什麼", PROMPT_KINDS, 8, t0());
    expect(close.map((r) => r.record.id)).toEqual([ramen]);
    const far = await e.engine.recall(scopes, [owen], "今天天氣", PROMPT_KINDS, 8, t0());
    expect(far).toEqual([]);
  });
});

describe("expiring state notes", () => {
  it("the wording of a present-tense note gives it a lifetime", () => {
    expect(wordingTtlHours("答應玩 Minecraft 並開直播,已經開台", config)).toBe(12);
    expect(wordingTtlHours("答應唱 Bad Apple,正在下載", config)).toBe(12);
    expect(wordingTtlHours("Owen 今晚要考試", config)).toBe(24);
    expect(wordingTtlHours("Owen 喜歡拉麵", config)).toBeNull();
    expect(wordingTtlHours("我答應 Owen 下次陪他打 Minecraft", config)).toBeNull();
    expect(wordingTtlHours("正在下載", memoryConfig({ state_note_hours: 0 }))).toBeNull();
  });

  it("expiryOf: the summarizer's lifetime wins; episodes and followups never expire this way", () => {
    const now = t0();
    const text = "已經開台";
    expect(Date.parse(expiryOf("self_note", text, null, config, now) ?? "")).toBe(
      Date.parse(now) + 12 * HOUR,
    );
    expect(Date.parse(expiryOf("fact", "Owen 在打 osu", 3, config, now) ?? "")).toBe(
      Date.parse(now) + 3 * HOUR,
    );
    expect(expiryOf("fact", "Owen 喜歡拉麵", null, config, now)).toBeNull();
    expect(expiryOf("episode", text, null, config, now)).toBeNull();
    expect(expiryOf("followup", text, null, config, now)).toBeNull();
    // Absurd lifetimes are capped.
    expect(Date.parse(expiryOf("fact", "x", 1e9, config, now) ?? "")).toBeLessThanOrEqual(
      Date.parse(now) + 90 * DAY,
    );
  });

  it("expired() ignores followups (their due is a start, not an end)", () => {
    const due = t0(-HOUR);
    expect(expired({ kind: "fact", due }, t0())).toBe(true);
    expect(expired({ kind: "fact", due: t0(HOUR) }, t0())).toBe(false);
    expect(expired({ kind: "fact", due: null }, t0())).toBe(false);
    expect(expired({ kind: "followup", due }, t0())).toBe(false);
  });

  it.each(BACKENDS)(
    "present-tense notes never enter memory; a note about tonight is kept and then expires (%s)",
    async (backend) => {
      const json = `{
      "episode": null,
      "facts": [{"subject_name": "Owen", "statement": "Owen 喜歡拉麵", "importance": 0.8, "confidence": 0.9, "global": false}],
      "self_notes": [
        {"note": "答應 Owen 玩 Minecraft 並開直播,已經開台", "importance": 0.8},
        {"note": "Owen 現在在打 osu", "importance": 0.8, "valid_hours": 2},
        {"note": "Owen 今晚要考期末考", "importance": 0.8}
      ],
      "followups": []
    }`;
      const llm = new MockProvider("sum").reply(json);
      const e = await envWith(backend, memoryConfig(), llm, null);
      const owen = await e.person(acct("2"), "Owen");
      const ctx = guildCtx("g1", "c1");
      await e.log(
        ctx,
        acct("2"),
        "Owen",
        "拉麵最好吃,等一下一起打 Minecraft 開直播,我今晚要考期末考,現在在打 osu",
        t0(-5 * MINUTE),
        false,
      );
      const report = await e.engine.consolidate(ctx, t0());
      expect(report.refusedState, JSON.stringify(report)).toBe(2);
      expect(report.inserted).toBe(2);

      const all = await e.all();
      expect(all.some((r) => r.content.includes("開台"))).toBe(false);
      expect(all.some((r) => r.content.includes("osu"))).toBe(false);
      const exam = all.find((r) => r.content.includes("期末考"));
      const ramen = all.find((r) => r.content.includes("拉麵"));
      expect(Date.parse(exam?.due ?? "")).toBe(Date.parse(t0()) + 24 * HOUR);
      expect(ramen?.due).toBeNull();

      const scopes = visibleScopes(ctx, [acct("2")], [owen]);
      const query = "Owen 直播 Minecraft osu 拉麵 期末考";
      const soon = await e.engine.recall(scopes, [owen], query, PROMPT_KINDS, 8, t0(HOUR));
      const soonText = soon.map((r) => r.record.content).join("|");
      expect(soonText).toContain("期末考");
      expect(soonText).toContain("拉麵");
      const later = await e.engine.recall(scopes, [owen], query, PROMPT_KINDS, 8, t0(25 * HOUR));
      const laterText = later.map((r) => r.record.content).join("|");
      expect(laterText).not.toContain("期末考");
      expect(laterText).toContain("拉麵");
    },
  );

  it.each(BACKENDS)(
    "maintenance expires notes written before lifetimes existed (%s)",
    async (backend) => {
      const e = await env(backend);
      // Written by an older build, which kept present-tense states in memory.
      const legacy = async (content: string, at: string) => {
        const id = newId();
        await e.store.memories.upsert({
          id,
          profile: profile(),
          kind: "self_note",
          scope: G1,
          subjects: [],
          content,
          tokens: tokenString(content),
          embedding: null,
          importance: 0.9,
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
        });
        return id;
      };
      const old = await legacy("答應玩 Minecraft 並開直播,已經開台", t0(-3 * DAY));
      const recentNote = await legacy("我正在下載 Bad Apple", t0(-HOUR));
      const lasting = await legacy("我答應下次一起去吃拉麵", t0(-30 * DAY));
      const report = await e.engine.maintain(t0());
      // Three days past its lifetime: still kept a while (a week), but already hidden.
      expect(report.expired).toBe(0);
      expect((await e.rec(old))?.due).not.toBeNull();
      expect(Date.parse((await e.rec(recentNote))?.due ?? "")).toBe(
        Date.parse(t0(-HOUR)) + 12 * HOUR,
      );
      expect((await e.rec(lasting))?.due).toBeNull();
      const scopes = visibleScopes(guildCtx("g1", "c1"), [acct("2")], []);
      const got = await e.engine.recall(scopes, [], "開台 直播 Minecraft", PROMPT_KINDS, 8, t0());
      expect(got).toEqual([]);
      // A week after it stopped being true it is deleted.
      const later = await e.engine.maintain(t0(8 * DAY));
      expect(later.expired).toBeGreaterThanOrEqual(1);
      expect(await e.rec(old)).toBeNull();
      expect(await e.rec(lasting)).not.toBeNull();
    },
  );
});

describe.each(BACKENDS)("followups (%s store)", (backend) => {
  it("closes followups a few hours after their time and offers the newest first", async () => {
    const e = await env(backend);
    const mk = (about: string, dueAt: string) =>
      e.engine.store(
        {
          kind: "followup",
          scope: G1,
          subjects: [],
          content: about,
          importance: 0.5,
          confidence: 1,
          source_context: null,
          origin: "experienced",
          due: dueAt,
        },
        t0(-DAY),
      );
    await mk("問期末考考得怎樣", t0(-30 * HOUR));
    const a = await mk("問週末去哪玩", t0(-5 * HOUR));
    const b = await mk("問新遊戲好不好玩", t0(-HOUR));
    await mk("問明天的計畫", t0(HOUR));
    const ids = (s: { type: string }) => (s as unknown as { id: string }).id;

    const due = await e.engine.due(profile(), t0());
    expect(due.map((f) => f.about)).toEqual(["問新遊戲好不好玩", "問週末去哪玩"]);
    expect(due.map((f) => f.id)).toEqual([ids(b), ids(a)]);

    // The one from 30 hours ago was closed, not just skipped: it never comes back.
    const closed = (await e.all()).find((r) => r.content.includes("期末考"));
    expect(closed?.done).toBe(true);
    // Later the 5-hour-old one has aged out too.
    const later = await e.engine.due(profile(), t0(2 * HOUR));
    expect(later.map((f) => f.about)).toEqual(["問明天的計畫", "問新遊戲好不好玩"]);
  });

  it("followup_max_age_hours = 0 keeps the old behaviour of never closing", async () => {
    const e = await envWith(backend, memoryConfig({ followup_max_age_hours: 0 }), null, null);
    await e.engine.store(
      {
        kind: "followup",
        scope: G1,
        subjects: [],
        content: "問很久以前的事",
        importance: 0.5,
        confidence: 1,
        source_context: null,
        origin: "experienced",
        due: t0(-10 * DAY),
      },
      t0(-11 * DAY),
    );
    expect((await e.engine.due(profile(), t0())).map((f) => f.about)).toEqual(["問很久以前的事"]);
    expect(
      (await e.engine.records.list(profile(), memoryFilter(10, { kind: "followup" })))[0]?.done,
    ).toBe(false);
  });
});

describe("repeated gags", () => {
  const cfg = memoryConfig().repeat;

  it("a thing said more than `allowed` times in the window is down-weighted per extra time", () => {
    const damper = new RepeatDamper(cfg);
    const gag = "白飯 梗 好吃 又來";
    expect(damper.factor(gag)).toBe(1);
    damper.note([gag, gag, gag]);
    expect(damper.factor(gag)).toBe(1); // exactly `allowed`
    damper.note([gag]);
    expect(damper.factor(gag)).toBeCloseTo(1 - cfg.penalty, 5);
    damper.note([gag, gag, gag, gag, gag, gag]);
    expect(damper.factor(gag)).toBe(cfg.floor);
    // Something else is untouched.
    expect(damper.factor("Owen 生日 三月 派對")).toBe(1);
    // Wording that mostly overlaps counts as the same gag.
    expect(damper.factor("白飯 梗 好吃")).toBeLessThan(1);
  });

  it("forgets what fell out of the window, and can be switched off", () => {
    const damper = new RepeatDamper({ ...cfg, window: 5, allowed: 1 });
    damper.note(["白飯 梗 好吃", "白飯 梗 好吃", "白飯 梗 好吃"]);
    expect(damper.factor("白飯 梗 好吃")).toBeLessThan(1);
    damper.note(["a1 b2", "c3 d4", "e5 f6", "g7 h8", "i9 j0"]);
    expect(damper.factor("白飯 梗 好吃")).toBe(1);
    const off = new RepeatDamper({ ...cfg, window: 0 });
    off.note(["白飯 梗", "白飯 梗", "白飯 梗", "白飯 梗", "白飯 梗"]);
    expect(off.factor("白飯 梗")).toBe(1);
  });

  it.each(BACKENDS)(
    "recall scores a gag lower once it filled recent recalls (%s)",
    async (backend) => {
      const e = await envWith(backend, memoryConfig({ min_score: 0.1 }), null, null);
      const gag = await e.add("fact", G1, [], "白飯 梗 大家都愛講白飯", 0.8, t0(-HOUR));
      const scopes = visibleScopes(guildCtx("g1", "c1"), [acct("2")], []);
      const first = await e.engine.recall(scopes, [], "白飯", PROMPT_KINDS, 8, t0());
      expect(first.map((r) => r.record.id)).toEqual([gag]);
      for (let i = 0; i < 8; i++) await e.engine.recall(scopes, [], "白飯", PROMPT_KINDS, 8, t0());
      const later = await e.engine.recall(scopes, [], "白飯", PROMPT_KINDS, 8, t0());
      expect(later[0]?.score ?? 1).toBeLessThan(first[0]?.score ?? 0);
      // Browsing (search) is not affected.
      const searched = await e.engine.search(scopes, "白飯", PROMPT_KINDS, 8, t0());
      expect(searched[0]?.score ?? 0).toBeGreaterThan(later[0]?.score ?? 1);
    },
  );
});

describe("no per-call codes in memories", () => {
  it.each(BACKENDS)("store rewrites or refuses text with u1-style codes (%s)", async (backend) => {
    const e = await env(backend);
    await expect(
      e.engine.store(
        {
          kind: "fact",
          scope: G1,
          subjects: [],
          content: "u7 一直嗆我",
          importance: 0.5,
          confidence: 0.8,
          source_context: null,
          origin: "experienced",
          due: null,
        },
        t0(),
      ),
    ).rejects.toThrow(MemoryError);
    const id = await e.add("fact", G1, [], "御坂(u1)喜歡下雨天", 0.5, t0());
    expect((await e.rec(id))?.content).toBe("御坂喜歡下雨天");
  });

  it("consolidation skips an extracted fact that only says a code, and keeps the rest", async () => {
    const json = `{
      "episode": null,
      "facts": [
        {"subject_name": "Owen", "statement": "u3 喜歡吃拉麵", "importance": 0.8, "confidence": 0.9},
        {"subject_name": "Owen", "statement": "Owen 喜歡吃拉麵", "importance": 0.8, "confidence": 0.9}
      ],
      "self_notes": [], "followups": []
    }`;
    const e = await envWith("fake", memoryConfig(), new MockProvider("sum").reply(json), null);
    await e.person(acct("2"), "Owen");
    const ctx = dmCtx("d1");
    await e.log(ctx, acct("2"), "Owen", "我喜歡拉麵", t0(-MINUTE), false);
    const report = await e.engine.consolidate(ctx, t0());
    expect(report.inserted).toBe(1);
    expect(report.skipped).toBeGreaterThanOrEqual(1);
    expect((await e.all()).map((r) => r.content)).toEqual(["Owen 喜歡吃拉麵"]);
  });
});
