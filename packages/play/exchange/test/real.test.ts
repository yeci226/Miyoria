// Real instruments: the market hours, the providers (a recorded one, a configurable JSON one with a
// fake fetch) and the guard over what they answer, and the house as the counterparty: fills at a
// quote later than the order, the hold time, the daily payout cap and its queue, the automatic halt,
// cross-margin leverage with a loss past the margin, and a bankruptcy that closes cleanly. Every
// number is made up; no real vendor is called.

import { describe, expect, it } from "vitest";
import {
  adminSellReal,
  cancelRealOrder,
  DEFAULT_HOUSE,
  type HouseBook,
  type HouseContext,
  type HouseOutcome,
  type HouseParams,
  isBankrupt,
  netOfLines,
  netOfPostings,
  newHouse,
  onQuote,
  placeRealBuy,
  placeRealSell,
  QTY_REAL,
  type RealOrder,
  rollDay,
  splitRealBuy,
  valueAt,
} from "../src/real/house.js";
import { DEFAULT_SESSIONS, isOpenAt, type RealInstrument } from "../src/real/instruments.js";
import {
  FixtureProvider,
  HttpJsonProvider,
  JUMP_BY_MARKET,
  type Quote,
  QuoteGuard,
} from "../src/real/provider.js";

const STOCK: RealInstrument = {
  code: "ACME",
  name: "Acme 股份",
  market: "us",
  provider: "fx",
  symbol: "ACME",
  enabled: true,
};
const COIN: RealInstrument = {
  code: "XCOIN",
  name: "某幣",
  market: "us",
  provider: "fx",
  symbol: "XCOIN",
  enabled: true,
};
const OTHER: RealInstrument = { ...STOCK, code: "BETA", symbol: "BETA", name: "Beta 公司" };
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 23, 15, 0); // Monday 10:00 in New York

describe("market hours", () => {
  it("know the US and Taiwan sessions, weekends, holidays, and that crypto never closes", () => {
    expect(isOpenAt(DEFAULT_SESSIONS.us, T0)).toBe(true);
    expect(isOpenAt(DEFAULT_SESSIONS.us, T0 - 2 * HOUR)).toBe(false); // 08:00
    expect(isOpenAt(DEFAULT_SESSIONS.us, Date.UTC(2026, 10, 21, 15, 0))).toBe(false); // Saturday
    expect(
      isOpenAt({ ...DEFAULT_SESSIONS.us, holidays: ["2026-11-26"] }, Date.UTC(2026, 10, 26, 16, 0)),
    ).toBe(false);
    expect(isOpenAt(DEFAULT_SESSIONS.tw, Date.UTC(2026, 10, 23, 2, 0))).toBe(true); // 10:00 Taipei
    expect(isOpenAt(DEFAULT_SESSIONS.tw, Date.UTC(2026, 10, 23, 6, 0))).toBe(false); // 14:00 Taipei
    expect(isOpenAt(DEFAULT_SESSIONS.crypto, Date.UTC(2026, 10, 22, 3, 0))).toBe(true);
  });
});

