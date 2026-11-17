// The framework: one game per voice channel, who plays, and every way a game ends, on fake
// timers. Nothing it does speaks: it only leaves notes for her.

import type { PartyRewardRequest, PartyRewards } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartyError } from "../src/game.js";
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
  VOICE,
  VOICE_CHAT,
} from "./helpers.js";

const QUESTIONS = [
  { question: "台灣最高的山?", answers: ["玉山"] },
  { question: "日本的首都?", answers: ["東京"] },
];

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
    table.start(VOICE, "quiz", { questions: QUESTIONS });
    expect(() => table.start(VOICE, "chain")).toThrow(PartyError);
    expect(() => table.start(VOICE, "chain")).toThrow(/已經在玩「問答」/);
    expect(table.session(VOICE)?.game.id).toBe("quiz");
  });

  it("runs games in two channels side by side, and only where she is", () => {
    const { table } = rig();
    expect(() => table.start(OTHER_VOICE, "quiz", { questions: QUESTIONS })).toThrow(
      /不在這個語音頻道/,
    );
    table.members(OTHER_VOICE, ROOM);
    table.start(VOICE, "quiz", { questions: QUESTIONS });
    table.start(OTHER_VOICE, "chain");
    expect(table.sessions().map((s) => s.game.id)).toEqual(["quiz", "chain"]);
  });

  it("takes the people in the channel as players, and whoever joins later", () => {
    const { table } = rig();
    const session = table.start(VOICE, "quiz", { questions: QUESTIONS });
    expect(session.players().map((p) => p.name)).toEqual(["你", "Amy", "Bob"]);
    table.members(VOICE, [...ROOM, member({ platform: "discord", id: "3" }, "Cat")]);
    expect(session.humans().map((p) => p.name)).toEqual(["Amy", "Bob", "Cat"]);
    // Her own account is never a player, even when it speaks or types.
    table.input(VOICE, { account: HER, name: "Miyo" }, "玉山");
    expect(session.humans().some((p) => p.key === "discord:100")).toBe(false);
  });

  it("hears the voice channel's text chat as the same game", () => {
    const { table, out } = rig();
    table.start(VOICE, "quiz", { questions: QUESTIONS }).game.next();
    table.input(VOICE_CHAT, amy, "玉山!");
    expect(out.last()?.summary).toContain("Amy 答對了第 1 題");
  });
});

describe("a clean end", () => {
  it("ends when someone says stop, and tells her", () => {
    const { table, out } = rig();
    table.start(VOICE, "quiz", { questions: QUESTIONS }).game.next();
    table.input(VOICE, bob, "好啦不玩了");
    expect(table.session(VOICE)).toBeNull();
    expect(out.ends.map((e) => e.reason)).toEqual(["stop"]);
    const end = out.last();
    expect(end?.speak).toBe(true);
    expect(end?.summary).toContain("「問答」結束了(有人說不玩了)");
    // The question still open is over: its answer may be said now.
    expect(end?.summary).toContain("最後一題的答案是「玉山」");
  });

  it("ends once everyone is gone for the grace period; a reconnect is not leaving", async () => {
    const { table, out, cfg } = rig();
    table.start(VOICE, "quiz", { questions: QUESTIONS });
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
    table.start(VOICE, "chain");
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
    table.start(VOICE, "quiz", { questions: QUESTIONS });
    table.left(VOICE);
    expect(table.session(VOICE)).toBeNull();
    expect(out.ends.map((e) => e.reason)).toEqual(["left"]);
    expect(out.last()?.speak).toBe(false);
    expect(() => table.start(VOICE, "quiz", { questions: QUESTIONS })).toThrow(/不在/);
  });

  it("ends every game when she is called away, and stops quietly on shutdown", async () => {
    const { table, out } = rig();
    table.members(OTHER_VOICE, ROOM);
    table.start(VOICE, "quiz", { questions: QUESTIONS });
    table.start(OTHER_VOICE, "chain");
    table.away();
    expect(table.sessions()).toEqual([]);
    expect(out.ends.map((e) => e.reason)).toEqual(["away", "away"]);
    const before = out.notes.length;
    table.start(VOICE, "chain");
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
    const session = table.start(VOICE, "quiz", { questions: QUESTIONS });
    session.note("x", "first");
    session.note("x", "again");
    expect(out.notes.map((n) => [n.key, n.revision])).toEqual([
      [`party:${session.id}:x`, 1],
      [`party:${session.id}:x`, 2],
    ]);
    expect(out.notes.every((n) => n.context === VOICE && n.game === "quiz")).toBe(true);
  });
});

