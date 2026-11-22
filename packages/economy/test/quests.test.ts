// The three daily quests (v5-architecture §9.4): what they pay, the bonus, the cap, topics that
// repeat, who ticks them (a game or a song with others, her own judgement), the one she thinks of
// for each person (written once a day, a plain one when she cannot), her tools and `/me quests`.

import { CommandRegistry, Permissions } from "@miyoria/commands";
import { getLogger, ServiceRegistry } from "@miyoria/runtime/kernel";
import type { AccountRef, JsonValue } from "@miyoria/types";
import {
  type AnyEventDefinition,
  type EventPayload,
  Events,
  eventEnvelope,
  newId,
  type PublishMetaArgs,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyCommands } from "../src/commands.js";
import { Earnings } from "../src/earn.js";
import { MAX_PICK_CHARS, PICK_KEEP_DAYS, PLAIN_PICKS, plainPick } from "../src/quests.js";
import { v2Capabilities } from "../src/v2-tools.js";
import { Economy2Key, type QuestPicker, QuestPickerKey } from "../src/v2-types.js";
import { ledgerOf, walletOf } from "./ledger.js";
import {
  ALICE,
  BOB,
  balance,
  rig as baseRig,
  CAROL,
  DAVE,
  DAY,
  ERIN,
  type Rig,
  rejects,
  say,
  T0,
} from "./rig.js";

/** An event of `definition` as the bus delivers it. */
const ev = <D extends AnyEventDefinition>(
  definition: D,
  data: EventPayload<D>,
  ...meta: PublishMetaArgs<D>
) => eventEnvelope("test", definition, data, ...meta);

/** Achievements pay coins of their own: keep them out of these sums. */
const rig = (config: Record<string, JsonValue> = {}, options = {}) =>
  baseRig({ achievement_cap: 0, ...config }, options);

/** A picker that answers `text` and counts the times it was asked, by account id. */
function picker(r: Rig, text: string | null | (() => Promise<string | null>)) {
  const asked: string[] = [];
  const p: QuestPicker = {
    pick: async (account: AccountRef) => {
      asked.push(account.id);
      return typeof text === "function" ? text() : text;
    },
  };
  r.services.provide("test", QuestPickerKey, p);
  return asked;
}

const pickOf = async (r: Rig, who: AccountRef, pick = true) =>
  (await r.economy.v2.quests(who, { pick })).quests.find((q) => q.id === "her_pick");

describe("quests", () => {
  it("are one with her, one with others and one she thought of, in that order", async () => {
    const r = await rig();
    const view = await r.economy.v2.quests(ALICE);
    expect(view.quests.map((q) => q.id)).toEqual(["new_topic", "together", "her_pick"]);
    expect(view.quests.every((q) => q.hint !== "" && !q.done)).toBe(true);
  });

  it("pays each once a day and the bonus for all three", async () => {
    const r = await rig();
    const q = r.economy.v2;
    expect(await q.completeQuest(ALICE, "together")).toMatchObject({ status: "paid", paid: 10 });
    expect(await q.completeQuest(ALICE, "together")).toMatchObject({ status: "done", paid: 0 });
    await q.quests(ALICE, { pick: true });
    await q.completeQuest(ALICE, "her_pick");
    const last = await q.completeQuest(ALICE, "new_topic", "她的貓");
    expect(last).toMatchObject({ status: "paid", paid: 10, bonus: 15, all_done: true });
    // 3 x 10 and the bonus, nothing more.
    expect(await balance(r, ALICE)).toBe(45);
    const view = await q.quests(ALICE);
    expect(view.quests.every((x) => x.done)).toBe(true);
    expect(view).toMatchObject({ bonus_done: true, earned_today: 45, cap: 45 });
    expect((await r.economy.wallet(ALICE)).recent.map((l) => l.label)).toContain(
      "今天的任務全部完成",
    );
    r.clock.at += DAY;
    expect((await q.quests(ALICE)).quests.every((x) => !x.done)).toBe(true);
    expect(await q.completeQuest(ALICE, "together")).toMatchObject({ paid: 10 });
  });

  it("does not count the same topic twice within the days, in any spelling", async () => {
    const r = await rig({ quest_topic_days: 3 });
    const q = r.economy.v2;
    await q.completeQuest(ALICE, "new_topic", "Her Cat!");
    r.clock.at += DAY;
    expect(await q.completeQuest(ALICE, "new_topic", "her  cat")).toMatchObject({
      status: "repeat",
      paid: 0,
    });
    r.clock.at += 3 * DAY;
    expect(await q.completeQuest(ALICE, "new_topic", "her cat")).toMatchObject({ status: "paid" });
    await rejects(q.completeQuest(BOB, "new_topic", "  !! "), 400);
    await rejects(q.completeQuest(BOB, "new_topic"), 400);
  });

  it("holds to quest_cap, and a stranger or a blocked person earns nothing", async () => {
    const r = await rig({ quest_cap: 12 });
    const q = r.economy.v2;
    await q.completeQuest(ALICE, "together");
    expect(await q.completeQuest(ALICE, "new_topic", "x")).toMatchObject({ paid: 2 });
    await q.quests(ALICE, { pick: true });
    expect(await q.completeQuest(ALICE, "her_pick")).toMatchObject({
      status: "capped",
      paid: 0,
    });
    expect(await balance(r, ALICE)).toBe(12);
    for (const who of [DAVE, CAROL]) {
      expect((await q.completeQuest(who, "together")).status).toBe("stranger");
      expect((await q.quests(who, { pick: true })).quests).toEqual([]);
    }
  });

  it("reads a game or a song of the quests of before as today's 'with others'", async () => {
    const r = await rig();
    const day = r.economy.today();
    // A row the quests of before wrote today (`play_game`): it is not paid a second time.
    await ledgerOf(r.store).post({
      id: newId(),
      person: walletOf(r.store, ALICE),
      delta: 10,
      reason: "quest",
      ref: "play_game",
      idem_key: `quest:${day}:play_game`,
      ts: toTimestamp(r.clock.at),
    });
    expect((await r.economy.v2.quests(ALICE)).quests[1]).toMatchObject({
      id: "together",
      done: true,
    });
    expect(await r.economy.v2.completeQuest(ALICE, "together")).toMatchObject({ status: "done" });
    expect(await balance(r, ALICE)).toBe(10);
  });
});

