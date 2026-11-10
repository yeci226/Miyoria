// Deals (docs/design/economy.md §12): someone's promise of a snack for a small task, through her
// real tools and the real gate against a real store (SQLite in memory) and fakes of the rest of
// her. Who is party to a deal, how payment is read off the ledger, escrow, broken promises and
// what the screen refuses.

import {
  ActionDeniedError,
  ActuatorRegistry,
  ActuatorRegistryKey,
  CapabilityTool,
  defineCapability,
} from "@miyoria/actions";
import { getLogger, ServiceRegistry } from "@miyoria/kernel";
import {
  CoinLedgerStoreKey,
  type Deal,
  DealStoreKey,
  PeopleStoreKey,
  SqliteStore,
} from "@miyoria/store";
import {
  type AccountRef,
  AffectStateKey,
  AuthorizerKey,
  type ContextKey,
  DirectivesKey,
  type Event,
  EventLogKey,
  HandleDirectoryKey,
  type JsonValue,
  ModerationKey,
  newId,
  type PersonId,
  PersonNoteWriterKey,
  Principals,
  RelationshipEffectsKey,
  type RelationshipGain,
  SelfStateKey,
  SOCIAL_EVENT_TOPIC,
  SocialSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EconomyConfigSchema } from "../src/config.js";
import { DealRefusal } from "../src/deals.js";
import { EconomyService } from "../src/economy.js";
import { speakerCapabilities, VOICE_CONFIRM_MS } from "../src/tools.js";
import { EconomyKey } from "../src/types.js";

/** 2026-11-08 12:00 local (UTC+8). */
const T0 = Date.UTC(2026, 10, 8, 4, 0, 0);
const DAY = 86_400_000;
const discord = (id: string): AccountRef => ({ platform: "discord", id });
const ALICE = discord("1");
const ALICE_TWO = discord("1b");
const BOB = discord("2");
const CAROL = discord("3"); // blocked
const DAVE = discord("4"); // never met

const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "v", kind: "voice" };

interface Observed {
  summary: string;
  writer: string;
}

