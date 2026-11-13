// 2026-11-10, in a DM: 「卤化银除了 AgF 以外全沉…」. She writes Traditional Chinese.

import { describe, expect, it } from "vitest";
import { cleanReply, toTraditional } from "../src/index.js";

describe("toTraditional", () => {
  it("writes what came out in Simplified in Traditional", () => {
    expect(
      toTraditional(
        "卤化银除了 AgF 以外全沉、硫酸盐里 Ba²⁺、Pb²⁺、Ca²⁺ 会沉、碳酸盐几乎全沉……大概就这些最容易考。",
      ),
    ).toBe(
      "鹵化銀除了 AgF 以外全沉、硫酸鹽裡 Ba²⁺、Pb²⁺、Ca²⁺ 會沉、碳酸鹽幾乎全沉……大概就這些最容易考。",
    );
    expect(toTraditional("这个视频你看过没")).toBe("這個影片你看過沒");
  });

  it("leaves Traditional, and characters Traditional uses too, as she wrote them", () => {
    for (const text of [
      "我沒有亂，只是同時有四件事在跑。",
      "上台",
      "台北好熱",
      "小丑",
      "皇后",
      "茶几",
      "後台的事我不管",
      "哼,才不要。",
      "OK lol",
      "",
    ]) {
      expect(toTraditional(text), text).toBe(text);
    }
  });

  it("in a line that mixes both, only the Simplified characters change", () => {
    expect(toTraditional("這个我知道")).toBe("這個我知道");
  });

  it("leaves Japanese alone", () => {
    expect(toTraditional("えっ、本当に?这个")).toBe("えっ、本当に?这个");
  });

  it("is part of cleaning her reply", () => {
    expect(cleanReply("Miyoria: 这些最容易考", ["Miyoria"])).toBe("這些最容易考");
  });
});
