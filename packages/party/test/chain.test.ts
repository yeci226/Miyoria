// 接龍: word chains free for all (she plays too), and the story chain in turns.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartyError } from "../src/game.js";
import { amy, bob, rig, VOICE } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("idiom chain", () => {
  it("starts from an idiom and scores whoever continues first", () => {
    const { table, out } = rig();
    const session = table.start(VOICE, "chain");
    // `random` is 0: the first idiom.
    expect(session.opening).toContain("你先出「一心一意」,大家要接「意」開頭的成語");
    table.input(VOICE, amy, "嗯…意氣風發!");
    table.input(VOICE, bob, "意氣風發");
    expect(out.notes.at(-2)?.summary).toContain("Amy 接了「意氣風發」,下一個要接「發」");
    // Bob was a moment late: his is a repeat.
    expect(out.last()?.summary).toContain("Bob 說的「意氣風發」已經用過了");
    expect(session.standings()).toBe("Amy 1、你 0、Bob 0");
  });

  it("does not take four characters out of a sentence unless they are an idiom", () => {
    const { table, out } = rig();
    table.start(VOICE, "chain");
    table.input(VOICE, amy, "我覺得意思是說大家都很開心啦");
    expect(out.notes).toHaveLength(0);
    table.input(VOICE, amy, "意外驚喜");
    expect(out.last()?.summary).toContain("詞庫裡沒有");
  });

  it("asks her about a known idiom with the wrong first character", () => {
    const { table, out } = rig();
    const game = table.start(VOICE, "chain").game;
    table.input(VOICE, amy, "意氣風發");
    table.input(VOICE, bob, "法揚光大");
    // Not an idiom she knows and not starting with 發: nothing.
    expect(out.notes).toHaveLength(1);
    table.input(VOICE, bob, "大公無私");
    expect(out.last()?.summary).toContain("開頭不是「發」");
    expect(game.judge(true, null)).toContain("Bob 接了「大公無私」");
    expect(game.view().join("\n")).toContain("要接「私」");
  });

  it("takes back a word she rejects", () => {
    const { table } = rig();
    const session = table.start(VOICE, "chain");
    table.input(VOICE, amy, "意外驚喜");
    expect(session.game.judge(false, null)).toContain("收回 Amy 的「意外驚喜」,還是要接「意」");
    expect(session.standings()).toBe("你 0、Amy 0");
  });

  it("lets her play, but only by the rules", () => {
    const { table } = rig();
    const game = table.start(VOICE, "chain").game;
    expect(() => game.play("天長地久")).toThrow(/要用「意」開頭/);
    expect(game.play("意氣風發")).toContain("你 接了「意氣風發」");
    expect(game.hint()).toBe("例如「發揚光大」。");
  });

  it("breaks the chain when nobody continues, with a bonus for the last word", async () => {
    const { table, out, cfg } = rig();
    const session = table.start(VOICE, "chain", { rounds: 2 });
    table.input(VOICE, amy, "意氣風發");
    await vi.advanceTimersByTimeAsync(cfg.chain_idle_secs * 1000);
    expect(out.last()?.summary).toContain("這串斷在「意氣風發」。Amy 是最後接上的,多拿 2 分");
    expect(session.standings()).toBe("Amy 3、你 0");
    expect(() => session.game.play("發揚光大")).toThrow(PartyError);
    expect(session.game.next()).toContain("第 2 串");
    await vi.advanceTimersByTimeAsync(cfg.chain_idle_secs * 1000);
    // That was the last chain.
    expect(out.ends.map((e) => e.reason)).toEqual(["done"]);
  });
});

describe("word chain", () => {
  it("takes two-character words and ignores sighs", () => {
    const { table, out } = rig();
    table.start(VOICE, "chain", { mode: "word" });
    // `random` 0: 天空, so 空.
    table.input(VOICE, amy, "空啊");
    expect(out.notes).toHaveLength(0);
    table.input(VOICE, amy, "空氣");
    expect(out.last()?.summary).toContain("Amy 接了「空氣」,下一個要接「氣」");
  });
});

describe("story chain", () => {
  it("goes round in turns, her included, and ends with the whole story", async () => {
    const { table, out, cfg } = rig({ config: { story_max_lines: 4 } });
    const session = table.start(VOICE, "chain", { mode: "story" });
    const game = session.game;
    expect(game.scored).toBe(false);
    expect(game.play("從前從前有一隻貓。")).toContain("輪到 Amy 接下一句");
    // Not Bob's turn: just talk.
    table.input(VOICE, bob, "哈哈哈");
    expect(out.notes).toHaveLength(0);
    table.input(VOICE, amy, "牠很喜歡吃魚。");
    expect(out.last()?.summary).toContain("Amy 接了:「牠很喜歡吃魚。」。輪到 Bob");
    expect(out.last()?.untrusted).toBe(true);
    // Bob says nothing: skipped, back to her.
    await vi.advanceTimersByTimeAsync(cfg.story_turn_secs * 1000);
    expect(out.last()?.summary).toContain("Bob 沒接上,跳過。輪到你了");
    expect(() => table.input(VOICE, bob, "太遲了")).not.toThrow();
    expect(game.play("有一天牠遇到一條會說話的魚。")).toContain("輪到 Amy");
    expect(() => game.play("再一句")).toThrow(/輪到 Amy/);
    table.input(VOICE, amy, "魚說:不要吃我!");
    expect(table.session(VOICE)).toBeNull();
    expect(out.last()?.summary).toContain("整個故事:從前從前有一隻貓。牠很喜歡吃魚。");
  });

  it("sends a line back for the same person to say again", () => {
    const { table } = rig();
    const game = table.start(VOICE, "chain", { mode: "story" }).game;
    game.play("從前有座山。");
    table.input(VOICE, amy, "亂講一通");
    expect(game.judge(false, null)).toContain("退回 Amy 的那句,輪到 Amy");
    expect(game.view().join("\n")).not.toContain("亂講一通");
  });
});
