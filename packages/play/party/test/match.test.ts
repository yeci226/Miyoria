// Forgiving answer matching: what speech recognition does to an answer must not cost the point,
// and a near miss must never give the answer away.

import { describe, expect, it } from "vitest";
import {
  asksToStop,
  closeness,
  editDistance,
  fold,
  judgeAnswer,
  numbersIn,
  similarity,
} from "../src/match.js";

describe("fold", () => {
  it("meets the recognizer halfway: variants, simplified characters, case and punctuation", () => {
    expect(fold("臺灣!")).toBe(fold("台湾"));
    expect(fold("東京。")).toBe(fold("东京"));
    expect(fold("Shape of You")).toBe("shapeofyou");
    expect(fold("Ｈ２Ｏ")).toBe("h2o");
  });

  it("measures edits and the best stretch of a longer line", () => {
    expect(editDistance("晴天", "情天")).toBe(1);
    expect(similarity(fold("我覺得是哈姆雷德吧"), fold("哈姆雷特"))).toBe(0.75);
  });
});

describe("judgeAnswer", () => {
  it("finds the answer inside filler", () => {
    expect(judgeAnswer("嗯…是玉山吧", ["玉山"])).toBe("hit");
    expect(judgeAnswer("答案是东京", ["東京"])).toBe("hit");
  });

  it("forgives one wrong character in four, not in two", () => {
    expect(judgeAnswer("哈姆雷德", ["哈姆雷特"])).toBe("hit");
    expect(judgeAnswer("情天", ["晴天"])).toBe("close");
    expect(judgeAnswer("不知道", ["玉山"])).toBe("miss");
  });

  it("takes any accepted form, and most of a long title", () => {
    expect(judgeAnswer("達芬奇", ["達文西", "達芬奇"])).toBe("hit");
    expect(judgeAnswer("shape of you", ["Shape of You"])).toBe("hit");
    expect(judgeAnswer("說好不哭wi", ["說好不哭with五月天"])).toBe("close");
    expect(judgeAnswer("說好", ["說好不哭with五月天"])).toBe("miss");
    expect(judgeAnswer("說好不哭with五", ["說好不哭with五月天"])).toBe("hit");
  });

  it("wants numbers exactly, said in digits or in Chinese", () => {
    expect(numbersIn(fold("十七天"))).toEqual(["17"]);
    expect(judgeAnswer("七個", ["7"])).toBe("hit");
    expect(judgeAnswer("十七", ["7"])).toBe("miss");
    expect(judgeAnswer("一百八十度", ["180"])).toBe("hit");
    expect(judgeAnswer("八八六", ["886"])).toBe("hit");
    expect(judgeAnswer("12個", ["12"])).toBe("hit");
    expect(judgeAnswer("112", ["12"])).toBe("miss");
  });

  it("says how near a miss is without the answer", () => {
    const near = closeness("情天", ["晴天"]);
    expect(near).toBe("差 1 個字(答案 2 個字)");
    expect(near).not.toContain("晴");
  });
});

describe("asksToStop", () => {
  it("hears a request to stop, not a story about one", () => {
    expect(asksToStop("好啦不玩了")).toBe(true);
    expect(asksToStop("結束遊戲")).toBe(true);
    expect(asksToStop("我們先不玩了吧")).toBe(true);
    expect(asksToStop("然後遊戲結束之後大家都回家睡覺了")).toBe(false);
    expect(asksToStop("我還要玩")).toBe(false);
  });
});