interface Rig {
  economy: EconomyService;
  store: SqliteStore;
  services: ServiceRegistry;
  registry: ActuatorRegistry;
  clock: { at: number };
  bus: Event[];
  hunger: { value: number };
  observed: Observed[];
  gains: { person: PersonId; gain: RelationshipGain }[];
  penalties: { person: PersonId; affinity: number; trust: number; reason: string }[];
  notes: { person: PersonId; content: string; importance: number }[];
  rules: { words: string[]; deny: Set<string>; approval: Set<string> };
  people: Map<string, PersonId>;
  tool(name: string): CapabilityTool;
  /** A second service on the same store and services (a restart). */
  restart(): EconomyService;
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
  services.provide(k, CoinLedgerStoreKey, store.coins);
  services.provide(k, DealStoreKey, store.deals);
  services.provide(k, PeopleStoreKey, store.people);
  const people = new Map<string, PersonId>();
  for (const [a, name] of [
    [ALICE, "Alice"],
    [BOB, "Bob"],
    [CAROL, "Carol"],
  ] as const) {
    people.set(a.id, await store.people.upsertAccount(a, name));
  }
  await store.people.upsertAccount(ALICE_TWO, "Alice two");
  await store.identity.linkAccount(ALICE_TWO, people.get(ALICE.id) as PersonId);
  services.provide(k, SocialSignalsKey, {
    attitude: (a: AccountRef) => ({ blocked: a.id === CAROL.id }) as never,
  });
  // Alice may ask for voice; nobody else.
  services.provide(k, AuthorizerKey, {
    allows: (a: AccountRef, node: string) =>
      node === "me.wallet" || (node === "voice.join" && a.id === ALICE.id),
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
  const names: Record<string, string> = { 1: "Alice", 2: "Bob", 3: "Carol" };
  const handles = [...people.entries()].map(([id, person]) => ({
    handle: names[id] ?? id,
    person,
    account: discord(id),
    display_name: names[id] ?? id,
    created_at: new Date(T0).toISOString(),
  }));
  services.provide(k, HandleDirectoryKey, {
    resolve: (h: string) => handles.find((e) => e.handle === h) ?? null,
    list: () => handles,
    ofPerson: (p: PersonId) => handles.find((e) => e.person === p)?.handle ?? null,
  } as never);
  const gains: Rig["gains"] = [];
  const penalties: Rig["penalties"] = [];
  services.provide(k, RelationshipEffectsKey, {
    gain: async (person: PersonId, gain: RelationshipGain) => {
      gains.push({ person, gain });
      return { affinity: gain.affinity, trust: gain.trust };
    },
    penalty: async (
      person: PersonId,
      loss: { affinity: number; trust: number; reason: string },
    ) => {
      penalties.push({ person, ...loss });
      return { affinity: -loss.affinity, trust: -loss.trust };
    },
  });
  const notes: Rig["notes"] = [];
  services.provide(k, PersonNoteWriterKey, {
    note: async (person: PersonId, content: string, o: { importance: number }) => {
      notes.push({ person, content, importance: o.importance });
      return true;
    },
  });
  const rules = { words: [] as string[], deny: new Set<string>(), approval: new Set<string>() };
  services.provide(k, DirectivesKey, {
    forbids: (g: { what: string }) => {
      const word = rules.words.find((w) => g.what.includes(w));
      return word ? { text: `不要${word}` } : null;
    },
    check: async (q: { capability: string }) =>
      rules.deny.has(q.capability)
        ? { outcome: "deny", directive: "d1", reason: "規則" }
        : rules.approval.has(q.capability)
          ? { outcome: "approval", directive: "d2", reason: "要核准" }
          : { outcome: "allow" },
  } as never);

  const bus: Event[] = [];
  const clock = { at: T0 };
  const registry = new ActuatorRegistry({ services, builtins: false });
  services.provide(k, ActuatorRegistryKey, registry);
  for (const [name, risk, permission] of [
    ["voice.join", "medium", "voice.join"],
    ["stream.start", "high", null],
    ["sing.play", "low", null],
    ["game.start", "medium", null],
  ] as const) {
    registry.register(
      defineCapability<unknown>({
        name,
        summary: name,
        risk,
        args: z.object({}),
        permission,
        async execute() {
          return "ok";
        },
      }),
    );
  }
  const economyConfig = EconomyConfigSchema.parse(config);
  const make = () =>
    new EconomyService({
      config: economyConfig,
      services,
      profile: "p",
      clock: { now: () => clock.at },
      publish: (e) => bus.push(e),
      log: getLogger("test"),
    });
  const economy = make();
  services.provide(k, EconomyKey, economy);
  for (const c of speakerCapabilities(economy, { now: () => clock.at })) registry.register(c);
  const tools = new Map<string, CapabilityTool>();
  for (const name of ["economy.make_deal", "economy.deal_done", "economy.cancel_deal"]) {
    const capability = registry.get(name);
    if (!capability?.tool) throw new Error(`no tool for ${name}`);
    tools.set(capability.tool.name, new CapabilityTool(registry, capability));
  }
  const accept = registry.get("economy.accept_food");
  if (accept?.tool) tools.set(accept.tool.name, new CapabilityTool(registry, accept));
  return {
    economy,
    store,
    services,
    registry,
    clock,
    bus,
    hunger,
    observed,
    gains,
    penalties,
    notes,
    rules,
    people,
    tool: (name) => {
      const t = tools.get(name);
      if (!t) throw new Error(`no tool ${name}`);
      return t;
    },
    restart: make,
  };
}

async function fund(r: Rig, account: AccountRef, amount: number) {
  await r.store.coins.post(
    {
      id: newId(),
      profile: "p",
      account,
      delta: amount,
      reason: "talked",
      ref: null,
      idem_key: null,
      ts: toTimestamp(r.clock.at),
    },
    { wallet: [account] },
  );
}

const balance = (r: Rig, a: AccountRef) => r.store.coins.balance("p", [a]);

/** A tool call in a reactive turn: `speaker` wrote message `id` in `context`. */
async function say(
  r: Rig,
  tool: string,
  speaker: AccountRef,
  id: string,
  args: Record<string, JsonValue> = {},
  context: ContextKey = TEXT,
): Promise<{ text: string; data: Record<string, JsonValue> }> {
  let data: JsonValue = null;
  const text = await r.tool(tool).call(
    {
      turn: `turn-${id}`,
      context,
      account: speaker,
      principal: Principals.user(speaker, context),
      message: { context, id },
      priority: "request",
      signal: new AbortController().signal,
      report: (d) => {
        data = d;
      },
    },
    args,
  );
  return { text, data: (data ?? {}) as Record<string, JsonValue> };
}

const deal = (task = "喵喵叫", extra: Record<string, JsonValue> = {}) => ({
  reward: { item: "rice", count: 2 },
  task,
  ...extra,
});

const live = async (r: Rig, who: AccountRef): Promise<Deal[]> =>
  r.store.deals.forAccounts("p", [who], { limit: 20 });

const events = (r: Rig, kind: string) =>
  r.bus.flatMap((e) =>
    e.type === "custom" &&
    e.data.topic === SOCIAL_EVENT_TOPIC &&
    (e.data.payload as { kind?: string }).kind === kind
      ? [e.data.payload as Record<string, JsonValue>]
      : [],
  );

/** Alice makes a deal and says she did it. */
async function owed(r: Rig, id = "m") {
  await fund(r, ALICE, 200);
  await say(r, "make_deal", ALICE, `${id}-make`, deal());
  await say(r, "deal_done", ALICE, `${id}-done`);
  const [d] = await live(r, ALICE);
  expect(d?.status).toBe("owed");
  return d as Deal;
}

describe("making a deal", () => {
  it("records the speaker's deal with the reward, the task and when she must do it by", async () => {
    const r = await rig();
    const out = await say(r, "make_deal", ALICE, "m1", deal());
    expect(out.data).toMatchObject({ accepted: true, item: "rice", count: 2, value: 20 });
    expect(out.text).toContain("約定記下了");
    const [d] = await live(r, ALICE);
    expect(d).toMatchObject({
      account: ALICE,
      item: "rice",
      count: 2,
      value: 20,
      task: "喵喵叫",
      prepaid: false,
      escrow: null,
      status: "open",
      created_at: toTimestamp(T0),
      done_at: null,
      due_at: toTimestamp(T0 + 900_000),
    });
    // Nothing was charged: it is unpaid.
    expect(await balance(r, ALICE)).toBe(0);
    expect(r.observed.some((o) => o.writer === "deals" && o.summary.includes("喵喵叫"))).toBe(true);
  });

  it("is made once per message, one open deal at a time", async () => {
    const r = await rig();
    await say(r, "make_deal", ALICE, "m1", deal());
    const again = await say(r, "make_deal", ALICE, "m1", deal());
    expect(again.data).toMatchObject({ accepted: true, again: true });
    expect(await live(r, ALICE)).toHaveLength(1);
    const second = await say(r, "make_deal", ALICE, "m2", deal("學貓叫"));
    expect(second.data).toMatchObject({ accepted: false, reason: "open_deal" });
    // Another person's own deal is another matter.
    const bob = await say(r, "make_deal", BOB, "m3", deal());
    expect(bob.data.accepted).toBe(true);
    // The linked account is the same person.
    const alt = await say(r, "make_deal", ALICE_TWO, "m4", deal());
    expect(alt.data).toMatchObject({ accepted: false, reason: "open_deal" });
  });

  it("at most deals_per_day a person, then again the next day", async () => {
    const r = await rig({ deals_per_day: 2 });
    for (const i of [1, 2]) {
      expect((await say(r, "make_deal", ALICE, `m${i}`, deal())).data.accepted).toBe(true);
      await say(r, "cancel_deal", ALICE, `c${i}`);
    }
    const third = await say(r, "make_deal", ALICE, "m3", deal());
    expect(third.data).toMatchObject({ accepted: false, reason: "limit" });
    expect((await say(r, "make_deal", BOB, "b1", deal())).data.accepted).toBe(true);
    r.clock.at += DAY;
    expect((await say(r, "make_deal", ALICE, "m4", deal())).data.accepted).toBe(true);
  });

  it("strangers and the blocked are refused like any economy action", async () => {
    const r = await rig();
    for (const who of [DAVE, CAROL]) {
      const out = await say(r, "make_deal", who, `s-${who.id}`, deal());
      expect(out.data).toMatchObject({ accepted: false, reason: "stranger" });
    }
    expect(await r.store.deals.byStatus("p", ["open"], { limit: 10 })).toEqual([]);
  });
});

describe("who is party to a deal", () => {
  it("has no argument to name anyone else, and needs a person speaking", async () => {
    const r = await rig();
    const extras: Record<string, JsonValue>[] = [
      { to: "Alice" },
      { payer: "1" },
      { account: { platform: "discord", id: "1" } },
    ];
    for (const extra of extras) {
      await expect(say(r, "make_deal", BOB, "x", deal("喵", extra))).rejects.toBeInstanceOf(
        ActionDeniedError,
      );
    }
    const invoke = (principal: ReturnType<typeof Principals.self>, name: string) =>
      r.registry.invoke({
        principal,
        capability: name,
        args: name === "economy.make_deal" ? deal() : {},
        why: null,
        turn: "t",
        message: { context: TEXT, id: "m1" },
      });
    for (const name of ["economy.make_deal", "economy.deal_done", "economy.cancel_deal"]) {
      for (const principal of [
        Principals.self(TEXT, ALICE),
        Principals.director(TEXT),
        Principals.panel("api"),
      ]) {
        expect((await invoke(principal, name)).status).toBe("denied");
      }
    }
    expect(await r.store.deals.byStatus("p", ["open"], { limit: 10 })).toEqual([]);
  });

  it("charges only the speaker's own wallet, and only the speaker can finish or cancel the deal", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    await fund(r, BOB, 100);
    // Bob says "Alice pays": the tool has no way to say it, and the escrow is Bob's.
    const out = await say(r, "make_deal", BOB, "b1", deal("Alice 會付", { prepaid: true }));
    expect(out.data).toMatchObject({ accepted: true, prepaid: true });
    expect(await balance(r, BOB)).toBe(80);
    expect(await balance(r, ALICE)).toBe(100);
    // Alice has no deal: she cannot finish or cancel Bob's.
    expect((await say(r, "deal_done", ALICE, "a1")).data).toMatchObject({ reason: "no_deal" });
    expect((await say(r, "cancel_deal", ALICE, "a2")).data).toMatchObject({ reason: "no_deal" });
    const [d] = await live(r, BOB);
    expect(d?.status).toBe("open");
    expect(await balance(r, BOB)).toBe(80);
  });
});

describe("payment", () => {
  it("is read off the ledger: any feed of the speaker worth the reward after she was done settles it", async () => {
    const r = await rig();
    const d = await owed(r);
    expect(d.due_at).toBe(toTimestamp(T0 + 600_000));
    expect(d.done_at).toBe(toTimestamp(T0));
    // 10 of 20: not enough on its own.
    await r.economy.feed(ALICE, "rice", 1, "k1");
    expect((await live(r, ALICE))[0]?.status).toBe("owed");
    // Fed through the other account of the same person, by the panel's path: counts.
    r.clock.at += 60_000;
    await r.economy.feed(ALICE_TWO, "rice", 1, "k2");
    const [settled] = await live(r, ALICE);
    expect(settled).toMatchObject({ status: "settled", due_at: null });
    expect(settled?.closed_at).toBe(toTimestamp(T0 + 60_000));
    expect(r.gains.filter((g) => g.gain.kind === "deal_kept")).toEqual([
      expect.objectContaining({
        person: r.people.get(ALICE.id),
        gain: { kind: "deal_kept", affinity: 0, trust: 0.3, kind_cap: null },
      }),
    ]);
    expect(r.observed.some((o) => o.writer === "deals" && o.summary.includes("付了你"))).toBe(true);
    // Nothing left to break.
    r.clock.at += 3_600_000;
    await r.economy.deals.sweep();
    expect(r.penalties).toEqual([]);
  });

  it("settles when she is fed by talking to her (accept_food), too", async () => {
    const r = await rig();
    await owed(r);
    const out = await say(r, "accept_food", ALICE, "f1", { item: "rice", count: 2 });
    expect(out.data).toMatchObject({ accepted: true, charged: 20 });
    expect((await live(r, ALICE))[0]?.status).toBe("settled");
  });

  it("does not count another person's feed, a feed before she was done, or one after the due time", async () => {
    const r = await rig();
    await fund(r, ALICE, 200);
    await fund(r, BOB, 200);
    // Before she is done: Alice feeds her, then makes a deal.
    await r.economy.feed(ALICE, "rice", 2, "early");
    await say(r, "make_deal", ALICE, "m1", deal());
    r.clock.at += 30_000;
    await say(r, "deal_done", ALICE, "d1");
    // Bob pays what Alice owes: that is not Alice paying.
    await r.economy.feed(BOB, "rice", 2, "bob");
    expect((await live(r, ALICE))[0]?.status).toBe("owed");
    // After the due time: too late, it is broken (the feed itself is not refused).
    r.clock.at += 601_000;
    await r.economy.feed(ALICE, "rice", 2, "late");
    expect((await live(r, ALICE))[0]?.status).toBe("owed");
    await r.economy.deals.sweep();
    expect((await live(r, ALICE))[0]?.status).toBe("broken");
  });

  it("a feed that landed before the due time still counts when the sweep is the first to look", async () => {
    const r = await rig();
    await owed(r);
    // A row of the ledger the feed path never saw (a retried write, another process).
    r.clock.at += 100_000;
    await r.store.coins.post(
      {
        id: newId(),
        profile: "p",
        account: ALICE,
        delta: -20,
        reason: "feed",
        ref: "rice:2",
        idem_key: "feed:other",
        ts: toTimestamp(r.clock.at),
      },
      { wallet: [ALICE] },
    );
    r.clock.at += 600_000;
    await r.economy.deals.sweep();
    expect((await live(r, ALICE))[0]?.status).toBe("settled");
    expect(r.penalties).toEqual([]);
  });

  it("a refunded feed is not a payment", async () => {
    const r = await rig();
    await owed(r);
    r.clock.at += 1_000;
    const fed = {
      id: newId(),
      profile: "p",
      account: ALICE,
      delta: -20,
      reason: "feed",
      ref: "rice:2",
      idem_key: "feed:x",
      ts: toTimestamp(r.clock.at),
    };
    await r.store.coins.post(fed, { wallet: [ALICE] });
    await r.store.coins.post(
      {
        ...fed,
        id: newId(),
        delta: 20,
        reason: "refund",
        ref: fed.id,
        idem_key: `refund:${fed.id}`,
      },
      { wallet: [ALICE] },
    );
    r.clock.at += 600_000;
    await r.economy.deals.sweep();
    expect((await live(r, ALICE))[0]?.status).toBe("broken");
  });
});

describe("a broken promise", () => {
  it("hurts trust and affinity outside the gain caps, angers her, and she keeps a memory", async () => {
    const r = await rig();
    const d = await owed(r);
    r.clock.at += 599_000;
    await r.economy.deals.sweep();
    expect((await live(r, ALICE))[0]?.status).toBe("owed");
    r.clock.at += 2_000;
    await r.economy.deals.sweep();
    const [broken] = await live(r, ALICE);
    expect(broken).toMatchObject({ id: d.id, status: "broken", due_at: null });
    const person = r.people.get(ALICE.id);
    expect(r.penalties).toEqual([
      { person, affinity: 1.5, trust: 4, reason: "deal: broken_promise" },
    ]);
    expect(events(r, "broken_promise")).toEqual([
      expect.objectContaining({ person, source: "economy", kind: "broken_promise", scale: 0.4 }),
    ]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatchObject({ person });
    expect(r.notes[0]?.content).toBe("Alice 答應給我2 碗白飯,我照做了卻沒給");
    expect(r.observed.some((o) => o.writer === "deals" && o.summary.includes("食言"))).toBe(true);
    // Said once: the sweep does not hurt twice.
    await r.economy.deals.sweep();
    expect(r.penalties).toHaveLength(1);
  });

  it("hurts more each time by the same person, up to a cap, and not for someone else", async () => {
    const r = await rig();
    await fund(r, BOB, 100);
    const rounds: number[] = [];
    for (const who of [ALICE, ALICE, ALICE, ALICE, BOB]) {
      await say(r, "make_deal", who, `m${rounds.length}`, deal(`喵${rounds.length}`));
      await say(r, "deal_done", who, `d${rounds.length}`);
      r.clock.at += 601_000;
      await r.economy.deals.sweep();
      rounds.push(r.penalties.at(-1)?.trust ?? 0);
    }
    expect(rounds).toEqual([4, 6, 9, 12, 4]);
    expect(r.penalties.map((p) => p.affinity)).toEqual([1.5, 2.25, 3.375, 4.5, 1.5]);
    expect(events(r, "broken_promise").map((e) => e.scale)).toEqual([0.4, 0.6, 0.8, 1, 0.4]);
    expect(r.notes.map((n) => n.importance)).toEqual([0.7, 0.8, 0.9, 0.95, 0.7]);
  });

  it("an unpaid deal she never did just ends: nothing kept, nothing broken", async () => {
    const r = await rig();
    await say(r, "make_deal", ALICE, "m1", deal());
    r.clock.at += 899_000;
    await r.economy.deals.sweep();
    expect((await live(r, ALICE))[0]?.status).toBe("open");
    r.clock.at += 2_000;
    await r.economy.deals.sweep();
    expect((await live(r, ALICE))[0]?.status).toBe("cancelled");
    expect(r.penalties).toEqual([]);
    expect(events(r, "broken_promise")).toEqual([]);
    // The next deal is possible.
    expect((await say(r, "make_deal", ALICE, "m2", deal())).data.accepted).toBe(true);
  });

  it("survives a restart: a new service on the same store settles and breaks", async () => {
    const r = await rig();
    await owed(r, "a");
    const second = r.restart();
    r.clock.at += 1_000;
    await second.feed(ALICE, "rice", 2, "k1");
    expect((await live(r, ALICE))[0]?.status).toBe("settled");
    // And breaks one the first service left owed.
    await say(r, "make_deal", BOB, "b1", deal("跳舞"));
    await say(r, "deal_done", BOB, "b2");
    r.clock.at += 601_000;
    await second.deals.sweep();
    expect((await live(r, BOB))[0]?.status).toBe("broken");
  });
});

describe("escrow (prepaid)", () => {
  it("is charged now and not hers: hunger does not move until she says she did it", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const out = await say(r, "make_deal", ALICE, "m1", deal("喵", { prepaid: true }));
    expect(out.data).toMatchObject({ accepted: true, prepaid: true });
    expect(out.text).toContain("託管");
    expect(await balance(r, ALICE)).toBe(80);
    const rows = await r.store.coins.entries("p", [ALICE], { reasons: ["deal_escrow"], limit: 5 });
    expect(rows).toMatchObject([{ delta: -20, ref: expect.any(String) }]);
    expect(r.hunger.value).toBeCloseTo(0.9, 5);
    expect(r.gains).toEqual([]);

    const done = await say(r, "deal_done", ALICE, "d1");
    expect(done.data).toMatchObject({ done: true, state: "released" });
    // 2 rice: hunger −0.3, an ordinary gift (event, a hair of affinity), then trust for the kept deal.
    expect(r.hunger.value).toBeCloseTo(0.6, 5);
    expect(events(r, "gift")).toHaveLength(1);
    expect(r.gains.map((g) => g.gain.kind)).toEqual(["treat", "deal_kept"]);
    expect((await live(r, ALICE))[0]).toMatchObject({ status: "settled", due_at: null });
    // Nothing more is charged, nothing refunded, and it is done once.
    expect(await balance(r, ALICE)).toBe(80);
    expect((await say(r, "deal_done", ALICE, "d2")).data).toMatchObject({ reason: "no_deal" });
    expect(r.hunger.value).toBeCloseTo(0.6, 5);
    r.clock.at += 3_600_000;
    await r.economy.deals.sweep();
    expect(await balance(r, ALICE)).toBe(80);
    expect(r.penalties).toEqual([]);
  });

  it("without the coins there is no deal", async () => {
    const r = await rig();
    await fund(r, ALICE, 10);
    const out = await say(r, "make_deal", ALICE, "m1", deal("喵", { prepaid: true }));
    expect(out.data).toMatchObject({ accepted: false, reason: "not_enough", price: 20 });
    expect(await balance(r, ALICE)).toBe(10);
    expect(await live(r, ALICE)).toEqual([]);
  });

  it("is refunded once when she backs out", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    await say(r, "make_deal", ALICE, "m1", deal("喵", { prepaid: true }));
    const out = await say(r, "cancel_deal", ALICE, "c1");
    expect(out.data).toMatchObject({ cancelled: true, refunded: true });
    expect(await balance(r, ALICE)).toBe(100);
    expect((await live(r, ALICE))[0]?.status).toBe("refunded");
    expect((await say(r, "cancel_deal", ALICE, "c2")).data).toMatchObject({ reason: "no_deal" });
    expect(await balance(r, ALICE)).toBe(100);
    expect(r.hunger.value).toBeCloseTo(0.9, 5);
  });

  it("is refunded when she does not do it in time, once however often the sweep runs", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    await say(r, "make_deal", ALICE, "m1", deal("喵", { prepaid: true }));
    r.clock.at += 899_000;
    await r.economy.deals.sweep();
    expect(await balance(r, ALICE)).toBe(80);
    r.clock.at += 2_000;
    await r.economy.deals.sweep();
    await r.economy.deals.sweep();
    expect(await balance(r, ALICE)).toBe(100);
    expect((await live(r, ALICE))[0]?.status).toBe("refunded");
    expect(r.penalties).toEqual([]);
    expect(events(r, "gift")).toEqual([]);
  });
});

