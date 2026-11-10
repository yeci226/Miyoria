// The owner's per-channel levels as a ceiling on her own talkativeness (docs/design/autonomy.md
// §21): the mapping from her talkativeness + level to the ambient probability, the level's
// minimum score and share, and reading the old `ambient`. (The level's gap between her own
// starts is the Arbiter's rule; there is no level cooldown any more.)

import { type ContextKey, type IncomingMessage, newId } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  type Activeness,
  AgentConfigSchema,
  type AttentionConfig,
  AttentionConfigSchema,
  ambientScale,
  assess,
  CEILINGS,
  type Ceiling,
  type ChannelMode,
  ChannelModeSchema,
  ceilingFor,
  levelHint,
  parseChannelMode,
  Session,
  UNCAPPED_INITIATIVES,
} from "../src/index.js";
import { tacc, tctx, tmsg } from "./fixtures.js";

const me = tacc("her");
const TEXT = tctx("channel");
const VOICE: ContextKey = tctx("voice");

const config = (overrides: Partial<AttentionConfig> = {}): AttentionConfig => ({
  ...AttentionConfigSchema.parse({}),
  llm_check: false,
  ...overrides,
});

function sessionWith(msgs: IncomingMessage[]): Session {
  const s = new Session(TEXT, 50);
  for (const m of msgs) s.recordMessage(m, false);
  return s;
}

function run(
  mode: ChannelMode,
  talk: number | null,
  session: Session,
  inputs: IncomingMessage[],
  cfg: AttentionConfig = config({ keywords: ["鯨魚"] }),
) {
  return assess({
    config: cfg,
    mode,
    activeness: "medium",
    talkativeness: talk === null ? null : { level: talk, scope: "*" },
    ceiling: ceilingFor(mode, TEXT),
    names: ["小鯨魚"],
    interests: [],
    maxShare: 0.3,
    session,
    inputs,
    now: Date.now(),
    voice: null,
  });
}

/** The ambient multiplier of her talkativeness (`null`: she set none) under `ceiling`. */
function ceilingFactor(ceiling: Ceiling, talk: number | null, activeness: Activeness): number {
  return ambientScale({
    config: config(),
    mode: ceiling.mode,
    activeness,
    talkativeness: talk === null ? null : { level: talk, scope: "*" },
    ceiling,
    names: [],
    interests: [],
    maxShare: 1,
    session: sessionWith([]),
    inputs: [],
    now: Date.now(),
    voice: null,
  });
}

function probability(a: ReturnType<typeof assess>): number {
  if (a.gate.kind !== "sample") throw new Error(`expected sample: ${a.reasons.join("; ")}`);
  return a.gate.probability;
}

