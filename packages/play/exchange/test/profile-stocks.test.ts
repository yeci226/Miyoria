// The five local stocks as a profile names them (docs/design/v5-profiles.md): the defaults are the
// first character's, word for word; another profile's codes, names and anchors are used; a code
// renamed on a database that keeps rows under the old one stops the exchange at start, and a new
// (empty) database takes any codes.

import { heartTables } from "@miyoria/heart/person";
import { Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import { afterEach, describe, expect, it } from "vitest";
import { ExchangeConfigSchema, exchangeConfig, localCompaniesOf } from "../src/config.js";
import { COMPANIES } from "../src/engine/companies.js";
import { ExchangeKey, ExchangeModule } from "../src/module.js";
import { checkLocalCodes } from "../src/real/codes.js";
import type { InstrumentRecord } from "../src/real/store.js";
import { exchangeTables } from "../src/store.js";
import { ALICE, local, OPEN, rig } from "./rig.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const RENAMED = {
  feeding: { code: "FOOD", name: "海帶便當", anchor: 60 },
  songs: { code: "TUNE", name: "Wave Records" },
  silence: { code: "NAPS", name: "打盹床業" },
  game: { code: "CUBE", name: "方塊礦業" },
  model: { code: "DPSK", name: "DipSick AI" },
};

describe("the local stocks of a profile", () => {
  it("are the first character's five, word for word, with no config", () => {
    expect(localCompaniesOf(exchangeConfig())).toEqual([
      {
        role: "feeding",
        code: "RICE",
        name: "白飯食品",
        anchor: 100,
        what_moves: "大家多餵她,白飯食品就容易漲",
        blurb: "穩,大家每天都要吃飯",
      },
      {
        role: "songs",
        code: "WHLE",
        name: "鯨落唱片",
        anchor: 108,
        what_moves: "她唱完的歌越多,鯨落唱片越好",
        blurb: "跟著新歌起伏",
      },
      {
        role: "silence",
        code: "NAPS",
        name: "打盹床業",
        anchor: 88,
        what_moves: "她安靜不說話的時間越長,打盹床業越好",
        blurb: "最穩的一家",
      },
      {
        role: "game",
        code: "CUBE",
        name: "方塊礦業",
        anchor: 116,
        what_moves: "她在遊戲裡達成目標就漲,死掉就跌",
        blurb: "景氣循環,偶爾出事故",
      },
      {
        role: "model",
        code: "DPSK",
        name: "DipSick AI",
        anchor: 94,
        what_moves: "她的模型出錯變多,DipSick AI 就跌",
        blurb: "她的老家。波動大,消息多",
      },
    ]);
    // The old local market's companies, in their old order with their old numbers.
    expect(COMPANIES.map((c) => [c.code, c.name, c.sector, c.blurb, c.beta, c.start])).toEqual([
      ["DPSK", "DipSick AI", "ai", "她的老家。波動大,消息多", 1.3, 10000],
      ["RICE", "白飯食品", "staples", "穩,大家每天都要吃飯", 0.6, 8000],
      ["WHLE", "鯨落唱片", "media", "跟著新歌起伏", 0.9, 6000],
      ["CUBE", "方塊礦業", "resources", "景氣循環,偶爾出事故", 1.1, 5000],
      ["NAPS", "打盹床業", "staples", "最穩的一家", 0.5, 7000],
    ]);
  });

  it("take a profile's codes, names, anchors and words, and write what moves them from the name", () => {
    const c = ExchangeConfigSchema.parse({ local_companies: RENAMED });
    const all = localCompaniesOf(c, "他");
    expect(all[0]).toMatchObject({ code: "FOOD", name: "海帶便當", anchor: 60 });
    expect(all[0]?.what_moves).toBe("大家多餵他,海帶便當就容易漲");
    // A Latin name keeps its space before the Chinese.
    expect(all[1]?.what_moves).toBe("他唱完的歌越多,Wave Records 越好");
    expect(all[1]?.anchor).toBe(108);
    const own = ExchangeConfigSchema.parse({
      local_companies: { game: { what_moves: "她今天贏了就漲", blurb: "看運氣" } },
    });
    expect(localCompaniesOf(own)[3]).toMatchObject({
      what_moves: "她今天贏了就漲",
      blurb: "看運氣",
    });
  });

  it("still read the old anchors keyed by the first character's codes", () => {
    const old = ExchangeConfigSchema.parse({ local_anchors: { RICE: 120, DPSK: 90 } });
    const all = localCompaniesOf(old);
    expect(all.map((c) => c.anchor)).toEqual([120, 108, 88, 116, 90]);
    // A role's own anchor wins.
    const both = ExchangeConfigSchema.parse({
      local_anchors: { RICE: 120 },
      local_companies: { feeding: { anchor: 80 } },
    });
    expect(localCompaniesOf(both)[0]?.anchor).toBe(80);
  });

  it("refuse codes that are not four capitals, or the same code twice", () => {
    expect(
      ExchangeConfigSchema.safeParse({ local_companies: { feeding: { code: "rice" } } }).success,
    ).toBe(false);
    expect(
      ExchangeConfigSchema.safeParse({ local_companies: { feeding: { code: "RICE1" } } }).success,
    ).toBe(false);
    const twice = ExchangeConfigSchema.safeParse({
      local_companies: { feeding: { code: "DPSK" } },
    });
    expect(twice.success).toBe(false);
    expect(JSON.stringify(twice.error?.issues)).toContain("same code DPSK");
  });

  it("are traded and drawn under the profile's names", async () => {
    const r = await rig({
      ...OPEN,
      local_companies: ExchangeConfigSchema.parse({ local_companies: RENAMED }).local_companies,
    });
    r.wallet.fund(ALICE, 500);
    await r.service.openAccount(ALICE);
    await r.at(local(0, 12, 30));
    const view = r.service.real.view();
    const food = view.instruments.find((i) => i.code === "FOOD");
    expect(food?.name).toBe("海帶便當");
    expect(food?.local?.what_moves).toContain("海帶便當");
    expect(view.instruments.some((i) => i.code === "RICE")).toBe(false);
    // Its first price is the profile's anchor (a walk from 60, held within the daily limit).
    expect(food?.price).toBeGreaterThan(60 * 0.9);
    expect(food?.price).toBeLessThan(60 * 1.1);
    const placed = await r.service.real.place(ALICE, { side: "buy", code: "FOOD", shares: 1 }, "k");
    expect(placed.ok).toBe(true);
  });
});

