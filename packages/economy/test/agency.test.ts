// Her own money (docs/design/economy.md §13), through her real tools and the real gate against a
// real store (SQLite in memory) and fakes of the rest of her: the share of gifts that is hers, what
// she treats people to, crowdfunding goals (escrow, reached, expired, withdrawn) and bounties.

import {
  ActuatorRegistry,
  ActuatorRegistryKey,
  CapabilityTool,
  defineCapability,
} from "@miyoria/gate/actions";
import { getLogger, ServiceRegistry } from "@miyoria/runtime/kernel";
import { SingerKey } from "@miyoria/sing";
import { PeopleStoreKey, SqliteStore } from "@miyoria/store";
import {
  type AccountRef,
  AffectStateKey,
  AuthorizerKey,
  type ContextKey,
  DirectivesKey,
  EventLogKey,
  HandleDirectoryKey,
  type JsonValue,
  ModerationKey,
  newId,
  type PersonId,
  Principals,
  SelfStateKey,
  SocialSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { agencyCapabilities } from "../src/agency-tools.js";
import { EconomyConfigSchema } from "../src/config.js";
import { EconomyService } from "../src/economy.js";
import { shortId } from "../src/purse.js";
import { BountyStoreKey, CoinLedgerStoreKey, PURSE } from "../src/records.js";
import { EconomyKey } from "../src/types.js";
import { economyOf, ledgerOf, walletOf } from "./ledger.js";

/** 2026-11-08 12:00 local (UTC+8). */
const T0 = Date.UTC(2026, 10, 8, 4, 0, 0);
const DAY = 86_400_000;
const discord = (id: string): AccountRef => ({ platform: "discord", id });
const ALICE = discord("1");
const BOB = discord("2");
const CAROL = discord("3"); // blocked
const DAVE = discord("4"); // never met

const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };

interface Observed {
  summary: string;
  writer: string;
}

interface Rig {
  economy: EconomyService;
  store: SqliteStore;
  registry: ActuatorRegistry;
  clock: { at: number };
  observed: Observed[];
  stage: { calls: Record<string, JsonValue>[]; fail: boolean; up: boolean };
  singing: { value: boolean };
  rules: { words: string[] };
}

let stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores) await s.close();
  stores = [];
});

async function rig(config: Record<string, JsonValue> = {}): Promise<Rig> {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  const services = new ServiceRegistry();
  const k = "test";
  services.provide(k, CoinLedgerStoreKey, ledgerOf(store));
  services.provide(k, BountyStoreKey, economyOf(store).bounties);
  services.provide(k, PeopleStoreKey, store.people);
  const people = new Map<string, PersonId>();
  for (const [a, name] of [
    [ALICE, "Alice"],
    [BOB, "Bob"],
    [CAROL, "Carol"],
  ] as const) {
    people.set(a.id, await store.people.upsertAccount(a, name));
  }
  services.provide(k, SocialSignalsKey, {
    attitude: (a: AccountRef) => ({ blocked: a.id === CAROL.id }) as never,
  });
  services.provide(k, AuthorizerKey, {
    allows: (_a: AccountRef, n: string) => n === "me.wallet",
  } as never);
  services.provide(k, AffectStateKey, { card: () => null, cards: () => [] } as never);
  const hunger = { value: 0.9 };
  services.provide(k, SelfStateKey, {
    drives: () => ({ hunger: hunger.value }),
    adjust: (d: { hunger?: number }) => {
      hunger.value = Math.min(Math.max(hunger.value + (d.hunger ?? 0), 0), 1);
    },
  } as never);
  services.provide(k, ModerationKey, {
    screen: (c: { visible?: string }) => ({ ok: !/BADWORD/.test(c.visible ?? "") }),
    inspect: () => ({ action: "pass" }),
  } as never);
  const observed: Observed[] = [];
  services.provide(k, EventLogKey, {
    observe: (
      o: { summary: string },
      opts: { buckets?: readonly { writer: string }[] } | undefined,
    ) => {
      observed.push({ summary: o.summary, writer: opts?.buckets?.[0]?.writer ?? "" });
      return {} as never;
    },
  } as never);
  const handles = [...people.entries()].map(([id, person]) => ({
    handle: id,
    person,
    account: discord(id),
    display_name: id,
    created_at: new Date(T0).toISOString(),
  }));
  services.provide(k, HandleDirectoryKey, {
    resolve: (h: string) => handles.find((e) => e.handle === h) ?? null,
    list: () => handles,
    ofPerson: (p: PersonId) => handles.find((e) => e.person === p)?.handle ?? null,
  } as never);
  const rules = { words: [] as string[] };
  services.provide(k, DirectivesKey, {
    forbids: (g: { what: string }) => {
      const word = rules.words.find((w) => g.what.includes(w));
      return word ? { text: `不要${word}` } : null;
    },
    check: async () => ({ outcome: "allow" }),
  } as never);
  const singing = { value: false };
  services.provide(k, SingerKey, { playing: () => (singing.value ? {} : null) } as never);

  const clock = { at: T0 };
  const registry = new ActuatorRegistry({ services, builtins: false });
  services.provide(k, ActuatorRegistryKey, registry);
  for (const [name, risk] of [
    ["stream.start", "high"],
    ["sing.play", "low"],
  ] as const) {
    registry.register(
      defineCapability<unknown>({
        name,
        summary: name,
        risk,
        args: z.object({}),
        permission: null,
        async execute() {
          return "ok";
        },
      }),
    );
  }
  const stage = { calls: [] as Record<string, JsonValue>[], fail: false, up: true };
  registry.register(
    defineCapability<Record<string, JsonValue>>({
      name: "stage.expression",
      summary: "expression",
      risk: "low",
      args: z.record(z.string(), z.unknown()) as never,
      permission: null,
      async execute(args) {
        if (stage.fail) throw new Error("no stage");
        stage.calls.push(args);
        return "ok";
      },
    }),
  );
  const economy = new EconomyService({
    // Achievement coins are tested in achievements.test.ts; off here so these sums stay exact.
    config: EconomyConfigSchema.parse({ achievement_cap: 0, ...config }),
    services,
    profile: "p",
    clock: { now: () => clock.at },
    publish: () => undefined,
    log: getLogger("test"),
  });
  services.provide(k, EconomyKey, economy);
  for (const c of agencyCapabilities(economy)) registry.register(c);
  const r: Rig = { economy, store, registry, clock, observed, stage, singing, rules };
  return r;
}

