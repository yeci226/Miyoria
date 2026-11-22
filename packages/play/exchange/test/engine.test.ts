import { describe, expect, it } from "vitest";
import {
  addMargin,
  type Book,
  cancelOrder,
  equityOf,
  exactValue,
  feeOn,
  initMarket,
  lastRoundDue,
  linePrice,
  marginRatio,
  type Order,
  params,
  placeBuy,
  placeSell,
  priceOf,
  qtyFor,
  type RoundOutcome,
  roundAt,
  saleBurns,
  settleRound,
  splitBuy,
  weekdayOf,
} from "../src/engine/index.js";

const P = params();
const DAY0 = 20_000;

function newBook(p = P): Book {
  return {
    market: initMarket(p, DAY0),
    orders: [],
    positions: [],
    owed: [],
    vault: 0,
    held_day: null,
  };
}

function ids() {
  let n = 0;
  return () => `id${(++n).toString().padStart(6, "0")}`;
}

function buy(
  book: Book,
  id: string,
  person: string,
  company: string,
  coins: number,
  leverage = 1,
  p = P,
): Order {
  const split = splitBuy(coins, leverage, p);
  if (!split) throw new Error("too small");
  return {
    id,
    person,
    company,
    side: "buy",
    kind: "market",
    limit: null,
    coins: split.margin + split.fee,
    margin: split.margin,
    exposure: split.exposure,
    fee: split.fee,
    leverage,
    qty: 0,
    position: null,
    placed_round: book.market.round,
    expires_day: Math.floor((book.market.round + 1) / p.rounds_per_day),
  };
}

function step(book: Book, seed: string, newId: () => string, p = P): RoundOutcome {
  return settleRound(book, { seed, round: book.market.round + 1, params: p, newId, mode: "held" });
}

describe("money", () => {
  it("rounds fees up with a smallest of one coin", () => {
    expect(feeOn(10, 0.015, 1)).toBe(1);
    expect(feeOn(100, 0.015, 1)).toBe(2);
    expect(feeOn(200, 0.015, 1)).toBe(3);
    expect(feeOn(0, 0.015, 1)).toBe(0);
  });

  it("never splits a buy into more than was paid", () => {
    for (let coins = 1; coins <= 400; coins++) {
      for (const x of [1, 2]) {
        const s = splitBuy(coins, x, P);
        if (s === null) continue;
        expect(s.margin + s.fee).toBeLessThanOrEqual(coins);
        expect(s.exposure).toBe(s.margin * x);
        expect(s.fee).toBe(feeOn(s.exposure, P.fee_buy, P.fee_min));
        // The largest margin that fits.
        const bigger = s.margin + 1;
        expect(bigger + feeOn(bigger * x, P.fee_buy, P.fee_min)).toBeGreaterThan(coins);
      }
    }
  });

  it("keeps a sale's fee and tax within what it brought in", () => {
    for (let gross = 0; gross <= 500; gross++) {
      const b = saleBurns(gross, P);
      expect(b.fee + b.tax).toBeLessThanOrEqual(gross);
      expect(b.fee).toBeGreaterThanOrEqual(0);
    }
    expect(saleBurns(100, P)).toEqual({ fee: 2, tax: 3 });
    expect(saleBurns(1, P)).toEqual({ fee: 1, tax: 0 });
  });

  it("never buys more shares than the coins pay for", () => {
    for (const price of [123, 9_999, 10_000, 54_321]) {
      for (const coins of [10, 77, 200]) {
        const qty = qtyFor(coins, price);
        expect(exactValue(qty, price)).toBeLessThanOrEqual(coins);
        expect(exactValue(qty + 1, price)).toBeGreaterThan(coins);
      }
    }
  });
});

