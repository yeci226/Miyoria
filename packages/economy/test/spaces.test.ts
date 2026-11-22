// Phase 6, many servers: what of the economy is per server (a prediction and its bets, a bounty,
// the per-server sponsor board) against identity's real `Places` on the store, with two servers.
// The wallet stays one wallet: the coins a person spends or wins anywhere are the same coins.

import { CommandRegistry, Permissions } from "@miyoria/commands";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type ContextKey,
  newId,
  type PersonId,
  PlacesKey,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyCommands } from "../src/commands.js";
import { BountyStoreKey, PURSE } from "../src/records.js";
import { spacesToShow } from "../src/spaces.js";
import { EconomyKey } from "../src/types.js";
import { v2Capabilities } from "../src/v2-tools.js";
import { Economy2Key } from "../src/v2-types.js";
import { economyOf, ledgerOf } from "./ledger.js";
import { ALICE, BOB, balance, DAVE, ERIN, fund, rejects, rig, say } from "./rig.js";

const IN_A: ContextKey = { platform: "discord", scope: "guild-a", channel: "a1", kind: "channel" };
const IN_B: ContextKey = { platform: "discord", scope: "guild-b", channel: "b1", kind: "channel" };
const DM: ContextKey = { platform: "discord", scope: null, channel: "dm", kind: "dm" };

/**
 * A rig with two servers: Alice wrote in A (the primary, seen first), Bob in B, Erin in both. The
 * documents are the store's own, so the Space columns are what is read back.
 */
async function twoServers(config: Record<string, number> = {}) {
  const r = await rig(
    { achievement_cap: 0, play_rewards: {}, prediction_rake: 0, ...config },
    { durable: true },
  );
  const wrote = (ctx: ContextKey, account: AccountRef, name: string) =>
    r.store.persons.resolve(ctx, { account, display_name: name });
  wrote(IN_A, ALICE, "Alice");
  wrote(IN_B, BOB, "Bob");
  wrote(IN_A, ERIN, "Erin");
  wrote(IN_B, ERIN, "Erin");
  r.services.provide("test", PlacesKey, r.store.places);
  r.services.provide("test", BountyStoreKey, economyOf(r.store).bounties);
  const places = r.store.places;
  const a = places.ofGuild("discord", "guild-a");
  const b = places.ofGuild("discord", "guild-b");
  if (!a || !b) throw new Error("no spaces");
  expect(a.primary).toBe(true);
  return { r, a: a.id, b: b.id };
}

const openIn = (r: Awaited<ReturnType<typeof rig>>, context: ContextKey | null, question = "q") =>
  r.economy.v2.openPrediction({ question, options: ["甲", "乙"], minutes: 30, context });

