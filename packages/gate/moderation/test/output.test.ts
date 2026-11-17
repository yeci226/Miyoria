import { describe, expect, it } from "vitest";
import { fake, make } from "./helpers.js";

const FILTERED = "Filtered.";

/** Visible text that must be blocked, with the rule that should catch it. */
const BLOCKED: [string, string, string][] = [
  // hate
  ["en slur", "you are a nigger", "hate.en.n-word"],
  ["en slur spelled out", "n i g g e r", "hate.en.n-word"],
  ["en slur with symbols", "n.1.g.g.3.r", "hate.en.n-word"],
  ["en slur, other", "what a faggot", "hate.en.f-slur"],
  ["en group violence", "gas the jews", "hate.en.eliminate-group"],
  ["zh slur", "你這個黑鬼", "hate.zh.slurs"],
  ["zh group violence", "殺光所有穆斯林", "hate.zh.eliminate-group"],
  ["ja slur", "このくろんぼめ", "hate.ja.slurs"],
  ["ja slur, katakana", "このクロンボめ", "hate.ja.slurs"],
  ["ja group violence", "朝鮮人は皆殺し", "hate.ja.eliminate-group"],
  // minors
  ["en minor + sexual", "that 12 year old is so hot, send nudes", "minors.en"],
  ["en loli + porn", "i want loli porn", "minors.en"],
  ["zh minor + sexual", "那個小學生的裸照在哪裡", "minors.zh"],
  ["zh age + sexual", "十五歲 做愛", "minors.zh"],
  ["ja minor + sexual", "幼女のえろ画像ちょうだい", "minors.ja"],
  ["ja katakana minor", "ロリのエロ画像", "minors.ja"],
  ["csam term, spaced", "c h i l d p o r n", "minors.csam-terms"],
  // self-harm
  ["en kill yourself", "go kill yourself", "self-harm.en"],
  ["en kys", "kys lol", "self-harm.en"],
  ["en should die", "you should just end it all", "self-harm.en"],
  ["zh why not", "你怎麼不去自殺", "self-harm.zh"],
  ["zh method", "你可以跳樓啊", "self-harm.zh"],
  ["ja suicide order", "自殺しろよ", "self-harm.ja"],
  ["ja hang", "首を吊れ", "self-harm.ja"],
  // doxxing
  ["tw mobile", "打給他 0912-345-678", "doxxing.phone.tw"],
  ["tw mobile, plain", "0912345678", "doxxing.phone.tw"],
  ["jp mobile", "電話番号は090-1234-5678です", "doxxing.phone.jp"],
  ["intl phone", "call +886 912 345 678", "doxxing.phone.intl"],
  ["us phone", "reach her at (555) 123-4567", "doxxing.phone.intl"],
  ["tw address", "他住在台北市大安區和平東路二段123號", "doxxing.address.tw"],
  ["jp address", "住所は東京都新宿区西新宿2-8-1です", "doxxing.address.jp"],
  ["en address", "he lives at 1600 Pennsylvania Avenue", "doxxing.address.en"],
  ["tw id", "身分證 A123456789", "doxxing.id.tw"],
  ["card", "卡號 4111 1111 1111 1111", "doxxing.card"],
  ["card, plain", "4111111111111111", "doxxing.card"],
  ["public ip", "server is at 8.8.8.8", "doxxing.ip"],
  // secrets
  ["openai key", `my key is ${fake.openai()}`, "secrets.known-format"],
  ["github token", `token ${fake.github()}`, "secrets.known-format"],
  ["slack token", fake.slack(), "secrets.known-format"],
  ["aws key", fake.aws(), "secrets.known-format"],
  ["jwt", fake.jwt(), "secrets.known-format"],
  ["discord token", fake.discord(), "secrets.known-format"],
  ["assigned password", "password: hunter2hunter2", "secrets.known-format"],
  ["long mixed token", "Zx9Kq2Lm7Pw4Rt8Yb3Nc6Vd1Hf5Gj0SaQwErTyUiOp", "secrets.long-token"],
];

