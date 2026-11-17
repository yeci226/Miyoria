// Links and code blocks in spoken replies.

import { describe, expect, it } from "vitest";
import { type FencedPiece, FenceSplitter, LinkSplitter } from "../src/index.js";

function run(
  splitter: { push(t: string): FencedPiece[]; flush(): FencedPiece[] },
  chunks: string[],
) {
  const out: FencedPiece[] = [];
  for (const c of chunks) out.push(...splitter.push(c));
  out.push(...splitter.flush());
  // Join neighbours of the same kind (chunking is not part of the contract).
  const joined: FencedPiece[] = [];
  for (const p of out) {
    const last = joined.at(-1);
    if (last && last.code === p.code) last.text += p.text;
    else joined.push({ ...p });
  }
  return joined;
}

describe("fences", () => {
  it("separates_code_blocks_even_when_fences_are_split", () => {
    expect(run(new FenceSplitter(), ["給你:``", "`py\nprint(1)\n`", "``好了"])).toEqual([
      { code: false, text: "給你:" },
      { code: true, text: "py\nprint(1)\n" },
      { code: false, text: "好了" },
    ]);
    // An unclosed block is code at the end; single backticks are text.
    expect(run(new FenceSplitter(), ["用 `x` 啦 ```js\nlet a"])).toEqual([
      { code: false, text: "用 `x` 啦 " },
      { code: true, text: "js\nlet a" },
    ]);
  });
});

describe("links", () => {
  it("takes_links_out_before_sentences_are_cut", () => {
    expect(
      run(new LinkSplitter(), ["看這個 htt", "ps://example.com/a?b=1&c", "=2。很好玩"]),
    ).toEqual([
      { code: false, text: "看這個 " },
      { code: true, text: "https://example.com/a?b=1&c=2" },
      { code: false, text: "。很好玩" },
    ]);
    // Trailing punctuation and a link at the very end.
    expect(run(new LinkSplitter(), ["去 http://x.y/z. 或 https://q.r"])).toEqual([
      { code: false, text: "去 " },
      { code: true, text: "http://x.y/z" },
      { code: false, text: ". 或 " },
      { code: true, text: "https://q.r" },
    ]);
    expect(run(new LinkSplitter(), ["沒有連結 h"])).toEqual([{ code: false, text: "沒有連結 h" }]);
  });
});
