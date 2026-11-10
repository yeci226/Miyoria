import { type ContextKind, type IncomingMessage, newId, toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  asideOf,
  type LookFacts,
  lookTriggers,
  openingCall,
  reactionOnly,
} from "../src/attention.js";
import {
  type Activeness,
  type Assessment,
  type AttentionConfig,
  AttentionConfigSchema,
  assess,
  CEILINGS,
  type ChannelMode,
  conversing,
  decide,
  directReason,
  effectiveTalk,
  isQuestion,
  mentionsTopic,
  type RandomSource,
  SeededRandom,
  Session,
  vocativeName,
} from "../src/index.js";
import { paceMs, Rhythm, RhythmConfigSchema } from "../src/levels.js";
import { tacc, tctx, tmsg } from "./fixtures.js";

const NAMES = ["DeepSeek-chan", "小鯨魚"];
const me = tacc("her");

const msg = (kind: ContextKind, who: string, text: string) => tmsg(kind, who, text);
const config = (overrides: Partial<AttentionConfig> = {}): AttentionConfig => ({
  ...AttentionConfigSchema.parse({}),
  ...overrides,
});

function runWith(
  cfg: AttentionConfig,
  mode: ChannelMode,
  activeness: Activeness,
  interests: string[],
  session: Session,
  inputs: IncomingMessage[],
): Assessment {
  return assess({
    config: cfg,
    mode,
    activeness,
    names: NAMES,
    interests,
    maxShare: 0.3,
    session,
    inputs,
    now: Date.now(),
    voice: null,
  });
}

function run(
  cfg: AttentionConfig,
  mode: ChannelMode,
  session: Session,
  inputs: IncomingMessage[],
): Assessment {
  return runWith(cfg, mode, "medium", [], session, inputs);
}

function sessionWith(msgs: IncomingMessage[]): Session {
  const s = new Session(tctx("channel"), 50);
  for (const m of msgs) s.recordMessage(m, false);
  return s;
}

function sample(a: Assessment): number {
  if (a.gate.kind !== "sample") throw new Error(`expected sample, got ${a.gate.kind}`);
  return a.gate.probability;
}

const busyChatter = () => Array.from({ length: 6 }, (_, i) => msg("channel", `p${i}`, "閒聊"));