async function fund(r: Rig, account: AccountRef, amount: number) {
  await ledgerOf(r.store).post({
    id: newId(),
    person: walletOf(r.store, account),
    delta: amount,
    reason: "talked",
    ref: null,
    idem_key: null,
    ts: toTimestamp(r.clock.at),
  });
}

const balance = (r: Rig, a: AccountRef) => ledgerOf(r.store).balance("p", walletOf(r.store, a));
const purse = (r: Rig) => r.economy.purse.balance();

/** One of her tools, called in a turn where `speaker` wrote message `id`; always `on_own`. */
async function say(
  r: Rig,
  tool: string,
  speaker: AccountRef,
  id: string,
  args: Record<string, JsonValue> = {},
): Promise<{ text: string; data: Record<string, JsonValue> }> {
  const capability = [...agencyCapabilities(r.economy)].find((c) => c.tool?.name === tool);
  if (!capability) throw new Error(`no tool ${tool}`);
  let data: JsonValue = null;
  const text = await new CapabilityTool(
    r.registry,
    r.registry.get(capability.name) ?? capability,
  ).call(
    {
      turn: `turn-${id}`,
      context: TEXT,
      account: speaker,
      principal: Principals.user(speaker, TEXT),
      message: { context: TEXT, id },
      priority: "request",
      signal: new AbortController().signal,
      report: (d) => {
        data = d;
      },
    },
    { on_own: true, why: "測試", ...args },
  );
  return { text, data: (data ?? {}) as Record<string, JsonValue> };
}

const lastNote = (r: Rig) => r.observed.filter((o) => o.writer === "purse").at(-1)?.summary ?? "";

