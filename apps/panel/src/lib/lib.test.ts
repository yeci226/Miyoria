import { describe, expect, it } from "vitest";
import { foldDiff } from "@/components/diff-view";
import { envelope } from "@/test/envelope";
import { diffLines, diffStats } from "./diff";
import { matchesAny, parseTopics, summarize, topicMatches } from "./events";
import { contextKeyString } from "./format";
import { readJson, readStorage, writeJson, writeStorage } from "./storage";

describe("diffLines", () => {
  it("marks added and removed lines with line numbers", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc\nd");
    expect(d.map((l) => `${l.op}:${l.text}`)).toEqual(["same:a", "del:b", "add:B", "same:c", "add:d"]);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
    expect(d[1]).toMatchObject({ oldNo: 2 });
    expect(d[2]).toMatchObject({ newNo: 2 });
  });

  it("reports no changes for identical text", () => {
    expect(diffStats(diffLines("x\ny", "x\ny"))).toEqual({ added: 0, removed: 0 });
  });

  it("folds long unchanged runs, keeping three lines of context", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "L10");
    const folds = foldDiff(diffLines(before, after)).flatMap((c) => (c.kind === "fold" ? [c.count] : []));
    expect(folds).toEqual([7, 6]);
  });
});

describe("topics", () => {
  it("matches like the kernel's TopicFilter", () => {
    expect(topicMatches("*", "anything")).toBe(true);
    expect(topicMatches("agent.*", "agent.turn.started")).toBe(true);
    expect(topicMatches("agent.*", "agent")).toBe(false);
    expect(topicMatches("agent.*", "agents.x")).toBe(false);
    expect(topicMatches("voice.utterance", "voice.utterance")).toBe(true);
    expect(matchesAny([], "x")).toBe(true);
    expect(matchesAny(parseTopics("voice.*, llm.budget"), "llm.budget")).toBe(true);
    expect(matchesAny(parseTopics("voice.*"), "agent.decision")).toBe(false);
  });

  it("words module states, and shows the payload of a type it does not word", () => {
    expect(summarize(envelope("system.module.state", { module: "m", state: "failed", reason: null }))).toEqual({
      text: "m → failed",
      tone: "danger",
    });
    expect(summarize(envelope("llm.budget", { state: "degraded" }))).toEqual({
      text: '{"state":"degraded"}',
      tone: "warn",
    });
    expect(summarize(envelope("voice.latency", null))).toEqual({ text: "", tone: "neutral" });
  });

  it("summarizes decisions", () => {
    const env = envelope("agent.decision", {
      turn: "t",
      context: { platform: "discord", scope: "g", channel: "c", kind: "channel" },
      respond: false,
      score: 0.3,
      reasons: ["too busy"],
    });
    expect(summarize(env)).toEqual({ text: "略過 · 分數 0.30 · too busy", tone: "neutral" });
  });
});

describe("format", () => {
  it("renders context keys like packages/types", () => {
    expect(contextKeyString({ platform: "discord", scope: "1", channel: "2", kind: "channel" })).toBe("discord:1:2");
    expect(contextKeyString({ platform: "discord", scope: null, channel: "9", kind: "voice" })).toBe("discord:dm:voice:9");
  });
});

describe("storage", () => {
  it("round-trips values and survives a throwing localStorage", () => {
    writeStorage("k", "v");
    expect(readStorage("k")).toBe("v");
    writeJson("j", { a: 1 });
    expect(readJson("j", null)).toEqual({ a: 1 });

    const orig = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      writeStorage("x", "memory-only");
      expect(readStorage("x")).toBe("memory-only");
      expect(readJson("missing", 42)).toBe(42);
    } finally {
      if (orig) Object.defineProperty(window, "localStorage", orig);
    }
  });
});
