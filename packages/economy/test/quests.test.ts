// The three daily quests: what they pay, the bonus, the cap, topics that repeat, who ticks them
// (a game, a song heard to the end, her own judgement) and her tools and `/me quests`.

import { CommandRegistry, Permissions } from "@miyoria/commands";
import { getLogger, ServiceRegistry } from "@miyoria/kernel";
import type { JsonValue } from "@miyoria/types";
import { customEvent, type Event, SONG_TOPIC } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyCommands } from "../src/commands.js";
import { Earnings } from "../src/earn.js";
import { v2Capabilities } from "../src/v2-tools.js";
import { Economy2Key } from "../src/v2-types.js";
import { ALICE, BOB, balance, rig as baseRig, CAROL, DAVE, DAY, rejects, say, T0 } from "./rig.js";

/** Achievements pay coins of their own: keep them out of these sums. */
const rig = (config: Record<string, JsonValue> = {}) => baseRig({ achievement_cap: 0, ...config });

describe("quests", () => {
  it("pays each once a day and the bonus for all three", async () => {
    const r = await rig();
    const q = r.economy.v2;
    expect(await q.completeQuest(ALICE, "play_game")).toMatchObject({ status: "paid", paid: 10 });
    expect(await q.completeQuest(ALICE, "play_game")).toMatchObject({ status: "done", paid: 0 });
    await q.completeQuest(ALICE, "listen_song");
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
    expect(await q.completeQuest(ALICE, "play_game")).toMatchObject({ paid: 10 });
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
    await q.completeQuest(ALICE, "play_game");
    expect(await q.completeQuest(ALICE, "listen_song")).toMatchObject({ paid: 2 });
    expect(await q.completeQuest(ALICE, "new_topic", "x")).toMatchObject({
      status: "capped",
      paid: 0,
    });
    expect(await balance(r, ALICE)).toBe(12);
    for (const who of [DAVE, CAROL]) {
      expect((await q.completeQuest(who, "play_game")).status).toBe("stranger");
      expect((await q.quests(who)).quests).toEqual([]);
    }
  });

  it("is ticked by a game the Participation service paid, even when play coins ran out", async () => {
    const r = await rig({ play_cap: 5 });
    await r.economy.v2.play.award(BOB, "game_join", "g1");
    await r.economy.v2.play.award(BOB, "game_finish", "g1");
    const play = (await r.economy.v2.quests(BOB)).quests.find((x) => x.id === "play_game");
    expect(play?.done).toBe(true);
    // A head-pat is not a game.
    await r.economy.v2.play.award(ALICE, "headpat", "h1");
    expect((await r.economy.v2.quests(ALICE)).quests.find((x) => x.id === "play_game")?.done).toBe(
      false,
    );
  });

  it("is ticked for whoever sat through a song in her voice channel, and not for one who came late", async () => {
    const r = await rig();
    const earnings = new Earnings(r.economy, r.economy.config, r.services, getLogger("test"));
    const voice = { platform: "discord", scope: "g", channel: "v", kind: "voice" } as const;
    const part = (a: typeof ALICE) => ({
      account: a,
      display_name: a.id,
      is_self: false,
      muted: false,
      deafened: false,
    });
    const joined = (...who: (typeof ALICE)[]): Event =>
      ({ type: "voice_joined", data: { context: voice, participants: who.map(part) } }) as never;
    const cue = (state: string, extra = {}): Event =>
      customEvent(SONG_TOPIC, { state, song: "s1", ...extra });
    await earnings.onEvent(joined(ALICE), T0);
    await earnings.onEvent(cue("started", { title: "t" }), T0);
    await earnings.onEvent(
      {
        type: "voice_participants",
        data: { context: voice, participants: [part(ALICE), part(BOB)] },
      } as never,
      T0,
    );
    await earnings.onEvent(cue("ended", { outcome: "finished" }), T0);
    const done = async (a: typeof ALICE) =>
      (await r.economy.v2.quests(a)).quests.find((x) => x.id === "listen_song")?.done;
    expect(await done(ALICE)).toBe(true);
    expect(await done(BOB)).toBe(false);
    // A song she stopped is not heard to the end.
    await earnings.onEvent(cue("started"), T0);
    await earnings.onEvent(cue("ended", { outcome: "interrupted" }), T0);
    expect(await done(BOB)).toBe(false);
  });
});

describe("quest tools and commands", () => {
  it("check_quests shows the speaker's own progress; complete_quest is her judgement", async () => {
    const r = await rig();
    const caps = v2Capabilities(r.economy);
    const before = await say(r, caps, "check_quests", ALICE, "m1");
    expect(before.text).toContain("還沒:跟她聊一件新的事");
    const done = await say(r, caps, "complete_quest", ALICE, "m2", { topic: "新養的魚" });
    expect(done.data).toMatchObject({ done: true, paid: 10 });
    expect(await balance(r, ALICE)).toBe(10);
    // Her tool cannot name somebody else: there is no argument for it, and extra keys are refused.
    await expect(
      say(r, caps, "complete_quest", ALICE, "m3", { topic: "x", who: "2" }),
    ).rejects.toThrow();
    const repeat = await say(r, caps, "complete_quest", ALICE, "m4", { topic: "新養的魚" });
    expect(repeat.data).toMatchObject({ done: false, reason: "already" });
    expect((await say(r, caps, "check_quests", ALICE, "m5")).text).toContain(
      "完成:跟她聊一件新的事",
    );
    // Bob is not Alice: his own list is untouched.
    expect((await say(r, caps, "check_quests", BOB, "m6")).text).toContain("還沒:跟她聊一件新的事");
  });

  it("/me quests answers with a neutral card, and a stranger gets the plain line", async () => {
    const r = await rig();
    await r.economy.v2.completeQuest(ALICE, "play_game");
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
    expect(reply.text).toContain("✅ 參加一場遊戲");
    expect(reply.text).toContain("⬜ 聽完一首歌");
    expect((await run(DAVE)).tone).toBe("info");
  });
});