describe("predictions per server", () => {
  it("belong to the server they were opened in, the primary when opened in no server", async () => {
    const { r, a, b } = await twoServers();
    const inA = await openIn(r, IN_A, "A 的題");
    const inB = await openIn(r, IN_B, "B 的題");
    const fromDm = await openIn(r, DM, "私訊開的");
    expect(inA.space?.id).toBe(a);
    expect(inB.space).toEqual({ id: b, name: "guild-b" });
    expect(fromDm.space?.id).toBe(a);
    const docs = await economyOf(r.store).docs.list("p", "prediction", { limit: 10 });
    expect(docs.map((d) => d.space).sort()).toEqual([a, a, b].sort());
    // Every server's for the owner, one server's otherwise.
    expect((await r.economy.v2.predictions(null)).length).toBe(3);
    expect((await r.economy.v2.predictions(null, [b])).map((p) => p.question)).toEqual(["B 的題"]);
  });

  it("are shown in a server for that server, in a DM for the person's own servers", async () => {
    const { r, a, b } = await twoServers();
    const places = r.store.places;
    const alice = places.spacesOf(r.store.persons.personOf(ALICE)?.id as never);
    expect(alice.map((s) => s.id)).toEqual([a]);
    expect(await r.economy.spacesFor(IN_B, ALICE)).toEqual([b]);
    expect(await r.economy.spacesFor(DM, ALICE)).toEqual([a]);
    expect((await r.economy.spacesFor(DM, ERIN))?.sort()).toEqual([a, b].sort());
    // Someone who is a member nowhere gets the primary, as before there were several.
    expect(spacesToShow(places, DM, null)).toEqual([a]);
  });

  it("refuse a bet from someone who is not a member of the prediction's server, with the reason", async () => {
    const { r } = await twoServers();
    await fund(r, ALICE, 100);
    await fund(r, BOB, 100);
    const inA = await openIn(r, IN_A);
    await rejects(
      r.economy.v2.placeBet(BOB, inA.id, 1, 10, "bob"),
      403,
      "這個預測是「guild-a」的,只有那裡的成員能押(在那個伺服器說過話、用過指令或進過語音就算)",
    );
    expect(await balance(r, BOB)).toBe(100);
    // A member bets from anywhere, a DM too: the money is the one wallet.
    const bet = await r.economy.v2.placeBet(ALICE, inA.id, 1, 10, "alice");
    expect(bet).toMatchObject({ amount: 10, balance: 90 });
    const bets = await economyOf(r.store).docs.list("p", "bet", { limit: 10 });
    expect(bets.map((d) => d.space)).toEqual([inA.space?.id]);
  });

  it("let someone who only ever used a command in the server bet there and be on its board", async () => {
    const { r, a, b } = await twoServers();
    // Dave never wrote anywhere: one command in A (what the Discord module records before the
    // command runs) makes him a member of A, and of A only.
    r.store.places.memberSeen(a, DAVE, "Dave");
    const dave = r.store.persons.personOf(DAVE)?.id as PersonId;
    expect(r.store.places.isMember(dave, a)).toBe(true);
    await fund(r, DAVE, 100);
    const inA = await openIn(r, IN_A);
    const inB = await openIn(r, IN_B);
    expect(await r.economy.v2.placeBet(DAVE, inA.id, 1, 10, "dave")).toMatchObject({
      amount: 10,
      balance: 90,
    });
    await rejects(r.economy.v2.placeBet(DAVE, inB.id, 1, 10, "dave-b"), 403);
    expect(await balance(r, DAVE)).toBe(90);
    await r.economy.feed(DAVE, "rice", 1, "feed-dave");
    const names = (lines: { name: string }[]) => lines.map((l) => l.name);
    expect(names(await r.economy.board(10, r.store.places.members(a)))).toContain("Dave");
    expect(names(await r.economy.board(10, r.store.places.members(b)))).not.toContain("Dave");
    expect(await r.economy.spacesFor(DM, DAVE)).toEqual([a]);
  });

  it("count predictions_open per server", async () => {
    const { r } = await twoServers({ predictions_open: 1 });
    await openIn(r, IN_A);
    await rejects(openIn(r, IN_A), 429);
    await openIn(r, IN_B);
  });

  it("are listed per server by her tool and /me predictions", async () => {
    const { r } = await twoServers();
    await openIn(r, IN_A, "A 的題");
    await openIn(r, IN_B, "B 的題");
    const caps = v2Capabilities(r.economy);
    const seen = await say(r, caps, "check_predictions", BOB, "m1", {}, false, IN_B);
    expect(seen.text).toContain("B 的題");
    expect(seen.text).not.toContain("A 的題");
    const registry = new CommandRegistry(Permissions.fromStrings([]));
    const services = new ServiceRegistry();
    services.provide("test", Economy2Key, r.economy.v2);
    services.provide("test", PlacesKey, r.store.places);
    services.provide("test", EconomyKey, r.economy);
    new EconomyCommands().install(registry, services);
    const list = async (who: AccountRef, context: ContextKey) =>
      (
        await registry.dispatch({
          path: ["me", "predictions"],
          args: {},
          invoker: who,
          invoker_display_name: "x",
          context,
          invoker_is_guild_admin: false,
        })
      ).text;
    expect(await list(ALICE, IN_A)).toContain("A 的題");
    expect(await list(ALICE, IN_A)).not.toContain("B 的題");
    // In a DM: every server of theirs, each named when there are several.
    const erin = await list(ERIN, DM);
    expect(erin).toContain("A 的題");
    expect(erin).toContain("B 的題");
    expect(erin).toContain("在「guild-b」");
  });
});

