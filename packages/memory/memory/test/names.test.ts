// `nameLikeWords`: the guess at names in a memory, which keeps them off a card or a slip.

import { describe, expect, it } from "vitest";
import { nameLikeWords, simplify } from "../src/index.js";

const has = (text: string, name: string) => nameLikeWords(text).includes(simplify(name));

describe("nameLikeWords", () => {
  it("finds nicknames, names by a surname and names standing where a person stands", () => {
    expect(has("她說阿凱推薦的那首歌很好聽", "阿凱")).toBe(true);
    expect(has("她找小芸一起逛街", "小芸")).toBe(true);
    expect(has("凱哥和志豪一起直播", "凱哥")).toBe(true);
    expect(has("凱哥和志豪一起直播", "志豪")).toBe(true);
    expect(has("王小明推薦的店", "王小明")).toBe(true);
    expect(has("陳志豪說他很累", "陳志豪")).toBe(true);
    expect(has("雅婷說今天會晚到", "雅婷")).toBe(true);
    expect(has("Kevin 推薦了 Lemon", "Kevin")).toBe(true);
    expect(has("她跟Amy一起去", "Amy")).toBe(true);
    expect(has("老王說要請客", "老王")).toBe(true);
  });

  it("leaves the plain words of a shared memory alone", () => {
    for (const memory of [
      "一起聊過下雨天的事",
      "她問過我喜歡什麼顏色",
      "一起熬夜把那首歌的副歌改了三次",
      "他說下次要換我選歌",
      "她在我低潮的時候陪我聊到天亮",
      "我們一起看過一次日出的直播",
      "有一次她把我的玩笑接得比我還好笑",
      "他在頻道裡一直唱反調",
      "她跟朋友一起去看電影",
    ]) {
      expect(nameLikeWords(memory), memory).toEqual([]);
    }
  });
});