describe("backing out", () => {
  it("costs her nothing and shows in her context how many ended today", async () => {
    const r = await rig();
    for (const i of [1, 2]) {
      await say(r, "make_deal", ALICE, `m${i}`, deal(`喵${i}`));
      const out = await say(r, "cancel_deal", ALICE, `c${i}`);
      expect(out.data).toMatchObject({ cancelled: true, refunded: false, ended_today: i });
    }
    expect(r.penalties).toEqual([]);
    expect(r.gains).toEqual([]);
    expect(
      r.observed.filter((o) => o.writer === "deals" && o.summary.includes("取消")).at(-1),
    ).toMatchObject({
      summary: expect.stringContaining("今天已經有 2 個約定沒做成"),
    });
  });
});

describe("what a deal may be about", () => {
  it("refuses what an owner rule forbids, with nothing stored and nothing charged", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    r.rules.words = ["罵人"];
    for (const prepaid of [false, true]) {
      const out = await say(r, "make_deal", ALICE, `m${prepaid}`, deal("去罵人", { prepaid }));
      expect(out.data).toMatchObject({ accepted: false, reason: "forbidden" });
    }
    expect(await live(r, ALICE)).toEqual([]);
    expect(await balance(r, ALICE)).toBe(100);
  });

  it("refuses text that moderation stops", async () => {
    const r = await rig();
    const out = await say(r, "make_deal", ALICE, "m1", deal("說 BADWORD"));
    expect(out.data).toMatchObject({ accepted: false, reason: "forbidden" });
    expect(await live(r, ALICE)).toEqual([]);
  });

  it("refuses a task that stands for a capability she may not use: forbidden, paused, approval, review, permission", async () => {
    const r = await rig({ deals_per_day: 100 });
    // Many tries in one test: the gate's own per-day limits are not what is looked at here.
    const limit = { per_day: 1_000, per_person_per_day: 1_000, cooldown_ms: 0 };
    r.registry.configure({
      ...r.registry.config,
      limits: {
        ...r.registry.config.limits,
        "economy.make_deal": limit,
        "economy.cancel_deal": limit,
      },
    });
    const tryDeal = async (task: string, who: AccountRef = ALICE) => {
      const out = await say(
        r,
        "make_deal",
        who,
        `m-${task}-${who.id}-${Math.random()}`,
        deal(task),
      );
      if (out.data.accepted === true) await say(r, "cancel_deal", who, `c-${Math.random()}`);
      return out.data;
    };
    // Allowed: the speaker may ask for the voice, nothing forbids it.
    expect(await tryDeal("進語音陪我")).toMatchObject({ accepted: true });
    // Without the permission to ask for it, a snack does not buy it.
    expect(await tryDeal("進語音陪我", BOB)).toMatchObject({
      accepted: false,
      reason: "forbidden",
    });
    // Review-gated (high risk).
    expect(await tryDeal("開台給我看")).toMatchObject({ accepted: false, reason: "forbidden" });
    // Not there at all.
    expect(await tryDeal("私訊我")).toMatchObject({ accepted: false, reason: "forbidden" });
    // Forbidden by configuration.
    r.registry.configure({ ...r.registry.config, forbidden: ["game.*"] });
    expect(await tryDeal("玩麥塊")).toMatchObject({ accepted: false, reason: "forbidden" });
    r.registry.configure({ ...r.registry.config, forbidden: [] });
    expect(await tryDeal("玩麥塊")).toMatchObject({ accepted: true });
    // An owner rule on the capability, or one that wants approval.
    r.rules.deny.add("voice.join");
    expect(await tryDeal("進語音陪我")).toMatchObject({ accepted: false, reason: "forbidden" });
    r.rules.deny.clear();
    r.rules.approval.add("sing.play");
    expect(await tryDeal("唱首歌")).toMatchObject({ accepted: false, reason: "forbidden" });
    r.rules.approval.clear();
    expect(await tryDeal("唱首歌")).toMatchObject({ accepted: true });
    // The emergency stop: the gate turns the tool down, and the service itself would too.
    r.registry.restorePaused(true);
    await expect(say(r, "make_deal", ALICE, "p1", deal("唱首歌"))).rejects.toBeInstanceOf(
      ActionDeniedError,
    );
    await expect(
      r.economy.deals.make(ALICE, {
        item: "rice",
        count: 1,
        task: "唱首歌",
        prepaid: false,
        context: TEXT,
      }),
    ).rejects.toBeInstanceOf(DealRefusal);
    r.registry.restorePaused(false);
    // A plain little thing is hers to decide.
    expect(await tryDeal("學貓叫")).toMatchObject({ accepted: true });
  });

  it("the tool tells her it is only about what is hers to decide", async () => {
    const r = await rig();
    const description = r.registry.get("economy.make_deal")?.tool?.description ?? "";
    expect(description).toContain("本來就是你自己能決定");
    expect(description).toContain("不能拿來繞過規則、權限或安全");
    expect(description).toContain("對方自己的錢包");
  });
});