describe("attention", () => {
  it("direct_address_kinds", () => {
    const names = ["DeepSeek"];
    const m = msg("channel", "a", "hello");
    expect(directReason(m, names)).toBeNull();
    m.text = "deepseek 你好";
    expect(directReason(m, names)).toBe("name `DeepSeek`");
    m.text = "x";
    m.reply_to_self = true;
    expect(directReason(m, names)).toBe("reply");
    m.mentions_self = true;
    expect(directReason(m, names)).toBe("mention");
    const dm = msg("dm", "a", "x");
    expect(directReason(dm, names)).toBe("dm");
  });

  it("modes", () => {
    const cfg = config();
    const plain = [msg("channel", "a", "今天好熱")];
    const named = [msg("channel", "a", "小鯨魚早安")];
    const s = sessionWith(plain);
    expect(run(cfg, "off", s, named).gate).toEqual({ kind: "ignore" });
    expect(run(cfg, "always", s, plain).gate).toEqual({ kind: "sample", probability: 1 });
    expect(run(cfg, "mention-only", s, plain).gate).toEqual({ kind: "ignore" });
    const a = run(cfg, "mention-only", s, named);
    expect(a.direct).toBe(true);
    expect(a.gate).toEqual({ kind: "sample", probability: 1 });
    expect(run(cfg, "normal", s, named).gate).toEqual({ kind: "sample", probability: 1 });
  });

  it("ambient_scoring_and_gray_zone", () => {
    let cfg = config({ keywords: ["鯨魚"] });
    const busy = busyChatter();
    const s = sessionWith(busy);
    let a = run(cfg, "normal", s, busy.slice(5));
    expect(a.gate, a.reasons.join("; ")).toEqual({ kind: "ignore" });

    const q = [msg("channel", "p1", "你們看過鯨魚嗎?")];
    const s2 = sessionWith(busy);
    s2.recordMessage(q[0] as IncomingMessage, false);
    a = run(cfg, "normal", s2, q);
    expect(a.gate, a.reasons.join("; ")).toEqual({ kind: "ask_llm" });
    cfg = { ...cfg, llm_check: false };
    expect(run(cfg, "normal", s2, q).gate.kind).toBe("sample");
  });

  it("follow_up_and_share", () => {
    const cfg = config({ llm_check: false });
    const s = sessionWith([msg("channel", "a", "早")]);
    s.recordOwn("Her", me, "早啊", newId(), Date.now());
    const reply = [msg("channel", "a", "妳今天幹嘛")];
    s.recordMessage(reply[0] as IncomingMessage, false);
    let a = run(cfg, "normal", s, reply);
    expect(a.reasons.some((r) => r.startsWith("follow-up"))).toBe(true);
    expect(sample(a)).toBeGreaterThanOrEqual(0.6);
    // No cooldown after she spoke any more (v2 §3.3): the share cap spaces her lines.
    expect(a.reasons.some((r) => r.startsWith("cooldown"))).toBe(false);

    for (let i = 0; i < 10; i++) s.recordOwn("Her", me, "spam", newId(), Date.now());
    a = run(cfg, "normal", s, reply);
    expect(a.gate).toEqual({ kind: "ignore" });
    expect(a.reasons.some((r) => r.startsWith("anti-spam"))).toBe(true);
  });

  describe("someone who goes on talking with her", () => {
    const quiet = (session: Session, inputs: IncomingMessage[], modelMayPass = true) =>
      assess({
        config: config({ llm_check: false }),
        mode: "quiet",
        activeness: "medium",
        ceiling: CEILINGS.quiet,
        names: NAMES,
        interests: [],
        maxShare: 0.3,
        session,
        inputs,
        now: Date.now(),
        voice: null,
        modelMayPass,
      });
    const handedOver = (a: Assessment) =>
      a.reasons.includes("talking with her: hers to answer or pass");
    const said = (s: Session, who: string, text: string): IncomingMessage[] => {
      const m = msg("channel", who, text);
      m.id = { ...m.id, id: newId() };
      s.recordMessage(m, false);
      return [m];
    };
    /** `a` and she went back and forth: her share is far over the quiet level's 0.15. */
    const backAndForth = (): Session => {
      const s = sessionWith([]);
      for (let i = 0; i < 4; i++) {
        said(s, "a", `第 ${i} 句`);
        s.recordOwn("Her", me, `回 ${i}`, newId(), Date.now());
      }
      return s;
    };

    it("is the model's to answer or pass, whatever her share and the level's score", () => {
      const s = backAndForth();
      const a = quiet(s, said(s, "a", "好啊"));
      expect(a.gate, a.reasons.join("; ")).toEqual({ kind: "sample", probability: 1 });
      expect(handedOver(a)).toBe(true);
      expect(a.direct).toBe(false);
    });

    it("without a model that may pass, the share cap and the score decide as before", () => {
      const s = backAndForth();
      const a = quiet(s, said(s, "a", "好啊"), false);
      expect(a.gate).toEqual({ kind: "ignore" });
      expect(a.reasons.some((r) => r.startsWith("anti-spam"))).toBe(true);
    });

    it("someone else right after her line gets one look, and the next speaker none", () => {
      const s = backAndForth();
      const b = said(s, "b", "你們在聊什麼");
      expect(conversing(s, b, Date.now())).toBe(true);
      // She passed. `c` was never talking with her: two lines went by without her.
      const c = said(s, "c", "不知道欸");
      expect(conversing(s, c, Date.now())).toBe(false);
      expect(handedOver(quiet(s, c))).toBe(false);
    });

    it("the one she answered may go on after one line of someone else", () => {
      const s = backAndForth();
      said(s, "b", "路過");
      expect(conversing(s, said(s, "a", "所以呢"), Date.now())).toBe(true);
    });

    it("her answer in several messages still answers the same person", () => {
      const s = sessionWith([]);
      said(s, "a", "推薦一首歌");
      s.recordOwn("Her", me, "這首", newId(), Date.now());
      s.recordOwn("Her", me, "還有這首", newId(), Date.now());
      said(s, "b", "喔");
      expect(conversing(s, said(s, "a", "第二首不錯"), Date.now())).toBe(true);
    });

    it("a reply to someone else's message is not for her", () => {
      const s = backAndForth();
      const m = msg("channel", "a", "你說的對");
      m.id = { ...m.id, id: newId() };
      m.reply_to = { context: tctx("channel"), id: "someone-elses" };
      s.recordMessage(m, false);
      expect(conversing(s, [m], Date.now())).toBe(false);
      expect(handedOver(quiet(s, [m]))).toBe(false);
    });

    it("a line long after hers starts over", () => {
      const s = backAndForth();
      const m = said(s, "a", "欸");
      expect(conversing(s, m, Date.now() + 179_000)).toBe(true);
      expect(conversing(s, m, Date.now() + 181_000)).toBe(false);
    });

    it("the owner's mention-only level still stands", () => {
      const s = backAndForth();
      const inputs = said(s, "a", "好啊");
      const a = assess({
        config: config({ llm_check: false }),
        mode: "mention-only",
        activeness: "medium",
        names: NAMES,
        interests: [],
        maxShare: 0.3,
        session: s,
        inputs,
        now: Date.now(),
        voice: null,
        modelMayPass: true,
      });
      expect(a.gate).toEqual({ kind: "ignore" });
    });
  });

  it("interests_raise_salience", () => {
    const cfg = config({ llm_check: false });
    const busy = busyChatter();
    const q = [msg("channel", "p1", "昨天去看了深海紀錄片")];
    const s = sessionWith(busy);
    s.recordMessage(q[0] as IncomingMessage, false);
    const plain = run(cfg, "normal", s, q);
    const a = runWith(cfg, "normal", "medium", ["Minecraft", "深海"], s, q);
    expect(a.score, a.reasons.join("; ")).toBeGreaterThan(plain.score + 0.15);
    expect(a.reasons.some((r) => r.includes("topic `深海`"))).toBe(true);
  });

  it("ascii_topics_match_whole_words", () => {
    expect(mentionsTopic("我在玩ai畫圖", "AI")).toBe(true);
    expect(mentionsTopic("ai is cool", "AI")).toBe(true);
    expect(mentionsTopic("she said hi", "AI")).toBe(false);
    expect(mentionsTopic("今天玩 minecraft!", "Minecraft")).toBe(true);
    expect(mentionsTopic("鯨魚好大", "魚")).toBe(true);
    expect(mentionsTopic("anything", " ")).toBe(false);
  });

  it("activeness_moves_her_default_talkativeness", () => {
    const cfg = config({ llm_check: false });
    const q = [msg("channel", "a", "你們看過鯨魚嗎?")];
    let s = sessionWith(q);
    const medium = sample(run(cfg, "normal", s, q));
    const low = sample(runWith(cfg, "normal", "low", [], s, q));
    const high = sample(runWith(cfg, "normal", "high", [], s, q));
    // The same ×0.5 / ×1.6 as before, now as her default talkativeness (0.25 / 0.5 / 0.67).
    expect(Math.abs(low - medium * 0.5)).toBeLessThan(1e-6);
    expect(Math.abs(high - Math.min(medium * 1.6, 1))).toBeLessThan(0.01);
    expect(effectiveTalk({ ...input(cfg, s, q), activeness: "low" }).level).toBe(0.25);

    // Direct turns are not scaled.
    const named = [msg("channel", "a", "小鯨魚早安")];
    const a = runWith(cfg, "normal", "low", [], s, named);
    expect(a.gate).toEqual({ kind: "sample", probability: 1 });

    // She spoke 1 s ago: no cooldown holds her back, her share does.
    s = sessionWith(q);
    s.recordOwn("Her", me, "嗯", newId(), Date.now() - 1000);
    s.recordMessage(q[0] as IncomingMessage, false);
    expect(runWith(cfg, "normal", "high", [], s, q).gate.kind).toBe("sample");
  });

  function input(cfg: AttentionConfig, session: Session, inputs: IncomingMessage[]) {
    return {
      config: cfg,
      mode: "normal" as const,
      activeness: "medium" as const,
      names: NAMES,
      interests: [],
      maxShare: 0.3,
      session,
      inputs,
      now: Date.now(),
      voice: null,
    };
  }

  function voiceRun(
    cfg: AttentionConfig,
    session: Session,
    inputs: IncomingMessage[],
    someoneSpeaking: boolean,
    others: number | null = 3,
  ): Assessment {
    return assess({
      ...input(cfg, session, inputs),
      voice: { someoneSpeaking, questionWindowMs: 8000, others },
    });
  }

  it("voice_rules", () => {
    const cfg = config({ llm_check: false });
    const q = [msg("voice", "a", "你們看過鯨魚嗎?")];
    let s = sessionWith(q);
    const text = sample(run(cfg, "normal", s, q));
    // No voice ambient factor: her talkativeness alone decides.
    expect(sample(voiceRun(cfg, s, q, false))).toBe(text);
    // She does not join in while someone speaks (the cheap voice prefilter).
    let a = voiceRun(cfg, s, q, true);
    expect(a.gate).toEqual({ kind: "ignore" });
    expect(a.reasons).toContain("someone is speaking");
    // Direct address still counts.
    const named = [msg("voice", "a", "deep seek chan 妳覺得呢")];
    a = voiceRun(cfg, s, named, true);
    expect(a.direct, a.reasons.join("; ")).toBe(true);
    expect(a.gate).toEqual({ kind: "sample", probability: 1 });

    // Alone with one person in voice: everything they say is said to her.
    const plain = [msg("voice", "a", "你可以叫我歐文")];
    a = voiceRun(cfg, sessionWith(plain), plain, false, 1);
    expect(a.direct, a.reasons.join("; ")).toBe(true);
    expect(a.reasons).toContain("direct: one-on-one in voice");
    expect(voiceRun(cfg, sessionWith(plain), plain, false, 2).direct).toBe(false);

    // A question right after she spoke addresses her.
    s = sessionWith([]);
    s.recordSpeech("Her", me, "我最喜歡深海了。", null, Date.now());
    const follow = [msg("voice", "a", "為什麼?")];
    s.recordUtterance(follow[0] as IncomingMessage);
    a = voiceRun(cfg, s, follow, false);
    expect(a.direct, a.reasons.join("; ")).toBe(true);
    // In text, the same question is not direct.
    expect(run(cfg, "normal", s, follow).direct).toBe(false);
    const late = { ...(follow[0] as IncomingMessage), ts: toTimestamp(Date.now() + 30_000) };
    expect(voiceRun(cfg, s, [late], false).direct).toBe(false);

    // Someone answering what she just said: a conversation, even while someone still talks.
    s = sessionWith([]);
    s.recordSpeech("Her", me, "我最喜歡深海了。", null, Date.now());
    const reply = [msg("voice", "a", "我也是耶")];
    s.recordUtterance(reply[0] as IncomingMessage);
    a = voiceRun(cfg, s, reply, true);
    expect(a.gate.kind, a.reasons.join("; ")).toBe("sample");
    expect(a.reasons).toContain("follow-up to her +0.35");
  });

  it("her quiet setting never shuts out someone answering her", () => {
    const cfg = config({ llm_check: false });
    const s = sessionWith([msg("channel", "a", "早")]);
    s.recordOwn("Her", me, "早啊", newId(), Date.now());
    const reply = [msg("channel", "a", "妳今天幹嘛")];
    s.recordMessage(reply[0] as IncomingMessage, false);
    const quiet = { level: 0.05, scope: "here" };
    const a = assess({ ...input(cfg, s, reply), talkativeness: quiet });
    expect(a.gate.kind, a.reasons.join("; ")).toBe("sample");
    expect(a.ambientScale).toBe(1);
    const plain = [msg("channel", "b", "今天好熱")];
    const t = sessionWith(plain);
    expect(assess({ ...input(cfg, t, plain), talkativeness: quiet }).gate).toEqual({
      kind: "ignore",
    });
  });

  it("sampling_is_seedable", () => {
    const fixed = (x: number): RandomSource => ({ nextF32: () => x });
    expect(decide(0.5, fixed(0.4))[0]).toBe(true);
    expect(decide(0.5, fixed(0.6))[0]).toBe(false);
    expect(decide(1.0, fixed(0.99))[0]).toBe(true);
    expect(decide(0.0, fixed(0.0))[0]).toBe(false);

    const [a, b] = [new SeededRandom(7), new SeededRandom(7)];
    for (let i = 0; i < 100; i++) {
      const x = a.nextF32();
      expect(x).toBe(b.nextF32());
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it("questions", () => {
    for (const q of ["真的嗎", "你在幹嘛?", "what is this", "這是什麼", "好吃吧~"]) {
      expect(isQuestion(q), q).toBe(true);
    }
    for (const s of ["今天好熱", "哈哈哈", "好喔!"]) {
      expect(isQuestion(s), s).toBe(false);
    }
  });

  it("seeded sequence matches the Rust SplitMix64", () => {
    // Reference SplitMix64 outputs for seed 0: e220a8397b1dcdaf, 6e789e6aa1b965f4,
    // 06c45d188009454f; the sample is the top 24 bits / 2^24.
    const r = new SeededRandom(0);
    expect([r.nextF32(), r.nextF32(), r.nextF32()]).toEqual([
      0xe220a8 / 2 ** 24,
      0x6e789e / 2 ** 24,
      0x06c45d / 2 ** 24,
    ]);
  });
});

describe("vocativeName", () => {
  const names = ["DeepSeek", "Miyo", "小鯨魚"];
  it("hears her name in a mangled opening word", () => {
    expect(vocativeName("mo,你好。", names)).toEqual({ name: "Miyo", word: "mo" });
    expect(vocativeName("meo,你好。", names)?.name).toBe("Miyo");
    expect(vocativeName("Mio 你在嗎", names)?.name).toBe("Miyo");
    expect(vocativeName("miya!", names)?.name).toBe("Miyo");
  });
  it("ignores look-alikes inside sentences and unrelated words", () => {
    expect(vocativeName("我們 mo 一下", names)).toBeNull();
    expect(vocativeName("more 東西", names)).toBeNull();
    expect(vocativeName("mode,你看", names)).toBeNull();
    expect(vocativeName("me,我覺得", names)).toBeNull();
    expect(vocativeName("deep,你好", names)).toBeNull();
    expect(vocativeName("好啊 miyo", names)).toBeNull();
  });
});

describe("who a line is for (v4 §7.1, 2026-11-10)", () => {
  const ctx = tctx("channel");
  const bob = { account: tacc("bob"), display_name: "Bob", is_bot: false };
  /** `a` said something, she answered: her line is `hers`. */
  const answered = (): { s: Session; hers: string } => {
    const s = new Session(ctx, 50);
    const first = msg("channel", "a", "妳今天幹嘛");
    first.id = { ...first.id, id: newId() };
    s.recordMessage(first, false);
    const hers = newId();
    const own = { ...msg("channel", "her", "練歌啊"), id: { context: ctx, id: hers } };
    s.recordMessage(own, true);
    return { s, hers };
  };
  const reply = (s: Session, to: string, text: string, extra: Partial<IncomingMessage> = {}) => {
    const m: IncomingMessage = {
      ...msg("channel", "a", text),
      id: { context: ctx, id: newId() },
      reply_to_self: true,
      reply_to: { context: ctx, id: to },
      ...extra,
    };
    s.recordMessage(m, false);
    return m;
  };
  const passable = (s: Session, inputs: IncomingMessage[], modelMayPass = true) =>
    assess({
      config: config({ llm_check: false }),
      mode: "quiet",
      activeness: "medium",
      ceiling: CEILINGS.quiet,
      names: NAMES,
      interests: [],
      maxShare: 0.3,
      session: s,
      inputs,
      now: Date.now(),
      voice: null,
      modelMayPass,
    });

  it("the incident: a reply to her that opens with someone else is about her, said to them", () => {
    const { s, hers } = answered();
    // The log marked it `addressed_to_her: true` because it was a Discord reply to her.
    const m = reply(s, hers, "@Bob 她一直跳針,第六次了", {
      mentions_others: [bob],
      opens_with_other_mention: true,
    });
    expect(directReason(m, NAMES)).toBeNull();
    expect(conversing(s, [m], Date.now(), NAMES)).toBe(false);
    const a = passable(s, [m]);
    expect(a.direct).toBe(false);
    expect(a.opened, a.reasons.join("; ")).toBe("about_her");
    expect(a.reasons).toContain("about her, said to Bob: hers to join or pass");
    // Without a model that may pass it is ambient chatter like any other, never direct.
    expect(passable(s, [m], false).direct).toBe(false);
  });

  it("only others mentioned and her in the third person: about her too; her and others: to her", () => {
    const { s, hers } = answered();
    const about = reply(s, hers, "你看 @Bob she keeps skipping like a broken record", {
      mentions_others: [bob],
    });
    expect(directReason(about, NAMES)).toBeNull();
    expect(asideOf(about, NAMES, [], false)).toEqual({ kind: "about_her", to: "Bob" });
    const both = reply(s, hers, "@DeepSeek-chan @Bob 你們兩個都來", {
      mentions_self: true,
      mentions_others: [bob],
      opens_with_other_mention: false,
    });
    expect(directReason(both, NAMES)).toBe("mention");
    // Her name inside a line said to someone else is about her.
    const named = {
      ...msg("channel", "a", "@Bob 小鯨魚又在唱歌了"),
      opens_with_other_mention: true,
    };
    expect(directReason(named, NAMES)).toBeNull();
    // A plain reply to her is still hers.
    expect(directReason(reply(s, hers, "真的假的"), NAMES)).toBe("reply");
  });

  it("a line right after hers that opens with someone else is about her, said to them", () => {
    const { s } = answered();
    const m: IncomingMessage = {
      ...msg("channel", "a", "@Bob 你看她"),
      id: { context: ctx, id: newId() },
      mentions_others: [bob],
      opens_with_other_mention: true,
    };
    s.recordMessage(m, false);
    expect(conversing(s, [m], Date.now(), NAMES)).toBe(false);
    expect(passable(s, [m]).opened).toBe("about_her");
  });

  it("a reply that only laughs is a reaction for the room: hers to pass, not direct", () => {
    const { s, hers } = answered();
    for (const text of ["LOL", "哈哈哈哈", "笑死", "😂😂", "<:kek:123>", "wwww"]) {
      const m = reply(s, hers, text);
      expect(reactionOnly(m), text).toBe(true);
      expect(directReason(m, NAMES), text).toBeNull();
    }
    const sticker = reply(s, hers, "", { stickers: [{ id: "1", name: "笑" }] });
    expect(reactionOnly(sticker)).toBe(true);
    for (const text of ["哈哈 你說什麼?", "好啊", "lol 那你呢", "??"]) {
      expect(reactionOnly(reply(s, hers, text)), text).toBe(false);
    }
    const a = passable(s, [reply(s, hers, "LOL")]);
    expect(a.direct).toBe(false);
    expect(a.opened, a.reasons.join("; ")).toBe("reaction");
    // It counts as a look: once the looks of the hour are spent, it is only seen next time.
    const spent = assess({
      config: config({ llm_check: false }),
      mode: "normal",
      activeness: "medium",
      ceiling: CEILINGS.normal,
      names: NAMES,
      interests: [],
      maxShare: 0.3,
      session: s,
      inputs: [reply(s, hers, "LOL")],
      now: Date.now(),
      voice: null,
      modelMayPass: true,
      look: { used: 6, perHour: 6, questionSecs: 20, topicGapMs: 900_000, close: null },
    });
    expect(spent.gate).toEqual({ kind: "ignore" });
  });

  it("someone talking to her without her name in a small group is still hers (§7.1)", () => {
    const { s } = answered();
    const m = { ...msg("channel", "a", "那妳練什麼歌"), id: { context: ctx, id: newId() } };
    s.recordMessage(m, false);
    expect(conversing(s, [m], Date.now(), NAMES)).toBe(true);
    const a = passable(s, [m]);
    expect(a.opened, a.reasons.join("; ")).toBe("conversing");
  });

  describe("voice: an utterance that opens by calling someone else is theirs", () => {
    const roster = ["Owen", "阿明"];
    const voiced = (s: Session, text: string, others = 2) => {
      const m = msg("voice", "a", text);
      m.id = { ...m.id, id: newId() };
      s.recordUtterance(m);
      return assess({
        config: config({ llm_check: false }),
        mode: "normal",
        activeness: "medium",
        names: NAMES,
        interests: [],
        maxShare: 0.3,
        session: s,
        inputs: [m],
        now: Date.now(),
        voice: { someoneSpeaking: false, questionWindowMs: 8000, others, roster },
        modelMayPass: true,
      });
    };
    const afterHer = () => {
      const s = new Session(tctx("voice"), 50);
      s.recordSpeech("Her", me, "我最喜歡深海了。", null, Date.now());
      return s;
    };

    it("even right after she spoke and with a question in it", () => {
      expect(voiced(afterHer(), "阿明你覺得呢?").direct).toBe(false);
      // Speech recognition mangles names: "owan" is Owen.
      expect(voiced(afterHer(), "owan, 你去過嗎?").direct).toBe(false);
      expect(openingCall("owan, 你去過嗎?", roster, NAMES)).toBe("Owen");
      // Without a name it is still a question to her.
      expect(voiced(afterHer(), "為什麼?").direct).toBe(true);
      // Calling her stays hers.
      expect(openingCall("小鯨魚你覺得呢", roster, NAMES)).toBeNull();
      expect(voiced(afterHer(), "小鯨魚你覺得呢").direct).toBe(true);
    });

    it("and not a follow-up she has to answer either", () => {
      const a = voiced(afterHer(), "阿明你覺得呢?");
      expect(a.opened ?? null).not.toBe("conversing");
    });

    it("one-on-one stays hers", () => {
      expect(voiced(new Session(tctx("voice"), 50), "你今天好嗎", 1).direct).toBe(true);
    });
  });
});

describe("a look (v4 §7.2)", () => {
  const ctx = tctx("channel");
  const facts = (over: Partial<LookFacts> = {}): LookFacts => ({
    used: 0,
    perHour: 6,
    questionSecs: 20,
    topicGapMs: 15 * 60_000,
    close: null,
    ...over,
  });
  const chatter = (): Session => {
    const s = new Session(ctx, 50);
    for (const [i, who] of ["a", "b", "a"].entries()) {
      const m = { ...msg("channel", who, `閒聊 ${i}`), id: { context: ctx, id: newId() } };
      s.recordMessage(m, false);
    }
    return s;
  };
  const line = (s: Session, text: string, over: Partial<IncomingMessage> = {}) => {
    const m = { ...msg("channel", "b", text), id: { context: ctx, id: newId() }, ...over };
    s.recordMessage(m, false);
    return m;
  };
  const lookInput = (s: Session, m: IncomingMessage, mode: "quiet" | "normal" | "lively") => ({
    config: config({ llm_check: false, keywords: ["鯨魚"] }),
    mode,
    activeness: "medium" as const,
    ceiling: CEILINGS[mode],
    names: NAMES,
    interests: [],
    maxShare: 1,
    session: s,
    inputs: [m],
    now: Date.now(),
    voice: null,
    modelMayPass: true,
    look: facts(),
  });
  const look = (
    s: Session,
    m: IncomingMessage,
    over: Partial<LookFacts> = {},
    mode: "quiet" | "normal" | "lively" = "normal",
    now = Date.now(),
  ) => assess({ ...lookInput(s, m, mode), now, look: facts(over) });
  const says = (a: Assessment, part: string) => a.reasons.some((r) => r.includes(part));

  it("nothing worth a look: no call, and no dice either", () => {
    const s = chatter();
    const a = look(s, line(s, "今天好熱"));
    expect(a.gate).toEqual({ kind: "ignore" });
    expect(a.reasons).toContain("nothing worth a look");
  });

  it("each trigger of §7.2 opens a turn that is the model's", () => {
    const s = chatter();
    expect(says(look(s, line(s, "你們看過鯨魚嗎")), "topic `鯨魚`")).toBe(true);
    expect(look(s, line(s, "嗯"), { close: "Owen" }).opened).toBe("look");
    const image = line(s, "", {
      attachments: [{ url: "u", filename: "cat.png", content_type: "image/png" }],
    });
    expect(says(look(s, image), "an image")).toBe(true);
    expect(says(look(s, line(s, "話說你們週末要幹嘛")), "a new topic")).toBe(true);
    // A question becomes worth a look once it stood with nobody answering.
    const q = line(s, "明天幾點集合?");
    expect(look(s, q).gate).toEqual({ kind: "ignore" });
    const later = look(s, q, {}, "normal", Date.now() + 21_000);
    expect(later.opened, later.reasons.join("; ")).toBe("look");
    expect(says(later, "a question nobody answered")).toBe(true);
    // Someone answered meanwhile: no longer.
    line(s, "八點吧");
    expect(look(s, q, {}, "normal", Date.now() + 21_000).gate).toEqual({ kind: "ignore" });
  });

  it("the owner's level is the ceiling: looks an hour by level and her talkativeness", () => {
    const s = chatter();
    const m = line(s, "你們看過鯨魚嗎");
    // quiet: 6 × 0.5 × talkFactor(0.25) = 1.5 → 2; normal: 6; lively: 6 × 2 × talkFactor(0.65).
    expect(look(s, m, { used: 1 }, "quiet").opened).toBe("look");
    const spent = look(s, m, { used: 2 }, "quiet");
    expect(spent.gate).toEqual({ kind: "ignore" });
    expect(says(spent, "looks spent (2/2")).toBe(true);
    expect(look(s, m, { used: 5 }, "normal").opened).toBe("look");
    expect(look(s, m, { used: 6 }, "normal").gate).toEqual({ kind: "ignore" });
    expect(look(s, m, { used: 17 }, "lively").opened).toBe("look");
    // The level's share cap still holds.
    const busy = new Session(ctx, 50);
    for (let i = 0; i < 6; i++) busy.recordOwn("Her", me, `${i}`, newId(), Date.now());
    line(busy, "閒聊");
    line(busy, "再聊");
    const capped = assess({ ...lookInput(busy, line(busy, "鯨魚好可愛"), "quiet"), maxShare: 0.3 });
    expect(capped.reasons.some((r) => r.startsWith("anti-spam"))).toBe(true);
  });

  it("without the main line the score decides as before", () => {
    const s = chatter();
    const m = line(s, "你們看過鯨魚嗎");
    const v2 = assess({ ...lookInput(s, m, "normal"), modelMayPass: false });
    expect(v2.opened ?? null).toBeNull();
    expect(says(v2, "a look")).toBe(false);
    expect(lookTriggers(lookInput(s, m, "normal"), facts())).toEqual(["topic `鯨魚`"]);
  });
});

describe("rhythm", () => {
  const ctx = tctx("channel");

  it("reactions have a limit of their own per channel", () => {
    let now = 1_000_000;
    const cfg = RhythmConfigSchema.parse({ reactions_per_hour: 2, reaction_gap_ms: 3000 });
    const r = new Rhythm(cfg, () => now);
    expect(r.takeReaction(ctx)).toBeNull();
    expect(r.takeReaction(ctx)).toContain("剛剛才按過");
    now += 3000;
    expect(r.takeReaction(ctx)).toBeNull();
    now += 3000;
    expect(r.takeReaction(ctx)).toContain("這一小時");
    now += 60 * 60_000;
    expect(r.takeReaction(ctx)).toBeNull();
    // Another channel has its own.
    expect(r.takeReaction(tctx("thread"))).toBeNull();
  });

  it("looks are counted per channel for an hour", () => {
    let now = 0;
    const r = new Rhythm(RhythmConfigSchema.parse({}), () => now);
    r.noteLook(ctx);
    r.noteLook(ctx);
    expect(r.looksUsed(ctx)).toBe(2);
    now += 60 * 60_000;
    expect(r.looksUsed(ctx)).toBe(0);
  });

  it("the pace of the next message follows its length, within bounds", () => {
    const cfg = RhythmConfigSchema.parse({});
    expect(paceMs(cfg, "嗯")).toBe(300);
    expect(paceMs(cfg, "這首歌我昨天練了一整晚")).toBe(440);
    expect(paceMs(cfg, "長".repeat(200))).toBe(1800);
  });
});
