// The picture of a gift she kept (docs/design/economy.md §16): the gift, her line, the day, and
// nothing that reads like a price or a bond.

import { describe, expect, it } from "vitest";
import { layoutPicture, PICTURE_SAMPLES } from "../src/pictures/index.js";

describe("the gift picture", () => {
  it("draws the gift, her line and the day, with no price", () => {
    const layout = layoutPicture("gift", PICTURE_SAMPLES.gift);
    const svg = layout.svg(null);
    expect(svg).toContain("一杯珍奶");
    expect(svg).toContain("她很喜歡");
    expect(svg).toContain("2026-11-21");
    expect(layout.alt).toContain("小魚乾送她的「一杯珍奶」");
    expect(layout.alt).toContain("珍珠好多");
    expect(svg).not.toMatch(/魚幣|羈絆/);
  });

  it("escapes what the member named", () => {
    const svg = layoutPicture("gift", { ...PICTURE_SAMPLES.gift, item: '<b>&"x"' }).svg(null);
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;b&gt;");
  });
});