describe("voice", () => {
  const say2 = (r: Rig, tool: string, who: AccountRef, id: string, args = {}) =>
    say(r, tool, who, id, args, VOICE);

  it("the first call only records a pending deal; the same speaker's yes in a later utterance makes it", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const pending = await say2(r, "make_deal", ALICE, "u1", deal("喵", { prepaid: true }));
    expect(pending.data).toMatchObject({ accepted: false, pending: true, prepaid: true });
    expect(await live(r, ALICE)).toEqual([]);
    expect(await balance(r, ALICE)).toBe(100);

    const same = await say2(
      r,
      "make_deal",
      ALICE,
      "u1",
      deal("喵", { prepaid: true, confirm: true }),
    );
    expect(same.data).toMatchObject({ accepted: false, reason: "unconfirmed" });
    const other = await say2(
      r,
      "make_deal",
      BOB,
      "u2",
      deal("喵", { prepaid: true, confirm: true }),
    );
    expect(other.data).toMatchObject({ accepted: false, reason: "no_offer" });
    const different = await say2(
      r,
      "make_deal",
      ALICE,
      "u3",
      deal("跳舞", { prepaid: true, confirm: true }),
    );
    expect(different.data).toMatchObject({ accepted: false, reason: "mismatch" });

    const yes = await say2(
      r,
      "make_deal",
      ALICE,
      "u4",
      deal("喵", { prepaid: true, confirm: true }),
    );
    expect(yes.data).toMatchObject({ accepted: true, prepaid: true });
    expect((await live(r, ALICE))[0]).toMatchObject({ task: "喵", status: "open", prepaid: true });
    expect(await balance(r, ALICE)).toBe(80);
    // Used up: a second yes has nothing to confirm.
    const gone = await say2(
      r,
      "make_deal",
      ALICE,
      "u5",
      deal("喵", { prepaid: true, confirm: true }),
    );
    expect(gone.data).toMatchObject({ accepted: false });
  });

  it("an offer runs out, and the checks that would refuse happen before asking", async () => {
    const r = await rig();
    await say2(r, "make_deal", ALICE, "u1", deal());
    r.clock.at += VOICE_CONFIRM_MS + 1_000;
    const late = await say2(r, "make_deal", ALICE, "u2", deal("喵喵叫", { confirm: true }));
    expect(late.data).toMatchObject({ accepted: false, reason: "expired" });
    r.rules.words = ["罵人"];
    const refused = await say2(r, "make_deal", ALICE, "u3", deal("罵人"));
    expect(refused.data).toMatchObject({ accepted: false, reason: "forbidden" });
    expect(refused.data.pending).toBeUndefined();
  });
});