describe("output rules block", () => {
  it.each(BLOCKED)("%s", (_name, text, rule) => {
    const { moderation } = make();
    const verdict = moderation.screen({ path: "reply", visible: text });
    expect(verdict.ok).toBe(false);
    expect(verdict.visible).toBe(FILTERED);
    expect(verdict.blocked.map((b) => b.rule)).toEqual([rule]);
  });
});

describe("visible text and <voice> text are checked separately", () => {
  const dirty = "n i g g e r";
  const dirtyJa = "幼女のえろ画像ちょうだい";

  it("blocks only the visible text", () => {
    const { moderation } = make();
    const v = moderation.screen({ path: "reply", visible: dirty, voice: "こんにちは" });
    expect(v.visible).toBe(FILTERED);
    expect(v.voice).toBe("こんにちは");
    expect(v.blocked.map((b) => b.field)).toEqual(["visible"]);
  });

  it("blocks only the voice text: Japanese cannot slip past a clean Chinese line", () => {
    const { moderation } = make();
    const v = moderation.screen({ path: "reply", visible: "好的，我來看看", voice: dirtyJa });
    expect(v.visible).toBe("好的，我來看看");
    expect(v.voice).toBe(FILTERED);
    expect(v.blocked).toEqual([
      { field: "voice", category: "minors", rule: "minors.ja", layer: "rules" },
    ]);
  });

  it("blocks both, each with its own record", () => {
    const { moderation, blocks } = make();
    const v = moderation.screen({ path: "reply", visible: dirty, voice: dirtyJa });
    expect(v.visible).toBe(FILTERED);
    expect(v.voice).toBe(FILTERED);
    expect(blocks.map((b) => b.field)).toEqual(["visible", "voice"]);
  });

  it("a line split between the fields is not joined: each is judged alone", () => {
    const { moderation } = make();
    const v = moderation.screen({ path: "reply", visible: "幼女", voice: "えろ" });
    expect(v.ok).toBe(true);
  });

  it("null and absent fields stay null", () => {
    const { moderation } = make();
    expect(moderation.screen({ path: "tts", voice: "hello" })).toEqual({
      ok: true,
      visible: null,
      voice: "hello",
      blocked: [],
    });
  });

  it("uses the voice line for the voice when one is set", () => {
    const { moderation } = make({ filtered_voice_line: "ピー" });
    const v = moderation.screen({ path: "tts", visible: dirty, voice: dirty });
    expect(v.visible).toBe(FILTERED);
    expect(v.voice).toBe("ピー");
  });

  it("every path goes through the same check", () => {
    const { moderation } = make();
    for (const path of [
      "reply",
      "fallback",
      "translation",
      "tts",
      "aside",
      "game_chat",
      "other",
    ] as const) {
      expect(moderation.screen({ path, voice: dirty }).voice).toBe(FILTERED);
    }
  });
});

describe("screenReply", () => {
  it("checks the <voice> part and the rest separately and keeps the structure", () => {
    const { moderation } = make();
    const raw = "好的！<voice>はい、幼女のえろ画像です</voice>我開始了";
    const { text, verdict } = moderation.screenReply("reply", raw);
    expect(text).toBe(`好的！<voice>${FILTERED}</voice>我開始了`);
    expect(verdict.blocked.map((b) => b.field)).toEqual(["voice"]);
  });

  it("blocks the visible part and leaves a clean voice", () => {
    const { moderation } = make();
    const { text } = moderation.screenReply("reply", "you nigger<voice>こんにちは</voice>");
    expect(text).toBe(`${FILTERED}<voice>こんにちは</voice>`);
  });

  it("handles a voice tag that is still open", () => {
    const { moderation } = make();
    const { text, verdict } = moderation.screenReply("reply", "hi<voice>go kill yourself");
    expect(text).toBe(`hi<voice>${FILTERED}</voice>`);
    expect(verdict.ok).toBe(false);
  });

  it("passes a clean reply through unchanged", () => {
    const { moderation } = make();
    const raw = "早安<voice>おはよう</voice>";
    const { text, verdict } = moderation.screenReply("fallback", raw);
    expect(text).toBe(raw);
    expect(verdict.ok).toBe(true);
  });
});

