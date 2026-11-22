import { describe, expect, it } from "vitest";
import {
  type BuyFacts,
  type BuyRequest,
  checkBuy,
  checkLeverageOptIn,
  checkOpen,
  checkSell,
  DEFAULT_LEVERAGE,
  DEFAULT_RULES,
  limitsFor,
  params,
  type Rules,
  type Trader,
} from "../src/engine/index.js";

const RULES: Rules = { ...DEFAULT_RULES, enabled: true };
const P = params({ leverage: { ...DEFAULT_LEVERAGE, enabled: true } });
const TRADER: Trader = {
  known_days: 10,
  tier: 0,
  insider: false,
  self: false,
  blocked: false,
  opened: true,
  leverage_opt_in: false,
};
const FACTS: BuyFacts = {
  balance: 1000,
  transferred: 0,
  orders_today: 0,
  bought_today: 0,
  company_cost: 0,
  total_cost: 0,
  margin: 0,
  company_value: 5000,
  my_company_value: 0,
};
const BUY: BuyRequest = { company: "DPSK", coins: 100, limit: null, leverage: 1, days: 1 };

const code = (r: ReturnType<typeof checkBuy>) => (r.ok ? "ok" : r.code);

describe("accounts", () => {
  it("open after seven days known at 認識 or more, never for her, an insider or someone blocked", () => {
    expect(checkOpen(RULES, TRADER)).toBeNull();
    expect(checkOpen(RULES, { ...TRADER, known_days: 6.9 })?.code).toBe("young");
    expect(checkOpen(RULES, { ...TRADER, tier: -1 })?.code).toBe("tier");
    expect(checkOpen(RULES, { ...TRADER, self: true })?.code).toBe("self");
    expect(checkOpen(RULES, { ...TRADER, insider: true })?.code).toBe("insider");
    expect(checkOpen(RULES, { ...TRADER, blocked: true })?.code).toBe("blocked");
  });

  it("asks more for leverage, and nothing while it is off", () => {
    expect(checkLeverageOptIn(RULES, P, TRADER)?.code).toBe("leverage_tier");
    expect(checkLeverageOptIn(RULES, P, { ...TRADER, tier: 1 })?.code).toBe("leverage_young");
    expect(checkLeverageOptIn(RULES, P, { ...TRADER, tier: 1, known_days: 30 })).toBeNull();
    const off = params({ leverage: { ...P.leverage, enabled: false } });
    expect(checkLeverageOptIn(RULES, off, { ...TRADER, tier: 1, known_days: 30 })?.code).toBe(
      "leverage_off",
    );
  });
});

describe("holding limits", () => {
  it("start at 200 and 600 and widen with tier and time, at most twice", () => {
    expect(limitsFor(RULES, { tier: 0, known_days: 10 })).toMatchObject({
      company: 200,
      total: 600,
    });
    expect(limitsFor(RULES, { tier: 1, known_days: 10 })).toMatchObject({
      company: 250,
      total: 750,
    });
    expect(limitsFor(RULES, { tier: 0, known_days: 65 })).toMatchObject({
      company: 240,
      total: 720,
    });
    expect(limitsFor(RULES, { tier: 9, known_days: 900 })).toMatchObject({
      company: 400,
      total: 1200,
    });
  });
});

