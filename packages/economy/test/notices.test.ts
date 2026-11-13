// What people see when they earn something they did not ask for in that moment: an achievement on
// the answer of the command that unlocked it, one card per song or game for everyone in it, a card
// where a goal was met, and nothing at all when there is no place to say it.

import { CommandRegistry, type CommandReply, Permissions, ReplySinkKey } from "@miyoria/commands";
import { getLogger } from "@miyoria/kernel";
import { SingerKey } from "@miyoria/sing";
import { GoalStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  customEvent,
  type Event,
  type JsonValue,
  SONG_TOPIC,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyCommands } from "../src/commands.js";
import { Earnings } from "../src/earn.js";
import { v2Capabilities } from "../src/v2-tools.js";
import { ALICE, BOB, DAY, ERIN, fund, type Rig, rig, say, T0, TEXT } from "./rig.js";

const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "v", kind: "voice" };

interface Posted {
  context: ContextKey;
  reply: CommandReply;
}

/** A platform that records every card posted into a context. */
function sink(r: Rig): Posted[] {
  const posted: Posted[] = [];
  r.services.provide("test", ReplySinkKey, {
    platform: "discord",
    sendDirect: async () => ({ context: TEXT, id: "d" }) as never,
    sendCard: async (context: ContextKey, reply: CommandReply) => {
      posted.push({ context, reply });
      return { context, id: `m${posted.length}` } as never;
    },
  });
  return posted;
}

/** The text of every block of a card, in order. */
const blocks = (reply: CommandReply): string[] =>
  (reply.card?.blocks ?? []).map((b) => ("text" in b ? String(b.text) : ""));

const part = (account: AccountRef) => ({
  account,
  display_name: account.id,
  is_self: false,
  muted: false,
  deafened: false,
});
const joined = (...who: AccountRef[]): Event =>
  ({ type: "voice_joined", data: { context: VOICE, participants: who.map(part) } }) as never;
const cue = (state: string, extra: Record<string, JsonValue> = {}): Event =>
  customEvent(SONG_TOPIC, { state, song: "s1", ...extra });

/** A finished song `s1` Alice requested, in a rig whose singer lists it. */
function singer(r: Rig, requester: AccountRef | null = ALICE): void {
  r.services.provide("test", SingerKey, {
    playing: () => null,
    list: {
      all: () => [
        {
          no: 1,
          requester,
          state: "done",
          created_at: new Date(T0).toISOString(),
          song: { id: "s1", title: "小星星" },
          query: "小星星",
        },
      ],
    },
  } as never);
}

