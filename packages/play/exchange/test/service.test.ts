import { describe, expect, it } from "vitest";
import { exchangeTables } from "../src/store.js";
import {
  ALICE,
  ALICE_ALT,
  BOB,
  CAROL,
  DAY,
  HER,
  HOUR,
  local,
  MALLORY,
  MIN,
  NEWBIE,
  OWNER,
  rig,
  STRANGER,
  T0,
} from "./rig.js";

type R = Awaited<ReturnType<typeof rig>>;

/** The books: coins out of wallets = vault + coins held by open buys + coins burned, once posted. */
function books(r: R) {
  const s = r.store.state();
  const escrow =
    r.store.book()?.book.orders.reduce((t, o) => t + (o.side === "buy" ? o.coins : 0), 0) ?? 0;
  const pending = r.store.postingTotals().pending;
  return {
    out: 0 - r.wallet.exchangeNet() + 0,
    inside: (s?.vault ?? 0) + escrow + (s?.burned ?? 0) - pending,
  };
}

async function opened(r: R, account = ALICE, coins = 1000) {
  r.wallet.fund(account, coins);
  const o = await r.service.openAccount(account);
  if (!o.ok) throw new Error(o.message);
}

describe("off by default", () => {
  it("holds no round and takes no order until the owner turns it on", async () => {
    const r = await rig({});
    r.wallet.fund(ALICE, 500);
    await r.at(local(0, 15));
    expect(r.store.rounds()).toHaveLength(0);
    expect(r.service.market().enabled).toBe(false);
    await r.service.openAccount(ALICE);
    const p = await r.service.place(ALICE, { side: "buy", company: "DPSK", coins: 100 }, "k1");
    expect(p).toMatchObject({ ok: false, code: "closed" });
    expect(r.wallet.balanceOf("p-alice")).toBe(500);
  });
});

describe("accounts", () => {
  it("open after seven days at 認識, never for her, an owner, someone new or a stranger", async () => {
    const r = await rig();
    expect(await r.service.openAccount(CAROL)).toMatchObject({ ok: true });
    expect(await r.service.openAccount(NEWBIE)).toMatchObject({ ok: false, code: "young" });
    expect(await r.service.openAccount(OWNER)).toMatchObject({ ok: false, code: "insider" });
    expect(await r.service.openAccount(HER)).toMatchObject({ ok: false, code: "self" });
    expect(await r.service.openAccount(STRANGER)).toMatchObject({ ok: false, code: "stranger" });
    expect(await r.service.openAccount(MALLORY)).toMatchObject({ ok: false, code: "blocked" });
  });
});

