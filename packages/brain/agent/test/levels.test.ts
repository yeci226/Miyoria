// The owner's per-channel levels (docs/design/autonomy.md §21): which levels are a ceiling on her
// own talkativeness, reading the old `ambient`, and how the level is shown to her. (The glances a
// level allows are the runner's triage; the gap between her own starts is her initiative's gates.)

import type { ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  AgentConfigSchema,
  CEILINGS,
  ChannelModeSchema,
  ceilingFor,
  levelHint,
  parseChannelMode,
} from "../src/index.js";
import { tctx } from "./fixtures.js";

const TEXT = tctx("channel");
const VOICE: ContextKey = tctx("voice");

describe("channel levels", () => {
  it("are a ceiling in text channels only", () => {
    expect(ceilingFor("quiet", TEXT)).toBe(CEILINGS.quiet);
    expect(ceilingFor("quiet", VOICE)).toBeNull();
    expect(ceilingFor("mention-only", TEXT)).toBeNull();
    expect(ceilingFor("always", TEXT)).toBe(CEILINGS.lively);
  });

  it("read the old `ambient` as normal when typed or saved; config takes the new names only", () => {
    expect(parseChannelMode("ambient")).toBe("normal");
    expect(parseChannelMode("Quiet")).toBe("quiet");
    expect(parseChannelMode("lively")).toBe("lively");
    expect(() => ChannelModeSchema.parse("ambient")).toThrow();
    const cfg = AgentConfigSchema.parse({
      default_mode: "quiet",
      channels: { a: "normal", b: "lively" },
      voice: { default_mode: "normal" },
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
});
