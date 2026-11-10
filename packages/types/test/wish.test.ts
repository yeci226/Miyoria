// One wish, one key (wish.ts): the topics of 2026-11-10 in the words each store had for them.

import { describe, expect, it } from "vitest";
import { sameWish, stopsAsking, wishGrams } from "../src/index.js";

describe("the topic of a wish", () => {
  it("is the same thing in the words of a proposal, two promises and a goal", () => {
    const proposal = "問 S 期末報告的結果(答應過的)";
    for (const other of [
      "11:02 之後問 S 期末報告的結果",
      "S 上線時問期末報告",
      "S 說話時接話,也順便問一下期末報告怎麼樣",
    ]) {
      expect(sameWish(proposal, other, "S")).toBe(true);
    }
  });

  it("is not the person, the time or the words every request has", () => {
    expect([...wishGrams("11:02 之後問 S 怎麼樣", "S")]).toEqual([]);
    expect(sameWish("問 S 期末報告", "問 S 生日禮物", "S")).toBe(false);
  });
});

describe("being told she asked already", () => {
  it("closes it: in the DM, several times, stop asking", () => {
    for (const text of [
      "你已經在私訊問過我了",
      "你問我好幾次了",
      "不要再問了啦",
      "你一直問",
      "you already asked me",
    ]) {
      expect(stopsAsking(text)).toBe(true);
    }
  });

  it("an answer or small talk is not that", () => {
    for (const text of ["還不錯,拿了 A", "今天好熱", "我想問你一件事"]) {
      expect(stopsAsking(text)).toBe(false);
    }
  });
});
