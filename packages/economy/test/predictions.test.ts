// Predictions: opening, staking, the pool paid to the ones who were right (nothing created, nothing
// lost), refunds, the sweep that finishes what a crash left, and her tools and `/me bet`.

import { CommandRegistry, Permissions } from "@miyoria/commands";
import { ServiceRegistry } from "@miyoria/kernel";
import type { AccountRef, JsonValue } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyCommands } from "../src/commands.js";
import { shortId } from "../src/purse.js";
import { v2Capabilities } from "../src/v2-tools.js";
import { Economy2Key } from "../src/v2-types.js";
import {
  ALICE,
  ALICE_TWO,
  BOB,
  balance,
  rig as baseRig,
  CAROL,
  DAVE,
  ERIN,
  fund,
  type Rig,
  rejects,
  say,
  TEXT,
} from "./rig.js";

const HOUR = 3_600_000;
const MIN = 60_000;

/** Quest, achievement and play coins are not what these sums are about. */
const rig = (config: Record<string, JsonValue> = {}) =>
  baseRig({ achievement_cap: 0, play_rewards: {}, ...config });

const open = (
  r: Rig,
  question = "她這場會怎麼死",
  options = ["摔死", "餓死", "被炸死"],
  minutes = 30,
) => r.economy.v2.openPrediction({ question, options, minutes });

/** Everything people and her purse hold: a settlement may move it around but never change it. */
async function everything(r: Rig, accounts: AccountRef[]): Promise<number> {
  let sum = await r.economy.purse.balance();
  for (const a of accounts) sum += await balance(r, a);
  return sum;
}

describe("opening", () => {
  it("takes a question, two to four different options and a closing time", async () => {
    const r = await rig();
    const p = await open(r);
    expect(p).toMatchObject({ question: "她這場會怎麼死", status: "open", total: 0 });
    expect(p.options.map((o) => o.label)).toEqual(["摔死", "餓死", "被炸死"]);
    await rejects(open(r, "", ["a", "b"]), 400);
    await rejects(open(r, "q", ["only one"]), 400);
    await rejects(open(r, "q", ["a", "a"]), 400);
    await rejects(open(r, "q", ["a", "b", "c", "d", "e"]), 400);
    await rejects(open(r, "q", ["a", ""]), 400);
    await rejects(open(r, "q", ["a", "b"], 0), 400);
    await rejects(open(r, "q", ["a", "b"], 121), 400);
    await rejects(open(r, "BADWORD?", ["a", "b"]), 400, /審查/);
  });

  it("holds to predictions_open", async () => {
    const r = await rig({ predictions_open: 2 });
    await open(r);
    await open(r);
    await rejects(open(r), 429);
  });
});

