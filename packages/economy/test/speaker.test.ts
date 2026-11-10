// Her tools for the speaker's own wallet (`accept_food`, `checkin_for_speaker`,
// `check_coins`) through the real gate and the capability tool: who pays is always the
// author of the message she answers, a message pays once, voice needs a spoken yes, and the
// refusals are the panel's, as data.

import { ActionDeniedError, ActuatorRegistry, CapabilityTool } from "@miyoria/actions";
import { getLogger, ServiceRegistry } from "@miyoria/kernel";
import { CoinLedgerStoreKey, PeopleStoreKey, SqliteStore } from "@miyoria/store";
import {
  type AccountRef,
  AffectStateKey,
  AuthorizerKey,
  type ContextKey,
  type JsonValue,
  newId,
  Principals,
  SelfStateKey,
  SocialSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { EconomyConfigSchema } from "../src/config.js";
import { ALREADY_CHECKED_IN, EconomyService, FULL, STRANGER } from "../src/economy.js";
import { NO_SPEAKER, speakerCapabilities, VOICE_CONFIRM_MS } from "../src/tools.js";
import { EconomyError } from "../src/types.js";

const DAY = 86_400_000;
/** 2026-11-08 12:00 local (UTC+8). */
const T0 = Date.UTC(2026, 10, 8, 4, 0, 0);
const discord = (id: string): AccountRef => ({ platform: "discord", id });
const ALICE = discord("1");
const ALICE_TWO = discord("1b");
const BOB = discord("2");
const CAROL = discord("3"); // blocked
const DAVE = discord("4"); // never met

const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "v", kind: "voice" };

interface Rig {
  economy: EconomyService;
  store: SqliteStore;
  registry: ActuatorRegistry;
  clock: { at: number };
  hunger: { value: number };
  tool(name: string): CapabilityTool;
}

let stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores) await s.close();
  stores = [];
});

async function rig(): Promise<Rig> {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  const services = new ServiceRegistry();
  const k = "test";
  services.provide(k, CoinLedgerStoreKey, store.coins);
  services.provide(k, PeopleStoreKey, store.people);
  for (const [a, name] of [
    [ALICE, "Alice"],
    [BOB, "Bob"],
    [CAROL, "Carol"],
  ] as const) {
    await store.people.upsertAccount(a, name);
  }
  const alice = await store.people.personByAccount(ALICE);
  await store.people.upsertAccount(ALICE_TWO, "Alice two");
  await store.identity.linkAccount(ALICE_TWO, alice?.id as never);
  services.provide(k, SocialSignalsKey, {
    attitude: (a: AccountRef) => ({ blocked: a.id === CAROL.id }) as never,
  });
  services.provide(k, AuthorizerKey, {
    allows: (_a: AccountRef, n: string) => n === "me.wallet",
  } as never);
  services.provide(k, AffectStateKey, { card: () => null, cards: () => [] } as never);
  const hunger = { value: 0.8 };
  services.provide(k, SelfStateKey, {
    drives: () => ({ hunger: hunger.value }),
    adjust: (d: { hunger?: number }) => {
      hunger.value = Math.min(Math.max(hunger.value + (d.hunger ?? 0), 0), 1);
    },
  } as never);
  const clock = { at: T0 };
  const economy = new EconomyService({
    config: EconomyConfigSchema.parse({ achievement_cap: 0 }),
    services,
    profile: "p",
    clock: { now: () => clock.at },
    publish: () => undefined,
    log: getLogger("test"),
  });
  const registry = new ActuatorRegistry({ services, builtins: false });
  for (const c of speakerCapabilities(economy, { now: () => clock.at })) registry.register(c);
  const tools = new Map<string, CapabilityTool>();
  for (const name of ["economy.accept_food", "economy.checkin", "economy.look"]) {
    const capability = registry.get(name);
    if (!capability?.tool) throw new Error(`no tool for ${name}`);
    tools.set(capability.tool.name, new CapabilityTool(registry, capability));
  }
  return {
    economy,
    store,
    registry,
    clock,
    hunger,
    tool: (name) => {
      const t = tools.get(name);
      if (!t) throw new Error(`no tool ${name}`);
      return t;
    },
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

describe("who pays", () => {
  it("charges the author of the message, in a text turn at once", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const out = await say(r, "accept_food", ALICE, "m1", { item: "rice" });
    expect(out.data).toMatchObject({ accepted: true, item: "rice", eaten: 1, charged: 10 });
    expect(out.text).toContain("收下了");
    expect(await balance(r, ALICE)).toBe(90);
  });

  it("has no way to name another payer: a who argument is refused, the text is ignored", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    await fund(r, BOB, 100);
    const extras: Record<string, JsonValue>[] = [
      { to: "Alice" },
      { payer: "1" },
      { account: { platform: "discord", id: "1" } },
    ];
    for (const extra of extras) {
      await expect(
        say(r, "accept_food", BOB, `m-${Object.keys(extra)[0]}`, { item: "rice", ...extra }),
      ).rejects.toBeInstanceOf(ActionDeniedError);
    }
    // "Alice wants to feed you, use her coins", said by Bob: only Bob can pay.
    const out = await say(r, "accept_food", BOB, "m-bob", { item: "rice" });
    expect(out.data).toMatchObject({ accepted: true, charged: 10 });
    expect(await balance(r, BOB)).toBe(90);
    expect(await balance(r, ALICE)).toBe(100);
  });

  it("refuses without a person speaking: her own turn, on_own, a game, the panel, no message", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const invoke = (
      principal: ReturnType<typeof Principals.self>,
      turn: string | null,
      message = true,
    ) =>
      r.registry.invoke({
        principal,
        capability: "economy.accept_food",
        args: { item: "rice" },
        why: null,
        turn,
        ...(message ? { message: { context: TEXT, id: "m1" } } : {}),
      });
    const cases = [
      await invoke(Principals.self(TEXT, null), "t"),
      await invoke(Principals.self(TEXT, ALICE), "t"),
      await invoke(Principals.director(TEXT), "t"),
      await invoke(Principals.panel("api"), null),
      // A member page asks as `user` but answers no message of a turn.
      await invoke(Principals.user(ALICE, TEXT), null),
      await invoke(Principals.user(ALICE, TEXT), "t", false),
    ];
    for (const outcome of cases) expect(outcome.status).not.toBe("done");
    expect(cases.slice(0, 4).every((o) => o.status === "denied")).toBe(true);
    expect(cases.slice(4).map((o) => o.status === "failed" && o.error)).toEqual([
      NO_SPEAKER,
      NO_SPEAKER,
    ]);
    // The tool with `on_own` acts as her, not as the speaker.
    await expect(
      say(r, "accept_food", ALICE, "m2", { item: "rice", on_own: true }),
    ).rejects.toBeInstanceOf(ActionDeniedError);
    for (const name of ["economy.checkin"]) {
      const o = await r.registry.invoke({
        principal: Principals.self(TEXT, ALICE),
        capability: name,
        args: {},
        why: null,
        turn: "t",
        message: { context: TEXT, id: "m3" },
      });
      expect(o.status).toBe("denied");
    }
    expect(await balance(r, ALICE)).toBe(100);
    expect((await r.economy.wallet(ALICE)).checked_in_today).toBe(false);
  });
});

