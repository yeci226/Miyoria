// What economy 2.0 keeps must survive a restart (documents in the store, not in memory), the party
// games' coins are paid once per game, and the health table reads the real ledger.

import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { Supervisor } from "@miyoria/runtime/kernel";
import { PeopleStoreKey, SqliteStore } from "@miyoria/store";
import {
  AuthorizerKey,
  Events,
  type JsonValue,
  ModerationKey,
  ParticipationKey,
  PartyOutcomesKey,
  PartyRewardsKey,
  SocialSignalsKey,
} from "@miyoria/types";
import { describe, expect, it, vi } from "vitest";
import { EconomyModule } from "../src/module.js";
import { CoinLedgerStoreKey, EconomyDocsKey, LedgerStatsKey } from "../src/records.js";
import { EconomyKey } from "../src/types.js";
import { Economy2Key } from "../src/v2-types.js";
import { economyOf, ledgerOf, walletOf } from "./ledger.js";
import { ALICE, BOB, balance, rig as baseRig, CAROL, DAVE, DAY, fund, TEXT } from "./rig.js";

/** Quests, achievements and plain play rewards are not what these sums are about. */
const config = (extra: Record<string, JsonValue> = {}) => ({
  achievement_cap: 0,
  quest_reward: 0,
  play_rewards: {},
  ...extra,
});
const rig = (extra: Record<string, JsonValue> = {}, options = {}) =>
  baseRig(config(extra), options);

describe("a restart", () => {
  it("keeps predictions and bets: a new service over the same store reads them back", async () => {
    const first = await rig({}, { durable: true });
    await fund(first, ALICE, 100);
    const opened = await first.economy.v2.openPrediction({
      question: "她這場會怎麼死",
      options: ["摔死", "餓死"],
      minutes: 30,
    });
    await first.economy.v2.placeBet(ALICE, opened.id, 1, 30, "bet-1");

    // The first service is gone; the second one only has the store.
    const second = await rig({}, { durable: true, store: first.store });
    const [seen] = await second.economy.v2.predictions(ALICE);
    expect(seen).toMatchObject({ id: opened.id, question: "她這場會怎麼死", total: 30 });
    // The bet is a document too: it still counts for the same person, and the same key is not paid twice.
    expect(seen?.my_bet).toMatchObject({ amount: 30 });
    expect(await balance(second, ALICE)).toBe(70);
    await expect(
      second.economy.v2.placeBet(ALICE, opened.id, 1, 30, "bet-1"),
    ).resolves.toBeDefined();
    expect(await balance(second, ALICE)).toBe(70);
  });

  it("keeps documents: a collectible drawn before the draw was removed is still there", async () => {
    const first = await rig({}, { durable: true });
    const at = new Date().toISOString();
    expect(
      await first.economy.docs().create({
        id: "item:old",
        kind: "item",
        owner: ALICE,
        status: "held",
        version: 1,
        data: { item: "glasses_black", rarity: "N", source: "draw" },
        created_at: at,
        updated_at: at,
      }),
    ).toBe(true);
    const held = (r: Awaited<ReturnType<typeof rig>>) =>
      r.economy.docs().list("p", "item", { owners: [ALICE], limit: 10 });

    const second = await rig({}, { durable: true, store: first.store });
    expect((await held(second)).map((d) => d.id)).toEqual(["item:old"]);
    // Without the store's documents (the in-memory fallback) a restart would forget it.
    const amnesia = await rig({}, { store: first.store });
    expect(await held(amnesia)).toEqual([]);
  });

  it("starts the module with the store's documents and provides what others call", async () => {
    const store = await SqliteStore.open(":memory:");
    try {
      const sup = new Supervisor();
      const s = sup.services;
      s.provide("kernel", CoinLedgerStoreKey, ledgerOf(store));
      s.provide("kernel", PeopleStoreKey, store.people);
      s.provide("kernel", SocialSignalsKey, { attitude: () => ({ blocked: false }) as never });
      s.provide("kernel", AuthorizerKey, { allows: () => true } as never);
      s.provide("kernel", EconomyDocsKey, economyOf(store).docs);
      s.provide("kernel", LedgerStatsKey, ledgerOf(store));
      s.provide("kernel", ModerationKey, {
        screen: () => ({ ok: true }),
        inspect: () => ({ action: "pass" }),
      } as never);
      s.provide("app", ActuatorRegistryKey, new ActuatorRegistry({ services: s, builtins: false }));
      await sup.register(new EconomyModule("p"), {}, true);
      await sup.startAll();
      try {
        const economy = s.require(EconomyKey) as unknown as { docsAreDurable: boolean };
        expect(economy.docsAreDurable).toBe(true);
        expect(s.require(PartyRewardsKey)).toBeDefined();
        // How a party game came out reaches the predictions bound to it.
        expect(s.require(PartyOutcomesKey)).toBeDefined();
        // Her game goals on the bus reach them too: one is bound, then settled by its end.
        const context = { platform: "discord", scope: "g", channel: "v", kind: "voice" } as const;
        sup.bus.publish("game", Events.GameDirectorSession, {
          state: "started",
          game: "minecraft",
          game_name: "Minecraft",
          context,
        });
        sup.bus.publish("game", Events.GameDirectorDecision, {
          game: "minecraft",
          trigger: [],
          goal: "蓋房子",
          action: null,
          verdict: null,
          commentary: null,
          busy: null,
          observation: "",
          want: null,
          held: [],
        });
        const v2 = s.require(Economy2Key);
        const opened = await vi.waitFor(() =>
          v2.openPrediction({ question: "蓋得好嗎", options: [], minutes: 3, settle_by: "goal" }),
        );
        sup.bus.publish("game", Events.GameDirectorGoal, {
          game: "minecraft",
          goal: "蓋房子",
          source: "director",
          status: "done",
          code: "done",
          task: null,
          detail: "",
          at: new Date().toISOString(),
          attention_key: "蓋房子",
        });
        await vi.waitFor(async () => {
          const [p] = await v2.predictions(null);
          expect(p).toMatchObject({ id: opened.id, status: "resolved", winner: "做到" });
        });
        expect(s.require(ParticipationKey)).toBeDefined();
      } finally {
        await sup.stopAll();
      }
    } finally {
      await store.close();
    }
  });
});

