import {
  type ArgValue,
  CommandRegistry,
  CommandRegistryKey,
  type InvocationData,
  Permissions,
} from "@miyoria/commands";
import {
  defineManifest,
  EventBus,
  type Module,
  type ModuleContext,
  ServiceRegistry,
  Supervisor,
  withTimeout,
} from "@miyoria/kernel";
import { LlmRouterKey, MockProvider } from "@miyoria/llm";
import {
  IdentityStoreKey,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  PeopleStoreKey,
  type Relationship,
  RelationshipStoreKey,
  SqliteStore,
} from "@miyoria/store";
import {
  type Event,
  type Mind,
  MindKey,
  MoodSignalsKey,
  newId,
  PromptContributors,
  PromptContributorsKey,
  type SelfState,
  SelfStateKey,
  SOCIAL_APPRAISAL_TOPIC,
  SocialSignalsKey,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  baseChange,
  DayLedger,
  FLIRT_FREE_AFFINITY,
  familiarityChange,
  flirtWeight,
  label,
  lineDepth,
  localDay,
  MoodModule,
  mergeInto,
  registerCommands,
  SocialConfigSchema,
  SocialKey,
  SocialModule,
  socialConfig,
  stripTags,
} from "../src/index.js";
import {
  acc,
  channel,
  close,
  dm,
  FakeStore,
  Harness,
  MINUTE,
  profile,
  router,
  t,
} from "./helpers.js";

