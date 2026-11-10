import { describe, expect, it } from "vitest";
import { herStatusHint, parseBudgetState, shownHint } from "../src/index.js";

describe("signals", () => {
  it("shown emotion hint: a fact about her, never how to act it nor which tag", () => {
    const hint = shownHint({
      from: "shy",
      tag: "embarrassed",
      style: "兇回去、嫌棄對方,但臉紅了",
      masked: true,
    });
    expect(hint).toBe("這份感受你不太想讓人看出來。");
    expect(hint).not.toContain("兇回去");
    expect(hint).not.toContain("<emo:");
    // Joy shows as it is, masked or not: the mood line names it.
    expect(shownHint({ from: "joy", tag: "smug", style: "表面淡定", masked: true })).toBe("");
    expect(shownHint({ from: "shy", tag: "embarrassed", style: "害羞", masked: false })).toBe("");
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