describe("rewards", () => {
  async function playQuiz(rewards: Rewards | null, minPlayers = 2) {
    const r = rig({
      rewards: () => rewards,
      config: {
        rewards: { enabled: true, coins_per_point: 7, max_coins: 10, min_players: minPlayers },
      },
    });
    const game = r.table.start(VOICE, "quiz", { questions: QUESTIONS }).game;
    game.next();
    r.table.input(VOICE, amy, "玉山");
    game.next();
    r.table.input(VOICE, bob, "東京");
    await vi.advanceTimersByTimeAsync(0);
    return r;
  }

  it("pays the people who scored once the game is done, capped per person", async () => {
    const rewards = new Rewards();
    const { out } = await playQuiz(rewards);
    expect(rewards.requests).toHaveLength(1);
    const request = rewards.requests[0] as PartyRewardRequest;
    expect(request.game).toBe("quiz");
    expect(request.id).toMatch(/^party:/);
    expect(request.awards).toEqual([
      { account: AMY, name: "Amy", coins: 7 },
      { account: BOB, name: "Bob", coins: 7 },
    ]);
    expect(out.last()?.summary).toContain("魚幣發好了:Amy 7、Bob 7");
    expect(out.last()?.speak).toBe(false);
  });

  it("pays nobody who played alone, and is skipped without an economy or when it fails", async () => {
    const rewards = new Rewards();
    await playQuiz(rewards, 3);
    expect(rewards.requests).toEqual([]);
    const { out } = await playQuiz(null);
    expect(out.ends.map((e) => e.reason)).toEqual(["done"]);
    const failing = new Rewards();
    failing.fail = true;
    await expect(playQuiz(failing)).resolves.toBeDefined();
  });
});

describe("the snapshot for the panel", () => {
  it("lists running games with players and scores, and the games that ended, bounded", () => {
    const { table } = rig();
    expect(table.snapshot()).toEqual({ sessions: [], recent: [] });
    const session = table.start(VOICE, "quiz", { questions: QUESTIONS });
    session.game.next();
    table.input(VOICE, amy, "玉山");
    const live = table.snapshot();
    expect(live.sessions).toHaveLength(1);
    expect(live.sessions[0]).toMatchObject({
      game: "quiz",
      title: "問答",
      state: "running",
      scored: true,
    });
    expect(live.sessions[0]?.players.map((p) => [p.name, p.score])).toEqual([
      ["你", 0],
      ["Amy", 1],
      ["Bob", 0],
    ]);
    // Nothing the game keeps hidden is in it: no answers, no view.
    expect(JSON.stringify(live)).not.toContain("玉山");

    table.end(VOICE, "host");
    const after = table.snapshot();
    expect(after.sessions).toEqual([]);
    expect(after.recent).toHaveLength(1);
    expect(after.recent[0]).toMatchObject({ game: "quiz", reason: "host", scored: true });
    expect(after.recent[0]?.players[0]).toMatchObject({ name: "Amy", score: 1 });

    // A shutdown is not a result, and only the last twenty are kept.
    for (let i = 0; i < 25; i++) {
      table.start(VOICE, "chain");
      table.end(VOICE, "done");
    }
    expect(table.snapshot().recent).toHaveLength(20);
    table.start(VOICE, "chain");
    table.close();
    expect(table.snapshot().recent).toHaveLength(20);
    expect(table.snapshot().recent[0]?.reason).toBe("done");
  });
});