describe("bounties per server", () => {
  async function withPurse() {
    const t = await twoServers();
    await ledgerOf(t.r.store).post({
      id: newId(),
      person: PURSE,
      delta: 500,
      reason: "admin_adjust",
      ref: "test",
      idem_key: null,
      ts: toTimestamp(t.r.clock.at),
    });
    return t;
  }

  it("belong to the server they were posted in, and are shown there", async () => {
    const { r, a, b } = await withPurse();
    const inA = await r.economy.bountyDesk.post({ task: "畫一張貓", reward: 10, context: IN_A });
    const inB = await r.economy.bountyDesk.post({ task: "猜一個謎語", reward: 10, context: IN_B });
    expect([inA.space, inB.space]).toEqual([a, b]);
    expect((await r.economy.bounties([a])).map((x) => x.task)).toEqual(["畫一張貓"]);
    expect((await r.economy.bounties()).length).toBe(2);
  });

  it("are paid only to a member of their server", async () => {
    const { r } = await withPurse();
    const inA = await r.economy.bountyDesk.post({ task: "畫一張貓", reward: 10, context: IN_A });
    await rejects(r.economy.bountyDesk.award(BOB, inA.id), 403, /只能給那裡的成員/);
    const won = await r.economy.bountyDesk.award(ALICE, inA.id);
    expect(won.paid).toBe(10);
    expect(await balance(r, ALICE)).toBe(10);
  });
});

describe("the sponsor board per server", () => {
  it("lists everyone, or one server's members ranked among themselves", async () => {
    const { r, a, b } = await twoServers();
    for (const who of [ALICE, BOB, ERIN]) {
      await fund(r, who, 100);
      await r.economy.feed(who, "rice", 1, `feed-${who.id}`);
    }
    const names = (lines: { name: string }[]) => lines.map((l) => l.name).sort();
    expect(names(await r.economy.board())).toEqual(["Alice", "Bob", "Erin"]);
    expect(names(await r.economy.board(10, r.store.places.members(a)))).toEqual(["Alice", "Erin"]);
    expect(names(await r.economy.board(10, r.store.places.members(b)))).toEqual(["Bob", "Erin"]);
  });

  it("/me board shows this server's list in a server and everyone's in a DM or with 全部", async () => {
    const { r } = await twoServers();
    await fund(r, ALICE, 100);
    await fund(r, BOB, 100);
    await r.economy.feed(ALICE, "rice", 1, "feed-alice");
    await r.economy.feed(BOB, "rice", 1, "feed-bob");
    const registry = new CommandRegistry(Permissions.fromStrings([]));
    const services = new ServiceRegistry();
    services.provide("test", EconomyKey, r.economy);
    services.provide("test", PlacesKey, r.store.places);
    new EconomyCommands().install(registry, services);
    const board = async (context: ContextKey, scope?: string) => {
      const reply = await registry.dispatch({
        path: ["me", "board"],
        args: scope === undefined ? {} : { 範圍: scope },
        invoker: ALICE,
        invoker_display_name: "Alice",
        context,
        invoker_is_guild_admin: false,
      });
      return reply.text;
    };
    const here = await board(IN_A);
    expect(here).toContain("Alice");
    expect(here).not.toContain("Bob");
    expect(here).toContain("範圍:這個伺服器");
    expect(await board(IN_A, "全部")).toContain("Bob");
    expect(await board(DM)).toContain("Bob");
    expect(await board(IN_B)).not.toContain("Alice");
  });
});
