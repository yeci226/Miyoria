// Predictions that settle by themselves (prediction-watch.ts) and the cut a win burns: bound to the
// soup or the game goal going on when she opens one, settled by what the game itself reports,
// every stake back when that cannot be told in time, a record of who settled each one, and the
// owner still able to settle or call off any of them by hand.

import type { AccountRef, ContextKey, JsonValue } from "@miyoria/types";
import {
  type AnyEventDefinition,
  type EventPayload,
  Events,
  eventEnvelope,
  PartyOverviewKey,
  type PartySessionView,
  type PublishMetaArgs,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { v2Capabilities } from "../src/v2-tools.js";
import {
  ALICE,
  BOB,
  balance,
  rig as baseRig,
  ERIN,
  fund,
  type Rig,
  rejects,
  say,
  TEXT,
} from "./rig.js";

const MIN = 60_000;

const rig = (config: Record<string, JsonValue> = {}, options = {}) =>
  baseRig({ achievement_cap: 0, play_rewards: {}, ...config }, options);

const ev = <D extends AnyEventDefinition>(
  definition: D,
  data: EventPayload<D>,
  ...meta: PublishMetaArgs<D>
) => eventEnvelope("test", definition, data, ...meta);

/** Everything people and her purse hold. */
async function everything(r: Rig, accounts: AccountRef[]): Promise<number> {
  let sum = await r.economy.purse.balance();
  for (const a of accounts) sum += await balance(r, a);
  return sum;
}

const OTHER: ContextKey = { ...TEXT, channel: "other" };

/** Soups going on, as the party module lists them. */
function soups(r: Rig, ...where: [string, ContextKey][]) {
  const sessions: PartySessionView[] = where.map(([id, context]) => ({
    id,
    game: "soup",
    title: "海龜湯",
    context,
    state: "running",
    started_at: "2026-11-08T04:00:00Z",
    scored: true,
    players: [],
  }));
  r.services.provide("party", PartyOverviewKey, { snapshot: () => ({ sessions, recent: [] }) });
}

const soupEnded = (r: Rig, session: string, solved: boolean | null) =>
  r.economy.v2.prediction.watch.ended({
    session,
    game: "soup",
    context: TEXT,
    reason: "done",
    solved,
  });

const watch = (r: Rig) => r.economy.v2.prediction.watch;
const game = (state: "started" | "stopped") =>
  ev(Events.GameDirectorSession, {
    state,
    game: "minecraft",
    game_name: "Minecraft",
    context: TEXT,
  });
const decided = (goal: string | null) =>
  ev(Events.GameDirectorDecision, {
    game: "minecraft",
    trigger: [],
    goal,
    action: null,
    verdict: null,
    commentary: null,
    busy: null,
    observation: "",
    want: null,
    held: [],
  });
const goalEnded = (goal: string, status: "done" | "failed", code: string) =>
  ev(Events.GameDirectorGoal, {
    game: "minecraft",
    goal,
    source: "director",
    status,
    code: code as never,
    task: null,
    detail: "",
    at: "2026-11-08T04:10:00Z",
    attention_key: goal,
  });

async function staked(r: Rig, id: string) {
  await fund(r, ALICE, 100);
  await fund(r, BOB, 100);
  await r.economy.v2.placeBet(ALICE, id, 1, 30, "a1");
  await r.economy.v2.placeBet(BOB, id, 2, 20, "b1");
}

const one = async (r: Rig, id: string) =>
  (await r.economy.v2.predictions(null)).find((p) => p.id === id);

describe("the cut a win burns", () => {
  it("takes prediction_rake of the pool from the winners and burns it; nothing when all goes back", async () => {
    const r = await rig();
    const p = await r.economy.v2.openPrediction({
      question: "q",
      options: ["a", "b"],
      minutes: 30,
    });
    await staked(r, p.id);
    const before = await everything(r, [ALICE, BOB]);
    const out = await r.economy.v2.resolvePrediction(p.id, 1);
    // 50 staked, 5%: 2 burned, Alice (the only winner) gets 48.
    expect(out).toMatchObject({ pool: 50, rake: 2, paid: 48, winners: 1, refunded: false });
    expect(await balance(r, ALICE)).toBe(100 - 30 + 48);
    // The 50 held come back to people less the 2 burned; nothing goes anywhere else.
    expect(await everything(r, [ALICE, BOB])).toBe(before + 50 - 2);

    const q = await r.economy.v2.openPrediction({
      question: "q2",
      options: ["a", "b"],
      minutes: 30,
    });
    await r.economy.v2.placeBet(ALICE, q.id, 1, 10, "a2");
    expect(await r.economy.v2.cancelPrediction(q.id)).toMatchObject({ rake: 0, refunded: true });
  });

  it("shows what a coin would return with the cut taken", async () => {
    const r = await rig({ prediction_rake: 0.1 });
    const p = await r.economy.v2.openPrediction({
      question: "q",
      options: ["a", "b"],
      minutes: 30,
    });
    await staked(r, p.id);
    // 50 in, 45 to share: 45 / 30 on the first option.
    expect((await one(r, p.id))?.options[0]?.multiplier).toBe(1.5);
  });
});

describe("a prediction on a turtle soup", () => {
  it("is bound to the soup going on, with fixed options, and closes early", async () => {
    const r = await rig();
    soups(r, ["S1", TEXT]);
    const p = await r.economy.v2.openPrediction({
      question: "這碗湯會被猜中嗎",
      options: [],
      minutes: 30,
      settle_by: "soup",
      context: TEXT,
    });
    expect(p.options.map((o) => o.label)).toEqual(["猜中", "沒猜中"]);
    expect(p.settles).toEqual({ kind: "soup", label: "照這碗海龜湯的結果自動結算" });
    expect(Date.parse(p.closes_at) - r.clock.at).toBe(5 * MIN);
    expect(p.settled_by).toBeNull();
  });

  it("settles on how the game came out, with the record of what settled it", async () => {
    const r = await rig();
    soups(r, ["S1", TEXT]);
    const p = await r.economy.v2.openPrediction({
      question: "會被猜中嗎",
      options: [],
      minutes: 3,
      settle_by: "soup",
    });
    await staked(r, p.id);
    // Another soup ending does nothing to it.
    await soupEnded(r, "S2", true);
    expect((await one(r, p.id))?.status).toBe("open");
    await soupEnded(r, "S1", true);
    const done = await one(r, p.id);
    expect(done).toMatchObject({ status: "resolved", winner: "猜中" });
    expect(done?.settled_by).toMatchObject({ by: "auto", note: "海龜湯被猜中了", who: null });
    // Alice backed 猜中: the pool less the cut.
    expect(await balance(r, ALICE)).toBe(100 - 30 + 48);
  });

  it("is 沒猜中 when it ended without the bottom guessed", async () => {
    const r = await rig();
    soups(r, ["S1", TEXT]);
    const p = await r.economy.v2.openPrediction({
      question: "q",
      options: [],
      minutes: 3,
      settle_by: "soup",
    });
    await staked(r, p.id);
    await soupEnded(r, "S1", false);
    expect(await one(r, p.id)).toMatchObject({ status: "resolved", winner: "沒猜中" });
    expect(await balance(r, BOB)).toBe(100 - 20 + 48);
  });

  it("cannot be opened without a soup to bind to, and picks the one where she is", async () => {
    const r = await rig();
    const req = { question: "q", options: [], minutes: 3, settle_by: "soup" as const };
    await rejects(r.economy.v2.openPrediction(req), 409);
    soups(r, ["S1", TEXT], ["S2", OTHER]);
    await rejects(r.economy.v2.openPrediction(req), 409);
    const p = await r.economy.v2.openPrediction({ ...req, context: OTHER });
    await soupEnded(r, "S1", true);
    expect((await one(r, p.id))?.status).toBe("open");
    await soupEnded(r, "S2", true);
    expect((await one(r, p.id))?.status).toBe("resolved");
  });

  it("is not hers to call, and her tool says so", async () => {
    const r = await rig();
    soups(r, ["S1", TEXT]);
    const caps = v2Capabilities(r.economy);
    const opened = await say(
      r,
      caps,
      "open_prediction",
      ALICE,
      "m1",
      { question: "會被猜中嗎", minutes: 3, settle_by: "soup" },
      true,
    );
    expect(opened.text).toContain("照這碗海龜湯的結果自動結算");
    const id = String(opened.data.id);
    await rejects(r.economy.v2.resolvePrediction(id, 1), 409);
    const called = await say(
      r,
      caps,
      "resolve_prediction",
      ALICE,
      "m2",
      { prediction: id, option: "1" },
      true,
    );
    expect(called.text).toContain("不用你公布");
    expect((await one(r, id))?.status).toBe("open");
  });
});

describe("a prediction on her game goal", () => {
  async function opened(r: Rig, goal = "蓋房子") {
    await watch(r).onEvent(game("started"));
    await watch(r).onEvent(decided(goal));
    const p = await r.economy.v2.openPrediction({
      question: "她蓋得好房子嗎",
      options: [],
      minutes: 3,
      settle_by: "goal",
    });
    await staked(r, p.id);
    return p;
  }

  it("is bound to the goal she is working on and settles when it is done", async () => {
    const r = await rig();
    const p = await opened(r);
    expect(p.options.map((o) => o.label)).toEqual(["做到", "沒做到"]);
    expect(p.settles.label).toBe("照她的遊戲目標「蓋房子」的結果自動結算");
    // Another goal ending is not this one.
    await watch(r).onEvent(goalEnded("吃東西", "done", "done"));
    expect((await one(r, p.id))?.status).toBe("open");
    await watch(r).onEvent(goalEnded("蓋房子", "done", "done"));
    expect(await one(r, p.id)).toMatchObject({ status: "resolved", winner: "做到" });
    expect((await one(r, p.id))?.settled_by?.note).toBe("她做到了目標「蓋房子」");
  });

  it("is 沒做到 when she failed at it", async () => {
    for (const code of ["gave_up", "no_progress", "died", "timeout"]) {
      const r = await rig();
      const p = await opened(r);
      await watch(r).onEvent(goalEnded("蓋房子", "failed", code));
      expect(await one(r, p.id)).toMatchObject({ status: "resolved", winner: "沒做到" });
    }
  });

  it("gives every stake back when the goal did not really end, or the game stopped first", async () => {
    for (const end of [
      goalEnded("蓋房子", "failed", "superseded"),
      goalEnded("蓋房子", "failed", "cancelled"),
      goalEnded("蓋房子", "failed", "crashed"),
      game("stopped"),
    ]) {
      const r = await rig();
      const p = await opened(r);
      await watch(r).onEvent(end);
      const after = await one(r, p.id);
      expect(after?.status).toBe("cancelled");
      expect(after?.settled_by?.by).toBe("auto");
      expect(await balance(r, ALICE)).toBe(100);
      expect(await balance(r, BOB)).toBe(100);
    }
  });

  it("cannot be opened while she has no goal, or before a decision since the start", async () => {
    const r = await rig();
    const req = { question: "q", options: [], minutes: 3, settle_by: "goal" as const };
    await rejects(r.economy.v2.openPrediction(req), 409);
    await watch(r).onEvent(game("started"));
    await rejects(r.economy.v2.openPrediction(req), 409);
    await watch(r).onEvent(decided("挖礦"));
    await watch(r).onEvent(goalEnded("挖礦", "done", "done"));
    await rejects(r.economy.v2.openPrediction(req), 409);
  });
});

describe("when nobody can tell", () => {
  it("gives every stake back prediction_auto_wait_minutes after betting closed", async () => {
    const r = await rig({ prediction_auto_wait_minutes: 30 });
    soups(r, ["S1", TEXT]);
    const p = await r.economy.v2.openPrediction({
      question: "q",
      options: [],
      minutes: 3,
      settle_by: "soup",
    });
    await staked(r, p.id);
    r.clock.at += 3 * MIN + 29 * MIN;
    await r.economy.v2.sweep();
    // Betting closed, the result still awaited.
    expect((await one(r, p.id))?.status).toBe("closed");
    r.clock.at += 2 * MIN;
    await r.economy.v2.sweep();
    const after = await one(r, p.id);
    expect(after).toMatchObject({ status: "cancelled", winner: null });
    expect(after?.settled_by).toMatchObject({ by: "expired" });
    expect(await balance(r, ALICE)).toBe(100);
    // The soup ending after that changes nothing.
    await soupEnded(r, "S1", true);
    expect(await balance(r, ALICE)).toBe(100);
  });

  it("keeps a day for her own ones, as before", async () => {
    const r = await rig({ prediction_auto_wait_minutes: 30 });
    const p = await r.economy.v2.openPrediction({ question: "q", options: ["a", "b"], minutes: 3 });
    r.clock.at += 3 * MIN + 31 * MIN;
    await r.economy.v2.sweep();
    expect((await one(r, p.id))?.status).toBe("closed");
  });
});

describe("the owner's hand", () => {
  it("settles or calls off any of them, and the record says who", async () => {
    const r = await rig();
    soups(r, ["S1", TEXT]);
    const p = await r.economy.v2.openPrediction({
      question: "q",
      options: [],
      minutes: 3,
      settle_by: "soup",
    });
    await staked(r, p.id);
    const out = await r.economy.v2.resolvePredictionByAdmin(p.id, "沒猜中", "owner:1");
    expect(out).toMatchObject({ winner: "沒猜中", winners: 1 });
    expect((await one(r, p.id))?.settled_by).toMatchObject({ by: "admin", who: "owner:1" });
    // The soup's own end comes later: it is settled already.
    await soupEnded(r, "S1", true);
    expect(await balance(r, BOB)).toBe(100 - 20 + 48);

    const q = await r.economy.v2.openPrediction({
      question: "q2",
      options: ["a", "b"],
      minutes: 30,
    });
    await fund(r, ERIN, 10);
    await r.economy.v2.placeBet(ERIN, q.id, 1, 10, "e1");
    expect(await r.economy.v2.cancelPredictionByAdmin(q.id, "owner:1")).toMatchObject({
      refunded: true,
    });
    expect((await one(r, q.id))?.settled_by).toMatchObject({
      by: "admin",
      note: "管理員取消了,全部退回",
    });
    expect(await balance(r, ERIN)).toBe(10);
    await rejects(r.economy.v2.resolvePredictionByAdmin(q.id, 1, "owner:1"), 409);
  });
});

describe("after a restart", () => {
  it("still settles what is bound, from the store", async () => {
    const first = await rig({}, { durable: true });
    soups(first, ["S1", TEXT]);
    const p = await first.economy.v2.openPrediction({
      question: "q",
      options: [],
      minutes: 3,
      settle_by: "soup",
    });
    await staked(first, p.id);
    const again = await rig({}, { durable: true, store: first.store });
    await soupEnded(again, "S1", false);
    expect(await one(again, p.id)).toMatchObject({ status: "resolved", winner: "沒猜中" });
    // Told twice (a replay): paid once.
    await soupEnded(again, "S1", false);
    expect(await balance(again, BOB)).toBe(100 - 20 + 48);
  });
});
