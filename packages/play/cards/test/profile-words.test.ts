// A card refused for want of coins names the profile's coins (docs/design/v5-profiles.md).

import { describe, expect, it } from "vitest";
import { CARD_TEXTS, refusalText } from "../src/service.js";

describe("a refused card's words", () => {
  it("are today's with no profile, and another profile's coins with one", () => {
    const short = { ok: false, reason: "insufficient", price: 30, balance: 2 } as const;
    expect(refusalText(short)).toBe("魚幣不夠");
    expect(refusalText(short)).toBe(CARD_TEXTS.insufficient);
    expect(refusalText(short, "貝殼")).toBe("貝殼不夠");
    expect(refusalText({ ok: false, reason: "no_foil" }, "貝殼")).toBe(CARD_TEXTS.no_foil);
  });
});