describe("the quest with others", () => {
  it("is ticked by a game the Participation service paid, even when play coins ran out", async () => {
    const r = await rig({ play_cap: 5 });
    await r.economy.v2.play.award(BOB, "game_join", "g1");
    await r.economy.v2.play.award(BOB, "game_finish", "g1");
    const play = (await r.economy.v2.quests(BOB)).quests.find((x) => x.id === "together");
    expect(play?.done).toBe(true);
    // A head-pat is not a game.
    await r.economy.v2.play.award(ALICE, "headpat", "h1");
    expect((await r.economy.v2.quests(ALICE)).quests.find((x) => x.id === "together")?.done).toBe(
      false,
    );
  });

  const voice = { platform: "discord", scope: "g", channel: "v", kind: "voice" } as const;
  const part = (a: AccountRef) => ({
    account: a,
    display_name: a.id,
    is_self: false,
    muted: false,
    deafened: false,
  });
  const cue = (state: string, extra = {}) =>
    ev(Events.SingCue, { state, song: "s1", ...extra } as never);
  const together = async (r: Rig, a: AccountRef) =>
    (await r.economy.v2.quests(a)).quests.find((x) => x.id === "together")?.done;

  it("is ticked for whoever sat through a song with someone else, and not for one who came late", async () => {
    const r = await rig();
    const earnings = new Earnings(r.economy, r.economy.config, r.services, getLogger("test"));
    const at = (...who: AccountRef[]) =>
      ev(Events.VoiceParticipants, { context: voice, participants: who.map(part) });
    await earnings.onEvent(
      ev(Events.VoiceJoined, { context: voice, participants: [part(ALICE), part(ERIN)] } as never),
      T0,
    );
    await earnings.onEvent(cue("started", { title: "t" }), T0);
    await earnings.onEvent(at(ALICE, ERIN, BOB), T0);
    await earnings.onEvent(cue("ended", { outcome: "finished" }), T0);
    expect(await together(r, ALICE)).toBe(true);
    expect(await together(r, ERIN)).toBe(true);
    expect(await together(r, BOB)).toBe(false);
    // A song she stopped is not heard to the end.
    await earnings.onEvent(cue("started"), T0);
    await earnings.onEvent(cue("ended", { outcome: "interrupted" }), T0);
    expect(await together(r, BOB)).toBe(false);
  });

  it("is not ticked by a song heard alone with her, or with someone she does not know", async () => {
    const r = await rig();
    const earnings = new Earnings(r.economy, r.economy.config, r.services, getLogger("test"));
    await earnings.onEvent(
      ev(Events.VoiceJoined, { context: voice, participants: [part(BOB), part(DAVE)] } as never),
      T0,
    );
    await earnings.onEvent(cue("started", { title: "t" }), T0);
    await earnings.onEvent(cue("ended", { outcome: "finished" }), T0);
    expect(await together(r, BOB)).toBe(false);
  });

  it("needs as many people as quest_together_min_people says", async () => {
    const r = await rig({ quest_together_min_people: 3 });
    const award = (id: string, who: AccountRef[]) =>
      r.economy.v2.party.award({
        id,
        game: "soup",
        title: "海龜湯",
        context: { platform: "discord", scope: "g", channel: "t", kind: "channel" },
        awards: who.map((account) => ({ account, name: account.id, coins: 1 })),
      });
    await award("party:two", [ALICE, BOB]);
    expect(await together(r, ALICE)).toBe(false);
    await award("party:three", [ALICE, BOB, ERIN]);
    expect(await together(r, ALICE)).toBe(true);
    expect(await together(r, ERIN)).toBe(true);
  });
});

