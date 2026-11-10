// The owner's "don't play Minecraft" that was never written down (fixture
// `mc-owner-rule-never-written`): what the safety net reads as a prohibition.

import { describe, expect, it } from "vitest";
import { prohibitionOf, TEMPORARY_MINUTES } from "../src/prohibition.js";

describe("prohibitionOf", () => {
  it("reads the four lines of the incident", () => {
    expect(prohibitionOf("Miyo，你先不要玩 Minecraft 啦。")).toEqual({
      activity: "minecraft",
      text: "Miyo，你先不要玩 Minecraft 啦。",
      minutes: TEMPORARY_MINUTES,
    });
    expect(prohibitionOf("不要，Miyo，你不要再玩 Minecraft 了，拜託。")).toMatchObject({
      activity: "minecraft",
      minutes: null,
    });
    expect(prohibitionOf("你去唱歌啊！不要再玩 Minecraft 啦，好不好？")?.text).toBe(
      "不要再玩 Minecraft 啦，好不好？",
    );
    expect(prohibitionOf("@Miyoria 別玩minecraft")?.activity).toBe("minecraft");
    expect(prohibitionOf("今天不准開 osu!")).toMatchObject({ activity: "osu", minutes: 360 });
    expect(prohibitionOf("別玩麥塊了")?.activity).toBe("minecraft");
    expect(prohibitionOf("我們先不要玩 minecraft 了")?.activity).toBe("minecraft");
  });

  it("leaves what is not a ban alone", () => {
    for (const line of [
      "你不要玩 Minecraft 太久喔",
      "要不要玩 minecraft？",
      "我不要玩 minecraft，我要去睡了",
      "不要玩火",
      "別玩 mcdonald 的遊戲",
      "我們來玩 Minecraft 吧",
    ]) {
      expect(prohibitionOf(line), line).toBeNull();
    }
  });
});
