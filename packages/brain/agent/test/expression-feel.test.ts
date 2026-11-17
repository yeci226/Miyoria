// The `<feel>` block (docs/design/v5-heart.md §2.1): never in what people see or hear, in every
// shape it may come in.

import { describe, expect, it } from "vitest";
import { Expression, ExpressionParser, type Segment } from "../src/index.js";

const BLOCK = "我: 開心 中\n小明: 羈絆 + 「他記得我上次說想吃的東西」";

/** Parses `chunks`; returns the visible text and the feel blocks. */
function parse(chunks: readonly string[]): { text: string; feel: string[]; segments: Segment[] } {
  const parser = new ExpressionParser();
  const segments: Segment[] = [];
  for (const c of chunks) segments.push(...parser.push(c));
  segments.push(...parser.finish());
  let text = "";
  const feel: string[] = [];
  for (const s of segments) {
    if (s.type === "text") text += s.text;
    if (s.type === "feel") feel.push(s.text);
  }
  return { text, feel, segments };
}

/** Every way of cutting `whole` in two, and one character at a time. */
function everySplit(whole: string): string[][] {
  const out: string[][] = [[whole], [...whole]];
  for (let i = 0; i <= whole.length; i++) out.push([whole.slice(0, i), whole.slice(i)]);
  // Three pieces around the tags too.
  for (let i = 0; i < whole.length; i += 3) {
    for (let j = i; j <= whole.length; j += 5) {
      out.push([whole.slice(0, i), whole.slice(i, j), whole.slice(j)]);
    }
  }
  return out;
}

describe("feel blocks", () => {
  it("takes a block at the end out of the text, at every chunk boundary", () => {
    const whole = `<emo:happy>真的嗎!謝謝你~\n<feel>\n${BLOCK}\n</feel>`;
    for (const chunks of everySplit(whole)) {
      const { text, feel } = parse(chunks);
      expect(text.trim(), JSON.stringify(chunks)).toBe("真的嗎!謝謝你~");
      expect(feel.join("").trim(), JSON.stringify(chunks)).toBe(BLOCK);
    }
  });

  it("keeps the words on both sides of a block in the middle", () => {
    const whole = `好啊<feel>${BLOCK}</feel>那就這樣`;
    for (const chunks of everySplit(whole)) {
      const { text, feel } = parse(chunks);
      expect(text, JSON.stringify(chunks)).toBe("好啊那就這樣");
      expect(feel, JSON.stringify(chunks)).toEqual([BLOCK]);
    }
  });

  it("swallows a block that is never closed, to the end of the stream", () => {
    const whole = `嗯嗯<feel>\n${BLOCK}`;
    for (const chunks of everySplit(whole)) {
      const { text, feel } = parse(chunks);
      expect(text, JSON.stringify(chunks)).toBe("嗯嗯");
      expect(feel.join("").trim(), JSON.stringify(chunks)).toBe(BLOCK);
    }
  });

  it("swallows a half-written opening or closing tag at the end", () => {
    for (const tail of ["<fe", "<fee", "<feel", "<feel ", "<FEEL", "</fe", "</feel"]) {
      expect(parse([`好喔${tail}`]).text, tail).toBe("好喔");
      expect(parse(["好喔", tail]).text, tail).toBe("好喔");
    }
    // Too short to tell.
    expect(parse(["好喔<"]).text).toBe("好喔<");
    expect(parse(["好喔<f"]).text).toBe("好喔<f");
    for (const tail of ["</", "</f", "</fe", "</fee", "</feel", "</feel "]) {
      const { text, feel } = parse([`好<feel>我: 開心 弱${tail}`]);
      expect(text, tail).toBe("好");
      expect(feel, tail).toEqual(["我: 開心 弱"]);
    }
  });

  it("takes the other shapes: case, attributes, self-closing, a stray close, no `>`", () => {
    expect(parse([`<FEEL>${BLOCK}</FEEL>好`]).text).toBe("好");
    expect(parse([`<Feel mood="x">${BLOCK}</feel >好`]).text).toBe("好");
    expect(parse(["好<feel/>啊"]).text).toBe("好啊");
    expect(parse(["好<feel />啊"]).feel).toEqual([""]);
    expect(parse(["好啊</feel>"]).text).toBe("好啊");
    expect(parse([`好啊<feel\n${BLOCK}\n</feel>`]).text).toBe("好啊");
    expect(
      parse([`好啊<feel\n${BLOCK}\n</feel>`])
        .feel.join("")
        .trim(),
    ).toBe(BLOCK);
    // `</feeling>` inside is part of the block.
    expect(parse(["<feel>a</feeling>b</feel>c"])).toMatchObject({
      text: "c",
      feel: ["a</feeling>b"],
    });
    // Two blocks.
    expect(parse(["<feel>a</feel>x<feel>b</feel>"])).toMatchObject({ text: "x", feel: ["a", "b"] });
  });

  it("leaves words that only look like the tag", () => {
    expect(parse(["<feeling>好</feeling>"]).text).toBe("<feeling>好</feeling>");
    expect(parse(["I <feel> it"]).text).toBe("I ");
    expect(parse(["a < feel b"]).text).toBe("a < feel b");
  });

  it("is silent when the reply is only a block, and the block is still read", () => {
    const e = Expression.parse(`<feel>${BLOCK}</feel>`);
    expect(e.isSilent()).toBe(true);
    expect(e.feel).toEqual([BLOCK]);
    const quiet = Expression.parse(`<silence/><feel>${BLOCK}</feel>`);
    expect(quiet.silence).toBe(true);
    expect(quiet.feel).toEqual([BLOCK]);
  });

  it("streams the words before a block before the block ends", () => {
    const p = new ExpressionParser();
    expect(p.push("好啊。<fe")).toEqual([{ type: "text", text: "好啊。" }]);
    expect(p.push("el>我: 開心")).toEqual([{ type: "feel_start" }]);
    expect(p.push(" 中</feel>")).toEqual([{ type: "feel", text: "我: 開心 中" }]);
    expect(p.finish()).toEqual([]);
  });
});