describe("the quest she thinks of", () => {
  it("is hers once a day: asked once, kept all day, a new one the next day", async () => {
    const r = await rig();
    const asked = picker(r, "跟她說說新家整理好了沒");
    // Looked at twice at once, by two accounts of hers: she is asked once.
    const [one, two] = await Promise.all([
      pickOf(r, ALICE),
      pickOf(r, { platform: "discord", id: "1b" }),
    ]);
    expect(one).toMatchObject({ label: "跟她說說新家整理好了沒", by: "her", done: false });
    expect(two?.label).toBe(one?.label);
    // Looked at again: the same, not asked again.
    await pickOf(r, ALICE);
    expect(asked).toHaveLength(1);
    r.clock.at += DAY;
    await pickOf(r, ALICE);
    expect(asked).toHaveLength(2);
  });

  it("is not chosen by an admin's look, and cannot be done before it is chosen", async () => {
    const r = await rig();
    const asked = picker(r, "跟她說說新家整理好了沒");
    expect(await pickOf(r, ALICE, false)).toMatchObject({ label: "她替你想的一件事", by: null });
    expect(asked).toEqual([]);
    expect(await r.economy.v2.completeQuest(ALICE, "her_pick")).toMatchObject({
      status: "unpicked",
      paid: 0,
    });
    await pickOf(r, ALICE);
    expect(await r.economy.v2.completeQuest(ALICE, "her_pick")).toMatchObject({
      status: "paid",
      paid: 10,
    });
    expect(await r.economy.v2.completeQuest(ALICE, "her_pick")).toMatchObject({ status: "done" });
    expect(await balance(r, ALICE)).toBe(10);
  });

  it("is a plain one when she cannot write it: nothing, a failure, too long, not passed, or off", async () => {
    const cases: [Record<string, JsonValue>, string | null | (() => Promise<string | null>)][] = [
      [{}, null],
      [{}, () => Promise.reject(new Error("the model is down"))],
      [{}, "長".repeat(MAX_PICK_CHARS + 1)],
      [{}, "說一個 BADWORD"],
      [{}, "   "],
      [{ quest_pick_by_her: false }, "跟她說說新家整理好了沒"],
    ];
    for (const [config, text] of cases) {
      const r = await rig(config);
      const asked = picker(r, text);
      const pick = await pickOf(r, ALICE);
      expect(pick?.by).toBe("fallback");
      expect(PLAIN_PICKS).toContain(pick?.label);
      if (config.quest_pick_by_her === false) expect(asked).toEqual([]);
    }
    // Without anyone to write it at all, the same.
    const r = await rig();
    expect((await pickOf(r, BOB))?.by).toBe("fallback");
  });

  it("chooses the plain one by person and day, the same on every restart", () => {
    expect(plainPick("P1", 100)).toBe(plainPick("P1", 100));
    const days = new Set(Array.from({ length: 30 }, (_, d) => plainPick("P1", d)));
    expect(days.size).toBeGreaterThan(1);
    for (const p of days) expect(PLAIN_PICKS).toContain(p);
  });

  it("is kept in the store: a restart shows the same one and does not ask again", async () => {
    const first = await rig({}, { durable: true });
    const asked = picker(first, "跟她說說新家整理好了沒");
    await pickOf(first, ALICE);
    const again = await rig({}, { durable: true, store: first.store });
    const later = picker(again, "別的");
    expect((await pickOf(again, ALICE))?.label).toBe("跟她說說新家整理好了沒");
    expect([...asked, ...later]).toEqual(["1"]);
  });

  it("is deleted by the sweep once its day is more than a week gone, in memory and in the store", async () => {
    for (const durable of [false, true]) {
      const r = await rig({}, { durable });
      const docs = r.economy.docs();
      const ids = async () =>
        (await docs.list("p", "quest_pick", { limit: 100 })).map((d) => d.data.day);
      const first = r.economy.today();
      for (let d = 0; d <= PICK_KEEP_DAYS + 2; d++) {
        await pickOf(r, ALICE);
        await pickOf(r, BOB);
        if (d === 0) await r.economy.v2.completeQuest(ALICE, "her_pick");
        if (d < PICK_KEEP_DAYS + 2) r.clock.at += DAY;
      }
      const today = r.economy.today();
      expect(today).toBe(first + PICK_KEEP_DAYS + 2);
      expect(await ids()).toHaveLength(2 * (PICK_KEEP_DAYS + 3));
      // A quest done on an old day stays in the ledger: only the picks go.
      await r.economy.v2.sweep();
      const left = await ids();
      expect(left).toHaveLength(2 * (PICK_KEEP_DAYS + 1));
      expect(Math.min(...left.map(Number))).toBe(today - PICK_KEEP_DAYS);
      expect(await balance(r, ALICE)).toBe(10);
      // Today's pick is untouched, and a second sweep the same day does nothing more.
      expect((await pickOf(r, ALICE, false))?.by).not.toBeNull();
      expect(await r.economy.v2.quest.prune()).toBe(0);
    }
  });
});

