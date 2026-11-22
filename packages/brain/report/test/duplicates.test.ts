// Which words a title is searched by, and which search answer counts as a likely duplicate.

import { describe, expect, it } from "vitest";
import { likelyDuplicate, searchTerms, titleSimilarity } from "../src/duplicates.js";
import { REMOVED } from "../src/sanitize.js";

describe("searchTerms", () => {
  it("keeps the longest words, without filler or what was removed", () => {
    expect(searchTerms(`The voice bot is not answering ${REMOVED.link}`)).toEqual([
      "answering",
      "voice",
      "bot",
    ]);
  });

  it("splits a Chinese title on filler characters", () => {
    expect(searchTerms("語音頻道裡她聽不到人說話")).toEqual(["語音頻道裡", "到人說話"]);
  });

  it("finds nothing to search in a title of filler", () => {
    expect(searchTerms("我的了")).toEqual([]);
  });
});

describe("likelyDuplicate", () => {
  const issues = [
    { number: 3, title: "[voice] 語音頻道裡她聽不到", url: "u3" },
    { number: 4, title: "[sing] 點歌沒有聲音", url: "u4" },
  ];

  it("picks the most alike open issue, ignoring its area prefix", () => {
    expect(likelyDuplicate("語音頻道裡她聽不到人說話", issues)).toMatchObject({ number: 3 });
  });

  it("takes nothing that is only loosely alike", () => {
    expect(likelyDuplicate("金幣不見了", issues)).toBeNull();
    expect(titleSimilarity("金幣不見了", "語音頻道裡她聽不到")).toBeLessThan(0.4);
  });
});