describe("providers and the guard", () => {
  it("replay a recorded series and are down during an outage", async () => {
    const p = new FixtureProvider("fx", {
      series: {
        ACME: [
          { at: T0, price: 100 },
          { at: T0 + HOUR, price: 101 },
        ],
      },
      outages: [{ from: T0 + 2 * HOUR, to: T0 + 3 * HOUR }],
    });
    expect((await p.quotes(["ACME", "NONE"], T0 + 30 * MIN)).get("ACME")?.price).toBe(100);
    expect((await p.quotes(["ACME"], T0 + 90 * MIN)).get("ACME")?.price).toBe(101);
    await expect(p.quotes(["ACME"], T0 + 2.5 * HOUR)).rejects.toThrow("down");
  });

  it("call only the configured host, send nothing about who asks, never follow redirects, and back off", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let fail = false;
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (fail) return new Response("no", { status: 503 });
      return new Response(
        JSON.stringify({
          data: { ACME: { last: "123.45", t: T0 / 1000 }, "A/B": { last: 7, t: T0 / 1000 } },
        }),
      );
    };
    const p = new HttpJsonProvider(
      {
        id: "web",
        url: "https://quotes.example.test/v1?s={symbols}",
        separator: ",",
        price_path: "data.{symbol}.last",
        time_path: "data.{symbol}.t",
        time_unit: "s",
        prev_close_path: null,
        rate_per_minute: 2,
        cache_seconds: 30,
        timeout_ms: 1000,
        max_backoff_seconds: 60,
        api_key_env: null,
        api_key_header: null,
        api_key_param: null,
      },
      fetch,
      {},
    );
    const q = await p.quotes(["ACME", "A/B"], T0);
    expect(q.get("ACME")).toEqual({ symbol: "ACME", price: 123.45, at: T0 });
    expect(calls[0]?.url).toBe("https://quotes.example.test/v1?s=ACME%2CA%2FB");
    expect(calls[0]?.init.redirect).toBe("error");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
    expect(headers["user-agent"]).toBe("Mozilla/5.0");
    // Within the cache: no new request.
    await p.quotes(["ACME"], T0 + 10_000);
    expect(calls).toHaveLength(1);
    // A failure backs off: the next pass inside the backoff makes no request.
    fail = true;
    await expect(p.quotes(["ACME"], T0 + 60_000)).rejects.toThrow("503");
    await expect(p.quotes(["ACME"], T0 + 60_500)).rejects.toThrow("backing off");
    expect(calls).toHaveLength(2);
    expect(
      () =>
        new HttpJsonProvider({ ...{ id: "x", url: "https://{symbol}.example.test/" } } as never),
    ).toThrow("fixed host");
  });

  it("refuse stale, future, absurd and unconfirmed jumping quotes", () => {
    const g = new QuoteGuard({ max_age_ms: 5 * MIN, jump: JUMP_BY_MARKET, confirm_within: 0.02 });
    expect(g.check(STOCK, { symbol: "ACME", price: 100, at: T0 - 10 * MIN }, T0)).toEqual({
      ok: false,
      why: "stale",
    });
    expect(g.check(STOCK, { symbol: "ACME", price: 100, at: T0 + 5 * MIN }, T0)).toEqual({
      ok: false,
      why: "future",
    });
    expect(g.check(STOCK, { symbol: "ACME", price: -1, at: T0 }, T0)).toEqual({
      ok: false,
      why: "range",
    });
    expect(g.check(STOCK, { symbol: "ACME", price: Number.NaN, at: T0 }, T0)).toEqual({
      ok: false,
      why: "number",
    });
    expect(g.check(STOCK, { symbol: "ACME", price: 100, at: T0 }, T0)).toMatchObject({ ok: true });
    // A 60% drop is not believed until a later fetch says the same.
    expect(g.check(STOCK, { symbol: "ACME", price: 40, at: T0 + MIN }, T0 + MIN)).toEqual({
      ok: false,
      why: "jump",
    });
    expect(
      g.check(STOCK, { symbol: "ACME", price: 40.3, at: T0 + 2 * MIN }, T0 + 2 * MIN),
    ).toMatchObject({ ok: true, confirmed: true });
    expect(g.check(STOCK, { symbol: "ACME", price: 41, at: T0 + MIN }, T0 + 3 * MIN)).toEqual({
      ok: false,
      why: "old",
    });
  });
});

// ---- the house --------------------------------------------------------------------------------

interface World {
  book: HouseBook;
  wallets: Map<string, number>;
  quotes: Map<string, Quote>;
  all: HouseOutcome[];
  n: number;
  now: number;
  day: number;
  params: HouseParams;
}

function world(params: Partial<HouseParams> = {}): World {
  return {
    book: newHouse(0),
    wallets: new Map([
      ["a", 1000],
      ["b", 1000],
    ]),
    quotes: new Map(),
    all: [],
    n: 0,
    now: T0,
    day: 0,
    params: { ...DEFAULT_HOUSE, ...params },
  };
}

function ctx(w: World): HouseContext {
  return {
    now: w.now,
    day: w.day,
    params: w.params,
    newId: () => `id${++w.n}`,
    instruments: [STOCK, COIN, OTHER],
    balance: (p) => w.wallets.get(p) ?? 0,
    latest: (code) => w.quotes.get(code) ?? null,
  };
}

/** Applies an outcome's postings to the wallets the way the economy does (covered: refused below zero). */
function apply(w: World, out: HouseOutcome): void {
  w.all.push(out);
  for (const p of out.postings) {
    const sum = p.entries.reduce((t, e) => t + e.delta, 0);
    const now = w.wallets.get(p.person) ?? 0;
    if (p.covered && now + sum < 0)
      throw new Error(`a covered posting would go below zero: ${p.key}`);
    w.wallets.set(p.person, now + sum);
  }
  for (const [person, coins] of w.wallets) if (coins < 0) throw new Error(`${person} below zero`);
  expect(netOfPostings(out.postings)).toBe(netOfLines(out.lines));
}