describe("her share of gifts", () => {
  it("is a fifth of a paid gift, floored, and only of the ones she is given", async () => {
    const r = await rig();
    await fund(r, ALICE, 500);
    await r.economy.feed(ALICE, "rice", 1, "k1");
    expect(await purse(r)).toBe(2);
    await r.economy.purchase(ALICE, "screen_message", "k3");
    expect(await purse(r)).toBe(8);
    // A fortune is not a gift to her; neither is a frame.
    await r.economy.purchase(ALICE, "fortune", "k4");
    await r.economy.frame(ALICE, { buy: "sakura" }, "k5");
    expect(await purse(r)).toBe(8);
    const rows = await ledgerOf(r.store).entries("p", PURSE, {
      reasons: ["her_share"],
      limit: 20,
    });
    expect(rows.map((x) => x.delta).sort()).toEqual([2, 6]);
    // Her share is not the person's loss: they paid the full price.
    expect(await balance(r, ALICE)).toBe(500 - 10 - 30 - 10 - 100);
  });

  it("is paid once per gift and not at all when the share is off", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    await r.economy.feed(ALICE, "rice", 1, "same");
    await r.economy.feed(ALICE, "rice", 1, "same");
    expect(await purse(r)).toBe(2);
    const off = await rig({ her_share: 0 });
    await fund(off, ALICE, 100);
    await off.economy.feed(ALICE, "rice", 1, "k");
    expect(await purse(off)).toBe(0);
  });

  it("is taken back when the gift is refunded, as far as she still has it", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const bought = await r.economy.purchase(ALICE, "screen_message", "k");
    expect(await purse(r)).toBe(6);
    expect(await r.economy.refund(ALICE, bought.entry_id)).toBe(true);
    expect(await purse(r)).toBe(0);
    expect(await r.economy.refund(ALICE, bought.entry_id)).toBe(false);
    expect(await purse(r)).toBe(0);
    // She spent most of it before the refund: only what is left goes back.
    const second = await r.economy.purchase(ALICE, "screen_message", "k2");
    await r.economy.purse.debit(5, "purse_treat", null, "spent");
    await r.economy.refund(ALICE, second.entry_id);
    expect(await purse(r)).toBe(0);
    expect(await balance(r, ALICE)).toBe(100);
  });

  it("shows up in her working context", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    await r.economy.feed(ALICE, "rice", 1, "k");
    await r.economy.purse.refresh();
    expect(lastNote(r)).toContain("你的小錢包有 2 魚幣");
  });
});

describe("treating people from her purse", () => {
  it("gives from the purse, within what she has and the day's caps", async () => {
    const r = await rig();
    await r.economy.purse.credit(100, "her_share", null, "seed");
    const first = await say(r, "treat_from_purse", ALICE, "m1", { amount: 20, reason: "陪我" });
    expect(first.data).toMatchObject({ done: true, given: 20, left: 80 });
    expect(await balance(r, ALICE)).toBe(20);
    expect(await purse(r)).toBe(80);
    // 30 a person a day: only 10 more.
    const second = await say(r, "treat_from_purse", ALICE, "m2", { amount: 20, reason: "再一次" });
    expect(second.data).toMatchObject({ done: true, given: 10 });
    expect(second.text).toContain("只夠");
    const third = await say(r, "treat_from_purse", ALICE, "m3", { amount: 5, reason: "又" });
    expect(third.data).toMatchObject({ done: false, given: 0 });
    expect(await balance(r, ALICE)).toBe(30);
    expect((await r.economy.wallet(ALICE)).recent[0]?.label).toBe("她請你的");
  });

  it("counts nothing toward her give_coins caps, and the total is its own", async () => {
    const r = await rig({ treat_total: 25, treat_per_person: 20 });
    await r.economy.purse.credit(100, "her_share", null, "seed");
    await say(r, "treat_from_purse", ALICE, "a", { amount: 20, reason: "x" });
    expect((await r.economy.give(ALICE, 30, "獎勵")).given).toBe(30);
    const bob = await say(r, "treat_from_purse", BOB, "b", { amount: 20, reason: "y" });
    expect(bob.data).toMatchObject({ given: 5 });
    expect(await purse(r)).toBe(75);
  });

  it("stops when the purse is empty", async () => {
    const r = await rig();
    await r.economy.purse.credit(8, "her_share", null, "seed");
    const out = await say(r, "treat_from_purse", ALICE, "a", { amount: 20, reason: "x" });
    expect(out.data).toMatchObject({ given: 8, left: 0 });
    const again = await say(r, "treat_from_purse", ALICE, "b", { amount: 5, reason: "x" });
    expect(again.data).toMatchObject({ done: false, given: 0 });
  });

  it("is for people she knows who are not blocked, and only for the one talking to her", async () => {
    const r = await rig();
    await r.economy.purse.credit(100, "her_share", null, "seed");
    for (const who of [CAROL, DAVE]) {
      const out = await say(r, "treat_from_purse", who, `m-${who.id}`, { amount: 5, reason: "x" });
      expect(out.data).toMatchObject({ done: false, reason: "stranger" });
    }
    expect(await purse(r)).toBe(100);
    // The schema has no "to": a name in the arguments is refused.
    await expect(
      say(r, "treat_from_purse", ALICE, "n", { amount: 5, reason: "x", to: "Bob" }),
    ).rejects.toBeTruthy();
    // Without anyone talking to her there is no one to treat.
    const outcome = await r.registry.invoke({
      principal: Principals.self(null, null),
      capability: "economy.treat",
      args: { amount: 5, reason: "x" },
      why: "x",
      turn: null,
    });
    expect(outcome.status).not.toBe("done");
    expect(await purse(r)).toBe(100);
  });

  it("cannot be asked for: without on_own the gate refuses", async () => {
    const r = await rig();
    await r.economy.purse.credit(100, "her_share", null, "seed");
    const outcome = await r.registry.invoke({
      principal: Principals.user(ALICE, TEXT),
      capability: "economy.treat",
      args: { amount: 5, reason: "x" },
      why: "x",
      turn: "t",
      message: { context: TEXT, id: "m" },
    });
    expect(outcome.status).toBe("denied");
    expect(await purse(r)).toBe(100);
  });
});

