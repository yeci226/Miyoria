import { describe, expect, test } from "vitest";
import { MAX_MESSAGE_LEN, splitMessage } from "../src/split.js";

const units = (s: string): number => s.length; // JS string length is UTF-16 code units

describe("splitMessage", () => {
  test("short_text_is_one_chunk", () => {
    expect(splitMessage("hello", 2000)).toEqual(["hello"]);
    expect(splitMessage("  \n ", 2000)).toEqual([]);
  });

  test("prefers_newlines_then_spaces", () => {
    expect(splitMessage("aaaa bbbb\ncccc dddd", 12)).toEqual(["aaaa bbbb", "cccc dddd"]);
    expect(splitMessage("aaaa bbbb cccc", 10)).toEqual(["aaaa bbbb", "cccc"]);
  });

  test("cjk_without_spaces_breaks_after_punctuation", () => {
    const sentence = "今天天氣很好,我們去散步吧。";
    const text = sentence.repeat(300);
    const chunks = splitMessage(text, MAX_MESSAGE_LEN);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(units(c)).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
      expect(c.endsWith("。"), c).toBe(true);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("hard_cuts_respect_char_boundaries", () => {
    const text = "喵".repeat(4500);
    const chunks = splitMessage(text, MAX_MESSAGE_LEN);
    expect(chunks.map((c) => Array.from(c).length)).toEqual([2000, 2000, 500]);
    expect(chunks.join("")).toBe(text);
  });

  test("emoji_count_as_two_units", () => {
    const text = "😀".repeat(1500);
    const chunks = splitMessage(text, MAX_MESSAGE_LEN);
    expect(Array.from(chunks[0] as string)).toHaveLength(1000);
    expect(chunks.join("")).toBe(text);
    // Tiny limits still fit one character per chunk.
    expect(splitMessage("😀😀", 1)).toEqual(["😀", "😀"]);
  });

  test("never_produces_lone_surrogates_or_oversized_chunks", () => {
    const text = "a😀".repeat(2500);
    for (const chunk of splitMessage(text, MAX_MESSAGE_LEN)) {
      expect(units(chunk)).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
      const lone = Array.from(chunk).some((ch) => {
        const code = ch.charCodeAt(0);
        return ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
      });
      expect(lone).toBe(false);
    }
  });

  test("breaks_on_the_last_newline_in_the_second_half_only", () => {
    // A newline in the first half is ignored: the cut happens mid-word instead.
    const text = `ab\n${"c".repeat(20)}`;
    expect(splitMessage(text, 10)).toEqual(["ab\nccccccc", "cccccccccc", "ccc"]);
  });

  test("a_code_block_cut_by_a_break_is_closed_and_opened_again", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `console.log("line ${i} of the program");`);
    const text = `先看程式:\n\`\`\`js\n${lines.join("\n")}\n\`\`\`\n之後的說明`;
    const chunks = splitMessage(text, MAX_MESSAGE_LEN);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(units(chunk)).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
      // Every block a chunk opens, it closes.
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]?.startsWith("```js\n")).toBe(true);
    expect(chunks.at(-1)?.endsWith("```\n之後的說明")).toBe(true);
    // Nothing of the program is lost or repeated.
    const code = chunks.join("\n").match(/console\.log\("line \d+ of the program"\);/g) ?? [];
    expect(code).toEqual(lines);
  });

  test("text_without_a_code_block_is_split_as_before", () => {
    const text = "字".repeat(4500);
    expect(splitMessage(text, MAX_MESSAGE_LEN).map(units)).toEqual([2000, 2000, 500]);
  });

  test("never_cuts_a_custom_emoji_a_mention_or_a_link", () => {
    for (const whole of [
      "<:deepseek_smile:123456789012345678>",
      "<a:wave:123456789012345678>",
      "<@123456789012345678>",
      "<#123456789012345678>",
      "https://example.com/a/long/path?with=query",
    ]) {
      for (let pad = 1960; pad < 2000; pad++) {
        const chunks = splitMessage(`${"字".repeat(pad)}${whole}後面`, MAX_MESSAGE_LEN);
        expect(chunks.filter((c) => c.includes(whole))).toHaveLength(1);
        for (const chunk of chunks) expect(units(chunk)).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
      }
    }
  });
});
