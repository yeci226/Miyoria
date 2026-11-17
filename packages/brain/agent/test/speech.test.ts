import { describe, expect, it } from "vitest";
import { isSpeakable, LONG_CLAUSE_CHARS, SentenceSplitter } from "../src/index.js";

function split(chunks: string[]): string[] {
  const s = new SentenceSplitter();
  const out: string[] = [];
  for (const c of chunks) out.push(...s.push(c));
  const rest = s.flush();
  if (rest !== null) out.push(rest);
  return out;
}

describe("speech", () => {
  it("splits_at_sentence_ends", () => {
    expect(split(["哼,才不是在等你呢。你回來了喔?好啦!"])).toEqual([
      "哼,才不是在等你呢。",
      "你回來了喔?",
      "好啦!",
    ]);
    expect(split(["wait! what?ok"])).toEqual(["wait!", "what?", "ok"]);
    expect(split(["第一行\n第二行"])).toEqual(["第一行", "第二行"]);
    expect(split(["哼~才怪"])).toEqual(["哼~", "才怪"]);
    expect(split(["  \n "])).toEqual([]);
  });

  it("keeps_end_runs_and_closers_together", () => {
    expect(split(["現在都中午了好嗎……早啦。"])).toEqual(["現在都中午了好嗎……", "早啦。"]);
    expect(split(["真的?!", "假的"])).toEqual(["真的?!", "假的"]);
    expect(split(["她說「好。」然後"])).toEqual(["她說「好。」", "然後"]);
    // The run continues in the next chunk.
    expect(split(["好嗎…", "…早啦"])).toEqual(["好嗎……", "早啦"]);
  });

  it("streams_sentences_as_they_complete", () => {
    const s = new SentenceSplitter();
    expect(s.push("你好")).toEqual([]);
    expect(s.push("啊。"), "end at buffer end waits").toEqual([]);
    expect(s.push("今天")).toEqual(["你好啊。"]);
    expect(s.push("呢?明")).toEqual(["今天呢?"]);
    expect(s.flush()).toBe("明");
    expect(s.flush()).toBeNull();

    expect(s.push("一半")).toEqual([]);
    expect(s.flushComplete()).toBeNull();
    expect(s.push("。")).toEqual([]);
    expect(s.flushComplete()).toBe("一半。");
    expect(s.flushComplete()).toBeNull();
  });

  it("long_clauses_are_cut_at_commas", () => {
    const short = "短短的,還不用切";
    expect(split([short])).toEqual([short]);
    const head = "啊".repeat(LONG_CLAUSE_CHARS);
    expect(split([`${head},後面還有,再一句`])).toEqual([`${head},`, "後面還有,再一句"]);
    const ascii = `${"a".repeat(LONG_CLAUSE_CHARS + 2)}, and more`;
    expect(split([ascii]).length).toBe(2);
    // Full-width commas and end marks count too.
    expect(split([`${head}，後面。`])).toEqual([`${head}，`, "後面。"]);
    expect(split(["好！真的？"])).toEqual(["好！", "真的？"]);
  });

  it("speakable_text", () => {
    expect(isSpeakable("哼。")).toBe(true);
    expect(isSpeakable("ok")).toBe(true);
    expect(isSpeakable("3")).toBe(true);
    expect(isSpeakable("……!")).toBe(false);
    expect(isSpeakable("🐋✨")).toBe(false);
  });
});