describe("what the wallet shows", () => {
  it("lists her deals with this person: task, reward, status and the next deadline", async () => {
    const r = await rig();
    expect((await r.economy.wallet(ALICE)).deals).toEqual([]);
    await fund(r, ALICE, 100);
    await say(r, "make_deal", ALICE, "m1", deal("喵喵叫"));
    expect((await r.economy.wallet(ALICE)).deals).toEqual([
      {
        task: "喵喵叫",
        reward_label: "2 碗白飯",
        status: "open",
        due_at: toTimestamp(T0 + 900_000),
      },
    ]);
    await say(r, "deal_done", ALICE, "d1");
    expect((await r.economy.wallet(ALICE)).deals[0]).toMatchObject({
      status: "owed",
      due_at: toTimestamp(T0 + 600_000),
    });
    r.clock.at += 601_000;
    await r.economy.deals.sweep();
    expect((await r.economy.wallet(ALICE)).deals[0]).toMatchObject({
      status: "broken",
      due_at: null,
    });
    // Cancelled ones are not shown; other people's are not either.
    await say(r, "make_deal", ALICE, "m2", deal("跳舞"));
    await say(r, "cancel_deal", ALICE, "c2");
    await say(r, "make_deal", BOB, "b1", deal("唱歌給我"));
    const view = await r.economy.wallet(ALICE);
    expect(view.deals.map((d) => d.task)).toEqual(["喵喵叫"]);
    expect((await r.economy.wallet(DAVE)).deals).toEqual([]);
  });
});