describe("staking", () => {
  it("charges the stake, once per person, by option number or words", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const p = await open(r);
    const bet = await r.economy.v2.placeBet(ALICE, p.id, 2, 20, "k1");
    expect(bet).toMatchObject({ option: "餓死", amount: 20, balance: 80, duplicate: false });
    expect(await r.economy.v2.placeBet(ALICE, p.id, "餓死", 20, "k1")).toMatchObject({
      duplicate: true,
    });
    expect(await balance(r, ALICE)).toBe(80);
    await rejects(r.economy.v2.placeBet(ALICE, p.id, 1, 10, "k2"), 409, /已經押過/);
    // The stake is the person's, whichever account they use.
    await rejects(r.economy.v2.placeBet(ALICE_TWO, p.id, 1, 10, "k3"), 409);
    const view = (await r.economy.v2.predictions(ALICE))[0];
    expect(view?.my_bet).toMatchObject({ option: "餓死", amount: 20, outcome: "open" });
    expect(view?.total).toBe(20);
    expect(view?.options[1]).toMatchObject({ staked: 20, backers: 1, multiplier: 1 });
    // Somebody else sees the pool, not Alice's stake.
    expect((await r.economy.v2.predictions(BOB))[0]?.my_bet).toBeNull();
    expect((await r.economy.wallet(ALICE)).recent[0]?.label).toBe("押預測");
  });

  it("refuses bad amounts, a wrong option, strangers, an empty purse and the day's limits", async () => {
    const r = await rig({ bet_max: 50, bet_daily_max: 60 });
    await fund(r, ALICE, 500);
    const p = await open(r);
    const q = await open(r, "第二題", ["甲", "乙"]);
    await rejects(r.economy.v2.placeBet(ALICE, p.id, 1, 0, "a"), 400);
    await rejects(r.economy.v2.placeBet(ALICE, p.id, 1, 51, "b"), 400);
    await rejects(r.economy.v2.placeBet(ALICE, p.id, 1, 1.5, "c"), 400);
    await rejects(r.economy.v2.placeBet(ALICE, p.id, 9, 5, "d"), 400, /沒有這個選項/);
    await rejects(r.economy.v2.placeBet(ALICE, p.id, "不存在", 5, "e"), 400);
    await rejects(r.economy.v2.placeBet(ALICE, "nope", 1, 5, "f"), 409, /沒有這個預測/);
    await rejects(r.economy.v2.placeBet(DAVE, p.id, 1, 5, "g"), 403);
    await rejects(r.economy.v2.placeBet(CAROL, p.id, 1, 5, "h"), 403);
    await rejects(r.economy.v2.placeBet(BOB, p.id, 1, 5, "i"), 402);
    await r.economy.v2.placeBet(ALICE, p.id, 1, 40, "j");
    await rejects(r.economy.v2.placeBet(ALICE, q.id, 1, 25, "k"), 429, /一天最多押 60/);
    await r.economy.v2.placeBet(ALICE, q.id, 1, 20, "l");
    expect(await balance(r, ALICE)).toBe(440);
  });

  it("closes at the time she set", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const p = await open(r, "q", ["a", "b"], 10);
    r.clock.at += 11 * MIN;
    await rejects(r.economy.v2.placeBet(ALICE, p.id, 1, 5, "k"), 409, /截止/);
    expect((await r.economy.v2.predictions(null))[0]?.status).toBe("closed");
    expect(await balance(r, ALICE)).toBe(100);
  });

  it("pays a few coins for taking part, under the play limits", async () => {
    const r = await baseRig({ achievement_cap: 0 });
    await fund(r, ALICE, 100);
    const p = await open(r);
    await r.economy.v2.placeBet(ALICE, p.id, 1, 10, "k");
    // 100 - 10 + the 3 that taking part pays.
    expect(await balance(r, ALICE)).toBe(93);
  });
});