describe("a buy and a sale", () => {
  it("charges at once, fills at the next round, sells from the next day and pays once", async () => {
    const r = await rig();
    await opened(r);
    await opened(r, BOB);
    await r.at(local(0, 11, 40));
    const quote = await r.service.quote(ALICE, { side: "buy", company: "RICE", coins: 100 });
    expect(quote).toMatchObject({
      ok: true,
      quote: { coins: 100, margin: 98, fee: 2, max_loss: null },
    });
    const p = await r.service.place(ALICE, { side: "buy", company: "RICE", coins: 100 }, "web:1");
    expect(p).toMatchObject({ ok: true, order: { status: "open" } });
    // The same key is the same order: charged once.
    expect(
      await r.service.place(ALICE_ALT, { side: "buy", company: "RICE", coins: 100 }, "web:1"),
    ).toMatchObject({ ok: true });
    await r.service.place(BOB, { side: "buy", company: "NAPS", coins: 200 }, "web:b");
    expect(r.wallet.balanceOf("p-alice")).toBe(900);
    expect(books(r).out).toBe(books(r).inside);
    await r.at(local(0, 12, 1));
    const port = await r.service.portfolio(ALICE);
    expect(port?.holdings).toHaveLength(1);
    expect(port?.holdings[0]?.sellable).toBe(0);
    // Same day: T+1.
    expect(
      await r.service.place(ALICE, { side: "sell", company: "RICE", all: true }, "web:2"),
    ).toMatchObject({ ok: false, code: "t1" });
    await r.runTo(local(1, 11, 30));
    const sell = await r.service.place(
      ALICE,
      { side: "sell", company: "RICE", all: true },
      "web:3",
    );
    expect(sell).toMatchObject({ ok: true });
    await r.at(local(1, 12, 1));
    const after = await r.service.portfolio(ALICE);
    expect(after?.holdings).toHaveLength(0);
    const fill = after?.fills.find((f) => f.side === "sell");
    expect(fill).toBeDefined();
    expect(r.wallet.balanceOf("p-alice")).toBe(900 + (fill?.paid ?? 0));
    expect(books(r).out).toBe(books(r).inside);
    // The vault's rows agree with the state.
    expect(r.store.vaultBalance()).toBe(r.store.state()?.vault);
  });

  it("refuses too few coins, coins received by transfer within a day, and someone blocked", async () => {
    const r = await rig();
    await opened(r, ALICE, 50);
    expect(
      await r.service.place(ALICE, { side: "buy", company: "DPSK", coins: 100 }, "a"),
    ).toMatchObject({ ok: false, code: "short" });
    r.wallet.fund(ALICE, 100, "transfer_in");
    expect(
      await r.service.place(ALICE, { side: "buy", company: "DPSK", coins: 100 }, "b"),
    ).toMatchObject({ ok: false, code: "transfer_lock" });
    r.clock.at += 25 * HOUR;
    expect(
      await r.service.place(ALICE, { side: "buy", company: "DPSK", coins: 100 }, "c"),
    ).toMatchObject({ ok: true });
    expect(
      await r.service.place(MALLORY, { side: "buy", company: "DPSK", coins: 100 }, "d"),
    ).toMatchObject({ ok: false, code: "blocked" });
  });

  it("lets someone blocked since sell what they hold", async () => {
    const r = await rig();
    // Mallory opened and bought while still a member: written straight into the book.
    r.wallet.fund(MALLORY, 300);
    r.service.store.openAccount("p-mallory", new Date(T0).toISOString() as never);
    await opened(r, BOB);
    await r.service.place(BOB, { side: "buy", company: "WHLE", coins: 200 }, "b");
    await r.at(local(0, 12, 1));
    const book = r.store.book()?.book;
    if (!book) throw new Error("no book");
    const pos = {
      ...(book.positions[0] as NonNullable<(typeof book.positions)[number]>),
      id: "pos-m",
      person: "p-mallory",
      day: book.positions[0]?.day ?? 0,
    };
    r.store.commit({
      outcome: {
        ...emptyOutcome(book.market.round),
        opened: [{ ...pos, qty: 100, cost: 10, margin: 10 }],
        vault: [{ kind: "buy", amount: 10, ref: "m" }],
      },
      book: { ...book, vault: book.vault + 10 },
      round: null,
      now: new Date(r.clock.at).toISOString() as never,
    });
    await r.runTo(local(1, 11, 30));
    expect(
      await r.service.place(MALLORY, { side: "sell", company: "WHLE", all: true }, "m1"),
    ).toMatchObject({ ok: true });
    await r.at(local(1, 12, 1));
    expect(r.wallet.balanceOf("p-mallory")).toBeGreaterThan(300);
  });
});

function emptyOutcome(round: number) {
  return {
    round,
    status: "held" as const,
    companies: [],
    news: [],
    fills: [],
    ended: [],
    opened: [],
    changed: [],
    closed: [],
    owed_added: [],
    owed_paid: [],
    notices: [],
    postings: [],
    vault: [],
    burned: 0,
    vault_after: 0,
    obligations: 0,
    level: null,
    fish: 0,
    breaker: false,
  };
}

describe("a restart", () => {
  it("settles a buy that stopped right after the charge, and voids one that never got there", async () => {
    const r = await rig();
    await opened(r);
    r.wallet.throwAfterPost = true;
    await expect(
      r.service.place(ALICE, { side: "buy", company: "DPSK", coins: 100 }, "x1"),
    ).rejects.toThrow();
    r.wallet.throwAfterPost = false;
    expect(r.store.charging()).toHaveLength(1);
    r.wallet.throwBeforePost = true;
    await expect(
      r.service.place(ALICE, { side: "buy", company: "CUBE", coins: 50 }, "x2"),
    ).rejects.toThrow();
    r.wallet.throwBeforePost = false;
    // A new process: the charged one opens, the other is void with nothing taken.
    r.restart();
    await r.at(local(0, 11, 45));
    expect(r.store.charging()).toHaveLength(0);
    expect(r.store.orderByKey("p-alice", "x1")?.status).toBe("open");
    expect(r.store.orderByKey("p-alice", "x2")?.status).toBe("void");
    expect(r.wallet.balanceOf("p-alice")).toBe(900);
    // Retrying the void one says so; it is never charged late.
    expect(
      await r.service.place(ALICE, { side: "buy", company: "CUBE", coins: 50 }, "x2"),
    ).toMatchObject({ ok: false, code: "void" });
  });

  it("keeps a payout while the wallet is away and posts it once when it is back", async () => {
    const r = await rig();
    await opened(r);
    await opened(r, BOB);
    await r.service.place(ALICE, { side: "buy", company: "RICE", coins: 100 }, "a");
    await r.service.place(BOB, { side: "buy", company: "NAPS", coins: 200 }, "b");
    await r.runTo(local(1, 11, 30));
    await r.service.place(ALICE, { side: "sell", company: "RICE", all: true }, "s");
    r.walletGone = true;
    await r.at(local(1, 12, 1));
    expect(r.store.pendingPostings()).toHaveLength(1);
    const before = r.wallet.balanceOf("p-alice");
    r.walletGone = false;
    r.restart();
    await r.at(local(1, 12, 2));
    await r.at(local(1, 12, 3));
    expect(r.store.pendingPostings()).toHaveLength(0);
    const paid = r.wallet.balanceOf("p-alice") - before;
    expect(paid).toBeGreaterThan(90);
    // Posted once: a third pass adds nothing.
    await r.service.flush();
    expect(r.wallet.balanceOf("p-alice") - before).toBe(paid);
  });
});