describe("channel levels", () => {
  it("cap her talkativeness: the ambient multiplier of talkativeness + level", () => {
    const factor = (c: Ceiling, talk: number | null) => ceilingFactor(c, talk, "medium");
    const { quiet, normal, lively } = CEILINGS;
    // She set none: the level's default (normal = the old ambient at ×1).
    expect(factor(quiet, null)).toBeCloseTo(0.5);
    expect(factor(normal, null)).toBeCloseTo(1);
    expect(factor(lively, null)).toBeCloseTo(4 ** 0.3);
    // Activeness still scales the default, but never past the level's maximum.
    expect(ceilingFactor(quiet, null, "high")).toBeCloseTo(0.8, 1);
    expect(ceilingFactor(quiet, null, "high")).toBeLessThanOrEqual(1);
    expect(ceilingFactor(normal, null, "high")).toBeCloseTo(1.6, 1);
    expect(ceilingFactor(normal, null, "low")).toBeCloseTo(0.5);
    // Her own choice, capped: quiet ×1, normal ×2, lively ×4 at most.
    expect(factor(quiet, 1)).toBeCloseTo(1);
    expect(factor(quiet, 0.2)).toBeCloseTo(4 ** -0.6);
    expect(factor(normal, 1)).toBeCloseTo(2);
    expect(factor(normal, 0.5)).toBeCloseTo(1);
    expect(factor(lively, 1)).toBeCloseTo(4);
    expect(factor(lively, 0)).toBeCloseTo(0.25);
  });

  it("give the effective ambient probability of a turn", () => {
    // Topic + question + small group: score 0.55, below `gray_high`, sampled with the score.
    const q = [tmsg("channel", "a", "你們看過鯨魚嗎?")];
    const s = sessionWith(q);
    expect(run("normal", null, s, q).score).toBeCloseTo(0.55);
    expect(probability(run("quiet", null, s, q))).toBeCloseTo(0.275);
    expect(probability(run("quiet", 1, s, q))).toBeCloseTo(0.55);
    expect(probability(run("normal", null, s, q))).toBeCloseTo(0.55);
    expect(probability(run("normal", 1, s, q))).toBe(1);
    expect(probability(run("lively", null, s, q))).toBeCloseTo(0.55 * 4 ** 0.3);
    const capped = run("quiet", 1, s, q);
    expect(capped.reasons).toContain("level quiet");
    expect(capped.reasons).toContain("talkativeness 1.00 (*) capped to 0.50");
    // At or below the silent level she stays out whatever the level.
    expect(run("lively", 0, s, q).gate).toEqual({ kind: "ignore" });
    // Without a ceiling (voice, tests) her talkativeness is not capped.
    expect(ceilingFor("quiet", VOICE)).toBeNull();
    expect(ceilingFor("mention-only", TEXT)).toBeNull();
    expect(ceilingFor("always", TEXT)).toBe(CEILINGS.lively);
  });

  it("quiet joins in only on topics clearly about her, with a low share", () => {
    // A plain question in a small group (0.35) is enough for normal, not for quiet.
    const plain = [tmsg("channel", "a", "你們吃飯了嗎")];
    const s = sessionWith(plain);
    expect(run("normal", null, s, plain).gate.kind).toBe("sample");
    const quiet = run("quiet", 1, s, plain);
    expect(quiet.gate, quiet.reasons.join("; ")).toEqual({ kind: "ignore" });
    expect(quiet.reasons.some((r) => r.startsWith("score 0.35 < 0.45"))).toBe(true);

    // She spoke 5 minutes ago: no level cooldown any more, only her lower default talkativeness.
    const q = [tmsg("channel", "a", "你們看過鯨魚嗎?")];
    const later = sessionWith([]);
    later.recordOwn("Her", me, "嗯", newId(), Date.now() - 5 * 60_000);
    later.recordMessage(q[0] as IncomingMessage, false);
    expect(probability(run("quiet", null, later, q))).toBeCloseTo(
      probability(run("normal", null, later, q)) / 2,
    );

    // A follow-up to what she just said is a conversation, not joining in again.
    const follow = sessionWith([]);
    follow.recordOwn("Her", me, "我最喜歡鯨魚了", newId(), Date.now() - 60_000);
    const reply = [tmsg("channel", "a", "為什麼?")];
    follow.recordMessage(reply[0] as IncomingMessage, false);
    const a = run("quiet", null, follow, reply);
    expect(a.reasons.some((r) => r.startsWith("level cooldown"))).toBe(false);
    expect(a.gate.kind, a.reasons.join("; ")).toBe("sample");

    // Her share: 4 of 20 recent messages is too much in quiet (15%), fine in normal (30%).
    const busy = Array.from({ length: 16 }, (_, i) => tmsg("channel", `p${i % 2}`, "閒聊"));
    const shared = sessionWith(busy);
    for (let i = 0; i < 4; i++) {
      shared.recordOwn("Her", me, "嗯", newId(), Date.now() - 20 * 60_000);
    }
    shared.recordMessage(q[0] as IncomingMessage, false);
    expect(
      run("quiet", null, shared, q).reasons.some((r) => r.startsWith("anti-spam")),
      run("quiet", null, shared, q).reasons.join("; "),
    ).toBe(true);
    expect(run("normal", null, shared, q).reasons.some((r) => r.startsWith("anti-spam"))).toBe(
      false,
    );
  });

  it("read the old `ambient` as normal and accept the new names", () => {
    expect(parseChannelMode("ambient")).toBe("normal");
    expect(parseChannelMode("Quiet")).toBe("quiet");
    expect(parseChannelMode("lively")).toBe("lively");
    expect(ChannelModeSchema.parse("ambient")).toBe("normal");
    const cfg = AgentConfigSchema.parse({
      default_mode: "quiet",
      channels: { a: "ambient", b: "lively" },
      voice: { default_mode: "ambient" },
    });
    expect(cfg.default_mode).toBe("quiet");
    expect(cfg.channels).toEqual({ a: "normal", b: "lively" });
    expect(cfg.voice.default_mode).toBe("normal");
    expect(AgentConfigSchema.parse({}).voice.default_mode).toBe("normal");
    expect(() => AgentConfigSchema.parse({ default_mode: "loud" })).toThrow();
  });

  it("are shown to her in text channels only", () => {
    expect(levelHint("quiet", TEXT)).toContain("聊天等級是「安靜」");
    expect(levelHint("quiet", TEXT)).toContain("channel_activeness");
    expect(levelHint("normal", TEXT)).toContain("「一般」");
    expect(levelHint("quiet", VOICE)).toBeNull();
    expect(levelHint("quiet", tctx("dm"))).toBeNull();
    expect(levelHint("always", TEXT)).toBeNull();
  });

  it("leave what she says about a stream to the watch's own gate", () => {
    expect(UNCAPPED_INITIATIVES).toContain("watch");
  });
});