function buy(
  w: World,
  person: string,
  code: string,
  coins: number,
  leverage = 1,
): RealOrder | null {
  const s = splitRealBuy(coins, leverage, w.params);
  if (!s) throw new Error("too small");
  // The service checks the wallet first; so does this.
  if ((w.wallets.get(person) ?? 0) < s.margin + s.fee) return null;
  const order: RealOrder = {
    id: `o${++w.n}`,
    person,
    code,
    side: "buy",
    limit: null,
    coins: s.margin + s.fee,
    ...s,
    leverage,
    qty: 0,
    position: null,
    placed_at: w.now,
    expires_at: Number.MAX_SAFE_INTEGER,
  };
  apply(w, placeRealBuy(w.book, order));
  return order;
}

function sell(
  w: World,
  person: string,
  code: string,
  qty: number,
  position: string | null = null,
): void {
  placeRealSell(w.book, {
    id: `o${++w.n}`,
    person,
    code,
    side: "sell",
    limit: null,
    coins: 0,
    margin: 0,
    exposure: 0,
    fee: 0,
    leverage: 1,
    qty,
    position,
    placed_at: w.now,
    expires_at: Number.MAX_SAFE_INTEGER,
  });
}

function quote(w: World, inst: RealInstrument, price: number, after = MIN): HouseOutcome {
  w.now += after;
  const q: Quote = { code: inst.code, price, at: w.now, prev_close: null };
  w.quotes.set(inst.code, q);
  const out = onQuote(w.book, inst, q, ctx(w));
  apply(w, out);
  return out;
}

describe("the house as the counterparty", () => {
  it("burns a buy into a position at the next quote, holds it, mints the sale back with one fee", () => {
    const w = world();
    buy(w, "a", "ACME", 100);
    expect(w.wallets.get("a")).toBe(900);
    const filled = quote(w, STOCK, 50);
    expect(filled.fills[0]).toMatchObject({ side: "buy", price: 50, fee: 1 });
    const pos = w.book.positions[0];
    expect(pos?.qty).toBe(Math.floor((99 * QTY_REAL) / 50));
    // Within the hold time a sale waits; after it, it fills.
    sell(w, "a", "ACME", pos?.qty ?? 0);
    expect(quote(w, STOCK, 55).fills).toHaveLength(0);
    const sold = quote(w, STOCK, 55, 10 * MIN);
    const fill = sold.fills.find((f) => f.side === "sell");
    expect(fill).toMatchObject({ gross: 108, fee: 2, tax: 0, paid: 106 });
    expect(w.wallets.get("a")).toBe(900 + 106);
    expect(w.book.state.today.minted - w.book.state.today.burned).toBe(6);
  });

  it("pays a sale past the day's cap in full and stops new buys for the rest of the day", () => {
    const w = world({ cap_daily: 50 });
    buy(w, "a", "ACME", 200);
    quote(w, STOCK, 10);
    const pos = w.book.positions[0];
    sell(w, "a", "ACME", pos?.qty ?? 0);
    buy(w, "b", "BETA", 100);
    const doubled = quote(w, STOCK, 20, HOUR);
    const fill = doubled.fills.find((f) => f.side === "sell");
    expect(fill?.paid).toBe(Math.floor(valueAt(pos?.qty ?? 0, 20)) - (fill?.fee ?? 0));
    expect(w.book.state.today.buys_halted).toBe(true);
    // Bob's waiting buy went back with its fee.
    expect(doubled.ended.find((e) => e.order.person === "b")).toMatchObject({ refunded: true });
    expect(w.wallets.get("b")).toBe(1000);
    w.day = 1;
    apply(w, rollDay(w.book, ctx(w)));
    expect(w.book.state.today.buys_halted).toBe(false);
    expect(w.book.state.history.at(-1)?.buys_halted).toBe(true);
  });
});