describe("time", () => {
  it("puts twelve rounds from 12:00 to 23:00 local", () => {
    const offset = 8 * 60;
    const first = roundAt(DAY0 * 12, P, offset);
    const last = roundAt(DAY0 * 12 + 11, P, offset);
    expect(new Date(first + offset * 60_000).getUTCHours()).toBe(12);
    expect(new Date(last + offset * 60_000).getUTCHours()).toBe(23);
    expect(lastRoundDue(first - 1, P, offset)).toBe(DAY0 * 12 - 1);
    expect(lastRoundDue(first, P, offset)).toBe(DAY0 * 12);
    expect(lastRoundDue(last + 3_600_000 * 5, P, offset)).toBe(DAY0 * 12 + 11);
    // 1970-01-04 was a Sunday.
    expect(weekdayOf(3)).toBe(0);
  });
});

describe("prices", () => {
  it("are the same from the same seed, and differ with another", () => {
    const run = (seed: string) => {
      const book = newBook();
      const newId = ids();
      const out: number[] = [];
      for (let i = 0; i < 200; i++)
        out.push(...step(book, seed, newId).companies.map((c) => c.price));
      return out;
    };
    expect(run("a")).toEqual(run("a"));
    expect(run("a")).not.toEqual(run("b"));
  });

  it("stay within the daily limit and the round limit, over many seeds", () => {
    for (let s = 0; s < 12; s++) {
      const book = newBook();
      const newId = ids();
      let prev = book.market.companies.map((c) => c.price);
      for (let i = 0; i < 12 * 14; i++) {
        const out = step(book, `bounds-${s}`, newId);
        for (const [k, c] of out.companies.entries()) {
          const before = prev[k] as number;
          expect(c.price).toBeGreaterThanOrEqual(Math.ceil(c.ref * (1 - P.daily_limit)));
          expect(c.price).toBeLessThanOrEqual(Math.floor(c.ref * (1 + P.daily_limit)));
          expect(c.price).toBeGreaterThanOrEqual(Math.ceil(before * (1 - P.round_limit)));
          expect(c.price).toBeLessThanOrEqual(Math.floor(before * (1 + P.round_limit)));
        }
        prev = out.companies.map((c) => c.price);
      }
    }
  });
});