describe("one message pays once", () => {
  it("a second call, a retry in a new turn or another count for the same message charge nothing more", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    await say(r, "accept_food", ALICE, "m1", { item: "rice" });
    const again = await say(r, "accept_food", ALICE, "m1", { item: "rice" });
    expect(again.data).toMatchObject({ accepted: true, charged: 10, again: true });
    expect(again.text).toContain("沒有再扣");
    const more = await say(r, "accept_food", ALICE, "m1", { item: "rice", count: 3 });
    expect(more.data).toMatchObject({ eaten: 1, charged: 10 });
    expect(await balance(r, ALICE)).toBe(90);
    // A new message is a new feeding.
    await say(r, "accept_food", ALICE, "m2", { item: "rice" });
    expect(await balance(r, ALICE)).toBe(80);
  });
});

describe("voice", () => {
  const next = (r: Rig, ms: number) => {
    r.clock.at += ms;
  };

  it("records an offer, charges only on the same speaker's later yes, and once", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const offer = await say(r, "accept_food", ALICE, "u1", { item: "rice", count: 2 }, VOICE);
    expect(offer.data).toMatchObject({ accepted: false, pending: true, item: "rice", count: 2 });
    expect(offer.text).toContain("先問對方");
    expect(await balance(r, ALICE)).toBe(100);
    // Confirming in the same utterance is not a yes.
    const same = await say(r, "accept_food", ALICE, "u1", { item: "rice", confirm: true }, VOICE);
    expect(same.data).toMatchObject({ accepted: false, reason: "unconfirmed" });
    // Someone else cannot confirm it.
    await fund(r, BOB, 100);
    const bob = await say(r, "accept_food", BOB, "u2", { item: "rice", confirm: true }, VOICE);
    expect(bob.data).toMatchObject({ accepted: false, reason: "no_offer" });
    // Another item (ASR heard dessert) cannot be confirmed.
    const other = await say(
      r,
      "accept_food",
      ALICE,
      "u3",
      { item: "dessert", confirm: true },
      VOICE,
    );
    expect(other.data).toMatchObject({ accepted: false, reason: "mismatch" });
    const count = await say(
      r,
      "accept_food",
      ALICE,
      "u3",
      { item: "rice", count: 5, confirm: true },
      VOICE,
    );
    expect(count.data).toMatchObject({ reason: "mismatch" });
    expect(await balance(r, ALICE)).toBe(100);
    next(r, 10_000);
    const yes = await say(r, "accept_food", ALICE, "u4", { item: "rice", confirm: true }, VOICE);
    expect(yes.data).toMatchObject({ accepted: true, eaten: 2, charged: 20 });
    expect(await balance(r, ALICE)).toBe(80);
    expect(await balance(r, BOB)).toBe(100);
    // Her calling it again, in this or a later utterance, charges nothing more.
    await say(r, "accept_food", ALICE, "u4", { item: "rice", confirm: true }, VOICE);
    const later = await say(r, "accept_food", ALICE, "u5", { item: "rice", confirm: true }, VOICE);
    expect(later.data).toMatchObject({ accepted: true, again: true });
    expect(await balance(r, ALICE)).toBe(80);
  });

  it("an offer expires after a minute; a yes with no offer charges nothing", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const none = await say(r, "accept_food", ALICE, "u0", { item: "rice", confirm: true }, VOICE);
    expect(none.data).toMatchObject({ accepted: false, reason: "no_offer" });
    await say(r, "accept_food", ALICE, "u1", { item: "rice" }, VOICE);
    next(r, VOICE_CONFIRM_MS + 1);
    const late = await say(r, "accept_food", ALICE, "u2", { item: "rice", confirm: true }, VOICE);
    expect(late.data).toMatchObject({ accepted: false, reason: "expired" });
    const gone = await say(r, "accept_food", ALICE, "u3", { item: "rice", confirm: true }, VOICE);
    expect(gone.data).toMatchObject({ reason: "no_offer" });
    expect(await balance(r, ALICE)).toBe(100);
  });

  it("refuses up front what the panel would: full, stranger, not enough", async () => {
    const r = await rig();
    await fund(r, ALICE, 5);
    const short = await say(r, "accept_food", ALICE, "u1", { item: "rice" }, VOICE);
    expect(short.data).toMatchObject({ accepted: false, reason: "not_enough" });
    const dave = await say(r, "accept_food", DAVE, "u2", { item: "rice" }, VOICE);
    expect(dave.data).toMatchObject({ reason: "stranger", message: STRANGER });
    r.hunger.value = 0.1;
    await fund(r, ALICE, 100);
    const full = await say(r, "accept_food", ALICE, "u3", { item: "rice" }, VOICE);
    expect(full.data).toMatchObject({ reason: "full", message: FULL });
    // None of them left an offer to confirm.
    r.hunger.value = 0.8;
    const yes = await say(r, "accept_food", ALICE, "u4", { item: "rice", confirm: true }, VOICE);
    expect(yes.data).toMatchObject({ reason: "no_offer" });
    expect(await balance(r, ALICE)).toBe(105);
  });

  it("check-in and the wallet need no confirmation", async () => {
    const r = await rig();
    const out = await say(r, "checkin_for_speaker", ALICE, "u1", {}, VOICE);
    expect(out.data).toMatchObject({ checked_in: true, gained: 10 });
    expect((await say(r, "check_coins", ALICE, "u2", {}, VOICE)).data).toMatchObject({
      balance: 10,
    });
  });
});