const request = (id: string, awards: { account: typeof ALICE; coins: number }[]) => ({
  id,
  game: "quiz",
  title: "問答",
  context: TEXT,
  awards: awards.map((a) => ({ ...a, name: a.account.id })),
});

describe("party rewards", () => {
  it("pays each person what the game said, through the ledger, once per game id", async () => {
    const r = await rig({ play_cap: 40 });
    const desk = r.economy.v2.party;
    await desk.award(
      request("party:1", [
        { account: ALICE, coins: 12 },
        { account: BOB, coins: 8 },
      ]),
    );
    expect(await balance(r, ALICE)).toBe(12);
    expect(await balance(r, BOB)).toBe(8);
    const rows = await ledgerOf(r.store).entries("p", walletOf(r.store, ALICE), { limit: 9 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "play", delta: 12, idem_key: "play:party:party:1" });

    // Announced again (a retry, a restart): nobody is paid twice, in the same service or a new one.
    await desk.award(
      request("party:1", [
        { account: ALICE, coins: 12 },
        { account: BOB, coins: 8 },
      ]),
    );
    const again = await rig({ play_cap: 40 }, { store: r.store });
    await again.economy.v2.party.award(request("party:1", [{ account: ALICE, coins: 12 }]));
    expect(await balance(r, ALICE)).toBe(12);
    expect(await balance(r, BOB)).toBe(8);
    // Another game pays again.
    await desk.award(request("party:2", [{ account: ALICE, coins: 5 }]));
    expect(await balance(r, ALICE)).toBe(17);
  });

  it("counts the day's play together: the cap holds, the last award is paid in part", async () => {
    const r = await rig({ play_cap: 20 });
    const desk = r.economy.v2.party;
    await desk.award(request("party:a", [{ account: ALICE, coins: 15 }]));
    await desk.award(request("party:b", [{ account: ALICE, coins: 15 }]));
    expect(await balance(r, ALICE)).toBe(20);
    await desk.award(request("party:c", [{ account: ALICE, coins: 15 }]));
    expect(await balance(r, ALICE)).toBe(20);
    // The next day the cap is fresh.
    r.clock.at += DAY;
    await desk.award(request("party:d", [{ account: ALICE, coins: 15 }]));
    expect(await balance(r, ALICE)).toBe(35);
  });

  it("pays strangers, the blocked, nothing and whole coins only, and a person listed twice once", async () => {
    const r = await rig();
    await r.economy.v2.party.award(
      request("party:x", [
        { account: DAVE, coins: 10 },
        { account: CAROL, coins: 10 },
        { account: BOB, coins: 0 },
        { account: ALICE, coins: 6.9 },
        { account: ALICE, coins: 9 },
      ]),
    );
    expect(await balance(r, DAVE)).toBe(0);
    expect(await balance(r, CAROL)).toBe(0);
    expect(await balance(r, BOB)).toBe(0);
    expect(await balance(r, ALICE)).toBe(6);
  });

  it("is played-with-others for the daily quest even when the coins are capped", async () => {
    const r = await rig({ play_cap: 5, quest_reward: 10 });
    await r.economy.v2.party.award(
      request("party:q", [
        { account: ALICE, coins: 5 },
        { account: BOB, coins: 5 },
      ]),
    );
    const quests = await r.economy.v2.quests(ALICE);
    expect(quests.quests.find((q) => q.id === "together")?.done).toBe(true);
  });

  it("is not played-with-others when they played alone with her", async () => {
    const r = await rig({ quest_reward: 10 });
    await r.economy.v2.party.award(request("party:solo", [{ account: ALICE, coins: 5 }]));
    const quests = await r.economy.v2.quests(ALICE);
    expect(quests.quests.find((q) => q.id === "together")?.done).toBe(false);
    expect(await balance(r, ALICE)).toBe(5);
  });
});

describe("the health table over the real ledger", () => {
  it("adds up what was issued and what was spent per local day", async () => {
    const r = await rig({ health_days: 3, play_rewards: { game_join: 10 } }, { durable: true });
    await r.economy.v2.play.award(ALICE, "game_join", "g1");
    await r.economy.v2.play.award(BOB, "game_join", "g1");
    await fund(r, ALICE, 100);
    await r.economy.spend(await r.economy.holder(ALICE), 6, "shop", "x", "k1");
    r.clock.at += DAY;
    await r.economy.v2.play.award(ALICE, "game_join", "g2");

    const view = await r.economy.v2.health();
    expect(view.available).toBe(true);
    expect(view.days).toHaveLength(3);
    // `admin_adjust` is neither issued nor recovered: it is the owner moving coins by hand.
    expect(view.days.at(-2)).toMatchObject({ issued: 20, recovered: 6 });
    expect(view.days.at(-1)).toMatchObject({ issued: 10, recovered: 0 });
    expect(view.week).toMatchObject({ issued: 30, recovered: 6 });
  });
});