describe("the book", () => {
  it("fills a buy at the next round, keeps T+1, sells and balances to the coin", () => {
    const book = newBook();
    const newId = ids();
    const order = buy(book, "o1", "alice", "RICE", 100);
    const placed = placeBuy(book, order);
    // Someone else's coins in the vault, so a rise can be paid.
    const other = buy(book, "o0", "bob", "NAPS", 200);
    placeBuy(book, other);
    expect(placed.entries).toEqual([
      { reason: "exchange_in", delta: -order.margin },
      { reason: "exchange_fee", delta: -order.fee },
    ]);
    const r1 = step(book, "t", newId);
    expect(r1.fills).toHaveLength(2);
    expect(book.vault).toBe(order.margin + other.margin);
    const pos = book.positions.find((x) => x.person === "alice");
    expect(pos?.day).toBe(DAY0);
    // Same day: nothing to sell.
    placeSell(book, {
      ...order,
      id: "s1",
      side: "sell",
      qty: pos?.qty ?? 0,
      coins: 0,
      margin: 0,
      exposure: 0,
      fee: 0,
      placed_round: book.market.round,
    });
    for (let i = 0; i < 11; i++) step(book, "t", newId);
    expect(book.positions).toHaveLength(2);
    // The sale did not fill on the day it was bought and ended at the close.
    placeSell(book, {
      ...order,
      id: "s2",
      side: "sell",
      qty: pos?.qty ?? 0,
      coins: 0,
      margin: 0,
      exposure: 0,
      fee: 0,
      placed_round: book.market.round,
    });
    const next = step(book, "t", newId);
    const sale = next.fills.find((f) => f.side === "sell");
    expect(sale).toBeDefined();
    expect(book.positions).toHaveLength(1);
    const paid = next.postings.find((x) => x.ref === sale?.id);
    const net = paid?.entries.reduce((t, e) => t + e.delta, 0) ?? 0;
    expect(net).toBe(sale?.paid);
    // Wallet out = vault + burned.
    const burned = order.fee + (sale?.fee ?? 0) + (sale?.tax ?? 0);
    expect(order.coins + other.coins - net).toBe(book.vault + burned + other.fee);
  });

  it("gives an unfilled market buy back at the close, and a skipped round's at once", () => {
    const book = newBook();
    const newId = ids();
    placeBuy(book, buy(book, "o1", "a", "DPSK", 50));
    const skipped = settleRound(book, {
      seed: "s",
      round: book.market.round + 1,
      params: P,
      newId,
      mode: "skipped",
    });
    expect(skipped.status).toBe("skipped");
    expect(skipped.ended[0]?.why).toBe("skipped");
    expect(skipped.postings[0]?.entries).toEqual([
      { reason: "exchange_out", delta: expect.any(Number) },
      { reason: "exchange_fee_back", delta: expect.any(Number) },
    ]);
    expect(book.orders).toHaveLength(0);
    // A limit far below the price waits, then expires at the close of its last day.
    const low: Order = { ...buy(book, "o2", "a", "DPSK", 50), kind: "limit", limit: 100 };
    placeBuy(book, low);
    let refunded = false;
    for (let i = 0; i < 11; i++) {
      const out = step(book, "s", newId);
      if (out.ended.some((e) => e.order.id === "o2" && e.refunded && e.why === "expired"))
        refunded = true;
    }
    expect(refunded).toBe(true);
    expect(cancelOrder(book, "o2")).toBeNull();
  });

  it("never pays a sale the vault cannot cover: it waits", () => {
    const book = newBook();
    const newId = ids();
    placeBuy(book, buy(book, "o1", "a", "NAPS", 100));
    for (let i = 0; i < 12; i++) step(book, "v", newId);
    const pos = book.positions[0] as NonNullable<Book["positions"][number]>;
    book.vault = 1; // as if others had taken the rest out
    placeSell(book, {
      ...buy(book, "s1", "a", "NAPS", 100),
      side: "sell",
      qty: pos.qty,
      coins: 0,
      margin: 0,
      exposure: 0,
      fee: 0,
    });
    const out = step(book, "v", newId);
    expect(out.fills.filter((f) => f.side === "sell")).toHaveLength(0);
    expect(book.vault).toBe(1);
    expect(book.orders).toHaveLength(1);
  });
});

/** A market that only falls: every company's hidden value far under its price, pulled at once. */
function crash() {
  const p = params({
    reversion: 1,
    market_sigma: 0,
    sector_sigma: 0,
    event_rate: 0,
    mood_drift: 0,
    earnings_sigma: 0,
    fundamental_sigma: 0,
    level_pull: 0,
    companies: P.companies.map((c) => ({ ...c, sigma: 0 })),
  });
  const book = newBook(p);
  return { p, book };
}