describe("rounds after downtime", () => {
  it("holds a round reached within the grace, skips older ones and gives their market buys back", async () => {
    const r = await rig();
    await opened(r);
    await r.at(local(0, 11, 50));
    await r.service.place(ALICE, { side: "buy", company: "WHLE", coins: 100 }, "a");
    // Down from 11:50 to 15:30: 12, 13, 14 and 15 are long past.
    await r.at(local(0, 15, 30));
    const rounds = r.store.rounds();
    expect(rounds.map((x) => x.status)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
    // Prices did not move at a skipped round.
    expect(new Set(rounds.map((x) => x.prices.length))).toEqual(new Set([0]));
    expect(r.wallet.balanceOf("p-alice")).toBe(1000);
    const notices = r.store.notices("p-alice");
    expect(notices[0]?.text).toContain("停機");
    // A round reached five minutes late is held as if on time.
    await r.service.place(ALICE, { side: "buy", company: "WHLE", coins: 100 }, "b");
    await r.at(local(0, 16, 5));
    expect(r.store.rounds().at(-1)?.status).toBe("held");
    expect((await r.service.portfolio(ALICE))?.holdings).toHaveLength(1);
  });
});

describe("the owner", () => {
  it("pauses: open orders go back, rounds move nothing; and sells a holding with an audit line", async () => {
    const r = await rig();
    await opened(r);
    await opened(r, BOB);
    await r.service.place(BOB, { side: "buy", company: "NAPS", coins: 200 }, "b");
    await r.at(local(0, 12, 1));
    await r.service.place(ALICE, { side: "buy", company: "DPSK", coins: 100 }, "a");
    const paused = await r.service.setPaused(true, "discord:8");
    expect(paused.refunded).toBe(1);
    expect(r.wallet.balanceOf("p-alice")).toBe(1000);
    const fish = r.service.market().fish;
    await r.at(local(0, 13, 1));
    expect(r.store.rounds().at(-1)?.status).toBe("paused");
    expect(r.service.market().fish).toBe(fish);
    expect(
      await r.service.place(ALICE, { side: "buy", company: "DPSK", coins: 100 }, "a2"),
    ).toMatchObject({ code: "closed" });
    await r.service.setPaused(false, "discord:8");
    const bobPos = r.store.openPositions("p-bob")[0];
    const sold = await r.service.adminSell(bobPos?.id ?? "", "discord:8", "cleanup");
    expect(sold).toMatchObject({ ok: true });
    expect(r.audits.map((a) => a.action)).toEqual([
      "exchange.pause",
      "exchange.pause",
      "exchange.admin_sell",
    ]);
    expect(r.store.openPositions("p-bob")).toHaveLength(0);
  });
});

describe("leverage", () => {
  it("needs its own opt-in and tier, shows the line, warns twice by DM and then sells by the rule", async () => {
    const r = await rig();
    await opened(r);
    await opened(r, BOB);
    await opened(r, CAROL);
    // Carol (認識, 10 days) cannot; Alice (好朋友, 60 days) can, after the opt-in.
    expect(await r.service.optInLeverage(CAROL, true)).toMatchObject({ ok: false });
    expect(
      await r.service.place(ALICE, { side: "buy", company: "DPSK", coins: 155, leverage: 2 }, "l0"),
    ).toMatchObject({ code: "leverage_opt_in" });
    expect(await r.service.optInLeverage(ALICE, false)).toMatchObject({
      ok: false,
      code: "not_accepted",
    });
    expect(await r.service.optInLeverage(ALICE, true)).toMatchObject({ ok: true });
    // In a thin market one person holds at most a quarter of 800: a 2x buy of 80 is exposure 154.
    expect(
      await r.service.place(
        ALICE,
        { side: "buy", company: "DPSK", coins: 155, leverage: 2 },
        "l0b",
      ),
    ).toMatchObject({ code: "concentration" });
    const q = await r.service.quote(ALICE, {
      side: "buy",
      company: "DPSK",
      coins: 80,
      leverage: 2,
    });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote).toMatchObject({ margin: 77, exposure: 154, fee: 3, max_loss: 77 });
    expect(q.quote.sentence).toContain("最多賠掉 77");
    expect(q.quote.line_price).toBe(
      Math.ceil(((77 + 0.2 * 77) * 100_000) / Math.floor((154 * 100_000) / q.quote.price)),
    );
    await r.service.place(ALICE, { side: "buy", company: "DPSK", coins: 80, leverage: 2 }, "l2");
    await r.service.place(BOB, { side: "buy", company: "WHLE", coins: 200 }, "b");
    await r.at(local(0, 12, 1));
    expect((await r.service.portfolio(ALICE))?.leveraged).toHaveLength(1);
    // Push DPSK's hidden value far down so it falls the limit every round and day.
    let liquidated = false;
    for (let h = 0; h < 24 * 8 && !liquidated; h++) {
      sink(r, "DPSK");
      await r.at(r.clock.at + HOUR);
      liquidated = r.store.notices("p-alice").some((n) => n.kind === "liquidated");
    }
    expect(liquidated).toBe(true);
    const kinds = r.store
      .notices("p-alice")
      .map((n) => n.kind)
      .reverse();
    expect(kinds).toEqual(["warn_half", "warn_near", "liquidated"]);
    expect(r.dms.filter((d) => d.person === "p-alice")).toHaveLength(3);
    const text = r.store.notices("p-alice")[0]?.text ?? "";
    expect(text).toContain("依規則");
    expect(text).not.toMatch(/她/);
    expect(r.wallet.balanceOf("p-alice")).toBeGreaterThan(1000 - 80);
    expect(r.wallet.balanceOf("p-alice")).toBeGreaterThanOrEqual(0);
    expect(books(r).out).toBe(books(r).inside);
  });

  it("adds margin once per key and moves the line down", async () => {
    const r = await rig();
    await opened(r);
    await r.service.optInLeverage(ALICE, true);
    await r.service.place(ALICE, { side: "buy", company: "RICE", coins: 100, leverage: 2 }, "l");
    await r.at(local(0, 12, 1));
    const before = (await r.service.portfolio(ALICE))?.leveraged[0];
    const added = await r.service.addMargin(ALICE, before?.id ?? "", 30, "m1");
    expect(added).toMatchObject({ ok: true, added: 30 });
    expect(await r.service.addMargin(ALICE, before?.id ?? "", 30, "m1")).toMatchObject({
      ok: false,
      code: "duplicate",
    });
    const after = (await r.service.portfolio(ALICE))?.leveraged[0];
    expect(after?.line_price).toBeLessThan(before?.line_price ?? 0);
    expect(after?.margin).toBe((before?.margin ?? 0) + 30);
    expect(r.wallet.balanceOf("p-alice")).toBe(1000 - 100 - 30);
    expect(r.store.vaultBalance()).toBe(r.store.state()?.vault);
  });
});