describe("settling", () => {
  it("shares the whole pool among the ones who were right, in proportion to their stakes", async () => {
    const r = await rig();
    for (const a of [ALICE, BOB, ERIN]) await fund(r, a, 100);
    const total = await everything(r, [ALICE, BOB, ERIN]);
    const p = await open(r);
    await r.economy.v2.placeBet(ALICE, p.id, 1, 30, "a");
    await r.economy.v2.placeBet(BOB, p.id, 1, 10, "b");
    await r.economy.v2.placeBet(ERIN, p.id, 2, 20, "c");
    const done = await r.economy.v2.resolvePrediction(p.id, "摔死");
    expect(done).toMatchObject({ winner: "摔死", winners: 2, pool: 60, paid: 60, refunded: false });
    // 60 * 30 / 40 = 45 and 60 * 10 / 40 = 15.
    expect(await balance(r, ALICE)).toBe(100 - 30 + 45);
    expect(await balance(r, BOB)).toBe(100 - 10 + 15);
    expect(await balance(r, ERIN)).toBe(80);
    expect(await everything(r, [ALICE, BOB, ERIN])).toBe(total);
    const view = (await r.economy.v2.predictions(ALICE))[0];
    expect(view).toMatchObject({ status: "resolved", winner: "摔死" });
    expect(view?.my_bet).toMatchObject({ outcome: "won", payout: 45 });
    expect((await r.economy.v2.predictions(ERIN))[0]?.my_bet?.outcome).toBe("lost");
    expect((await r.economy.wallet(ALICE)).recent[0]?.label).toBe("預測猜中了");
    // It is settled once.
    await rejects(r.economy.v2.resolvePrediction(p.id, "摔死"), 409);
  });

  it("gives the coins the floors leave to her purse, so nothing is created or lost", async () => {
    const r = await rig();
    for (const a of [ALICE, BOB, ERIN]) await fund(r, a, 10);
    const total = await everything(r, [ALICE, BOB, ERIN]);
    const p = await open(r, "q", ["x", "y"]);
    await r.economy.v2.placeBet(ALICE, p.id, 1, 1, "a");
    await r.economy.v2.placeBet(BOB, p.id, 1, 1, "b");
    await r.economy.v2.placeBet(ERIN, p.id, 2, 1, "c");
    await r.economy.v2.resolvePrediction(p.id, 1);
    // 3 staked, 2 winners with 1 each: floor(3 / 2) = 1 each, one coin of dust is hers.
    expect(await balance(r, ALICE)).toBe(10);
    expect(await balance(r, BOB)).toBe(10);
    expect(await r.economy.purse.balance()).toBe(1);
    expect(await everything(r, [ALICE, BOB, ERIN])).toBe(total);
  });

  it("gives every stake back when nobody was right, or it is called off", async () => {
    const r = await rig();
    for (const a of [ALICE, BOB]) await fund(r, a, 100);
    const total = await everything(r, [ALICE, BOB]);
    const p = await open(r);
    await r.economy.v2.placeBet(ALICE, p.id, 1, 30, "a");
    await r.economy.v2.placeBet(BOB, p.id, 2, 10, "b");
    const none = await r.economy.v2.resolvePrediction(p.id, 3);
    expect(none).toMatchObject({ winner: "被炸死", winners: 0, refunded: true, pool: 40 });
    expect(await balance(r, ALICE)).toBe(100);
    expect(await balance(r, BOB)).toBe(100);
    expect((await r.economy.v2.predictions(ALICE))[0]?.my_bet?.outcome).toBe("refunded");
    const q = await open(r, "q2", ["a", "b"]);
    await r.economy.v2.placeBet(ALICE, q.id, 1, 30, "c");
    expect(await balance(r, ALICE)).toBe(70);
    expect(await r.economy.v2.cancelPrediction(q.id)).toMatchObject({ refunded: true });
    expect(await balance(r, ALICE)).toBe(100);
    expect(await everything(r, [ALICE, BOB])).toBe(total);
  });

  it("calls off what nobody settled a day after it closed, and then the stakes are back", async () => {
    const r = await rig({ prediction_expire_hours: 24 });
    await fund(r, ALICE, 100);
    const p = await open(r, "q", ["a", "b"], 10);
    await r.economy.v2.placeBet(ALICE, p.id, 1, 30, "a");
    r.clock.at += 10 * MIN + 23 * HOUR;
    await r.economy.v2.sweep();
    expect(await balance(r, ALICE)).toBe(70);
    r.clock.at += 2 * HOUR;
    await r.economy.v2.sweep();
    expect(await balance(r, ALICE)).toBe(100);
    expect((await r.economy.v2.predictions(ALICE))[0]?.status).toBe("cancelled");
  });

  it("finishes a settlement a crash left halfway, paying each winner exactly once", async () => {
    const r = await rig();
    for (const a of [ALICE, BOB, ERIN]) await fund(r, a, 100);
    const total = await everything(r, [ALICE, BOB, ERIN]);
    const p = await open(r);
    await r.economy.v2.placeBet(ALICE, p.id, 1, 30, "a");
    await r.economy.v2.placeBet(BOB, p.id, 1, 10, "b");
    await r.economy.v2.placeBet(ERIN, p.id, 2, 20, "c");
    const post = r.store.coins.post.bind(r.store.coins);
    let failed = 0;
    r.store.coins.post = async (entry, rule) => {
      if (entry.reason === "bet_win" && entry.account.id === BOB.id && failed === 0) {
        failed += 1;
        throw new Error("disk full");
      }
      return post(entry, rule);
    };
    await r.economy.v2.resolvePrediction(p.id, 1);
    expect(await balance(r, ALICE)).toBe(115);
    expect(await balance(r, BOB)).toBe(90);
    r.store.coins.post = post;
    await r.economy.v2.sweep();
    await r.economy.v2.sweep();
    expect(await balance(r, BOB)).toBe(105);
    expect(await balance(r, ALICE)).toBe(115);
    expect(await everything(r, [ALICE, BOB, ERIN])).toBe(total);
  });

  it("is told to her silently: what was called and who was right", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const p = await open(r, "她會不會贏", ["會", "不會"]);
    await r.economy.v2.placeBet(ALICE, p.id, 1, 10, "a");
    await r.economy.v2.resolvePrediction(p.id, "會");
    expect(
      r.observed.some((o) => o.summary.includes("她會不會贏") && o.summary.includes("1 個人猜中")),
    ).toBe(true);
  });
});