describe("buying an expression for herself", () => {
  it("pays from the purse and shows it on stage", async () => {
    const r = await rig();
    await r.economy.purse.credit(50, "her_share", null, "seed");
    const out = await say(r, "buy_for_self", ALICE, "m", { expression: "heart" });
    expect(out.data).toMatchObject({ done: true, paid: 20, left: 30 });
    expect(r.stage.calls).toEqual([{ expression: "heart", seconds: 8 }]);
    expect(await purse(r)).toBe(30);
  });

  it("gives the coins back when it does not show, and refuses when it cannot", async () => {
    const r = await rig({ self_expressions_per_day: 2 });
    await r.economy.purse.credit(100, "her_share", null, "seed");
    r.stage.fail = true;
    const failed = await say(r, "buy_for_self", ALICE, "a", { expression: "blush" });
    expect(failed.data).toMatchObject({ done: false });
    expect(await purse(r)).toBe(100);
    r.stage.fail = false;
    r.singing.value = true;
    expect((await say(r, "buy_for_self", ALICE, "b", { expression: "blush" })).data).toMatchObject({
      done: false,
    });
    r.singing.value = false;
    await say(r, "buy_for_self", ALICE, "c", { expression: "squint" });
    await say(r, "buy_for_self", ALICE, "d", { expression: "squint" });
    const capped = await say(r, "buy_for_self", ALICE, "e", { expression: "squint" });
    expect(capped.data).toMatchObject({ done: false, reason: "limit" });
    expect(await purse(r)).toBe(60);
  });

  it("is refused when the purse is short", async () => {
    const r = await rig();
    await r.economy.purse.credit(5, "her_share", null, "seed");
    const out = await say(r, "buy_for_self", ALICE, "a", { expression: "heart" });
    expect(out.data).toMatchObject({ done: false, reason: "not_enough" });
    expect(r.stage.calls).toEqual([]);
    expect(await purse(r)).toBe(5);
  });
});

async function post(r: Rig, args: Record<string, JsonValue>) {
  const out = await say(r, "post_bounty", ALICE, newId(), args);
  const rows = await economyOf(r.store).bounties.list("p", { statuses: ["open"], limit: 10 });
  return { out, rows };
}

