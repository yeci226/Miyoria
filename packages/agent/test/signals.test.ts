import { describe, expect, it } from "vitest";
import { herStatusHint, parseBudgetState, shownHint } from "../src/index.js";

describe("signals", () => {
  it("shown emotion hint: her lines and tags follow what she shows", () => {
    const hint = shownHint({
      from: "shy",
      tag: "embarrassed",
      style: "兇回去、嫌棄對方,但臉紅了",
      masked: true,
    });
    expect(hint).toBe(
      "你現在表現出來的樣子:兇回去、嫌棄對方,但臉紅了。台詞和 <emo:…> 照這個走(多半是 <emo:embarrassed>);心裡真正的感受藏起來,不要直接說出來",
    );
    // Only a plain tag name gets through.
    expect(shownHint({ from: "joy", tag: "x>y", style: "開心", masked: false })).toContain(
      "<emo:neutral>",
    );
  });

  it("parses_budget_states", () => {
    expect(parseBudgetState("OK")).toBe("ok");
    expect(parseBudgetState("degraded")).toBe("degraded");
    expect(parseBudgetState("exhausted")).toBe("exhausted");
    expect(() => parseBudgetState("broke")).toThrow("unknown budget state `broke`");
  });
});

describe("herStatusHint", () => {
  it("states where she is, whether she is live and what she plays", () => {
    const base = {
      voice: null,
      voice_name: null,
      golive: null,
      streaming: false,
      scene: null,
      game: null,
    };
    expect(herStatusHint(base)).toBe("你現在不在語音頻道、沒有在直播、沒有在玩遊戲。");
    expect(
      herStatusHint({
        ...base,
        voice: { platform: "discord", scope: "g", channel: "vc", kind: "voice" },
        voice_name: "active-only",
        golive: "live",
        game: "Minecraft",
      }),
    ).toBe("你現在在語音頻道 active-only、正在 Go Live 直播、正在玩 Minecraft。");
  });
});
