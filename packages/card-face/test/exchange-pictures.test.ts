// The exchange's pictures: each one draws (a smoke test of every template), ends with the small
// print, states the colour convention in a legend, and switches red and green with it. The quote
// is a candle chart (candles, MA5/MA20/MA60, volume, the price axis with the last price tagged,
// the date axis, the timeframe in the header); the maps are the shared treemap.

import type { ExchangeQuotePicture, PictureKind } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { layoutMap, tileColor } from "../src/market.js";
import { conventionWord, MA_COLORS, moveColors } from "../src/pictures/exchange.js";
import { layoutPicture, LONG_SAMPLES, PICTURE_SAMPLES } from "../src/pictures/index.js";

const KINDS = [
  "exchange_overview",
  "exchange_quote",
  "exchange_portfolio",
  "exchange_rich",
  "exchange_receipt",
  "exchange_bankrupt",
  "exchange_map",
] as const satisfies readonly PictureKind[];

const BASE = "魚幣是遊戲點數";

describe("the exchange pictures", () => {
  it.each(KINDS)("%s draws, with the small print at the bottom", (kind) => {
    for (const data of [PICTURE_SAMPLES[kind], LONG_SAMPLES[kind]]) {
      const layout = layoutPicture(kind, data as never);
      const svg = layout.svg(null);
      expect(svg).toContain(BASE);
      expect(layout.alt.length).toBeGreaterThan(5);
    }
  });

  it("states the convention and swaps red and green with it", () => {
    expect(moveColors("tw").up).toBe(moveColors("us").down);
    expect(moveColors("tw").down).toBe(moveColors("us").up);
    const tw = layoutPicture("exchange_quote", PICTURE_SAMPLES.exchange_quote).svg(null);
    const us = layoutPicture("exchange_quote", { ...PICTURE_SAMPLES.exchange_quote, colors: "us" }).svg(
      null,
    );
    expect(tw).toContain(conventionWord("tw"));
    expect(us).toContain(conventionWord("us"));
    // Never colour alone: the arrow and sign are written.
    expect(tw).toContain("▲ +1.7%");
  });
});

describe("the quote's candle chart", () => {
  const q = PICTURE_SAMPLES.exchange_quote;
  const svg = (d: ExchangeQuotePicture) => layoutPicture("exchange_quote", d).svg(null);

  it("draws candles in the convention's colours: an up bar red in tw, green in us", () => {
    const up = { o: 100_000, h: 103_000, l: 99_000, c: 102_000, v: 10, label: "1/1" };
    const down = { o: 102_000, h: 102_500, l: 98_000, c: 99_000, v: 20, label: "1/2" };
    const d: ExchangeQuotePicture = { ...q, candles: [up, down, up] };
    const tw = svg(d);
    const us = svg({ ...d, colors: "us" });
    const fills = (s: string) => s.match(/<rect [^>]*fill="(#ef5f5f|#3fc48a)"/g) ?? [];
    expect(fills(tw).some((r) => r.includes(moveColors("tw").up))).toBe(true);
    expect(fills(tw).some((r) => r.includes(moveColors("tw").down))).toBe(true);
    // The same bars in us: up is green.
    expect(moveColors("us").up).toBe("#3fc48a");
    expect(fills(us).length).toBe(fills(tw).length);
    // Volume bars follow the bar's direction too.
    expect(tw).toContain(`fill="${moveColors("tw").up}" fill-opacity="0.55"`);
    expect(us).toContain(`fill="${moveColors("us").down}" fill-opacity="0.55"`);
  });

  it("draws MA5, MA20 and MA60 with their values, the volume, the last price and the timeframe", () => {
    const s = svg(q);
    for (const n of [5, 20, 60]) expect(s).toContain(`MA${n} `);
    for (const color of MA_COLORS) expect(s).toContain(`stroke="${color}"`);
    expect(s).toContain("成交量");
    expect(s).toContain("2,045");
    expect(s).toContain("日線");
    // The date axis: the first and the last bar's labels.
    expect(s).toContain(q.candles.at(-1)?.label);
  });

  it("names the timeframe for each switch", () => {
    for (const [tf, word] of [
      ["intraday", "當日"],
      ["weekly", "週線"],
      ["monthly", "月線"],
    ] as const)
      expect(svg({ ...q, timeframe: tf })).toContain(word);
  });

  it("has no volume pane without volume (the local stocks) and says what moved a local stock", () => {
    const local: ExchangeQuotePicture = {
      ...q,
      code: "RICE",
      currency: "魚幣",
      candles: q.candles.map((k) => ({ ...k, v: null })),
      today: "昨天她被餵了 16 次,比平常多 → 今天開盤 +1.8%",
    };
    const s = svg(local);
    expect(s).not.toContain("成交量");
    expect(s).toContain("昨天她被餵了 16 次");
    expect(layoutPicture("exchange_quote", local).alt).toContain("今天開盤 +1.8%");
  });

  it("draws an empty chart before there are two bars", () => {
    expect(svg({ ...q, candles: [] })).toContain("還沒有 K 線");
  });
});

