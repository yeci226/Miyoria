// The heat maps (docs/design/exchange.md §11): the 伺服器持股圖 never lets one person's position be
// read off it (a ticker held by too few people merged into 其他, and 其他 left out when too few
// people are in it), the sectors it uses, the 熱門 maps' sectors and weights from the starter lists,
// the starter lists' config (a plain code or `{ code, sector, weight }`, checked), and the desk's
// maps over real positions.

import { describe, expect, it } from "vitest";
import {
  ExchangeConfigSchema,
  exchangeConfig,
  STARTERS_TW,
  STARTERS_US,
  starterEntries,
} from "../src/config.js";
import type { RealLine } from "../src/real/desk.js";
import { holdingsMap, LOCAL_SECTOR, OTHER_CODE, starterMap } from "../src/real/maps.js";
import { ALICE, BOB, CAROL, local, rig } from "./rig.js";

const line = (
  code: string,
  change: number | null,
  market: RealLine["market"] = "tw",
): RealLine => ({
  code,
  name: `${code} 公司`,
  market,
  price: 100,
  basis: "quote",
  price_date: "2026-11-23",
  price_note: null,
  next_open: null,
  currency: market === "tw" ? "TWD" : market === "local" ? "COIN" : "USD",
  local: null,
  coin_price: 100,
  age_minutes: 1,
  source: "資料來源:Yahoo Finance",
  change,
  at: null,
  open: true,
  stale: false,
  quotes: "intraday",
});

describe("the 伺服器持股圖", () => {
  const lines = new Map(
    [
      line("2330.TW", 0.01),
      line("AAPL", -0.02, "us"),
      line("RICE", 0.03, "local"),
      line("ODD", 0),
    ].map((l) => [l.code, l] as const),
  );
  const sectorOf = (l: RealLine) =>
    l.market === "local" ? LOCAL_SECTOR : l.code === "2330.TW" ? "半導體" : "其他";

  it("sums the server's coins per ticker, and merges one held by too few people into 其他", () => {
    const map = holdingsMap({
      held: [
        { person: "p1", code: "2330.TW", value: 500 },
        { person: "p2", code: "2330.TW", value: 300 },
        { person: "p1", code: "RICE", value: 120 },
        { person: "p3", code: "RICE", value: 80 },
        // One person each: merged.
        { person: "p1", code: "AAPL", value: 999 },
        { person: "p2", code: "ODD", value: 50 },
      ],
      lines,
      sectorOf,
      minHolders: 2,
    });
    const by = Object.fromEntries(map.tiles.map((t) => [t.code, t]));
    expect(by["2330.TW"]).toMatchObject({ weight: 800, sector: "半導體", change: 0.01 });
    expect(by.RICE).toMatchObject({ weight: 200, sector: LOCAL_SECTOR });
    expect(by.AAPL).toBeUndefined();
    expect(by.ODD).toBeUndefined();
    // 其他 holds two people's positions together, with no change and no ticker named.
    expect(by[OTHER_CODE]).toMatchObject({ weight: 1049, change: null, sector: "其他" });
    expect(by[OTHER_CODE]?.basis).toContain("2 檔");
    expect(map.hidden).toBe(0);
    // Nobody is in it anywhere.
    expect(JSON.stringify(map)).not.toMatch(/p1|p2|p3/);
    expect(map.footnote).toContain("少於 2 人持有的併入「其他」");
  });

  it("leaves 其他 out when fewer people than the line are in it, so one position is never shown", () => {
    const map = holdingsMap({
      held: [
        { person: "p1", code: "2330.TW", value: 500 },
        { person: "p2", code: "2330.TW", value: 300 },
        { person: "p1", code: "AAPL", value: 999 },
        { person: "p1", code: "ODD", value: 50 },
      ],
      lines,
      sectorOf,
      minHolders: 2,
    });
    expect(map.tiles.map((t) => t.code)).toEqual(["2330.TW"]);
    expect(map.hidden).toBe(2);
    expect(map.footnote).toContain("只有少數人持有的 2 檔不列出");
    // A higher line merges more.
    const strict = holdingsMap({
      held: [
        { person: "p1", code: "2330.TW", value: 500 },
        { person: "p2", code: "2330.TW", value: 300 },
      ],
      lines,
      sectorOf,
      minHolders: 3,
    });
    expect(strict.tiles).toEqual([]);
    expect(strict.hidden).toBe(1);
  });
});