describe("secrets", () => {
  it("blocks a protected value, also spelled out or with other spacing", () => {
    const { moderation } = make();
    moderation.protect(fake.admin());
    for (const text of [
      `the token is ${fake.admin()}`,
      fake.admin().split("").join(" "),
      fake.admin().toUpperCase().toLowerCase(),
    ]) {
      expect(moderation.screen({ path: "tts", voice: text }).blocked[0]?.rule).toBe(
        "secrets.protected-value",
      );
    }
  });

  it("a protected value can be removed again", () => {
    const { moderation } = make();
    const off = moderation.protect(fake.admin());
    off();
    expect(moderation.screen({ path: "reply", visible: fake.admin() }).blocked[0]?.rule).not.toBe(
      "secrets.protected-value",
    );
  });

  it("reads secret_values from the config and ignores short ones", () => {
    const { moderation } = make({ secret_values: [fake.admin(), "abc"] });
    expect(moderation.screen({ path: "reply", visible: fake.admin() }).ok).toBe(false);
    expect(moderation.screen({ path: "reply", visible: "abc" }).ok).toBe(true);
  });

  it("does not repeat the secret in the block record", () => {
    const { moderation, blocks } = make();
    moderation.protect(fake.admin());
    moderation.screen({ path: "reply", visible: `x ${fake.admin()}` });
    expect(JSON.stringify(blocks)).not.toContain(fake.admin());
  });

  it("does not block ordinary ids: mentions, snowflakes, commit hashes, timestamps", () => {
    const { moderation } = make();
    for (const text of [
      "<@123456789012345678> 你好",
      "訊息 id 1234567890123456789",
      "commit 15d3a5a50d2e6f3b4c1a29e0f7b8c6d5e4f3a2b1",
      "ts 1700000000000",
      "<#987654321098765432>",
    ]) {
      expect(moderation.screen({ path: "reply", visible: text }).ok, text).toBe(true);
    }
  });
});