describe("bounties", () => {
  it("holds the reward out of the purse and pays it to the person talking to her, once", async () => {
    const r = await rig();
    await r.economy.purse.credit(100, "her_share", null, "seed");
    const { out, rows } = await post(r, { task: "猜她的幸運數字", reward: 30 });
    expect(out.data).toMatchObject({ done: true, reward: 30 });
    expect(await purse(r)).toBe(70);
    const [b] = rows;
    if (!b) throw new Error("no bounty");
    expect(await r.economy.bounties()).toEqual([
      {
        id: b.id,
        task: "猜她的幸運數字",
        reward: 30,
        posted_at: toTimestamp(T0),
        expires_at: toTimestamp(T0 + 3 * DAY),
      },
    ]);
    const paid = await say(r, "award_bounty", BOB, "w", { bounty: shortId(b.id) });
    expect(paid.data).toMatchObject({ done: true, paid: 30 });
    expect(await balance(r, BOB)).toBe(30);
    expect(await purse(r)).toBe(70);
    expect((await r.economy.wallet(BOB)).recent[0]?.label).toBe("領到她的懸賞");
    const done = await economyOf(r.store).bounties.get(b.id);
    expect(done).toMatchObject({ status: "awarded", winner: BOB });
    // One award per bounty, and it is off the list.
    const again = await say(r, "award_bounty", ALICE, "w2", { bounty: shortId(b.id) });
    expect(again.data).toMatchObject({ done: false, reason: "no_bounty" });
    expect(await balance(r, ALICE)).toBe(0);
    expect(await r.economy.bounties()).toEqual([]);
  });

  it("is never paid to herself, to a stranger or to someone she has blocked", async () => {
    const r = await rig();
    await r.economy.purse.credit(100, "her_share", null, "seed");
    const { rows } = await post(r, { task: "畫她", reward: 10 });
    const ref = shortId(rows[0]?.id ?? "");
    await expect(r.economy.bountyDesk.award(r.economy.purse.account, ref)).rejects.toMatchObject({
      status: 400,
    });
    for (const who of [DAVE, CAROL]) {
      const out = await say(r, "award_bounty", who, `m-${who.id}`, { bounty: ref });
      expect(out.data).toMatchObject({ done: false, reason: "stranger" });
    }
    expect(await purse(r)).toBe(90);
    expect((await economyOf(r.store).bounties.get(rows[0]?.id ?? ""))?.status).toBe("open");
  });

  it("goes back to the purse when she cancels it or nobody takes it in time", async () => {
    const r = await rig();
    await r.economy.purse.credit(100, "her_share", null, "seed");
    const { rows } = await post(r, { task: "A", reward: 20 });
    await post(r, { task: "B", reward: 25 });
    expect(await purse(r)).toBe(55);
    const first = rows.find((b) => b.task === "A");
    const cancelled = await say(r, "cancel_bounty", ALICE, "c", {
      bounty: shortId(first?.id ?? ""),
    });
    expect(cancelled.data).toMatchObject({ done: true, reward: 20 });
    expect(await purse(r)).toBe(75);
    r.clock.at = T0 + 4 * DAY;
    await r.economy.bountyDesk.sweep();
    await r.economy.bountyDesk.sweep();
    expect(await purse(r)).toBe(100);
    const all = await economyOf(r.store).bounties.list("p", { limit: 10 });
    expect(all.map((b) => b.status).sort()).toEqual(["cancelled", "expired"]);
    expect(await r.economy.bounties()).toEqual([]);
    // Cancelled ones cannot be cancelled or awarded again.
    expect(
      (await say(r, "cancel_bounty", ALICE, "c2", { bounty: shortId(first?.id ?? "") })).data,
    ).toMatchObject({ done: false, reason: "no_bounty" });
  });

  it("has a few open at most, a top reward, and only what her purse covers", async () => {
    const r = await rig();
    await r.economy.purse.credit(300, "her_share", null, "seed");
    for (const task of ["一", "二", "三"]) {
      expect((await post(r, { task, reward: 10 })).out.data).toMatchObject({ done: true });
    }
    expect((await post(r, { task: "四", reward: 10 })).out.data).toMatchObject({
      done: false,
      reason: "limit",
    });
    expect(await purse(r)).toBe(270);
    const other = await rig();
    await other.economy.purse.credit(40, "her_share", null, "seed");
    expect((await post(other, { task: "大", reward: 51 })).out.data).toMatchObject({
      done: false,
      reason: "invalid",
    });
    expect((await post(other, { task: "貴", reward: 50 })).out.data).toMatchObject({
      done: false,
      reason: "not_enough",
    });
    expect(await purse(other)).toBe(40);
    expect(await economyOf(other.store).bounties.list("p", { limit: 5 })).toEqual([]);
  });

  it("only asks for what is hers to decide", async () => {
    const r = await rig();
    await r.economy.purse.credit(100, "her_share", null, "seed");
    r.rules.words = ["壞事"];
    for (const task of ["開台給我看", "BADWORD", "做壞事"]) {
      expect((await post(r, { task, reward: 10 })).out.data, task).toMatchObject({
        done: false,
        reason: "forbidden",
      });
    }
    expect(await purse(r)).toBe(100);
  });

  it("is told to her in her context", async () => {
    const r = await rig();
    await r.economy.purse.credit(100, "her_share", null, "seed");
    const { rows } = await post(r, { task: "猜謎", reward: 15 });
    expect(lastNote(r)).toContain(`你貼的懸賞[${shortId(rows[0]?.id ?? "")}]「猜謎」15 魚幣`);
  });
});
