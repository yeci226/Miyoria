import type { ToolEntry } from "@miyoria/llm/tools";
import { describe, expect, it } from "vitest";
import {
  PREFIX_PROFILE,
  PROFILE_NAMES,
  PROFILES,
  VOICE_TOOLS,
  withLimits,
} from "../src/profiles.js";
import {
  BASE_RULES,
  LIMIT_NOTE_QUIET,
  LIMIT_NOTES,
  PROFILE_NOTES,
  RULES,
  rulesFor,
} from "../src/rules.js";
import { addressed, calls, fakeTool, rig, say } from "./harness.js";

const entry = (name: string, effect: ToolEntry["effect"]): ToolEntry =>
  ({ name, effect }) as unknown as ToolEntry;

describe("profiles", () => {
  it("has the four, with their limits", () => {
    expect(PROFILE_NAMES).toEqual(["text", "voice", "subagent", "reflect"]);
    expect(PROFILES.text.limits).toMatchObject({ rounds: 10, sessionUsdPerHour: 1 });
    expect(PROFILES.text).toMatchObject({
      reasoning: null,
      reasoningPurpose: "chat_text",
      speaks: true,
    });
    expect(PROFILES.voice.limits).toMatchObject({ rounds: 2, wallMs: 12_000 });
    expect(PROFILES.voice).toMatchObject({ reasoning: "off", maxStepTokens: 600, speaks: true });
    expect(PROFILES.subagent).toMatchObject({ speaks: false, reasoning: "high" });
    expect(PROFILES.subagent.limits.tokens).toBeGreaterThan(PROFILES.text.limits.tokens);
    expect(PROFILES.reflect).toMatchObject({ speaks: false, reasoning: "high" });
    for (const name of PROFILE_NAMES) {
      const l = PROFILES[name].limits;
      expect(l.sessionUsdPerHour).toBe(1);
      expect(l.sessionTokensPerHour).toBeGreaterThan(0);
      expect(l.callsPerRound).toBeGreaterThan(0);
      expect(l.toolMs).toBeLessThanOrEqual(l.wallMs);
    }
  });

  it("offers: voice what text does (its calls a short list); subagent and reflect nothing that speaks", () => {
    expect(PROFILES.text.offers(entry("say", "say"))).toBe(true);
    expect(PROFILES.voice.offers(entry("web_search", "read"))).toBe(true);
    expect(PROFILES.voice.offers(entry("react", "say"))).toBe(true);
    expect(PREFIX_PROFILE.voice).toBe("text");
    expect([...VOICE_TOOLS]).toContain("find_tools");
    expect([...VOICE_TOOLS]).toContain("sing_start");
    // She decides on her own to watch a friend's stream, in voice, so the three tools are allowed.
    expect([...VOICE_TOOLS]).toEqual(
      expect.arrayContaining(["watch_start", "watch_stop", "watch_look"]),
    );
    expect([...VOICE_TOOLS]).not.toContain("react");
    for (const name of ["subagent", "reflect"] as const) {
      expect(PROFILES[name].offers(entry("say", "say"))).toBe(false);
      expect(PROFILES[name].offers(entry("react", "say"))).toBe(false);
      expect(PROFILES[name].offers(entry("web_search", "read"))).toBe(true);
    }
  });

  it("withLimits replaces only what it is given", () => {
    const p = withLimits(PROFILES.text, { rounds: 3 });
    expect(p.limits).toEqual({ ...PROFILES.text.limits, rounds: 3 });
    expect(PROFILES.text.limits.rounds).toBe(10);
  });

  it("each profile adds its note to the rules", () => {
    expect(rulesFor("text")).toBe(RULES);
    expect(rulesFor("voice")).toBe(`${RULES}\n${PROFILE_NOTES.voice}`);
    // The background profiles never apply a feel block, so they are not told of it.
    for (const profile of ["subagent", "reflect"] as const) {
      expect(rulesFor(profile)).not.toContain("<feel>");
      expect(rulesFor(profile).startsWith(BASE_RULES)).toBe(true);
    }
    expect(RULES).toContain("<feel>");
  });

  it("voice: two rounds, no reasoning, a cap on a step", async () => {
    const r = await rig([calls([{ name: "web_search" }])]);
    r.tools.register(fakeTool("web_search"));
    r.line("Owen", "@她 查一下");
    const result = await r.run(addressed(), { profile: PROFILES.voice });
    expect(r.model.requests).toHaveLength(3);
    expect(r.model.requests[0]).toMatchObject({
      reasoning: "off",
      reasoning_purpose: "chat_voice",
      max_tokens: 600,
    });
    expect(result.limits).toEqual(["rounds"]);
    const last = r.model.requests[2]?.messages.at(-1);
    expect(last?.content).toBe(LIMIT_NOTES.rounds);
    // What she says is spoken.
    expect(r.transcript.tail("s1").entries.find((e) => e.kind === "tool_calls")?.spoken).toBe(true);
  });

  it("reflect: high reasoning, nothing said, the last text is the result", async () => {
    const r = await rig([say("我整理好了三件事。")]);
    const result = await r.run({ kind: "self", note: "每晚的整理" }, { profile: PROFILES.reflect });
    expect(r.model.requests[0]).toMatchObject({ reasoning: "high", reasoning_purpose: "reflect" });
    expect(r.outlet.lines).toEqual([]);
    expect(result).toMatchObject({ outcome: "said", text: "我整理好了三件事。", lines: [] });
  });

  it("a quiet profile at a limit is told in its own words", async () => {
    const r = await rig([calls([{ name: "look" }])]);
    r.tools.register(fakeTool("look"));
    await r.run(
      { kind: "self", note: null },
      { profile: withLimits(PROFILES.subagent, { rounds: 1 }) },
    );
    expect(r.model.requests[1]?.messages.at(-1)?.content).toBe(LIMIT_NOTE_QUIET);
  });
});
