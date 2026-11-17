// Her `<feel>` block in the runner (docs/design/v5-heart.md §2.1, §2.9): read line by line, never
// shown or said in text or voice, kept for the host, a reply of only a block is silent.

import { toMessages } from "@miyoria/memory/transcript";
import { describe, expect, it } from "vitest";
import { isFeelLine, limitProposals, parseFeel } from "../src/feel.js";
import { PROFILES } from "../src/profiles.js";
import { StepText } from "../src/screens.js";
import { addressed, calls, done, fakeTool, rig, SESSION, say } from "./harness.js";

const BLOCK = "我: 開心 中\n小明: 羈絆 + 「他記得我上次說想吃的東西」";

describe("reading a feel block", () => {
  it("reads her emotion and the proposals", () => {
    expect(parseFeel(BLOCK)).toEqual({
      self: { word: "開心", emotion: "joy", strength: "medium" },
      lines: [{ name: "小明", field: "bond", direction: "up", quote: "他記得我上次說想吃的東西" }],
      dropped: [],
    });
  });

  it("takes the shapes she may write and drops what does not read", () => {
    const parsed = parseFeel(
      [
        "- 我:難過 強",
        "我: 開心 弱",
        "@Owen：心結＋「他又放我鴿子」",
        "阿哲: 信任 - 沒有遵守約定",
        "阿哲: 好感 + ",
        "阿哲: 愛 + 「?」",
        "我: 很複雜 中",
        "隨便寫寫",
      ].join("\n"),
    );
    expect(parsed.self).toEqual({ word: "難過", emotion: "sorrow", strength: "strong" });
    expect(parsed.lines).toEqual([
      { name: "Owen", field: "grudge", direction: "up", quote: "他又放我鴿子" },
      { name: "阿哲", field: "trust", direction: "down", quote: "沒有遵守約定" },
    ]);
    expect(parsed.dropped.map((d) => d.why)).toEqual([
      "repeated",
      "no_quote",
      "unknown_field",
      "unknown_emotion",
      "malformed",
    ]);
  });

  it("drops a proposal the token limit cut off", () => {
    // The bracket never closes.
    expect(parseFeel("我: 開心 中\n小明: 羈絆 + 「他記得我上次說\n").dropped).toEqual([
      { line: "小明: 羈絆 + 「他記得我上次說", why: "cut" },
    ]);
    // No brackets, the last line, nothing after it: it may have been cut.
    const cut = parseFeel("我: 開心 中\n阿哲: 信任 - 沒有遵守約");
    expect(cut.lines).toEqual([]);
    expect(cut.dropped.map((d) => d.why)).toEqual(["cut"]);
    expect(cut.self?.emotion).toBe("joy");
    // The same line with the block ended after it reads.
    expect(parseFeel("阿哲: 信任 - 沒有遵守約定\n").lines).toEqual([
      { name: "阿哲", field: "trust", direction: "down", quote: "沒有遵守約定" },
    ]);
  });

  it("reads calm as no emotion, and a strength written onto the word", () => {
    expect(parseFeel("我: 平靜 弱").self).toEqual({
      word: "平靜",
      emotion: null,
      strength: "weak",
    });
    expect(parseFeel("我: 開心中").self).toEqual({
      word: "開心",
      emotion: "joy",
      strength: "medium",
    });
    expect(parseFeel("我: 害羞").self?.strength).toBe("medium");
  });

  it("keeps two people and three lines a turn, the same proposal once", () => {
    const p = (person: string, field: string, direction = "up") => ({ person, field, direction });
    const { kept, over } = limitProposals([
      p("a", "bond"),
      p("a", "bond"),
      p("b", "trust"),
      p("c", "bond"),
      p("a", "warmth"),
      p("b", "ease"),
    ]);
    expect(kept).toEqual([p("a", "bond"), p("b", "trust"), p("a", "warmth")]);
    expect(over).toBe(3);
  });

  it("knows a line of a block written without its tags", () => {
    for (const line of [
      "我: 開心 中",
      "我：難過強",
      "小明: 羈絆 + 「謝謝」",
      "Owen：心結 -",
      "</feel>",
    ]) {
      expect(isFeelLine(line), line).toBe(true);
    }
    for (const line of ["我覺得還好", "我: 今天好累", "小明說他很信任你", "好感度+1 哈哈"]) {
      expect(isFeelLine(line), line).toBe(false);
    }
  });
});

/** Every way of cutting `whole` in two. */
function splits(whole: string): string[][] {
  const out: string[][] = [[...whole]];
  for (let i = 0; i <= whole.length; i++) out.push([whole.slice(0, i), whole.slice(i)]);
  return out;
}