describe("the 熱門 maps and their config", () => {
  it("take each tile's sector and weight from the starter list, and say the size is a preset", () => {
    const map = starterMap("us", [
      {
        entry: { code: "AAPL", name: "Apple", sector: "科技", weight: 38 },
        line: line("AAPL", 0.01, "us"),
      },
      {
        entry: { code: "NVDA", name: null, sector: "半導體", weight: 45 },
        line: line("NVDA", -0.01, "us"),
      },
      { entry: { code: "GONE", name: null, sector: "其他", weight: 9 }, line: null },
    ]);
    expect(map.tiles.map((t) => [t.code, t.sector, t.weight])).toEqual([
      ["AAPL", "科技", 38],
      ["NVDA", "半導體", 45],
    ]);
    expect(map.footnote).toBe("格子大小為預設權重,非即時市值");
    expect(map.max_share).toBe(1);
    const capped = starterMap("us", [], 0.35);
    expect(capped.footnote).toBe(
      "格子大小為預設權重,非即時市值;單一格最多占整張圖的 35%,超過的縮到這個大小",
    );
    expect(capped.max_share).toBe(0.35);
    expect(map.title).toBe("熱門美股圖");
  });

  it("ship every starter with a sector and a weight", () => {
    const c = exchangeConfig();
    for (const list of [c.starters_tw, c.starters_us])
      for (const e of starterEntries(list)) {
        expect(e.sector.length).toBeGreaterThan(0);
        expect(e.weight).toBeGreaterThan(0);
      }
    expect(starterEntries(c.starters_tw)).toEqual(STARTERS_TW);
    expect(starterEntries(c.starters_us)).toEqual(STARTERS_US);
    expect(STARTERS_TW.find((e) => e.code === "2330")).toMatchObject({ sector: "半導體" });
    // Every shipped Taiwan starter has its zh-TW name, each checked against its code.
    expect(Object.fromEntries(STARTERS_TW.map((e) => [e.code, e.name]))).toEqual({
      "2330": "台積電",
      "2317": "鴻海",
      "2454": "聯發科",
      "2308": "台達電",
      "2382": "廣達",
      "2412": "中華電",
      "2881": "富邦金",
      "2882": "國泰金",
      "2891": "中信金",
      "2303": "聯電",
      "1301": "台塑",
      "2002": "中鋼",
      "0050": "元大台灣50",
      "0056": "元大高股息",
      "00878": "國泰永續高股息",
      "006208": "富邦台50",
    });
    expect(STARTERS_US.every((e) => e.name !== null && /^[ -~]+$/.test(e.name))).toBe(true);
    expect(STARTERS_US.find((e) => e.code === "SPY")).toMatchObject({ sector: "ETF" });
  });

  it("accept a plain code or an entry, fill what is left out, and refuse a bad weight or sector", () => {
    const parsed = ExchangeConfigSchema.parse({
      starters_tw: [
        "2330",
        { code: "0050", name: " 元大台灣50 ", sector: "ETF", weight: 6 },
        { code: "2454" },
      ],
    });
    expect(starterEntries(parsed.starters_tw)).toEqual([
      { code: "2330", name: null, sector: "其他", weight: 1 },
      { code: "0050", name: "元大台灣50", sector: "ETF", weight: 6 },
      { code: "2454", name: null, sector: "其他", weight: 1 },
    ]);
    for (const bad of [
      { code: "2330", weight: 0 },
      { code: "2330", weight: -3 },
      { code: "2330", sector: "" },
      { code: "2330", sector: "一個太長太長太長的產業類別名稱" },
      { sector: "ETF", weight: 1 },
    ])
      expect(
        ExchangeConfigSchema.safeParse({ starters_us: [bad] }).success,
        JSON.stringify(bad),
      ).toBe(false);
  });
});

describe("the desk's maps", () => {
  it("draw the local stocks two people hold, merge one person's into 其他 and leave it out", async () => {
    const r = await rig({ open: true });
    for (const who of [ALICE, BOB, CAROL]) {
      r.wallet.fund(who, 2000);
      await r.service.openAccount(who);
    }
    await r.at(local(0, 12, 30));
    await r.service.real.place(ALICE, { side: "buy", code: "RICE", shares: 2 }, "a1");
    await r.service.real.place(BOB, { side: "buy", code: "RICE", shares: 1 }, "b1");
    await r.service.real.place(CAROL, { side: "buy", code: "NAPS", shares: 1 }, "c1");
    await r.at(local(0, 13, 1));
    const map = r.service.real.map("holdings");
    expect(map.tiles.map((t) => t.code)).toEqual(["RICE"]);
    expect(map.tiles[0]).toMatchObject({ sector: LOCAL_SECTOR });
    expect(map.tiles[0]?.weight).toBeGreaterThan(250);
    expect(map.hidden).toBe(1);
    // No 熱門 ticker validated in this store: an empty map, not an error.
    expect(r.service.real.map("tw").tiles).toEqual([]);
  });
});