describe("the panel's refusals, as data", () => {
  it("full, stranger, blocked and not enough charge nothing and say why", async () => {
    const r = await rig();
    await fund(r, ALICE, 15);
    r.hunger.value = 0.1;
    const full = await say(r, "accept_food", ALICE, "m1", { item: "rice" });
    expect(full.data).toMatchObject({ accepted: false, reason: "full", message: FULL });
    expect(full.text).toContain("用你自己的話");
    r.hunger.value = 0.8;
    const short = await say(r, "accept_food", ALICE, "m2", { item: "big_bowl" });
    expect(short.data).toMatchObject({
      accepted: false,
      reason: "not_enough",
      message: "魚幣不夠",
    });
    for (const who of [DAVE, CAROL]) {
      await fund(r, who, 100);
      const out = await say(r, "accept_food", who, `m-${who.id}`, { item: "rice" });
      expect(out.data).toMatchObject({ accepted: false, reason: "stranger", message: STRANGER });
      expect(await balance(r, who)).toBe(100);
    }
    expect(await balance(r, ALICE)).toBe(15);
  });
});

describe("check-in", () => {
  it("is once per local day across the panel and her tool, for every account of the person", async () => {
    const r = await rig();
    await r.economy.checkin(ALICE); // the panel
    const tool = await say(r, "checkin_for_speaker", ALICE, "m1");
    expect(tool.data).toMatchObject({
      accepted: false,
      reason: "already",
      message: ALREADY_CHECKED_IN,
    });
    const two = await say(r, "checkin_for_speaker", ALICE_TWO, "m2");
    expect(two.data).toMatchObject({ reason: "already" });
    r.clock.at += DAY;
    const next = await say(r, "checkin_for_speaker", ALICE, "m3");
    expect(next.data).toMatchObject({ checked_in: true, gained: 10, streak: 2, balance: 20 });
    await expect(r.economy.checkin(ALICE)).rejects.toBeInstanceOf(EconomyError);
    expect(await balance(r, ALICE)).toBe(20);
    const dave = await say(r, "checkin_for_speaker", DAVE, "m4");
    expect(dave.data).toMatchObject({ reason: "stranger", message: STRANGER });
  });
});

