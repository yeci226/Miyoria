// The one-of-a-kind frame a weekly auction gives (`one-<lot id>`): drawn on the card, the same
// frame the same way every time, two won frames differently, and named 只此一件.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardFace, type CardData, frameName, isUniqueFrame } from "../src/index.js";

const card = (frame: string | null): CardData => ({
  serial: "S-1",
  issued_at: "2026-11-17T00:00:00.000Z",
  name: "Amy",
  number: 1,
  call_name: null,
  relationship: "知心",
  affinity: null,
  trust: null,
  familiarity: null,
  public_feeling: null,
  frame,
});

const draw = (frame: string | null) =>
  renderToStaticMarkup(
    <CardFace
      card={card(frame)}
      art={null}
      avatar={null}
      colors={{ primary: "#123456", secondary: "#654321" }}
      verifyUrl="https://example.invalid/c/S-1"
    />,
  );

/** The stop colours of the frame's band. */
const stops = (svg: string) =>
  [...svg.matchAll(/<linearGradient id="one-[^"]*"[\s\S]*?<\/linearGradient>/g)]
    .flatMap((m) => [...m[0].matchAll(/stop-color="(#[0-9a-f]{6})"/g)].map((s) => s[1]));

describe("the one-of-a-kind frame", () => {
  it("is drawn from its id, the same each time and different from another", () => {
    const one = draw("one-01JLOT0000000000000000AA");
    expect(stops(one)).toHaveLength(4);
    expect(stops(draw("one-01JLOT0000000000000000AA"))).toEqual(stops(one));
    expect(stops(draw("one-01JLOT0000000000000000BB"))).not.toEqual(stops(one));
    expect(stops(draw("gold"))).toEqual([]);
  });

  it("is named 只此一件, and the shop's frames keep their names", () => {
    expect(isUniqueFrame("one-X")).toBe(true);
    expect(isUniqueFrame("gold")).toBe(false);
    expect(frameName("one-X")).toBe("只此一件");
    expect(frameName("gold")).toBe("金框");
    expect(frameName(null)).toBeNull();
  });
});
