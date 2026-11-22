// The coins' name comes from the profile (docs/design/v5-profiles.md): with none configured every
// line reads as it always has, word for word; with another name the old one never shows.

import { describe, expect, it } from "vitest";
import {
  AMOUNT_CURRENCY,
  AMOUNT_HELP,
  amountExamples,
  amountHelp,
  DEFAULT_CURRENCY,
  EXCHANGE_DISCLAIMER,
  exchangeDisclaimer,
  exchangeSmallPrint,
  parseOrderAmount,
} from "../src/index.js";

describe("the coins' name", () => {
  it("defaults to today's words", () => {
    expect(DEFAULT_CURRENCY).toBe("魚幣");
    expect(AMOUNT_CURRENCY).toBe(DEFAULT_CURRENCY);
    expect(EXCHANGE_DISCLAIMER).toBe(
      "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。",
    );
    expect(exchangeSmallPrint({ real: true, leverage: true })).toBe(
      "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。資料來源:Yahoo Finance,報價可能延遲。槓桿可能讓你賠光錢包和其他持股。",
    );
    expect(AMOUNT_HELP).toBe("寫數字是股數(例如 3、0.5),前面加 $ 是魚幣(例如 $200)");
    expect(amountExamples(2000, "buy")).toBe(
      "1 = 1 股(約 2,000 魚幣)・$200 = 花 200 魚幣(約 0.1 股)",
    );
    expect(parseOrderAmount("$1.5", "buy")).toEqual({
      ok: false,
      message: "魚幣只能是整數:寫數字是股數(例如 3、0.5),前面加 $ 是魚幣(例如 $200)",
    });
  });

  it("uses another profile's name and keeps the small print's meaning", () => {
    const shell = exchangeDisclaimer("貝殼");
    expect(shell).toContain("貝殼是遊戲點數,沒有現金價值");
    expect(shell).toContain("不是投資建議");
    expect(shell).not.toContain("魚幣");
    expect(exchangeSmallPrint({ currency: "貝殼", leverage: true })).not.toContain("魚幣");
    expect(amountHelp("貝殼")).not.toContain("魚幣");
    expect(amountExamples(50, "sell", "貝殼")).not.toContain("魚幣");
    const refused = parseOrderAmount("$2.5", "buy", "貝殼");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).not.toContain("魚幣");
  });

  it("reads the amount the same way, with the configured name as a trailing word", () => {
    for (const [raw, side, currency, want] of [
      ["3", "buy", undefined, { unit: "shares", value: 3 }],
      ["$200", "buy", undefined, { unit: "coins", value: 200 }],
      ["$1,000 魚幣", "buy", undefined, { unit: "coins", value: 1000 }],
      ["$50幣", "buy", undefined, { unit: "coins", value: 50 }],
      ["0.5 股", "sell", undefined, { unit: "shares", value: 0.5 }],
      ["全部", "sell", undefined, { unit: "all", value: 0 }],
      ["$30 貝殼", "buy", "貝殼", { unit: "coins", value: 30 }],
      ["＄３０", "buy", "貝殼", { unit: "coins", value: 30 }],
    ] as const)
      expect(parseOrderAmount(raw, side, currency)).toEqual({ ok: true, amount: want });
    for (const [raw, currency] of [
      ["3 顆", undefined],
      ["3.", undefined],
      ["1,00", undefined],
      ["$30 魚幣", "貝殼"],
      ["-3", undefined],
      ["", undefined],
    ] as const)
      expect(parseOrderAmount(raw, "buy", currency).ok, raw).toBe(false);
  });
});