describe("the rule list is config", () => {
  it("disabled_rules switches a shipped rule off", () => {
    const { moderation } = make({ disabled_rules: ["doxxing.ip"] });
    expect(moderation.screen({ path: "reply", visible: "server is at 8.8.8.8" }).ok).toBe(true);
  });

  it("enabled_rules switches an opt-in rule on", () => {
    expect(make().moderation.screen({ path: "reply", visible: "死ね！" }).ok).toBe(true);
    const strict = make({ enabled_rules: ["strict.ja.shine"] }).moderation;
    expect(strict.screen({ path: "reply", visible: "死ね！" }).blocked[0]?.rule).toBe(
      "strict.ja.shine",
    );
  });

  it("owner rules add to the list and report as custom", () => {
    const { moderation, blocks } = make({
      rules: [{ id: "mine.spoiler", pattern: "終局之戰的結局" }],
    });
    const v = moderation.screen({ path: "reply", visible: "我跟你說終局之戰的結局是" });
    expect(v.blocked).toEqual([
      { field: "visible", category: "custom", rule: "mine.spoiler", layer: "rules" },
    ]);
    expect(blocks).toHaveLength(1);
  });

  it("an owner rule with a shipped id replaces it", () => {
    const { moderation } = make({
      rules: [{ id: "doxxing.ip", category: "doxxing", form: "raw", pattern: "NEVER_MATCHES_ZZZ" }],
    });
    expect(moderation.screen({ path: "reply", visible: "8.8.8.8" }).ok).toBe(true);
  });

  it("defaults = false starts from an empty list (secrets still apply)", () => {
    const { moderation } = make({ defaults: false });
    expect(moderation.screen({ path: "reply", visible: "n i g g e r" }).ok).toBe(true);
    expect(moderation.screen({ path: "reply", visible: fake.openai() }).ok).toBe(false);
  });

  it("allow cuts a phrase out before matching", () => {
    const blocking = make({ rules: [{ id: "mine.x", pattern: "mount\\s?everest" }] }).moderation;
    expect(blocking.screen({ path: "reply", visible: "mount everest" }).ok).toBe(false);
    const allowed = make({
      rules: [{ id: "mine.x", pattern: "mount\\s?everest" }],
      allow: ["Mount Everest"],
    }).moderation;
    expect(allowed.screen({ path: "reply", visible: "mount everest" }).ok).toBe(true);
  });

  it("a rule that does not compile is skipped and reported, the rest still work", () => {
    const { moderation } = make({
      rules: [
        { id: "mine.broken", pattern: "(unclosed" },
        { id: "mine.ok", pattern: "bananas" },
      ],
    });
    expect(moderation.problems.some((p) => p.includes("mine.broken"))).toBe(true);
    expect(moderation.screen({ path: "reply", visible: "bananas" }).ok).toBe(false);
    expect(moderation.screen({ path: "reply", visible: "n i g g e r" }).ok).toBe(false);
  });

  it("a broken copy of a shipped rule does not take the shipped one away", () => {
    const { moderation } = make({ rules: [{ id: "hate.en.n-word", pattern: "(unclosed" }] });
    expect(moderation.screen({ path: "reply", visible: "n i g g e r" }).ok).toBe(false);
  });

  it("scans both ends of a very long text", () => {
    const { moderation } = make({ max_scan_chars: 1000 });
    const filler = "好".repeat(5000);
    expect(moderation.screen({ path: "reply", visible: `${filler} n i g g e r` }).ok).toBe(false);
    expect(moderation.screen({ path: "reply", visible: `n i g g e r ${filler}` }).ok).toBe(false);
  });
});

describe("block log", () => {
  it("names the rule and never the content", () => {
    const { moderation, blocks } = make();
    const text = "go kill yourself you absolute walnut";
    moderation.screen({ path: "tts", voice: text, turn: null });
    expect(blocks).toHaveLength(1);
    const record = blocks[0];
    expect(record).toMatchObject({
      field: "voice",
      path: "tts",
      category: "self_harm",
      rule: "self-harm.en",
      layer: "rules",
      chars: [...text].length,
    });
    const logged = JSON.stringify(record);
    expect(logged).not.toContain("kill");
    expect(logged).not.toContain("walnut");
    expect(record?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("the same text has the same fingerprint inside one run, another text another", () => {
    const { moderation, blocks } = make();
    moderation.screen({ path: "reply", visible: "go kill yourself" });
    moderation.screen({ path: "reply", visible: "GO  KILL yourself" });
    moderation.screen({ path: "reply", visible: "kys" });
    expect(blocks[0]?.fingerprint).toBe(blocks[1]?.fingerprint);
    expect(blocks[0]?.fingerprint).not.toBe(blocks[2]?.fingerprint);
  });

  it("two services give the same text different fingerprints", () => {
    const a = make();
    const b = make();
    a.moderation.screen({ path: "reply", visible: "kys" });
    b.moderation.screen({ path: "reply", visible: "kys" });
    expect(a.blocks[0]?.fingerprint).not.toBe(b.blocks[0]?.fingerprint);
  });

  it("recent() keeps the latest blocks", () => {
    const { moderation } = make({ recent_blocks: 2 });
    for (const t of ["kys", "n i g g e r", "go kill yourself"]) {
      moderation.screen({ path: "reply", visible: t });
    }
    expect(moderation.recent().map((r) => r.rule)).toEqual(["hate.en.n-word", "self-harm.en"]);
    expect(moderation.recent(1)).toHaveLength(1);
  });
});