describe("leverage", () => {
  it("warns twice, then sells at the line in a later round, and never loses more than the margin", () => {
    const { p, book } = crash();
    const newId = ids();
    // A plain holder keeps the vault able to pay.
    placeBuy(book, buy(book, "plain", "b", "WHLE", 200, 1, p));
    const order = buy(book, "lev", "a", "DPSK", 155, 2, p);
    placeBuy(book, order);
    step(book, "c", newId, p);
    const pos = book.positions.find((x) => x.person === "a");
    if (!pos) throw new Error("no position");
    expect(pos.loan).toBe(pos.margin);
    const line = linePrice(pos, p);
    expect(line).toBe(Math.ceil(((pos.loan + p.leverage.line * pos.margin) * 100_000) / pos.qty));
    const seen: string[] = [];
    let liquidated: RoundOutcome | null = null;
    let days = 0;
    for (let i = 0; i < 12 * 10 && !liquidated; i++) {
      for (const c of book.market.companies) if (c.code === "DPSK") c.value = 0;
      const out = step(book, "c", newId, p);
      if (out.round % 12 === 11) days++;
      for (const n of out.notices) if (n.person === "a") seen.push(`${n.kind}@${out.round}`);
      if (out.notices.some((n) => n.kind === "liquidated")) liquidated = out;
    }
    expect(liquidated).not.toBeNull();
    const kinds = seen.map((s) => s.split("@")[0]);
    expect(kinds).toEqual(["warn_half", "warn_near", "liquidated"]);
    const rounds = seen.map((s) => Number(s.split("@")[1]));
    expect(rounds[2] as number).toBeGreaterThan(rounds[1] as number);
    const fill = liquidated?.fills.find((f) => f.kind === "liquidation");
    expect(fill?.paid).toBeGreaterThan(0);
    // What came back plus the fee paid never falls short of zero; the loss is at most the margin.
    expect(order.coins - (fill?.paid ?? 0)).toBeLessThanOrEqual(order.coins);
    expect(fill?.price).toBeLessThanOrEqual(line);
    // Entered at the reference price, falling the full daily limit every day: sold on day five.
    expect(days).toBe(4);
    expect(book.vault).toBeGreaterThanOrEqual(0);
  });

  it("owes a liquidation the vault cannot pay, and pays it first when it can", () => {
    const { p, book } = crash();
    const newId = ids();
    placeBuy(book, buy(book, "lev", "a", "DPSK", 155, 2, p));
    step(book, "o", newId, p);
    let owed = false;
    for (let i = 0; i < 12 * 10 && !owed; i++) {
      for (const c of book.market.companies) if (c.code === "DPSK") c.value = 0;
      // Someone else's sale took the vault's coins.
      book.vault = 0;
      const out = step(book, "o", newId, p);
      if (out.owed_added.length > 0) owed = true;
    }
    expect(owed).toBe(true);
    expect(book.positions).toHaveLength(0);
    const due = book.owed[0];
    book.vault = (due?.gross ?? 0) + 5;
    const out = step(book, "o", newId, p);
    expect(out.owed_paid).toHaveLength(1);
    expect(book.vault).toBe(5);
    const net = out.postings[0]?.entries.reduce((t, e) => t + e.delta, 0) ?? -1;
    expect(net).toBeGreaterThanOrEqual(0);
  });

  it("moves the line down when margin is added, and charges the carry from the margin", () => {
    const { p, book } = crash();
    const newId = ids();
    placeBuy(book, buy(book, "lev", "a", "RICE", 155, 2, p));
    step(book, "m", newId, p);
    const pos = book.positions[0] as NonNullable<Book["positions"][number]>;
    const before = linePrice(pos, p);
    for (let i = 0; i < 11; i++) step(book, "m", newId, p);
    expect(pos.carry).toBe(Math.ceil(pos.loan * p.leverage.carry_daily * 1000));
    const ratio = marginRatio(pos, priceOf(book, "RICE"));
    expect(ratio).toBeLessThan(1);
    expect(equityOf(pos, priceOf(book, "RICE"))).toBeCloseTo(
      exactValue(pos.qty, priceOf(book, "RICE")) - pos.loan - pos.carry / 1000,
    );
    const added = addMargin(book, pos.id, 50, "exchange:margin:k", p);
    expect(added?.added).toBe(50);
    expect(added?.posting.entries).toEqual([{ reason: "exchange_in", delta: -50 }]);
    expect(linePrice(pos, p)).toBeLessThan(before);
    expect(pos.margin + pos.loan).toBe(pos.cost);
    // Never more than what is still borrowed.
    const left = pos.loan;
    expect(addMargin(book, pos.id, 10_000, "exchange:margin:k2", p)?.added).toBe(left);
    expect(pos.loan).toBe(0);
  });
});