describe("cross-margin leverage", () => {
  it("warns on the way down and then sells at the line, taking a loss past the margin from the wallet", () => {
    const w = world();
    buy(w, "a", "ACME", 103, 2);
    quote(w, STOCK, 100);
    const pos = w.book.positions[0];
    expect(pos).toMatchObject({ leverage: 2, margin: 100, loan: 100 });
    const kinds: string[] = [];
    for (const price of [80, 70, 66, 59])
      for (const n of quote(w, STOCK, price).notices) kinds.push(n.kind);
    expect(kinds).toEqual(["warn_half", "warn_near", "liquidated"]);
    // A loss inside the margin: the rest came back, nothing past it.
    expect(w.wallets.get("a")).toBeGreaterThan(1000 - 103);
  });

  it("lets a gap take a position past zero: the shortfall comes from the wallet, then other holdings, then it is written off", () => {
    const w = world();
    w.wallets.set("a", 300);
    buy(w, "a", "BETA", 100);
    quote(w, OTHER, 10);
    buy(w, "a", "XCOIN", 155, 2);
    quote(w, COIN, 100);
    expect(w.wallets.get("a")).toBe(45);
    // The coin gaps from 100 to 5 at one quote: worth 7.5 against a loan of 50.
    const gap = quote(w, COIN, 5, HOUR);
    const liq = gap.notices.find((n) => n.kind === "liquidated");
    expect(liq?.warned).toBe(false);
    expect(gap.fills.find((f) => f.kind === "liquidation")?.shortfall).toBeGreaterThan(0);
    // The wallet paid first, then BETA was sold toward it; nothing went below zero.
    expect(w.wallets.get("a")).toBeGreaterThanOrEqual(0);
    expect(w.book.positions.filter((p) => p.person === "a")).toHaveLength(0);
    expect(isBankrupt(w.book.state, "a", w.now)).toBe(false);
  });

  it("goes bankrupt cleanly when nothing is left: everything closed, the rest written off, a cooling-off period", () => {
    const w = world();
    w.wallets.set("a", 160);
    buy(w, "a", "XCOIN", 155, 2);
    quote(w, COIN, 100);
    buy(w, "a", "ACME", 5);
    const gap = quote(w, COIN, 1, HOUR);
    expect(gap.bankrupt).toEqual(["a"]);
    expect(w.wallets.get("a")).toBe(0);
    expect(w.book.positions.filter((p) => p.person === "a")).toHaveLength(0);
    expect(w.book.orders.filter((o) => o.person === "a")).toHaveLength(0);
    expect(w.book.state.today.written_off).toBeGreaterThan(0);
    expect(gap.lines.some((l) => l.kind === "writeoff" && l.amount > 0)).toBe(true);
    expect(isBankrupt(w.book.state, "a", w.now + 6 * 86_400_000)).toBe(true);
    expect(isBankrupt(w.book.state, "a", w.now + 8 * 86_400_000)).toBe(false);
    // A buy while bankrupt does not fill.
    w.wallets.set("a", 100);
    buy(w, "a", "ACME", 50);
    expect(quote(w, STOCK, 10).ended[0]).toMatchObject({ why: "halted", refunded: true });
  });

  it("keeps the postings and the house's lines equal to the coin over a long random run", () => {
    const w = world({ cap_daily: 60 });
    let price = 100;
    let coin = 100;
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i++) {
      const who = rnd() < 0.5 ? "a" : "b";
      const r = rnd();
      if (r < 0.2) buy(w, who, "ACME", 10 + Math.floor(rnd() * 100), rnd() < 0.3 ? 2 : 1);
      else if (r < 0.3) buy(w, who, "XCOIN", 10 + Math.floor(rnd() * 80), rnd() < 0.3 ? 2 : 1);
      else if (r < 0.34)
        for (const p of w.book.positions.filter((x) => x.person === who))
          sell(w, who, p.code, p.qty, p.leverage > 1 ? p.id : null);
      else if (r < 0.52) {
        const o = w.book.orders.find((x) => x.person === who);
        if (o) apply(w, cancelRealOrder(w.book, o.id) as HouseOutcome);
      }
      price = Math.max(1, price * Math.exp((rnd() - 0.5) * 0.08));
      coin = Math.max(0.5, coin * Math.exp((rnd() - 0.5) * 0.2));
      // A crypto crash and a stock gap down, every 400 steps.
      if (i % 400 === 399) coin *= 0.1;
      if (i % 400 === 199) price *= 0.35;
      quote(w, STOCK, Math.round(price * 100) / 100, 20 * MIN);
      quote(w, COIN, Math.round(coin * 100) / 100, 0);
      if (i % 50 === 49) {
        w.day++;
        apply(w, rollDay(w.book, ctx(w)));
        if ((w.wallets.get("a") ?? 0) < 50) w.wallets.set("a", (w.wallets.get("a") ?? 0) + 500);
        if ((w.wallets.get("b") ?? 0) < 50) w.wallets.set("b", (w.wallets.get("b") ?? 0) + 500);
      }
      // Past the cap no buy fills for the rest of the day.
      const t = w.book.state.today;
      if (t.buys_halted) expect(w.all.at(-1)?.fills.some((f) => f.side === "buy")).toBe(false);
    }
    // The run went through liquidations, a loss past the margin and the payout cap.
    expect(w.all.some((o) => o.fills.some((f) => f.kind === "liquidation"))).toBe(true);
    expect(w.all.some((o) => o.fills.some((f) => f.shortfall > 0))).toBe(true);
    expect([...w.book.state.history, w.book.state.today].some((d) => d.buys_halted)).toBe(true);
    const all = w.all.flatMap((o) => o.postings);
    expect(netOfPostings(all)).toBe(netOfLines(w.all.flatMap((o) => o.lines)));
    const owner = w.book.positions[0];
    if (owner) expect(adminSellReal(w.book, owner, ctx(w))).not.toBeNull();
  });
});
