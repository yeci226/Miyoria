// 海龜湯: she hosts without the bottom. It goes to the referee with each question and reaches
// her (or any note) only once the soup is over.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOUP_PUZZLES } from "../src/content.js";
import { PartyError } from "../src/game.js";
import { parseVerdict } from "../src/judge.js";
import { FakeJudge, rig, VOICE } from "./helpers.js";

/** `random` is 0: the first puzzle. */
const PUZZLE = SOUP_PUZZLES[0] as (typeof SOUP_PUZZLES)[number];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("turtle soup", () => {
  it("needs a referee", () => {
    const { table } = rig();
    expect(() => table.start(VOICE, "soup")).toThrow(/沒有裁判/);
    expect(table.session(VOICE)).toBeNull();
  });

  it("gives her the surface and the referee's word, never the bottom while it is open", async () => {
    const judge = new FakeJudge();
    const { table, out } = rig({ judge: () => judge });
    const session = table.start(VOICE, "soup");
    expect(session.opening).toContain(PUZZLE.surface);
    expect(session.opening).not.toContain(PUZZLE.bottom);
    const game = session.game;
    expect(await game.ask("他是自殺的嗎?", session.find("Amy"))).toBe("裁判:是。");
    judge.verdict = "irrelevant";
    expect(await game.ask("跟天氣有關嗎?", null)).toBe("裁判:不重要(跟真相無關)。");
    expect(judge.cases[0]).toEqual({
      surface: PUZZLE.surface,
      bottom: PUZZLE.bottom,
      question: "他是自殺的嗎?",
    });
    expect(game.hint()).toBe(`提示:${PUZZLE.hints[0]}`);
    const seen = [session.opening, ...game.view(), out.text()].join("\n");
    expect(seen).not.toContain(PUZZLE.bottom);
    expect(game.view().join("\n")).toContain("「跟天氣有關嗎?」→ 不重要");
  });

  it("reveals the bottom once someone solves it, scores them, and ends", async () => {
    const judge = new FakeJudge();
    judge.verdict = "solved";
    const { table } = rig({ judge: () => judge });
    const session = table.start(VOICE, "soup");
    const answer = await session.game.ask("他喝過的是人肉", session.find("Bob"));
    expect(answer).toContain("猜中了!Bob 說出了真相");
    expect(answer).toContain(PUZZLE.bottom);
    expect(session.standings()).toBe("Bob 3、你 0");
    expect(table.session(VOICE)).toBeNull();
  });

  it("answers two guesses in flight once: the first solves it, the second is late", async () => {
    const judge = new FakeJudge();
    judge.verdict = null;
    const { table } = rig({ judge: () => judge });
    const session = table.start(VOICE, "soup");
    const first = session.game.ask("是人肉", session.find("Amy"));
    const second = session.game.ask("吃了同伴", session.find("Bob"));
    judge.answer("solved");
    expect(await first).toContain("Amy 說出了真相");
    judge.answer("solved");
    expect(await second).toBe("已經有人先猜中了。");
    expect(session.standings()).toBe("Amy 3、你 0");
  });

  it("asks for another wording when the referee fails", async () => {
    const judge = new FakeJudge();
    judge.verdict = null;
    const { table } = rig({ judge: () => judge });
    const game = table.start(VOICE, "soup").game;
    const asked = game.ask("他有家人嗎?", null);
    judge.fail();
    await expect(asked).rejects.toThrow(PartyError);
    await expect(game.ask("", null)).rejects.toThrow(/要把問題寫進來/);
  });

  it("gives the bottom when time is up, or when she gives up", async () => {
    const judge = new FakeJudge();
    const timed = rig({ judge: () => judge });
    timed.table.start(VOICE, "soup");
    await vi.advanceTimersByTimeAsync(timed.cfg.soup_mins * 60_000);
    const spoken = timed.out.spoken();
    expect(spoken.at(-1)?.summary).toContain(`湯底是:「${PUZZLE.bottom}」`);
    expect(timed.table.session(VOICE)).toBeNull();

    const quit = rig({ judge: () => judge });
    const game = quit.table.start(VOICE, "soup").game;
    expect(game.next()).toContain(PUZZLE.bottom);
    expect(() => game.play("我猜")).toThrow(PartyError);
  });

  it("reads only a verdict out of the referee's reply", () => {
    expect(parseVerdict('{"verdict": "no"}')).toBe("no");
    expect(parseVerdict("close")).toBe("close");
    expect(parseVerdict("湯底是…")).toBeNull();
  });
});
