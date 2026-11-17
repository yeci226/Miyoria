// 問答 and 猜歌: the hidden answer stays with the program until the round is over, the first
// right answer scores, near misses wait for her ruling, time runs out on fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUIZ_QUESTIONS } from "../src/content.js";
import { PartyError } from "../src/game.js";
import { bareTitle } from "../src/games/song.js";
import { amy, bob, FakeClips, rig, VOICE } from "./helpers.js";

const QUESTIONS = [
  { question: "台灣最高的山?", answers: ["玉山"] },
  { question: "周杰倫哪首歌在講下雨天?", answers: ["晴天"] },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("quiz", () => {
  it("scores the first right answer only, even when two arrive together", () => {
    const { table, out } = rig();
    const session = table.start(VOICE, "quiz", { questions: QUESTIONS });
    expect(session.opening).toContain("一共 2 題");
    expect(session.game.next()).toContain("第 1/2 題:「台灣最高的山?」");
    table.input(VOICE, amy, "是玉山");
    table.input(VOICE, bob, "玉山!");
    expect(session.standings()).toBe("Amy 1、你 0");
    const won = out.spoken();
    expect(won).toHaveLength(1);
    expect(won[0]?.summary).toContain("Amy 答對了第 1 題,答案是「玉山」");
    expect(won[0]?.key).toBe(`party:${session.id}:q1:won`);
  });

  it("lets her rule on a near miss without telling her the answer", () => {
    const { table, out } = rig();
    const game = table.start(VOICE, "quiz", { questions: QUESTIONS }).game;
    game.next();
    game.next();
    // One character of two wrong is not a hit: that is hers to rule on.
    table.input(VOICE, bob, "情天");
    expect(out.notes.at(-1)?.summary).toContain("Bob 說「情天」,跟答案差 1 個字(答案 2 個字)");
    expect(out.text()).not.toContain("晴天");
    // Said again: no second note for the same person in the same round.
    table.input(VOICE, bob, "情天啦");
    const near = out.notes.filter((n) => n.key.includes(":near:"));
    expect(near).toHaveLength(1);
    expect(near[0]?.untrusted).toBe(true);
    expect(game.view().join("\n")).toContain("等你判定:Bob");
    expect(game.judge(true, null)).toContain("算 Bob 答對了第 2 題,答案是「晴天」");
    // That was the last question: the game is over.
    expect(table.session(VOICE)).toBeNull();
  });

  it("gives the answer when time is up, and ends after the last question", async () => {
    const { table, out, cfg } = rig();
    const game = table.start(VOICE, "quiz", { questions: QUESTIONS }).game;
    game.next();
    await vi.advanceTimersByTimeAsync(cfg.quiz_answer_secs * 1000);
    expect(out.last()?.summary).toContain("第 1 題時間到,沒人答對,答案是「玉山」");
    expect(out.last()?.speak).toBe(true);
    // An answer after the time is up is nothing.
    table.input(VOICE, amy, "玉山");
    expect(table.session(VOICE)?.standings()).toBe("你 0");
    game.next();
    await vi.advanceTimersByTimeAsync(cfg.quiz_answer_secs * 1000);
    expect(table.session(VOICE)).toBeNull();
    expect(out.ends.map((e) => e.reason)).toEqual(["done"]);
  });

  it("never shows her the answer of the open question, and lets her guess the built-in ones", () => {
    const { table } = rig();
    const game = table.start(VOICE, "quiz", { rounds: 3 }).game;
    const asked = game.next();
    const q = QUIZ_QUESTIONS.find((x) => asked.includes(x.question));
    if (!q) throw new Error("question not from the bank");
    const answer = q.answers[0] as string;
    expect(game.view().join("\n")).not.toContain(answer);
    expect(game.hint()).toMatch(/答案是/);
    expect(game.play("不知道")).toBe("不對。");
    expect(game.play(answer)).toContain("你答對了!");
    expect(() => game.play(answer)).toThrow(PartyError);
    expect(game.view().join("\n")).toContain(answer);
  });

  it("does not let her answer questions she wrote", () => {
    const { table } = rig();
    const game = table.start(VOICE, "quiz", { questions: QUESTIONS }).game;
    game.next();
    expect(() => game.play("玉山")).toThrow(/你知道答案/);
    expect(game.view().join("\n")).toContain("答案:玉山");
  });

  it("gives hints from the length to the first characters, then no more", () => {
    const { table } = rig();
    const game = table.start(VOICE, "quiz", {
      questions: [{ question: "?", answers: ["哈姆雷特"] }],
    }).game;
    game.next();
    expect([game.hint(), game.hint(), game.hint(), game.hint()]).toEqual([
      "答案是 4 個字",
      "第一個字是「哈」",
      "前兩個字是「哈姆」",
      "沒有更多提示了。",
    ]);
  });
});

describe("song guessing", () => {
  const SONGS = [
    { id: "s1", title: "晴天 (Live)", artist: "周杰倫" },
    { id: "s2", title: "小幸運", artist: null, aliases: ["小幸运"] },
  ];

  it("needs songs to play", () => {
    const { table } = rig();
    expect(() => table.start(VOICE, "song")).toThrow(/沒有歌可以放/);
    const empty = rig({ clips: () => new FakeClips([]) });
    expect(() => empty.table.start(VOICE, "song")).toThrow(PartyError);
  });

  it("plays a clip in her channel and takes the title as people say it", async () => {
    const clips = new FakeClips(SONGS);
    const { table, out, cfg } = rig({ clips: () => clips });
    const game = table.start(VOICE, "song").game;
    expect(game.next()).toContain("片段開始放了");
    expect(clips.played).toHaveLength(1);
    expect(clips.played[0]?.durationMs).toBe(cfg.clip_secs * 1000);
    expect(clips.played[0]?.context).toBe(VOICE);
    const id = clips.played[0]?.id;
    const song = SONGS.find((s) => s.id === id);
    if (!song) throw new Error("unknown song");
    // Her view says a clip plays, never which.
    expect(game.view().join("\n")).not.toContain(bareTitle(song.title));
    if (song.artist) {
      table.input(VOICE, bob, song.artist);
      expect(out.last()?.summary).toContain("猜到歌手");
    }
    table.input(VOICE, amy, `是${bareTitle(song.title)}吧`);
    expect(out.last()?.summary).toContain(`Amy 猜對了第 1 首`);
    await vi.advanceTimersByTimeAsync(0);
    // The clip stops once someone got it.
    expect(game.view().join("\n")).toContain("已經結束");
  });

  it("starts the clip where the song says it is worth guessing, else at the start", () => {
    const clips = new FakeClips([
      { id: "a", title: "甲", artist: null, clipStartMs: 12_000 },
      { id: "b", title: "乙", artist: null },
    ]);
    const { table } = rig({ clips: () => clips });
    const game = table.start(VOICE, "song", { rounds: 2 }).game;
    game.next();
    game.next();
    const starts = new Map(clips.played.map((p) => [p.id, p.startMs]));
    expect(starts.get("a")).toBe(12_000);
    expect(starts.get("b")).toBe(0);
  });

  it("tells her when a clip cannot play", async () => {
    const clips = new FakeClips(SONGS);
    const { table, out } = rig({ clips: () => clips });
    table.start(VOICE, "song").game.next();
    clips.end("failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(out.last()?.summary).toContain("片段放不出來");
  });

  it("strips what is not the title", () => {
    expect(bareTitle("晴天 (Live)")).toBe("晴天");
    expect(bareTitle("【官方MV】小幸運")).toBe("小幸運");
  });
});