describe("a feel block in her text", () => {
  const run = (unit: "line" | "sentence", parts: readonly string[]) => {
    const s = new StepText(unit);
    const out = parts.flatMap((p) => s.push(p));
    const lines = [...out, ...s.finish()].map((l) => l.text);
    return { lines, screen: s };
  };

  it("never reaches a line or a sentence, at any chunk boundary", () => {
    const whole = `<emo:happy>真的嗎!謝謝你。\n今天好開心。<feel>\n${BLOCK}\n</feel>`;
    for (const unit of ["line", "sentence"] as const) {
      for (const parts of splits(whole)) {
        const { lines, screen } = run(unit, parts);
        const said = lines.join("|");
        expect(said, `${unit} ${JSON.stringify(parts)}`).not.toMatch(/feel|我:|羈絆|小明/);
        expect(screen.feel.join("").trim()).toBe(BLOCK);
        expect(screen.silence).toBe(false);
      }
    }
  });

  it("says the sentences before the block as they come; the block adds no wait", () => {
    const s = new StepText("sentence");
    expect(s.push("好啊!我們走吧。").map((l) => l.text)).toEqual(["好啊!"]);
    expect(s.push("<feel>\n我: 開心").map((l) => l.text)).toEqual(["我們走吧。"]);
    expect(s.push(" 中\n</feel>")).toEqual([]);
    expect(s.finish()).toEqual([]);
    expect(s.feel).toEqual(["\n我: 開心 中\n"]);
  });

  it("leaves out lines of a block she wrote without the tags", () => {
    for (const unit of ["line", "sentence"] as const) {
      const { lines, screen } = run(unit, ["好喔\n我: 開心 中\n小明: 羈絆 + 「他記得」\n"]);
      expect(lines, unit).toEqual(["好喔"]);
      expect(screen.feelCut, unit).toBe(2);
    }
  });

  it("is silent when the step is only a block, also after <silence/>", () => {
    for (const text of [
      `<feel>${BLOCK}</feel>`,
      `<silence/><feel>${BLOCK}</feel>`,
      "我: 開心 中",
    ]) {
      const { lines, screen } = run("line", [text]);
      expect(lines, text).toEqual([]);
      expect(screen.silence, text).toBe(true);
    }
    expect(run("line", [`<feel>${BLOCK}</feel>`]).screen.feel).toEqual([BLOCK]);
  });
});

describe("a run with a feel block", () => {
  it("delivers only her words, keeps the block for the host and out of the transcript", async () => {
    const r = await rig([say(`<emo:happy>謝謝你記得!\n<feel>\n${BLOCK}\n</feel>`)]);
    r.line("Owen", "@她 我帶了你上次說想吃的布丁");
    const result = await r.run();
    expect(r.outlet.texts()).toEqual(["謝謝你記得!"]);
    expect(result.outcome).toBe("said");
    expect(result.feel.map((f) => f.trim())).toEqual([BLOCK]);
    const tail = r.transcript.tail(SESSION.id);
    const history = JSON.stringify(toMessages(tail));
    expect(history).not.toMatch(/feel|羈絆/);
  });

  it("is a silent run, with no fixed line, when the reply is only a block", async () => {
    const r = await rig([say(`<feel>${BLOCK}</feel>`)]);
    r.line("Owen", "@她 嗯");
    const result = await r.run();
    expect(result.outcome).toBe("silent");
    expect(r.outlet.texts()).toEqual([]);
    expect(result.feel).toEqual([BLOCK]);
  });

  it("keeps the blocks of every step, around her tool calls", async () => {
    const r = await rig([
      calls([{ name: "web_search", args: {} }], "<feel>我: 害怕 弱</feel>"),
      say("查到了。<feel>我: 開心 中</feel>"),
    ]);
    r.tools.register(fakeTool("web_search", "結果", { core: true }));
    r.line("Owen", "@她 查一下");
    const result = await r.run();
    expect(r.outlet.texts()).toEqual(["查到了。"]);
    expect(result.feel).toEqual(["我: 害怕 弱", "我: 開心 中"]);
  });

  it("is never said in voice, and a block cut by the step's token limit is swallowed", async () => {
    const r = await rig([
      [
        { type: "text_delta", text: "好啊,我們走吧。" },
        { type: "text_delta", text: "\n<feel>\n我: 開心 中\n小明: 羈" },
        done(undefined, "length"),
      ],
    ]);
    r.line("Owen", "@她 走吧");
    const result = await r.run(addressed(), { profile: PROFILES.voice });
    expect(r.outlet.texts()).toEqual(["好啊,我們走吧。"]);
    expect(result.feel.join("")).toContain("我: 開心 中");
  });
});