describe("a local stock's code in the store", () => {
  it("may change freely on an empty database", async () => {
    const r = await rig(OPEN);
    const renamed = ExchangeConfigSchema.parse({ local_companies: RENAMED });
    expect(checkLocalCodes(r.store.real, localCompaniesOf(renamed))).toEqual({
      error: null,
      stale: [],
    });
  });

  it("is refused when rows are kept under the old one, and a never-traded old code is unlisted", async () => {
    const r = await rig(OPEN);
    r.wallet.fund(ALICE, 500);
    await r.service.openAccount(ALICE);
    await r.at(local(0, 12, 30));
    await r.service.real.place(ALICE, { side: "buy", code: "RICE", shares: 1 }, "a");
    await r.at(local(0, 13, 1));
    // The default codes are fine: nothing changes for the first character.
    expect(checkLocalCodes(r.store.real, localCompaniesOf(exchangeConfig()))).toEqual({
      error: null,
      stale: [],
    });
    const renamed = localCompaniesOf(
      ExchangeConfigSchema.parse({ local_companies: { feeding: { code: "FOOD" } } }),
    );
    const check = checkLocalCodes(r.store.real, renamed);
    expect(check.error).toBe(
      '[modules.exchange.local_companies]: feeding.code was "RICE" and is now "FOOD", but the database keeps holdings, orders or price history under RICE. A code is what those rows are kept under, so they would be left behind. Either put feeding.code back to "RICE", or use the new codes in a new profile (its database starts empty).',
    );
    // A real ticker of the same code is refused too.
    const clash = checkLocalCodes(
      {
        instrumentList: () => [
          {
            ...(r.store.real.instrument("RICE") as InstrumentRecord),
            code: "AAPL",
            market: "us" as const,
          },
        ],
        rowsUnder: () => 0,
      },
      localCompaniesOf(
        ExchangeConfigSchema.parse({ local_companies: { model: { code: "AAPL" } } }),
      ),
    );
    expect(clash.error).toContain('model.code = "AAPL" is a us ticker');
    // Listed but never priced or traded: only unlisted.
    const quiet = checkLocalCodes(
      { instrumentList: () => r.store.real.instrumentList(), rowsUnder: () => 0 },
      renamed,
    );
    expect(quiet).toEqual({ error: null, stale: ["RICE"] });
  });

  it("stops the module at start, with the reason", async () => {
    const store = await SqliteStore.open(":memory:", { plugins: [heartTables, exchangeTables] });
    cleanup.push(() => store.close());
    const tables = store.plugin(exchangeTables);
    const now = Date.UTC(2026, 10, 23, 4, 30);
    tables.real.addInstrument(
      {
        code: "RICE",
        market: "local",
        name: "白飯食品",
        exchange: "LOCAL",
        type: "LOCAL",
        currency: "COIN",
        provider: "local",
        status: "active",
        added_at: now,
        added_by: null,
      },
      now,
    );
    tables.real.lines(
      [{ kind: "burn", person: "p1", code: "RICE", amount: 10, ref: "o1" }],
      0,
      now,
    );
    expect(tables.real.rowsUnder("RICE")).toBeGreaterThan(0);
    const sup = new Supervisor();
    cleanup.push(() => sup.stopAll());
    sup.services.provide("app", StoreKey, store);
    await sup.register(
      new ExchangeModule({ clock: { now: () => now }, seed: "m", sources: {} }),
      { local_companies: { feeding: { code: "FOOD" } } },
      true,
    );
    await sup.startAll();
    expect(sup.services.get(ExchangeKey)).toBeUndefined();
    const status = sup.list().find((s) => s.id === "exchange");
    expect(status?.reason).toContain('feeding.code was "RICE" and is now "FOOD"');
  });
});