describe("tools and commands", () => {
  it("lets her open and call a prediction, and the speaker stake on it in text only", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const caps = v2Capabilities(r.economy);
    const made = await say(
      r,
      caps,
      "open_prediction",
      ALICE,
      "m1",
      { question: "她這場幾分", options: ["高", "低"], minutes: 20 },
      true,
    );
    const id = made.data.id as string;
    expect(made.data.done).toBe(true);
    expect((await say(r, caps, "check_predictions", ALICE, "m2")).text).toContain("她這場幾分");
    const bet = await say(r, caps, "place_bet", ALICE, "m3", {
      prediction: id,
      option: "高",
      amount: 10,
    });
    expect(bet.data).toMatchObject({ done: true, amount: 10 });
    // The same message stakes once; a voice message does not stake at all.
    await say(r, caps, "place_bet", ALICE, "m3", { prediction: id, option: "高", amount: 10 });
    expect(await balance(r, ALICE)).toBe(90 + 3 * 0);
    const voice = { ...TEXT, kind: "voice" } as const;
    const refused = await say(
      r,
      caps,
      "place_bet",
      BOB,
      "m4",
      { prediction: id, option: "低", amount: 5 },
      false,
      voice,
    );
    expect(refused.data).toMatchObject({ accepted: false, reason: "unconfirmed" });
    const called = await say(
      r,
      caps,
      "resolve_prediction",
      ALICE,
      "m5",
      { prediction: id, option: "高" },
      true,
    );
    expect(called.data).toMatchObject({ done: true, winner: "高", winners: 1, pool: 10 });
    expect(shortId(id)).toBe(id);
    // The speaker cannot open or call one: the tools are hers (`on_own`).
    await expect(
      say(r, caps, "open_prediction", ALICE, "m6", {
        question: "x",
        options: ["a", "b"],
        minutes: 5,
      }),
    ).rejects.toThrow();
  });

  it("lets her call one off", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const caps = v2Capabilities(r.economy);
    const p = await open(r, "q", ["a", "b"]);
    await r.economy.v2.placeBet(ALICE, p.id, 1, 10, "a");
    const out = await say(r, caps, "cancel_prediction", ALICE, "m1", { prediction: p.id }, true);
    expect(out.data).toMatchObject({ done: true, pool: 10 });
    expect(await balance(r, ALICE)).toBe(100);
    const again = await say(r, caps, "cancel_prediction", ALICE, "m2", { prediction: p.id }, true);
    expect(again.data).toMatchObject({ accepted: false, reason: "already" });
  });

  it("/me predictions and /me bet answer with neutral cards", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const p = await open(r);
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:1", "discord:4"]));
    const services = new ServiceRegistry();
    services.provide("test", Economy2Key, r.economy.v2);
    new EconomyCommands().install(registry, services);
    const run = (
      path: string[],
      who: AccountRef,
      args: Record<string, string | number | boolean> = {},
    ) =>
      registry.dispatch({
        path,
        args,
        invoker: who,
        invoker_display_name: "x",
        context: { platform: "discord", scope: null, channel: "9", kind: "dm" },
        invoker_is_guild_admin: false,
      });
    const bet = await run(["me", "bet"], ALICE, { prediction: p.id, option: "1", amount: 10 });
    expect(bet.card?.accent).toBe("neutral");
    expect(bet.text).toContain("押了「她這場會怎麼死」的「摔死」10");
    const list = await run(["me", "predictions"], ALICE);
    expect(list.text).toContain("你押了 10 在「摔死」");
    expect(list.text).toContain(`[${p.id}]`);
    expect(
      (await run(["me", "bet"], ALICE, { prediction: p.id, option: "2", amount: 5 })).tone,
    ).toBe("info");
    expect(
      (await run(["me", "bet"], DAVE, { prediction: p.id, option: "2", amount: 5 })).tone,
    ).toBe("info");
  });
});