describe("quest tools and commands", () => {
  it("check_quests shows the speaker's own progress and her pick; complete_quest is her judgement", async () => {
    const r = await rig();
    picker(r, "跟她說說新家整理好了沒");
    const caps = v2Capabilities(r.economy);
    const before = await say(r, caps, "check_quests", ALICE, "m1");
    expect(before.text).toContain("還沒:跟她聊一件新的事");
    expect(before.text).toContain("還沒:你替他想的「跟她說說新家整理好了沒」");
    const done = await say(r, caps, "complete_quest", ALICE, "m2", { topic: "新養的魚" });
    expect(done.data).toMatchObject({ done: true, paid: 10 });
    expect(await balance(r, ALICE)).toBe(10);
    // Her tool cannot name somebody else: there is no argument for it, and extra keys are refused.
    await expect(
      say(r, caps, "complete_quest", ALICE, "m3", { topic: "x", who: "2" }),
    ).rejects.toThrow();
    const repeat = await say(r, caps, "complete_quest", ALICE, "m4", { topic: "新養的魚" });
    expect(repeat.data).toMatchObject({ done: false, reason: "already" });
    const pick = await say(r, caps, "complete_quest", ALICE, "m5", { quest: "her_pick" });
    expect(pick.data).toMatchObject({ done: true, paid: 10 });
    const after = await say(r, caps, "check_quests", ALICE, "m6");
    expect(after.text).toContain("完成:跟她聊一件新的事");
    expect(after.text).toContain("完成:你替他想的");
    // Bob is not Alice: his own list is untouched, and his pick is not chosen yet.
    expect(
      (await say(r, caps, "complete_quest", BOB, "m7", { quest: "her_pick" })).data,
    ).toMatchObject({ done: false, reason: "unpicked" });
    expect((await say(r, caps, "check_quests", BOB, "m8")).text).toContain("還沒:跟她聊一件新的事");
  });

  it("/me quests answers only the asker with a neutral card, and a stranger gets the plain line", async () => {
    const r = await rig();
    picker(r, "跟她說說新家整理好了沒");
    await r.economy.v2.completeQuest(ALICE, "together");
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:1", "discord:4"]));
    const services = new ServiceRegistry();
    services.provide("test", Economy2Key, r.economy.v2);
    new EconomyCommands().install(registry, services);
    const run = (who: typeof ALICE) =>
      registry.dispatch({
        path: ["me", "quests"],
        args: {},
        invoker: who,
        invoker_display_name: "x",
        context: { platform: "discord", scope: null, channel: "9", kind: "dm" },
        invoker_is_guild_admin: false,
      });
    const reply = await run(ALICE);
    expect(reply.card?.accent).toBe("neutral");
    expect(registry.get(["me", "quests"])?.ephemeral).toBe(true);
    expect(reply.text).toContain("✅ 和大家一起玩一場");
    expect(reply.text).toContain("⬜ 她替你想的：跟她說說新家整理好了沒");
    expect((await run(DAVE)).tone).toBe("info");
  });
});