/** Sets a company's hidden value far under its price (the test's crash). */
function sink(r: R, code: string): void {
  const s = r.store.state();
  if (!s) return;
  for (const c of s.market.companies) if (c.code === code) c.value = 0;
  r.raw.db.exec(
    `UPDATE exchange_state SET market = '${JSON.stringify(s.market).replaceAll("'", "''")}'`,
  );
}

describe("the boards", () => {
  it("rank by wallet plus holdings, leave out who hides, and show holdings only when asked", async () => {
    const r = await rig();
    await opened(r, ALICE, 1000);
    await opened(r, BOB, 400);
    await opened(r, CAROL, 700);
    await r.service.place(BOB, { side: "buy", company: "NAPS", coins: 200 }, "b");
    await r.at(local(0, 12, 1));
    let b = await r.service.boards(BOB);
    expect(b.rich.map((x) => x.name)).toEqual(["Alice", "Carol", "Bob"]);
    expect(b.volume.map((x) => x.name)).toEqual(["Bob"]);
    expect(b.rich[2]?.holdings).toBeNull();
    await r.service.setVisibility(ALICE, { hide_boards: true });
    await r.service.setVisibility(BOB, { show_holdings: true });
    b = await r.service.boards(ALICE);
    expect(b.rich.map((x) => x.name)).toEqual(["Carol", "Bob"]);
    expect(b.rich[1]?.holdings?.[0]?.code).toBe("NAPS");
    expect(b.me).toEqual({ rich: 1, volume: null, hidden: true });
  });

  it("rank one server's members among themselves, with the same prices and holdings", async () => {
    const r = await rig();
    await opened(r, ALICE, 1000);
    await opened(r, BOB, 400);
    await opened(r, CAROL, 700);
    await r.service.place(BOB, { side: "buy", company: "NAPS", coins: 200 }, "b");
    await r.at(local(0, 12, 1));
    const everyone = await r.service.boards(BOB);
    const server = await r.service.boards(BOB, new Set(["p-alice", "p-bob"]));
    expect(server.rich.map((x) => [x.rank, x.name])).toEqual([
      [1, "Alice"],
      [2, "Bob"],
    ]);
    // Bob's worth is the global one: only who is ranked differs.
    expect(server.rich[1]?.worth).toBe(everyone.rich.find((x) => x.name === "Bob")?.worth);
    expect(server.volume.map((x) => x.name)).toEqual(["Bob"]);
    expect(server.me).toEqual({ rich: 2, volume: 1, hidden: false });
    // Someone who is not a member there has no place on that list.
    const other = await r.service.boards(CAROL, new Set(["p-alice", "p-bob"]));
    expect(other.me).toEqual({ rich: null, volume: null, hidden: false });
  });
});