describe("the heat map picture", () => {
  const m = PICTURE_SAMPLES.exchange_map;

  it("fills each tile by its change and writes its name over its code and its change where it fits", () => {
    const tw = layoutPicture("exchange_map", m).svg(null);
    const us = layoutPicture("exchange_map", { ...m, colors: "us" }).svg(null);
    const big = m.tiles[0];
    expect(tw).toContain(`fill="${tileColor(big?.change ?? 0, "tw")}"`);
    expect(us).toContain(`fill="${tileColor(big?.change ?? 0, "us")}"`);
    // The name first, then the Taiwan code without its board (smaller), then the change.
    expect(tw).toContain(">示範半導體<");
    expect(tw).toContain(">2330<");
    expect(tw.indexOf(">示範半導體<")).toBeLessThan(tw.indexOf(">2330<"));
    expect(tw).toContain("▲ +1.7%");
    expect(tw).toContain("格子大小為預");
    expect(tw).toContain("最多占整張圖的 35%");
    // Sector labels.
    for (const s of ["半導體", "科技", "金融"]) expect(tw).toContain(s);
  });

  it("agrees with the shared layout the panel uses", () => {
    const layout = layoutMap(m.tiles, 484, 300, { header: 16, gap: 2, maxShare: m.max_share });
    const biggest = layout.tiles.find((t) => t.tile.code === "2330.TW");
    const svg = layoutPicture("exchange_map", m).svg(null);
    expect(biggest).toBeDefined();
    if (biggest) expect(svg).toContain(`width="${Math.round(biggest.w * 100) / 100}"`);
  });

  it("no tile is laid out over the map's cap (2330 is two thirds of the weights)", () => {
    const capped = layoutMap(m.tiles, 484, 300, { header: 0, gap: 0, maxShare: m.max_share });
    const area = (t: { w: number; h: number }) => t.w * t.h;
    const all = capped.tiles.reduce((s, t) => s + area(t), 0);
    const big = capped.tiles.find((t) => t.tile.code === "2330.TW");
    expect(big && area(big) / all).toBeCloseTo(0.35, 2);
    const raw = layoutMap(m.tiles, 484, 300, { header: 0, gap: 0 });
    const rawBig = raw.tiles.find((t) => t.tile.code === "2330.TW");
    expect(rawBig && area(rawBig) / all).toBeGreaterThan(0.6);
  });

  it("names the coins as the data does: the default name without a field, another profile's with it", () => {
    const overview = PICTURE_SAMPLES.exchange_overview;
    expect(layoutPicture("exchange_overview", overview).svg(null)).toContain("價格單位:魚幣一股");
    const shell = layoutPicture("exchange_overview", { ...overview, currency: "貝殼" }).svg(null);
    expect(shell).toContain("價格單位:貝殼一股");
    expect(shell).not.toContain("價格單位:魚幣");
    const receipt = { ...PICTURE_SAMPLES.exchange_receipt, side: "sell" as const };
    expect(layoutPicture("exchange_receipt", receipt).svg(null)).toContain("賣出的魚幣已經進錢包。");
    const sold = layoutPicture("exchange_receipt", { ...receipt, currency: "貝殼" }).svg(null);
    expect(sold).toContain("賣出的貝殼已經進錢包。");
  });

  it("names the tiles too small for text in the picture and the alt text", () => {
    const tiny = {
      ...m,
      max_share: 1,
      tiles: [
        { code: "BIG", name: "大", sector: "S", weight: 10_000, change: 0.01 },
        { code: "TINY", name: "小", sector: "S", weight: 1, change: -0.02 },
      ],
    };
    const l = layoutPicture("exchange_map", tiny);
    expect(l.svg(null)).toContain("太小沒寫完的:小(TINY)▼ −2.0%");
    expect(l.alt).toContain("小(TINY)▼ −2.0%");
  });
});