describe("achievement notices", () => {
  it("adds the unlock as a muted line of the command's own reply, not a second card", async () => {
    const r = await rig();
    const posted = sink(r);
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
    new EconomyCommands().install(registry, r.services);
    const reply = await registry.dispatch({
      path: ["me", "checkin"],
      args: {},
      invoker: ALICE,
      invoker_display_name: "Alice",
      context: TEXT,
      invoker_is_guild_admin: false,
    });
    expect(reply.card?.accent).toBe("neutral");
    // 10 for the check-in and 10 for the achievement: the balance says both.
    expect(blocks(reply)).toEqual([
      "簽到了，+10 魚幣。連續 1 天，現在有 20 魚幣。",
      "🏅 解鎖「第一次簽到」,稱號「新面孔」+10",
    ]);
    expect(reply.card?.blocks[1]?.type).toBe("muted");
    expect(posted).toEqual([]);
    // Nothing new the next day: no line.
    r.clock.at += DAY;
    const again = await registry.dispatch({
      path: ["me", "checkin"],
      args: {},
      invoker: ALICE,
      invoker_display_name: "Alice",
      context: TEXT,
      invoker_is_guild_admin: false,
    });
    expect(again.card?.blocks).toHaveLength(1);
  });

  it("puts the unlock and the all-three bonus on her tool's receipt", async () => {
    const r = await rig({ quest_bonus: 15 });
    const posted = sink(r);
    await r.economy.v2.completeQuest(ALICE, "play_game");
    await r.economy.v2.completeQuest(ALICE, "listen_song");
    await say(r, v2Capabilities(r.economy), "complete_quest", ALICE, "m1", { topic: "新養的魚" });
    // The receipt is the only card, where she was talking.
    expect(posted).toHaveLength(1);
    expect(posted[0]?.context).toEqual(TEXT);
    expect(blocks(posted[0]?.reply as CommandReply)).toEqual([
      "**📝 每日任務**\n<@1> 聊了一件新的事,拿到 10 魚幣",
      "三個任務都完成,再加 15 🎉",
    ]);
  });

  it("puts an unlock on her tool's receipt", async () => {
    const r = await rig();
    const posted = sink(r);
    await say(r, v2Capabilities(r.economy), "complete_quest", ALICE, "m1", { topic: "新養的魚" });
    expect(blocks(posted[0]?.reply as CommandReply)[1]).toBe(
      "🏅 解鎖「第一個每日任務」,稱號「跑腿」+10",
    );
  });

  it("tells her once per person, not once per achievement", async () => {
    const r = await rig();
    await r.economy.checkin(ALICE);
    await r.economy.checkin(BOB);
    const keys = r.observed.filter((o) => o.source === "economy.achievement").map((o) => o.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(key).toMatch(/^economy:achv:first_checkin:.+/);
  });
});

describe("song notices", () => {
  it("posts one card for the song in her voice channel: requester, listeners, unlocks", async () => {
    const r = await rig({ quest_bonus: 15 });
    const posted = sink(r);
    singer(r);
    // Bob has done the other two quests: listening is his third.
    await r.economy.v2.completeQuest(BOB, "play_game");
    await r.economy.v2.completeQuest(BOB, "new_topic", "他的貓");
    const earnings = new Earnings(r.economy, r.economy.config, r.services, getLogger("test"));
    await earnings.onEvent(joined(ALICE, BOB, ERIN), T0);
    await earnings.onEvent(cue("started", { title: "小星星" }), T0);
    await earnings.onEvent(cue("ended", { outcome: "finished" }), T0);
    expect(posted).toHaveLength(1);
    const [card] = posted;
    if (!card) throw new Error("no card");
    expect(card.context).toEqual(VOICE);
    expect(card.reply.card?.accent).toBe("neutral");
    expect(card.reply.ephemeral).not.toBe(true);
    const [text, muted] = blocks(card.reply);
    expect(text).toBe(
      ["**🎵 唱完〈小星星〉**", "<@1> 點的,+5", "聽完的人:<@1> <@2> <@5> 各 +10(每日任務)"].join(
        "\n",
      ),
    );
    expect(muted?.split("\n")).toEqual([
      "<@2> 三個任務都完成,再加 15 🎉",
      "🏅 <@1> 解鎖「第一首點的歌被她唱完」,稱號「點歌人」+10",
      "🏅 <@1> 解鎖「第一個每日任務」,稱號「跑腿」+10",
      "🏅 <@5> 解鎖「第一個每日任務」,稱號「跑腿」+10",
    ]);
    // The same song again pays nobody and posts nothing.
    await earnings.onEvent(cue("started", { title: "小星星" }), T0);
    await earnings.onEvent(cue("ended", { outcome: "finished" }), T0);
    expect(posted).toHaveLength(1);
  });

  it("posts nothing when there is no voice channel to post in", async () => {
    const r = await rig();
    const posted = sink(r);
    singer(r);
    const earnings = new Earnings(r.economy, r.economy.config, r.services, getLogger("test"));
    await earnings.onEvent(cue("started", { title: "小星星" }), T0);
    await earnings.onEvent(cue("ended", { outcome: "finished" }), T0);
    // The requester is still paid; nobody is told where it would be a guess.
    expect(await r.store.coins.balance("p", [ALICE])).toBeGreaterThan(0);
    expect(posted).toEqual([]);
  });
});

describe("game notices", () => {
  it("posts one card for a game in its voice channel", async () => {
    const r = await rig({ achievement_cap: 0 });
    const posted = sink(r);
    await r.economy.v2.party.award({
      id: "party:1",
      game: "quiz",
      title: "問答",
      context: VOICE,
      awards: [
        { account: ALICE, name: "Alice", coins: 30 },
        { account: BOB, name: "Bob", coins: 20 },
      ],
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.context).toEqual(VOICE);
    expect(blocks(posted[0]?.reply as CommandReply)).toEqual([
      ["**🎮 玩完「問答」**", "這場拿到:<@1> +30 <@2> +20", "每日任務:<@1> <@2> 各 +10"].join("\n"),
    ]);
  });
});

describe("goal notices", () => {
  async function goal(r: Rig, target = 50): Promise<string> {
    r.services.provide("test", GoalStoreKey, r.store.goals);
    const id = `g${target}`;
    await r.store.goals.create({
      id,
      profile: "p",
      title: "新麥克風",
      promise: "學三種貓叫",
      target,
      status: "open",
      created_at: toTimestamp(T0),
      deadline: toTimestamp(T0 + 3 * DAY),
      closed_at: null,
    });
    return id;
  }

  it("posts a card where the pledge that met the target was made", async () => {
    const r = await rig();
    const posted = sink(r);
    await fund(r, ALICE, 100);
    await fund(r, BOB, 100);
    const id = await goal(r);
    await r.economy.pledge(ALICE, id, 30, "a1", TEXT);
    expect(posted).toEqual([]);
    await r.economy.pledge(BOB, id, 40, "b1", TEXT);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.context).toEqual(TEXT);
    expect(blocks(posted[0]?.reply as CommandReply)).toEqual([
      "**🎯「新麥克風」湊滿了!**\n她答應的:學三種貓叫",
      "大家湊了 50 魚幣",
    ]);
    // She is still told, silently.
    expect(r.observed.some((o) => o.summary.includes("你答應過要:學三種貓叫"))).toBe(true);
  });

  it("posts nothing for a pledge made where there is no place to post", async () => {
    const r = await rig();
    const posted = sink(r);
    await fund(r, ALICE, 100);
    const id = await goal(r, 20);
    expect(await r.economy.pledge(ALICE, id, 20, "a1")).toMatchObject({ reached: true });
    expect(posted).toEqual([]);
  });
});
