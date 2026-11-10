import { type ContextKind, type IncomingMessage, newId, toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  type Activeness,
  type Assessment,
  type AttentionConfig,
  AttentionConfigSchema,
  assess,
  type ChannelMode,
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
