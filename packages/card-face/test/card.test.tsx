import { bondBand } from "@miyoria/types/bond";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AFFINITY, CardFace, type CardData } from "../src/index.js";

const PRIMARY = "#123456";

const card = (affinity: string): CardData => ({
  serial: "S-1",
  issued_at: "2026-11-17T00:00:00.000Z",
  name: "Amy",
  number: 1,
  call_name: null,
  relationship: "知心",
  affinity,
  trust: null,
  familiarity: null,
  public_feeling: null,
});

/** How many steps of the meters are lit (only the bond's has a value here). */
const lit = (affinity: string) =>
  (
    renderToStaticMarkup(
      <CardFace
        card={card(affinity)}
        art={null}
        avatar={null}
        colors={{ primary: PRIMARY, secondary: "#654321" }}
        verifyUrl="https://example.invalid/c/S-1"
      />,
    ).match(new RegExp(`<rect[^>]*height="6"[^>]*fill="${PRIMARY}"`, "g")) ?? []
  ).length;

describe("the card's bond meter", () => {
  it("has a step for every word the bond's bands give, up to 1000", () => {
    for (const bond of [-80, -20, 0, 20, 50, 80, 130, 300, 500, 800, 1000]) {
      expect(AFFINITY).toContain(bondBand(bond));
    }
  });

  it("draws the meter for the words above 非常好 too", () => {
    expect(lit("非常好")).toBe(AFFINITY.indexOf("非常好") + 1);
    expect(lit("心意相通")).toBe(AFFINITY.indexOf("心意相通") + 1);
    expect(lit("永恆的羈絆")).toBe(AFFINITY.length);
  });
});

describe("a daily card", () => {
  const draw = (data: CardData) =>
    renderToStaticMarkup(
      <CardFace
        card={data}
        art={null}
        avatar={null}
        colors={{ primary: PRIMARY, secondary: "#654321" }}
        verifyUrl="https://example.invalid/c/S-1"
      />,
    );

  it("prints its rarity, her expression and the parts drawn onto it", () => {
    const svg = draw({
      ...card("很好"),
      rarity: "SR",
      expression: "臉紅",
      parts: [{ name: "單片眼鏡" }, { name: "夜空" }],
    });
    expect(svg).toContain("SR・臉紅・單片眼鏡・夜空");
  });

  it("prints nothing of a draw on an older card", () => {
    expect(draw(card("很好"))).not.toContain("・");
  });

  it("puts its number in the strip, with nothing of the header under it", () => {
    const daily = draw({ ...card("很好"), rarity: "N", parts: [{ name: "夜空" }] });
    expect(daily.match(/No\.001/g)).toHaveLength(1);
    expect(daily).not.toContain("MIYORIA");
    const older = draw(card("很好"));
    expect(older).toContain("MIYORIA");
    expect(older.match(/No\.001/g)).toHaveLength(1);
  });
});