describe("social engine", () => {
  it("ledger_caps_and_diminishing_returns", () => {
    const config = socialConfig();
    let l = new DayLedger(localDay(t(1, 12), config));
    expect(l.take("gift", baseChange("gift", 1), config)).toEqual([3, 1]);
    expect(l.take("gift", baseChange("gift", 1), config)).toEqual([1.5, 0.5]);
    const [a0] = l.take("praise", baseChange("praise", 1), config);
    expect(close(a0, 1.5)).toBe(true);
    l.take("thanks", baseChange("thanks", 1), config);
    l.take("apology", baseChange("apology", 1), config);
    expect(close(l.affinity_gained, 8)).toBe(true);
    const [a1, tr1] = l.take("friendly", baseChange("friendly", 1), config);
    expect(close(a1, 0), "affinity cap reached").toBe(true);
    expect(tr1 > 0, "trust cap not reached yet").toBe(true);

    // Losses have their own budget.
    l = new DayLedger(localDay(t(1, 12), config));
    const h = baseChange("harassment", 1);
    expect(l.take("harassment", h, config)).toEqual([-5, -3]);
    expect(l.take("harassment", h, config)).toEqual([-2.5, -1.5]);
    const [a2, tr2] = l.take("insult", baseChange("insult", 1), config);
    expect(close(a2, -0.5) && close(tr2, -0.5), `${a2} ${tr2}`).toBe(true);
  });

  it("labels", () => {
    const r: Relationship = {
      profile: profile(),
      person: "p",
      affinity: 0,
      trust: 10,
      familiarity: 0,
      tags: [],
      notes: "",
      call_name: null,
      interactions: 0,
      last_interaction: null,
      updated_at: new Date().toISOString(),
    };
    const check = (a: number, f: number, want: string) => {
      r.affinity = a;
      r.familiarity = f;
      expect(label(r), `affinity ${a} familiarity ${f}`).toBe(want);
    };
    check(0, 0, "陌生人");
    check(5, 5, "認識");
    check(20, 1, "朋友");
    check(50, 20, "好朋友");
    check(50, 5, "朋友");
    check(80, 40, "摯友");
    check(80, 20, "好朋友");
    check(-20, 50, "討厭");
    check(-60, 50, "很討厭");
  });

  it("familiarity grows with how much and how deeply people talk, and decays without contact", () => {
    const c = socialConfig();
    // Every line counts (not +1 a day), by its depth, slowing toward 100.
    expect(close(familiarityChange(null, t(1, 12), c), 0.15)).toBe(true);
    expect(close(familiarityChange(t(1, 9), t(1, 23), c, 0, 1), 0.15)).toBe(true);
    expect(close(familiarityChange(t(1, 9), t(1, 23), c, 0, 3), 0.45)).toBe(true);
    expect(close(familiarityChange(t(1, 9), t(1, 23), c, 50, 1), 0.075)).toBe(true);
    expect(familiarityChange(t(1, 9), t(1, 23), c, 100, 4)).toBe(0);
    // The next day is just another line.
    expect(close(familiarityChange(t(1, 23), t(2, 1), c), 0.15)).toBe(true);
    // 19 days without contact, 7 of grace: 12 days of decay.
    expect(close(familiarityChange(t(1, 12), t(21, 12), c), 0.15 - 12 * 0.5)).toBe(true);
    // Depth: said to her, long, very long.
    expect([
      lineDepth("嗨", false),
      lineDepth("嗨", true),
      lineDepth("嗨".repeat(40), true),
    ]).toEqual([1, 2, 3]);
    expect(lineDepth("嗨".repeat(120), true)).toBe(4);
  });

  it("a person who talks a lot is not a stranger (604 lines)", async () => {
    const h = new Harness();
    for (let i = 0; i < 604; i++) {
      await h.say(
        "discord:2",
        "Amy",
        "今天天氣真好,我們一起去走走吧,順便聊聊最近發生的事情吧",
        dm(),
        t(1, 10) + i * MINUTE,
      );
    }
    const r = h.rel("discord:2");
    expect(r.interactions).toBe(604);
    expect(r.familiarity).toBeGreaterThan(30);
    expect(r.familiarity).toBeLessThan(100);
    // Rows are written in steps of half a point, not one per line.
    const rows = h.store
      .deltas(h.person("discord:2"))
      .filter((d) => d.reason === "familiarity: lines");
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(250);
  });

  it("rules_are_capped_per_day_and_survive_restart", async () => {
    const h = new Harness();
    for (let i = 0; i < 20; i++) {
      await h.say("discord:2", "Amy", "謝謝你,你好可愛", dm(), t(1, 10) + i * MINUTE);
    }
    let r = h.rel("discord:2");
    // thanks: 1 + .5 + .25 ... < 2, praise: 1.5 + .75 ... < 3.
    expect(r.affinity > 4.5 && r.affinity < 5.001, `${r.affinity}`).toBe(true);
    // 20 lines said to her (depth 2): 0.3 each, slowing a little.
    expect(r.familiarity > 5 && r.familiarity < 6.5, `${r.familiarity}`).toBe(true);
    expect(r.interactions).toBe(20);
    const p = h.person("discord:2");
    const reasons = h.store.deltas(p).map((d) => d.reason);
    expect(reasons).toContain("rule: thanks");
    expect(reasons).toContain("familiarity: lines");
    expect(h.topics()).not.toEqual([]);

    // A restart rebuilds today's ledger from the recorded deltas.
    const before = h.store.stored(p)?.affinity ?? Number.NaN;
    const again = new Harness(socialConfig(), h.store);
    await again.social.load();
    await again.say("discord:2", "Amy", "謝謝", dm(), t(1, 11));
    const gain = again.rel("discord:2").affinity - before;
    expect(gain < 0.001, `21st thanks of the day is worth ~0: ${gain}`).toBe(true);

    // A new day has a new budget.
    await again.say("discord:2", "Amy", "謝謝", dm(), t(2, 11));
    r = again.rel("discord:2");
    expect(close(r.affinity - before, 1), `${r.affinity - before}`).toBe(true);
    // The next day's lines add to what the first day made (it is only a few lines more).
    expect(r.familiarity > 5.5, `${r.familiarity}`).toBe(true);
  });

  it("economy gains: tiny, diminishing, a kind cap inside the overall caps, no emotion event", async () => {
    const h = new Harness();
    await h.say("discord:2", "Amy", "嗨", dm(), t(1, 10));
    const p = h.person("discord:2");
    const start = h.rel("discord:2");
    const events = () =>
      h.events.filter((e) => e.type === "custom" && e.data.topic === "social.event").length;
    const before = events();
    const treat = (now: number) =>
      h.social.gain(
        p,
        { kind: "treat", affinity: 0.4, trust: 0.1, kind_cap: { affinity: 1.5, trust: 0.5 } },
        now,
      );
    const first = await treat(t(1, 11));
    expect(close(first.affinity, 0.4) && close(first.trust, 0.1), JSON.stringify(first)).toBe(true);
    // The n-th of the day is worth repeat_decay^n of it.
    const second = await treat(t(1, 11));
    expect(close(second.affinity, 0.2) && close(second.trust, 0.05)).toBe(true);
    for (let i = 0; i < 10; i++) await treat(t(1, 11));
    const gained = h.rel("discord:2").affinity - start.affinity;
    // 0.4 / (1 - .5) is 0.8 at most however many; far below the kind cap.
    expect(gained > 0.7 && gained < 0.81, `${gained}`).toBe(true);
    const reasons = h.store.deltas(p).map((d) => d.reason);
    expect(reasons).toContain("economy: treat");
    expect(events(), "her emotions are the economy's to publish").toBe(before);

    // The kind's own cap: a big raw gain stops at it, and counts toward the overall cap.
    const big = new Harness();
    await big.say("discord:3", "Bob", "嗨", dm(), t(1, 10));
    const bob = big.person("discord:3");
    const got = await big.social.gain(
      bob,
      { kind: "treat", affinity: 5, trust: 3, kind_cap: { affinity: 1.5, trust: 0.5 } },
      t(1, 11),
    );
    expect(close(got.affinity, 1.5) && close(got.trust, 0.5), JSON.stringify(got)).toBe(true);
    const more = await big.social.gain(
      bob,
      { kind: "treat", affinity: 5, trust: 3, kind_cap: { affinity: 1.5, trust: 0.5 } },
      t(1, 12),
    );
    expect(more).toEqual({ affinity: 0, trust: 0 });
    const ledger = big.social.today(bob, t(1, 12));
    expect(close(ledger?.affinity_gained ?? 0, 1.5 + 0.5)).toBe(true);
    // Used up by gifts, the rest of her day's budget is still there for other things.
    await big.say("discord:3", "Bob", "謝謝你,你好可愛", dm(), t(1, 13));
    expect((big.social.today(bob, t(1, 13))?.affinity_gained ?? 0) > 2).toBe(true);

    // A restart rebuilds the kind's total from the recorded deltas.
    const again = new Harness(socialConfig(), big.store);
    await again.social.load();
    const after = await again.social.gain(
      bob,
      { kind: "treat", affinity: 5, trust: 3, kind_cap: { affinity: 1.5, trust: 0.5 } },
      t(1, 14),
    );
    expect(after).toEqual({ affinity: 0, trust: 0 });
    // A new day, a new budget.
    const next = await again.social.gain(
      bob,
      { kind: "treat", affinity: 0.4, trust: 0.1, kind_cap: { affinity: 1.5, trust: 0.5 } },
      t(2, 10),
    );
    expect(close(next.affinity, 0.4)).toBe(true);
  });

  it("economy gains do nothing for blocked people; a penalty is outside the caps", async () => {
    const h = new Harness();
    await h.say("discord:5", "Troll", "嗨", dm(), t(1, 10));
    const p = h.person("discord:5");
    const gain = { kind: "deal_kept" as const, affinity: 0, trust: 0.3, kind_cap: null };
    const kept = await h.social.gain(p, gain, t(1, 11));
    expect(close(kept.trust, 0.3), JSON.stringify(kept)).toBe(true);
    // A day of insults used up the loss budget; the penalty still lands in full.
    for (let i = 0; i < 6; i++) await h.say("discord:5", "Troll", "你這個智障", dm(), t(1, 12));
    const before = h.rel("discord:5");
    const hit = await h.social.penalty(
      p,
      { affinity: 1.5, trust: 4, reason: "deal: broken_promise" },
      t(1, 13),
    );
    expect(close(hit.affinity, -1.5) && close(hit.trust, -4), JSON.stringify(hit)).toBe(true);
    expect(close(before.trust - h.rel("discord:5").trust, 4)).toBe(true);
    expect(h.store.deltas(p).map((d) => d.reason)).toContain("deal: broken_promise");

    expect(await h.social.setTag(p, "blocked", true, "test", t(1, 14))).toBe(true);
    const n = h.store.deltas(p).length;
    expect(await h.social.gain(p, gain, t(1, 15))).toEqual({ affinity: 0, trust: 0 });
    expect(h.store.deltas(p)).toHaveLength(n);
  });

  it("rules_only_count_lines_said_to_her", async () => {
    const h = new Harness();
    await h.say("discord:2", "Amy", "謝謝你喔 Bob", channel(), t(1, 10));
    expect(close(h.rel("discord:2").affinity, 0)).toBe(true);
    await h.say("discord:2", "Amy", "DS醬謝謝你", channel(), t(1, 10));
    expect(close(h.rel("discord:2").affinity, 1)).toBe(true);
    // Right after she spoke, lines count as answers to her.
    h.social.observeSelf(channel(), "<emo:happy>哼,不客氣。", t(1, 11));
    await h.say("discord:3", "Bob", "你好棒", channel(), t(1, 11) + 10_000);
    expect(h.rel("discord:3").affinity > 0).toBe(true);
  });

  it("owner_floor_and_auto_tag", async () => {
    const h = new Harness();
    h.social.setAuthorizer(Permissions.fromStrings(["discord:1"]));
    await h.say("discord:1", "Owen", "嗨", dm(), t(1, 10));
    let r = h.rel("discord:1");
    expect(r.tags).toContain("owner");
    expect(close(r.trust, 100) && close(r.affinity, 30.5), JSON.stringify(r)).toBe(true);
    expect(label(r)).toBe("朋友");
    for (let i = 0; i < 5; i++) await h.say("discord:1", "Owen", "你這個智障", dm(), t(1, 11));
    r = h.rel("discord:1");
    expect(close(r.affinity, 30) && close(r.trust, 100), JSON.stringify(r)).toBe(true);

    // A normal person is not tagged.
    await h.say("discord:2", "Amy", "嗨", dm(), t(1, 10));
    expect(h.rel("discord:2").tags).toEqual([]);
  });

  it("dirty_jokes_cost_by_how_close_they_are", async () => {
    expect(flirtWeight(-5)).toBe(1);
    expect(flirtWeight(0)).toBe(1);
    expect(close(flirtWeight(FLIRT_FREE_AFFINITY / 2), 0.5)).toBe(true);
    expect(flirtWeight(FLIRT_FREE_AFFINITY)).toBe(0);
    expect(flirtWeight(80)).toBe(0);

    const h = new Harness();
    h.social.setAuthorizer(Permissions.fromStrings(["discord:1"]));
    // A stranger pays full price...
    await h.say("discord:2", "Amy", "DS醬給我看內褲", dm(), t(1, 10));
    const stranger = h.rel("discord:2");
    expect(close(stranger.affinity, -2) && close(stranger.trust, 10 - 1.5)).toBe(true);
    // ...from someone she is close to (the owner's floor is 30) it is just teasing.
    await h.say("discord:1", "Owen", "嗨", dm(), t(1, 10));
    const before = h.rel("discord:1").affinity;
    await h.say("discord:1", "Owen", "DS醬給我看內褲", dm(), t(1, 11));
    expect(close(h.rel("discord:1").affinity, before)).toBe(true);
    const reasons = h.store.deltas(h.person("discord:1")).map((d) => d.reason);
    expect(reasons).not.toContain("rule: flirt_too_far");
  });

  it("blocked_people_are_ignored", async () => {
    const h = new Harness();
    await h.say("discord:5", "Troll", "嗨", dm(), t(1, 10));
    const p = h.person("discord:5");
    expect(await h.social.setTag(p, "blocked", true, "test", t(1, 10))).toBe(true);
    const n = h.store.deltas(p).length;
    await h.say("discord:5", "Troll", "去死啦白痴", dm(), t(1, 11));
    expect(h.store.deltas(p), "no changes while blocked").toHaveLength(n);
    expect(h.social.attitude(acc("discord:5"))?.blocked).toBe(true);
  });

  it("llm_appraisal_is_parsed_and_applied", async () => {
    const h = new Harness(socialConfig({ appraisal_every_lines: 3 }));
    const mock = new MockProvider("mock").reply(
      `\`\`\`json
{"people":[
 {"person_name":"Alice","toward_her":0.8,"events":["praise","thanks"]},
 {"person_name":"Bob","toward_her":-0.6,"events":["insult"]},
 {"person_name":"DeepSeek-chan","toward_her":1,"events":["gift"]}
]}
\`\`\``,
    );
    const r = router(mock);
    expect(await h.say("discord:2", "Alice", "DS醬謝謝", channel(), t(1, 10))).toBe(false);
    expect(await h.say("discord:3", "Bob", "她很爛", channel(), t(1, 10))).toBe(false);
    expect(await h.say("discord:2", "Alice", "她真的超可愛", channel(), t(1, 10))).toBe(true);
    expect(await h.social.appraise(r, channel(), t(1, 10))).toBe(2);

    const request = mock.requests()[0];
    expect(request?.json_mode).toBe(true);
    expect(request?.model).toBe("fast-model");
    expect(request?.session).toBe("miyoria-deepseek-chan-social");
    expect(request?.messages[0]?.content).toContain("Alice、Bob");
    expect(request?.messages[1]?.content).toContain("Bob: 她很爛");

    const alice = h.person("discord:2");
    const reasons = h.store.deltas(alice).map((d) => d.reason);
    expect(reasons).toContain("appraisal: praise");
    expect(reasons).toContain("appraisal: warm");
    expect(reasons).toContain("rule: thanks");
    expect(reasons, "thanks already counted by the rules").not.toContain("appraisal: thanks");
    const bob = h.rel("discord:3");
    expect(bob.affinity < -3, `${bob.affinity}`).toBe(true);

    // Nothing new: no second call.
    expect(await h.social.appraise(r, channel(), t(1, 10))).toBe(0);
    expect(mock.requests()).toHaveLength(1);

    // Idle contexts become due.
    await h.say("discord:3", "Bob", "嗯", channel(), t(1, 11));
    expect(h.social.dueAppraisals(t(1, 11))).toEqual([]);
    expect(h.social.dueAppraisals(t(1, 12))).toEqual([channel()]);
  });

  it("bad_llm_answers_change_nothing", async () => {
    const h = new Harness();
    const r = router(new MockProvider("mock").reply("我拒絕回答"));
    await h.say("discord:3", "Bob", "hello", channel(), t(1, 10));
    const before = h.rel("discord:3");
    await expect(h.social.appraise(r, channel(), t(1, 10))).rejects.toThrow();
    expect(close(h.rel("discord:3").affinity, before.affinity)).toBe(true);
  });

  it("notes_refresh_and_prompt", async () => {
    const h = new Harness(socialConfig({ notes_every_lines: 2 }));
    await h.say("discord:2", "Amy", "我今天去水族館看鯨魚", dm(), t(1, 10));
    expect(h.social.dueNotes(t(1, 10))).toEqual([]);
    h.social.observeSelf(dm(), "鯨魚很可愛吧!", t(1, 10));
    await h.say("discord:2", "Amy", "對啊超大", dm(), t(1, 10));
    const p = h.person("discord:2");
    expect(h.social.dueNotes(t(1, 10))).toEqual([p]);

    const mock = new MockProvider("mock").reply('{"notes":"喜歡鯨魚的人,品味還不錯。"}');
    expect(await h.social.refreshNotes(router(mock), p, t(1, 10))).toBe(true);
    expect(h.rel("discord:2").notes).toBe("喜歡鯨魚的人,品味還不錯。");
    expect(mock.requests()[0]?.session).toBe("miyoria-deepseek-chan-social");
    expect(mock.requests()[0]?.messages[1]?.content).toContain("DeepSeek-chan: 鯨魚很可愛吧!");
    expect(h.social.dueNotes(t(1, 10))).toEqual([]);
    await h.social.setCallName(p, "阿美", t(1, 10));
  });

  it("link_code_flow", async () => {
    const h = new Harness();
    const a = acc("discord:1");
    const b = acc("twitch:9");
    await h.say("discord:1", "Owen", "嗨", dm(), t(1, 10));
    const keep = h.person("discord:1");
    await h.social.adjust(keep, 5, "test", t(1, 10));

    let code = (await h.social.issueLinkCode(a, "Owen", t(1, 10))) ?? "";
    expect(code).toHaveLength(8);
    expect(await h.social.redeemLinkCode(a, "Owen", code, t(1, 10))).toEqual({
      type: "same_account",
    });
    code = (await h.social.issueLinkCode(a, "Owen", t(1, 10))) ?? "";
    // Twitch account already has a better relationship.
    const absorb = (await h.social.resolve(b, "owen_tw", t(1, 10))) ?? "";
    await h.social.adjust(absorb, 20, "test", t(1, 10));
    await h.social.setCallName(absorb, "歐文", t(1, 10));

    expect(await h.social.redeemLinkCode(b, "owen_tw", "WRONG123", t(1, 10))).toEqual({
      type: "invalid_code",
    });
    const expired = t(1, 10) + 11 * MINUTE;
    expect(await h.social.redeemLinkCode(b, "owen_tw", code.toLowerCase(), expired)).toEqual({
      type: "invalid_code",
    });
    code = (await h.social.issueLinkCode(a, "Owen", t(1, 10))) ?? "";
    const outcome = await h.social.redeemLinkCode(b, "owen_tw", code.toLowerCase(), t(1, 10));
    expect(outcome).toEqual({ type: "linked", keep, absorbed: absorb });

    expect(h.social.personOf(b)).toBe(keep);
    expect(h.store.personOf(b)).toBe(keep);
    const merged = h.store.stored(keep);
    expect(
      close(merged?.affinity ?? 0, 20),
      `higher affinity kept: ${JSON.stringify(merged)}`,
    ).toBe(true);
    expect(merged?.call_name).toBe("歐文");
    expect(h.store.stored(absorb)).toBeNull();
    expect(h.social.attitude(a)?.person).toBe(h.social.attitude(b)?.person);
    expect(
      await h.social.redeemLinkCode(b, "owen_tw", code, t(1, 10)),
      "codes are one-time",
    ).toEqual({ type: "invalid_code" });
    for (let i = 0; i < 5; i++) await h.social.redeemLinkCode(b, "x", "NOPE", t(1, 10));
    expect(await h.social.redeemLinkCode(b, "x", "NOPE", t(1, 10))).toEqual({
      type: "too_many_attempts",
    });
  });

  it("link_moves_memories_to_the_kept_person", async () => {
    const store = await SqliteStore.open(":memory:");
    try {
      const h = new Harness(socialConfig(), new FakeStore(), store.memories);
      const a = acc("discord:1");
      const b = acc("twitch:9");
      const keep = (await h.social.resolve(a, "Owen", t(1, 10))) ?? "";
      const absorb = (await h.social.resolve(b, "owen_tw", t(1, 10))) ?? "";
      const other = (await h.social.resolve(acc("discord:5"), "Amy", t(1, 10))) ?? "";
      const at = new Date(t(1, 10)).toISOString();
      const memory = (
        kind: MemoryKind,
        scope: MemoryScope,
        subjects: string[],
        tokens: string,
        profileId = profile(),
      ): MemoryRecord => ({
        id: newId(),
        profile: profileId,
        kind,
        scope,
        subjects,
        content: tokens,
        tokens,
        embedding: [0, 1],
        importance: 0.5,
        confidence: 0.8,
        created_at: at,
        updated_at: at,
        last_accessed: null,
        access_count: 0,
        source_context: null,
        source: null,
        due: kind === "followup" ? at : null,
        done: false,
        superseded_by: null,
      });
      const episode = memory("episode", { type: "global" }, [absorb, other], "minecraft lava");
      const fact = memory("fact", { type: "person", person: absorb }, [absorb], "likes ramen");
      const followup = memory("followup", { type: "dm", account: b }, [absorb], "dentist");
      const note = memory("self_note", { type: "person", person: absorb }, [], "owe him cake");
      const elsewhere = memory("fact", { type: "global" }, [absorb, keep], "tall", "other-chan");
      const unrelated = memory("fact", { type: "person", person: other }, [other], "cats");
      const all = [episode, fact, followup, note, elsewhere, unrelated];
      for (const r of all) await store.memories.upsert(r);

      const code = (await h.social.issueLinkCode(a, "Owen", t(1, 10))) ?? "";
      const outcome = await h.social.redeemLinkCode(b, "owen_tw", code, t(1, 10));
      expect(outcome).toEqual({ type: "linked", keep, absorbed: absorb });

      const read = async (r: MemoryRecord) => (await store.memories.get(r.id)) as MemoryRecord;
      expect((await read(episode)).subjects).toEqual([keep, other]);
      expect((await read(fact)).scope).toEqual({ type: "person", person: keep });
      expect((await read(fact)).subjects).toEqual([keep]);
      expect((await read(followup)).subjects).toEqual([keep]);
      expect((await read(followup)).scope, "account scopes stay").toEqual({
        type: "dm",
        account: b,
      });
      expect((await read(note)).scope).toEqual({ type: "person", person: keep });
      expect((await read(elsewhere)).subjects, "other profiles too, no duplicate").toEqual([keep]);
      expect((await read(unrelated)).subjects).toEqual([other]);

      // Full text and vectors still find them under the kept person.
      const keepScope: MemoryScope = { type: "person", person: keep };
      const hits = await store.memories.search({
        profile: profile(),
        scopes: [keepScope],
        kinds: null,
        tokens: ["ramen", "cake"],
        embedding: [0, 1],
        limit: 10,
      });
      expect(hits.map((x) => x.record.id).sort()).toEqual([fact.id, note.id].sort());
      expect(hits.every((x) => x.text_score > 0 && (x.vector_score ?? 0) > 0.99)).toBe(true);
      const filter = {
        subject: absorb,
        scope: null,
        kind: null,
        before: null,
        include_superseded: true,
        limit: 100,
      };
      expect(await store.memories.list(profile(), filter)).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("merge_keeps_higher_affinity_and_combines_the_rest", () => {
    let n = 0;
    const base = (a: number, f: number, tags: string[], notes: string): Relationship => ({
      profile: profile(),
      person: `person-${n++}`,
      affinity: a,
      trust: a,
      familiarity: f,
      tags,
      notes,
      call_name: null,
      interactions: 3,
      last_interaction: new Date(t(1, 10)).toISOString(),
      updated_at: new Date(t(1, 10)).toISOString(),
    });
    const keep = base(5, 30, ["regular"], "");
    const person = keep.person;
    mergeInto(keep, base(40, 10, ["friend"], "很好的人"));
    expect(keep.person).toBe(person);
    expect(close(keep.affinity, 40) && close(keep.trust, 40)).toBe(true);
    expect(close(keep.familiarity, 30)).toBe(true);
    expect(keep.interactions).toBe(6);
    expect(keep.notes).toBe("很好的人");
    expect(keep.tags).toEqual(["regular", "friend"]);
  });

  it("commands", async () => {
    const h = new Harness();
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
    registerCommands(registry, h.social);
    const run = async (inv: InvocationData) => (await registry.dispatch(inv)).text;
    const s = (v: string): ArgValue => v;

    let me = await run(inv("discord:2", "me profile", {}, false));
    expect(me.includes("關係：陌生人") && me.includes("尚未設定"), me).toBe(true);
    expect(me.includes("."), `no exact numbers: ${me}`).toBe(false);
    const refused = await run(inv("discord:2", "me call", { name: s("笨蛋") }, false));
    expect(refused).toBe("這個稱呼不適合，請換一個。");
    const set = await run(inv("discord:2", "me call", { name: s("小明") }, false));
    expect(set).toBe("已設定：她會稱呼你「小明」。");
    me = await run(inv("discord:2", "me profile", {}, false));
    expect(me).toContain("她怎麼稱呼你：「小明」");
    // The profile's "set" button opens a modal; its submission updates the card.
    const click = (who: string, id: string, fields: Record<string, string> = {}) =>
      registry.dispatchComponent({
        ...inv(who, "x", {}, false),
        custom_id: id,
        fields,
        message_id: "m1",
      });
    const modal = await click("discord:2", "mi:me:call:edit");
    expect(modal?.result.type).toBe("modal");
    const submitted = await click("discord:2", "mi:me:call:submit", { call: " 阿明 " });
    expect(submitted?.result.type).toBe("update");
    expect(h.rel("discord:2").call_name).toBe("阿明");
    await run(inv("discord:2", "me call", { name: s("小明") }, false));

    const denied = await run(inv("discord:2", "admin person show", { user: s("<@2>") }, false));
    expect(denied).toContain("權限");
    const shown = await run(inv("discord:3", "admin person show", { user: s("<@!2>") }, true));
    expect(shown.includes("好感 0.0") && shown.includes("小明"), shown).toBe(true);
    const byName = await run(inv("discord:3", "admin person show", { user: s("user2") }, true));
    expect(byName).toContain("user2\n好感");
    const unknown = await run(
      inv("discord:3", "admin person show", { user: s("discord:404") }, true),
    );
    expect(unknown).toBe("找不到「discord:404」這個人。");

    const tag = await run(
      inv("discord:3", "admin person tag", { user: s("2"), tag: s("Regular") }, true),
    );
    expect(tag).toContain("`regular`");
    const ownerTag = await run(
      inv("discord:3", "admin person tag", { user: s("2"), tag: s("owner") }, true),
    );
    expect(ownerTag).toContain("owner.person.tag");
    const badTag = await run(
      inv("discord:3", "admin person tag", { user: s("2"), tag: s("壞 人") }, true),
    );
    expect(badTag).toContain("標籤只能");

    const adjustArgs = { user: s("2"), affinity: 25 };
    const notOwner = await run(inv("discord:3", "admin person adjust", adjustArgs, true));
    expect(notOwner).toContain("owner.person.adjust");
    const adjusted = await run(inv("discord:1", "admin person adjust", adjustArgs, false));
    expect(adjusted.includes("+25") && adjusted.includes("朋友"), adjusted).toBe(true);
    me = await run(inv("discord:2", "me profile", {}, false));
    expect(me).toContain("朋友");

    const blocked = await run(inv("discord:3", "admin person block", { user: s("2") }, true));
    expect(blocked).toContain("她不會再回應這個人");
    me = await run(inv("discord:2", "me profile", {}, false));
    expect(me).toBe("她目前不會回應你。");
    await run(inv("discord:3", "admin person unblock", { user: s("2") }, true));

    // Resetting asks first (a red confirm card); the confirm button does it.
    const ask = await registry.dispatch(
      inv("discord:3", "admin person reset", { user: s("2") }, true),
    );
    expect(ask.card?.accent).toBe("danger");
    expect(close(h.rel("discord:2").affinity, 0)).toBe(false);
    const confirmId = ask.card?.blocks.flatMap((b) =>
      b.type === "buttons" ? b.buttons.map((x) => x.id) : [],
    )[0] as string;
    const reset = await registry.dispatchComponent({
      ...inv("discord:3", "x", {}, true),
      custom_id: confirmId,
    });
    expect(reset?.result.type === "update" && reset.result.reply.text).toContain("已重置");
    const r = h.rel("discord:2");
    expect(close(r.affinity, 0) && r.call_name === null).toBe(true);
    expect(r.tags, "tags survive a reset").toEqual(["regular"]);

    const issued = await run(inv("discord:2", "me link", {}, false));
    const code = issued.split("`")[1] ?? "";
    const linked = await run(inv("discord:7", "me link", { code: s(code) }, false));
    expect(linked).toBe("已連結：這兩個帳號現在屬於同一個人。");
    expect(h.social.personOf(acc("discord:7"))).toBe(h.social.personOf(acc("discord:2")));
  });

  // ---- TS-specific -----------------------------------------------------------------------

  it("config defaults match legacy", () => {
    expect(SocialConfigSchema.parse({})).toEqual({
      daily_affinity_cap: 8,
      daily_trust_cap: 5,
      repeat_decay: 0.5,
      owner_trust: 100,
      owner_affinity_floor: 30,
      default_trust: 10,
      utc_offset_minutes: 480,
      familiarity_grace_days: 7,
      familiarity_decay_per_day: 0.5,
      familiarity_per_line: 0.15,
      appraisal_every_lines: 8,
      appraisal_idle_secs: 90,
      appraisal_max_lines: 30,
      direct_window_secs: 45,
      notes_every_lines: 40,
      notes_min_interval_hours: 12,
      tick_secs: 15,
      auto_owner_tag: true,
      llm_purpose: "fast",
    });
  });

  it("relationship events have the legacy JSON shape", async () => {
    const h = new Harness();
    await h.say("discord:2", "Amy", "謝謝", dm(), t(1, 10));
    const p = h.person("discord:2");
    // One short line is only a hair of familiarity: no row for it yet.
    const [thanks] = h.topics();
    expect(thanks).toMatchObject({
      profile: profile(),
      person: p,
      name: "Amy",
      reason: "rule: thanks",
      kind: "thanks",
      positive: true,
      trust: expect.any(Number),
      label: "陌生人",
      context: dm(),
    });
    const delta = h.store.deltas(p)[0];
    expect(Object.keys(delta ?? {}).sort()).toEqual([
      "affinity",
      "at",
      "familiarity",
      "reason",
      "trust",
    ]);
    expect(Date.parse(delta?.at ?? "")).toBe(t(1, 10));
  });

  it("strips her markup", () => {
    expect(stripTags("<emo:happy>哼,  不客氣。<act:wave>")).toBe("哼, 不客氣。");
  });
});

function inv(
  who: string,
  path: string,
  args: Record<string, ArgValue>,
  guildAdmin: boolean,
): InvocationData {
  return {
    path: path.split(" "),
    args,
    invoker: acc(who),
    invoker_display_name: `user${who.split(":").pop()}`,
    context: channel(),
    invoker_is_guild_admin: guildAdmin,
  };
}

// ---------------------------------------------------------- module test ---

class LlmStub implements Module {
  readonly manifest = defineManifest("llm", "LLM stub");
  constructor(readonly mock: MockProvider) {}
  async start(ctx: ModuleContext): Promise<void> {
    ctx.provide(LlmRouterKey, router(this.mock));
  }
}

async function eventually(what: string, f: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (f()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("modules", () => {
  /** The module with her feelings around and a line due for its pass. */
  async function reading(mind: boolean) {
    const bus = new EventBus();
    const services = new ServiceRegistry();
    const store = new FakeStore();
    services.provide("kernel", PeopleStoreKey, store);
    services.provide("kernel", RelationshipStoreKey, store);
    services.provide("kernel", IdentityStoreKey, store);
    services.provide("kernel", SelfStateKey, {
      crush: () => null,
      emotions: () => [],
      drives: () => ({ esteem: 0, attention: 0, social: 0, longing: 0, hunger: 0 }),
    } as unknown as SelfState);
    if (mind) services.provide("kernel", MindKey, {} as Mind);
    const mock = new MockProvider("mock").reply(
      '{"people":[{"person_name":"Amy","toward_her":0,"events":[],"romance":0.8}],"her":{"joy":0.9}}',
    );
    const sup = new Supervisor({ bus, services });
    await sup.register(new LlmStub(mock), null, true);
    await sup.register(
      new SocialModule(profile(), "DeepSeek-chan", ["DS醬"]),
      { appraisal_every_lines: 1 },
      true,
    );
    await sup.startAll();
    const appraisals = bus.subscribe([SOCIAL_APPRAISAL_TOPIC]);
    bus.publish("platform.test", {
      type: "platform_message_created",
      data: {
        id: { context: channel(), id: "m1" },
        author: { account: acc("discord:2"), display_name: "Amy", is_bot: false },
        text: "DS醬今天好可愛",
        mentions_self: false,
        reply_to_self: false,
        attachments: [],
        ts: new Date().toISOString(),
      },
    });
    await eventually("the pass", () => mock.requests().length > 0);
    const asked = JSON.stringify(mock.requests()[0]?.messages);
    const published = await withTimeout(appraisals.recv(), 200);
    await sup.stopAll();
    return { asked, published };
  }

  it("her feelings are Appraise's to read: with the mind running, this pass leaves them", async () => {
    const { asked, published } = await reading(true);
    expect(asked).not.toContain("romance");
    expect(asked).not.toContain("她在乎的事");
    expect(published).toBeUndefined();
  });

  it("without the mind, this pass is what reads them", async () => {
    const { asked, published } = await reading(false);
    expect(asked).toContain("romance");
    expect(published).toBeTruthy();
  });

  it("modules_wire_services_and_events", async () => {
    const bus = new EventBus();
    const services = new ServiceRegistry();
    const store = new FakeStore();
    services.provide("kernel", PeopleStoreKey, store);
    services.provide("kernel", RelationshipStoreKey, store);
    services.provide("kernel", IdentityStoreKey, store);
    const contributors = new PromptContributors();
    services.provide("kernel", PromptContributorsKey, contributors);
    const registry = new CommandRegistry(new Permissions());
    services.provide("kernel", CommandRegistryKey, registry);
    const sup = new Supervisor({ bus, services });
    await sup.register(new LlmStub(new MockProvider("mock").reply('{"people":[]}')), null, true);
    await sup.register(new SocialModule(profile(), "DeepSeek-chan", ["DS醬"]), null, true);
    await sup.register(
      new MoodModule(profile(), { valence: 0.1, arousal: 0.5, energy: 0.7 }),
      null,
      true,
    );
    await sup.startAll();

    const signals = services.require(SocialSignalsKey);
    const mood = services.require(MoodSignalsKey);
    expect(services.has(SocialKey)).toBe(true);
    expect(contributors.all()).toEqual([]);
    expect(registry.specs().map((s) => s.path.join(" "))).toContain("admin person adjust");
    const valenceBefore = mood.mood().valence;

    const changed = bus.subscribe(["mood.changed"]);
    const src = "platform.test";
    bus.publish(src, {
      type: "platform_ready",
      data: { platform: "discord", self_account: acc("discord:999") },
    });
    for (const [who, text] of [
      ["discord:999", "我是她自己"],
      ["discord:2", "DS醬你送我的禮物好棒,謝謝"],
    ] as const) {
      const event: Event = {
        type: "platform_message_created",
        data: {
          id: { context: channel(), id: "m1" },
          author: { account: acc(who), display_name: "Amy", is_bot: false },
          text,
          mentions_self: false,
          reply_to_self: false,
          attachments: [],
          ts: new Date().toISOString(),
        },
      };
      bus.publish(src, event);
    }
    await eventually("attitude", () => (signals.attitude(acc("discord:2"))?.affinity ?? 0) > 2);
    expect(signals.attitude(acc("discord:999")), "her own account is skipped").toBeNull();
    const env = await withTimeout(changed.recv(), 2000);
    expect(env, "mood.changed published").toBeTruthy();
    expect(env?.event.type === "custom" && env.event.data.topic).toBe("mood.changed");
    expect(mood.mood().valence > valenceBefore).toBe(true);

    await sup.stopAll();
    expect(contributors.all()).toEqual([]);
    expect(registry.specs()).toEqual([]);
  });

  it("start fails without a relationship store", async () => {
    const sup = new Supervisor();
    sup.services.provide("kernel", PeopleStoreKey, new FakeStore());
    await sup.register(new LlmStub(new MockProvider("mock").reply("{}")), null, true);
    await sup.register(new SocialModule(profile(), "DS", []), null, true);
    await sup.startAll();
    const status = () => sup.list().find((m) => m.id === "social");
    await eventually("failed state", () => status()?.state === "failed");
    expect(status()?.reason).toContain("social needs a `dyn RelationshipStore` service");
    await sup.stopAll();
  });
});