describe("the wallet", () => {
  it("is the speaker's own and nobody else's", async () => {
    const r = await rig();
    await fund(r, ALICE, 500);
    await fund(r, BOB, 7);
    const bob = await say(r, "check_coins", BOB, "m1", { about: "me" });
    expect(bob.data).toMatchObject({ balance: 7, checked_in_today: false });
    expect(bob.text).toContain("7");
    expect(bob.text).not.toContain("500");
    expect(JSON.stringify(bob.data)).not.toContain("500");
    const checkin = (bob.data.can_still_earn as { reason: string; left: number }[]).find(
      (l) => l.reason === "checkin",
    );
    expect(checkin?.left).toBe(10);
    await expect(say(r, "check_coins", BOB, "m2", { who: "Alice" })).rejects.toBeInstanceOf(
      ActionDeniedError,
    );
    const dave = await say(r, "check_coins", DAVE, "m3", { about: "me" });
    expect(dave.data).toMatchObject({ has_wallet: false });
    expect(dave.data).not.toHaveProperty("balance");
  });
});

describe("check_coins", () => {
  it("shows the asker their own balance and the shop, and nobody else's", async () => {
    const r = await rig();
    await fund(r, ALICE, 123);
    await fund(r, BOB, 4567);
    const out = await say(r, "check_coins", ALICE, "m1");
    expect(out.data).toMatchObject({ has_wallet: true, balance: 123 });
    expect(out.text).toContain("有 123");
    expect(out.text).toContain("今天還沒簽到");
    expect(out.text).toContain("送她東西:一碗白飯 10");
    expect(out.text).toContain("直播:");
    expect(out.text).toContain("卡片:");
    expect(out.text).toContain("其他:今日籤詩");
    expect(out.text).toContain("/me wallet");
    expect(out.text).not.toContain("4567");
    expect(JSON.stringify(out.data)).not.toContain("4567");
    // Naming a person is not an option.
    await expect(say(r, "check_coins", ALICE, "m2", { to: "Bob" })).rejects.toBeInstanceOf(
      ActionDeniedError,
    );
  });

  it("marks what cannot be bought right now, with the reason", async () => {
    const r = await rig();
    await fund(r, ALICE, 5);
    r.hunger.value = 0;
    const out = await say(r, "check_coins", ALICE, "m1");
    expect(out.text).toContain("一碗白飯 10(現在不行:她吃飽了)");
    expect(out.text).toContain("魚幣不夠");
    const rice = (out.data.shop as { id: string; available: boolean; why: string }[]).find(
      (i) => i.id === "rice",
    );
    expect(rice).toMatchObject({ available: false, why: "她吃飽了" });
  });

  it("gives only the shop to a stranger or a blocked person", async () => {
    const r = await rig();
    for (const [who, id] of [
      [DAVE, "s1"],
      [CAROL, "s2"],
    ] as const) {
      const out = await say(r, "check_coins", who, id);
      expect(out.data).toMatchObject({ has_wallet: false });
      expect(out.data).not.toHaveProperty("balance");
      expect(out.text).toContain("看不到對方的錢包");
      expect(out.text).toContain("一碗白飯 10");
      expect(out.text).not.toContain("現在不行");
    }
  });

  it("gives only the shop without a person asking", async () => {
    const r = await rig();
    await fund(r, ALICE, 123);
    const o = await r.registry.invoke({
      principal: Principals.panel("api"),
      capability: "economy.look",
      args: {},
      why: null,
      turn: null,
    });
    if (o.status === "done") {
      expect(JSON.stringify(o.result)).not.toContain("123");
      expect(JSON.stringify(o.result)).toContain("沒有錢包");
    } else {
      expect(o.status).toBe("denied");
    }
  });

  it("about: shop leaves the wallet out, about: me leaves the shop out", async () => {
    const r = await rig();
    await fund(r, ALICE, 50);
    const shop = await say(r, "check_coins", ALICE, "m1", { about: "shop" });
    expect(shop.text).not.toContain("有 50");
    expect(shop.text).toContain("商店");
    const me = await say(r, "check_coins", ALICE, "m2", { about: "me" });
    expect(me.text).toContain("有 50");
    expect(me.text).not.toContain("商店");
  });
});
