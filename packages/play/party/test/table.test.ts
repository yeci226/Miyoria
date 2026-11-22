// The framework: one game per voice channel, who plays, and every way a game ends, on fake
// timers. Nothing it does speaks: it only leaves notes for her.

import type { PartyRewardRequest, PartyRewards } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GameId, PartyError } from "../src/game.js";
import {
  AMY,
  amy,
  BOB,
  bob,
  HER,
  member,
  OTHER_VOICE,
  ROOM,
  rig,
  TEXT,
  VOICE,
  VOICE_CHAT,
} from "./helpers.js";

class Rewards implements PartyRewards {
  readonly requests: PartyRewardRequest[] = [];
  fail = false;
  async award(request: PartyRewardRequest): Promise<void> {
    if (this.fail) throw new Error("economy is down");
    this.requests.push(request);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("one game per channel", () => {
  it("refuses a second game where one runs, whoever asked first wins", () => {
    const { table } = rig();
    table.start(VOICE, "song");
    expect(() => table.start(VOICE, "soup")).toThrow(PartyError);
    expect(() => table.start(VOICE, "soup")).toThrow(/已經在玩「猜歌」/);
    expect(table.session(VOICE)?.game.id).toBe("song");
  });

  it("runs games in two channels side by side, and only where she is", () => {
    const { table } = rig();
    expect(() => table.start(OTHER_VOICE, "song")).toThrow(/不在這個語音頻道/);
    table.members(OTHER_VOICE, ROOM);
    table.start(VOICE, "song");
    table.start(OTHER_VOICE, "soup");
    expect(table.sessions().map((s) => s.game.id)).toEqual(["song", "soup"]);
  });

  it("takes the people in the channel as players, and whoever joins later", () => {
    const { table } = rig();
    const session = table.start(VOICE, "song");
    expect(session.players().map((p) => p.name)).toEqual(["你", "Amy", "Bob"]);
    table.members(VOICE, [...ROOM, member({ platform: "discord", id: "3" }, "Cat")]);
    expect(session.humans().map((p) => p.name)).toEqual(["Amy", "Bob", "Cat"]);
    // Her own account is never a player, even when it speaks or types.
    table.input(VOICE, { account: HER, name: "Miyo" }, "晴天");
    expect(session.humans().some((p) => p.key === "discord:100")).toBe(false);
  });

  it("hears the voice channel's text chat as the same game", () => {
    const { table, out, clips } = rig();
    table.start(VOICE, "song").game.next();
    table.input(VOICE_CHAT, amy, `${clips.current()}!`);
    expect(out.last()?.summary).toContain("Amy 猜對了第 1 首");
  });
});

describe("a clean end", () => {
  it("ends when someone says stop, and tells her", () => {
    const { table, out, clips } = rig();
    table.start(VOICE, "song").game.next();
    table.input(VOICE, bob, "好啦不玩了");
    expect(table.session(VOICE)).toBeNull();
    expect(out.ends.map((e) => e.reason)).toEqual(["stop"]);
    const end = out.last();
    expect(end?.speak).toBe(true);
    expect(end?.summary).toContain("「猜歌」結束了(有人說不玩了)");
    // The song still open is over: its title may be said now.
    expect(end?.summary).toContain(`最後一首是「${clips.current()}」`);
  });

  it("ends once everyone is gone for the grace period; a reconnect is not leaving", async () => {
    const { table, out, cfg } = rig();
    table.start(VOICE, "song");
    const alone = [member(HER, "Miyo", true)];
    table.members(VOICE, alone);
    await vi.advanceTimersByTimeAsync(cfg.empty_grace_secs * 1000 - 1000);
    table.members(VOICE, ROOM);
    await vi.advanceTimersByTimeAsync(cfg.empty_grace_secs * 1000);
    expect(table.session(VOICE)).not.toBeNull();
    table.members(VOICE, alone);
    await vi.advanceTimersByTimeAsync(cfg.empty_grace_secs * 1000);
    expect(table.session(VOICE)).toBeNull();
    expect(out.ends.map((e) => e.reason)).toEqual(["empty"]);
    // Nobody is there to hear about it.
    expect(out.last()?.speak).toBe(false);
  });

  it("ends when nothing happens for a while; anything someone says keeps it going", async () => {
    const { table, out, cfg } = rig();
    table.start(VOICE, "soup");
    await vi.advanceTimersByTimeAsync(cfg.idle_mins * 60_000 - 1000);
    table.input(VOICE, amy, "今天好熱");
    await vi.advanceTimersByTimeAsync(cfg.idle_mins * 60_000 - 1000);
    expect(table.session(VOICE)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(table.session(VOICE)).toBeNull();
    expect(out.ends.map((e) => e.reason)).toEqual(["idle"]);
  });

  it("ends without a word when she leaves the channel", () => {
    const { table, out } = rig();
    table.start(VOICE, "song");
    table.left(VOICE);
    expect(table.session(VOICE)).toBeNull();
    expect(out.ends.map((e) => e.reason)).toEqual(["left"]);
    expect(out.last()?.speak).toBe(false);
    expect(() => table.start(VOICE, "song")).toThrow(/不在/);
  });

  it("ends every game when she is called away, and stops quietly on shutdown", async () => {
    const { table, out } = rig();
    table.members(OTHER_VOICE, ROOM);
    table.start(VOICE, "song");
    table.start(OTHER_VOICE, "soup");
    table.away();
    expect(table.sessions()).toEqual([]);
    expect(out.ends.map((e) => e.reason)).toEqual(["away", "away"]);
    const before = out.notes.length;
    table.start(VOICE, "soup");
    table.close();
    expect(table.sessions()).toEqual([]);
    // No end note on the way down, and no timer of it fires later.
    expect(out.notes.length).toBe(before);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(out.notes.length).toBe(before);
  });
});

describe("notes", () => {
  it("carry a stable key per thing, and a revision when the same thing comes again", () => {
    const { table, out } = rig();
    const session = table.start(VOICE, "song");
    session.note("x", "first");
    session.note("x", "again");
    expect(out.notes.map((n) => [n.key, n.revision])).toEqual([
      [`party:${session.id}:x`, 1],
      [`party:${session.id}:x`, 2],
    ]);
    expect(out.notes.every((n) => n.context === VOICE && n.game === "song")).toBe(true);
  });
});

describe("rewards", () => {
  async function playSongs(rewards: Rewards | null, minPlayers = 2, currency?: string) {
    const r = rig({
      rewards: () => rewards,
      ...(currency === undefined ? {} : { currency: () => currency }),
      config: {
        rewards: { enabled: true, coins_per_point: 7, max_coins: 10, min_players: minPlayers },
      },
    });
    const game = r.table.start(VOICE, "song", { rounds: 2 }).game;
    game.next();
    r.table.input(VOICE, amy, r.clips.current());
    game.next();
    r.table.input(VOICE, bob, r.clips.current());
    await vi.advanceTimersByTimeAsync(0);
    return r;
  }

  it("pays the people who scored once the game is done, capped per person", async () => {
    const rewards = new Rewards();
    const { out } = await playSongs(rewards);
    expect(rewards.requests).toHaveLength(1);
    const request = rewards.requests[0] as PartyRewardRequest;
    expect(request.game).toBe("song");
    expect(request.id).toMatch(/^party:/);
    expect(request.awards).toEqual([
      { account: AMY, name: "Amy", coins: 7 },
      { account: BOB, name: "Bob", coins: 7 },
    ]);
    expect(out.last()?.summary).toContain("魚幣發好了:Amy 7、Bob 7");
    expect(out.last()?.speak).toBe(false);
  });

  it("names the profile's coins in her note", async () => {
    const { out } = await playSongs(new Rewards(), 2, "貝殼");
    expect(out.last()?.summary).toContain("的貝殼發好了:Amy 7、Bob 7");
    expect(out.last()?.summary).not.toContain("魚幣");
  });

  it("pays nobody who played alone, and is skipped without an economy or when it fails", async () => {
    const rewards = new Rewards();
    await playSongs(rewards, 3);
    expect(rewards.requests).toEqual([]);
    const { out } = await playSongs(null);
    expect(out.ends.map((e) => e.reason)).toEqual(["done"]);
    const failing = new Rewards();
    failing.fail = true;
    await expect(playSongs(failing)).resolves.toBeDefined();
  });
});

describe("the snapshot for the panel", () => {
  it("lists running games with players and scores, and the games that ended, bounded", () => {
    const { table, clips } = rig();
    expect(table.snapshot()).toEqual({ sessions: [], recent: [] });
    const session = table.start(VOICE, "song");
    session.game.next();
    const title = clips.current();
    table.input(VOICE, amy, title);
    const live = table.snapshot();
    expect(live.sessions).toHaveLength(1);
    expect(live.sessions[0]).toMatchObject({
      game: "song",
      title: "猜歌",
      state: "running",
      scored: true,
    });
    expect(live.sessions[0]?.players.map((p) => [p.name, p.score])).toEqual([
      ["你", 0],
      ["Amy", 1],
      ["Bob", 0],
    ]);
    // Nothing the game keeps hidden is in it: no answers, no view.
    expect(JSON.stringify(live)).not.toContain(title);

    table.end(VOICE, "host");
    const after = table.snapshot();
    expect(after.sessions).toEqual([]);
    expect(after.recent).toHaveLength(1);
    expect(after.recent[0]).toMatchObject({ game: "song", reason: "host", scored: true });
    expect(after.recent[0]?.players[0]).toMatchObject({ name: "Amy", score: 1 });

    // A shutdown is not a result, and only the last twenty are kept.
    for (let i = 0; i < 25; i++) {
      table.start(VOICE, "soup");
      table.end(VOICE, "done");
    }
    expect(table.snapshot().recent).toHaveLength(20);
    table.start(VOICE, "soup");
    table.close();
    expect(table.snapshot().recent).toHaveLength(20);
    expect(table.snapshot().recent[0]?.reason).toBe("done");
  });
});

describe("games that are gone", () => {
  it("refuses a quiz or a chain as a game, and leaves nothing running", () => {
    const { table } = rig();
    for (const gone of ["quiz", "chain"]) {
      const start = () => table.start(VOICE, gone as GameId);
      expect(start).toThrow(PartyError);
      expect(start).toThrow(new RegExp(`沒有「${gone}」這個遊戲。現在只有「海龜湯」`));
    }
    expect(table.sessions()).toEqual([]);
    // The same in a text channel, where the kind check would say something else.
    expect(() => table.start(TEXT, "quiz" as GameId)).toThrow(/沒有「quiz」這個遊戲/);
    expect(table.sessions()).toEqual([]);
  });
});

describe("turtle soup in a text channel", () => {
  it("starts in the channel without a voice channel, and hears the people typing there", () => {
    const { table, out } = rig();
    const session = table.start(TEXT, "soup");
    expect(session.opening).toContain("貼在頻道裡");
    expect(session.opening).not.toContain("念給大家聽");
    expect(table.session(TEXT)).toBe(session);
    // Not a voice game: the voice channel is free, and other channels know nothing of it.
    expect(table.session(VOICE)).toBeNull();
    expect(table.session({ ...TEXT, channel: "t2" })).toBeNull();
    // Nobody is a player until they write; then they are.
    expect(session.humans()).toEqual([]);
    table.input(TEXT, amy, "他是自殺的嗎?");
    expect(session.humans().map((p) => p.name)).toEqual(["Amy"]);
    expect(out.notes.every((n) => n.context === TEXT && n.game === "soup")).toBe(true);
  });

  it("plays beside a voice game, and a voice channel and its own chat are one channel", () => {
    const { table } = rig();
    table.start(TEXT, "soup");
    table.start(VOICE, "song");
    expect(table.sessions().map((s) => s.game.id)).toEqual(["soup", "song"]);
    // The voice channel's text chat has the song game, not a second one.
    expect(table.session(VOICE_CHAT)?.game.id).toBe("song");
    expect(() => table.start(VOICE_CHAT, "soup")).toThrow(/已經在玩「猜歌」/);
    const other = rig();
    other.table.start(VOICE_CHAT, "soup");
    expect(() => other.table.start(VOICE, "song")).toThrow(/已經在玩「海龜湯」/);
    expect(() => other.table.start(TEXT, "soup")).not.toThrow();
  });

  it("is only for turtle soup, and only in a server's channel", () => {
    const { table } = rig();
    expect(() => table.start(TEXT, "song")).toThrow(/猜歌要在語音頻道玩/);
    expect(() => table.start({ ...TEXT, scope: null }, "soup")).toThrow(/私訊/);
    expect(table.sessions()).toEqual([]);
  });

  it("asks the referee, pays the one who solved it, and tells the heart who played", async () => {
    const rewards = new Rewards();
    const { table, out, judge } = rig({
      rewards: () => rewards,
      config: { rewards: { enabled: true, coins_per_point: 5, max_coins: 20, min_players: 1 } },
    });
    const session = table.start(TEXT, "soup");
    table.input(TEXT, amy, "他是自殺的嗎?");
    table.input(TEXT, bob, "跟天氣有關嗎?");
    expect(await session.game.ask("他是自殺的嗎?", session.find("Amy"))).toBe("裁判:是。");
    judge.verdict = "solved";
    expect(await session.game.ask("他吃了同伴", session.find("Bob"))).toContain("Bob 說出了真相");
    expect(table.session(TEXT)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    // Both asked a question the referee answered, so both played (the heart's evidence).
    expect(out.ends[0]?.players.map((p) => p.name)).toEqual(["Amy", "Bob"]);
    expect(out.ends[0]?.context).toEqual(TEXT);
    expect(rewards.requests[0]?.awards).toEqual([{ account: BOB, name: "Bob", coins: 15 }]);
    expect(rewards.requests[0]?.context).toEqual(TEXT);
  });

  it("ends like any game: stop, idle, called away; her leaving voice does not end it", async () => {
    const { table, out, cfg } = rig();
    table.start(TEXT, "soup");
    table.left(VOICE);
    expect(table.session(TEXT)).not.toBeNull();
    table.input(TEXT, amy, "不玩了");
    expect(out.ends.map((e) => e.reason)).toEqual(["stop"]);

    table.start(TEXT, "soup");
    await vi.advanceTimersByTimeAsync(cfg.idle_mins * 60_000 + 1000);
    expect(out.ends.map((e) => e.reason)).toEqual(["stop", "idle"]);

    table.start(TEXT, "soup");
    table.away();
    expect(out.ends.map((e) => e.reason)).toEqual(["stop", "idle", "away"]);
  });
});