describe("people", () => {
  it("keeps holdings when someone is forgotten and moves them when two are merged", async () => {
    const r = await rig();
    await opened(r);
    await opened(r, BOB);
    await r.service.place(BOB, { side: "buy", company: "NAPS", coins: 200 }, "b");
    await r.at(local(0, 12, 1));
    expect(exchangeTables.forgetPerson?.(r.store, { person: "p-bob" } as never)).toMatchObject({
      declined: expect.any(String),
    });
    const merged = r.store.merge("p-alice", "p-bob");
    expect(merged.counts).toMatchObject({ exchange_positions: 1, exchange_accounts: 1 });
    expect(r.store.openPositions("p-alice")).toHaveLength(1);
    expect(r.store.account("p-bob")).toBeNull();
    expect(r.store.account("p-alice")).not.toBeNull();
  });
});

describe("the books over many days", () => {
  it("balance to the coin and the vault never goes below zero, with people trading at random", async () => {
    const r = await rig();
    const people = [ALICE, BOB, CAROL];
    for (const p of people) await opened(r, p, 2000);
    await r.service.optInLeverage(ALICE, true);
    let n = 0;
    for (let h = 0; h < 24 * 6; h++) {
      const who = people[h % 3] ?? ALICE;
      const codes = ["DPSK", "RICE", "NAPS", "WHLE"];
      const code = codes[(h * 7) % codes.length] ?? "DPSK";
      if (h % 2 === 0)
        await r.service.place(
          who,
          { side: "buy", company: code, coins: 20 + ((h * 13) % 120) },
          `k${n++}`,
        );
      else
        for (const c of codes)
          await r.service.place(who, { side: "sell", company: c, all: true }, `k${n++}`);
      if (h % 11 === 0)
        await r.service.place(
          ALICE,
          { side: "buy", company: h % 22 === 0 ? "CUBE" : "WHLE", coins: 40, leverage: 2 },
          `k${n++}`,
        );
      await r.runTo(r.clock.at + HOUR);
      const s = r.store.state();
      expect(s?.vault).toBeGreaterThanOrEqual(0);
      expect(books(r).out).toBe(books(r).inside);
      for (const p of ["p-alice", "p-bob", "p-carol"])
        expect(r.wallet.balanceOf(p)).toBeGreaterThanOrEqual(0);
    }
    expect(r.store.vaultBalance() ?? 0).toBe(r.store.state()?.vault);
    expect(r.clock.at - T0).toBeGreaterThan(5 * DAY);
    // People did trade: sales were paid and leverage was taken.
    expect(r.store.fills("p-bob", 1000).some((f) => f.side === "sell")).toBe(true);
    expect(r.store.fills("p-alice", 1000).filter((f) => f.leverage === 2).length).toBeGreaterThan(
      1,
    );
    void MIN;
  }, 30_000);
});