describe("a buy", () => {
  it("passes with the defaults", () => {
    expect(code(checkBuy(RULES, P, TRADER, BUY, FACTS))).toBe("ok");
  });

  it("is refused while the market is off or paused", () => {
    expect(code(checkBuy({ ...RULES, enabled: false }, P, TRADER, BUY, FACTS))).toBe("closed");
    expect(code(checkBuy({ ...RULES, paused: true }, P, TRADER, BUY, FACTS))).toBe("closed");
  });

  it("keeps each order between 10 and 200, 20 orders and 300 coins a day", () => {
    expect(code(checkBuy(RULES, P, TRADER, { ...BUY, coins: 9 }, FACTS))).toBe("size");
    expect(code(checkBuy(RULES, P, TRADER, { ...BUY, coins: 201 }, FACTS))).toBe("size");
    expect(code(checkBuy(RULES, P, TRADER, BUY, { ...FACTS, orders_today: 20 }))).toBe("orders");
    expect(code(checkBuy(RULES, P, TRADER, BUY, { ...FACTS, bought_today: 201 }))).toBe("daily");
    expect(code(checkBuy(RULES, P, TRADER, BUY, { ...FACTS, bought_today: 200 }))).toBe("ok");
  });

  it("refuses someone blocked, an account not opened and coins not there", () => {
    expect(code(checkBuy(RULES, P, { ...TRADER, blocked: true }, BUY, FACTS))).toBe("blocked");
    expect(code(checkBuy(RULES, P, { ...TRADER, opened: false }, BUY, FACTS))).toBe("no_account");
    expect(code(checkBuy(RULES, P, TRADER, BUY, { ...FACTS, balance: 99 }))).toBe("short");
  });

  it("keeps coins received by transfer out for a day", () => {
    expect(code(checkBuy(RULES, P, TRADER, BUY, { ...FACTS, balance: 150, transferred: 60 }))).toBe(
      "transfer_lock",
    );
    expect(code(checkBuy(RULES, P, TRADER, BUY, { ...FACTS, balance: 160, transferred: 60 }))).toBe(
      "ok",
    );
  });

  it("counts open buys and leverage at full exposure against the limits", () => {
    expect(code(checkBuy(RULES, P, TRADER, BUY, { ...FACTS, company_cost: 110 }))).toBe(
      "limit_company",
    );
    expect(code(checkBuy(RULES, P, TRADER, BUY, { ...FACTS, total_cost: 510 }))).toBe(
      "limit_total",
    );
    const lev: Trader = { ...TRADER, tier: 1, known_days: 30, leverage_opt_in: true };
    // 100 coins at 2x is exposure 194: over a company limit of 270 (tier 1, 30 days) with 80 held.
    expect(
      code(checkBuy(RULES, P, lev, { ...BUY, leverage: 2 }, { ...FACTS, company_cost: 80 })),
    ).toBe("limit_company");
    expect(
      code(checkBuy(RULES, P, lev, { ...BUY, leverage: 2 }, { ...FACTS, company_cost: 76 })),
    ).toBe("ok");
  });

  it("needs leverage's opt-in, and caps its margin", () => {
    const lev: Trader = { ...TRADER, tier: 1, known_days: 30 };
    expect(code(checkBuy(RULES, P, lev, { ...BUY, leverage: 2 }, FACTS))).toBe("leverage_opt_in");
    const opted = { ...lev, leverage_opt_in: true };
    expect(code(checkBuy(RULES, P, opted, { ...BUY, leverage: 2 }, FACTS))).toBe("ok");
    expect(code(checkBuy(RULES, P, opted, { ...BUY, leverage: 2 }, { ...FACTS, margin: 60 }))).toBe(
      "margin_cap",
    );
    expect(code(checkBuy(RULES, P, opted, { ...BUY, leverage: 3 }, FACTS))).toBe("leverage");
  });

  it("keeps one person under a quarter of a company's value held", () => {
    expect(
      code(
        checkBuy(RULES, P, TRADER, BUY, { ...FACTS, company_value: 200, my_company_value: 150 }),
      ),
    ).toBe("concentration");
    // A small market counts as at least `concentration_floor`.
    expect(
      code(checkBuy(RULES, P, TRADER, { ...BUY, coins: 150 }, { ...FACTS, company_value: 0 })),
    ).toBe("ok");
    expect(
      code(
        checkBuy(
          RULES,
          P,
          { ...TRADER, tier: 4, known_days: 200 },
          { ...BUY, coins: 200 },
          { ...FACTS, company_value: 0, my_company_value: 50, company_cost: 50 },
        ),
      ),
    ).toBe("concentration");
  });
});

describe("a sale", () => {
  const SELL = { qty: 1000, limit: null, days: 1, position: null };
  const SF = { sellable: 1000, orders_today: 0, position_ok: null, pending_close: false };

  it("is allowed to someone blocked, never more than can be sold today", () => {
    expect(checkSell(RULES, { ...TRADER, blocked: true }, SELL, SF)).toBeNull();
    expect(checkSell(RULES, TRADER, { ...SELL, qty: 1001 }, SF)?.code).toBe("t1");
    expect(checkSell(RULES, TRADER, SELL, { ...SF, sellable: 0 })?.code).toBe("t1");
  });

  it("closes a leveraged position from the day after", () => {
    const close = { ...SELL, position: "p1" };
    expect(checkSell(RULES, TRADER, close, { ...SF, position_ok: true })).toBeNull();
    expect(checkSell(RULES, TRADER, close, { ...SF, position_ok: false })?.code).toBe("t1");
    expect(
      checkSell(RULES, TRADER, close, { ...SF, position_ok: true, pending_close: true })?.code,
    ).toBe("pending");
    expect(checkSell(RULES, TRADER, close, SF)?.code).toBe("no_position");
  });
});
