import type { ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  type Block,
  blockLifted,
  conditionOf,
  placeKey,
  related,
  SelfStarts,
  type Situation,
  similar,
} from "../src/selfstart.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-02T10:29:13.000Z");
const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
const KEY = placeKey(VOICE);

function ledger() {
  return new SelfStarts({
    self_start_gap_voice_secs: 300,
    self_start_gap_text_secs: 600,
    self_start_max_backoff: 8,
    stale_topic_mins: 45,
  });
}

describe("similar topics", () => {
  it("matches the same thing said again, not different topics", () => {
    expect(similar("那個 bypass 別找了", "你那個 bypass 找不到就先放著啦")).toBe(true);
    expect(similar("過來陪我玩麥塊", "今天晚餐吃什麼")).toBe(false);
    expect(similar("", "那個 bypass")).toBe(false);
    // An agenda item and the reason of the action that was for it.
    expect(related("過來陪我玩麥塊", "想去玩麥塊挖礦")).toBe(true);
    expect(related("問 Owen 報告的結果", "想玩麥塊")).toBe(false);
  });
});

describe("self-start backoff", () => {
  it("doubles the gap with every ignored self-start and resets after a real exchange", () => {
    const s = ledger();
    expect(s.wait(KEY, "voice", T0)).toEqual({ ms: 0, misses: 0 });
    s.started(KEY, "voice", VOICE, T0, "那個 bypass 別找了", "");
    // Within the base gap (5 minutes in voice).
    expect(s.wait(KEY, "voice", T0 + 31_000).ms).toBe(5 * MIN - 31_000);
    // Nobody addressed her within the window: ignored, the gap is 10 minutes now.
    expect(s.wait(KEY, "voice", T0 + 6 * MIN)).toEqual({ ms: 4 * MIN, misses: 1 });
    s.started(KEY, "voice", VOICE, T0 + 10 * MIN, "過來陪我玩麥塊", "");
    expect(s.wait(KEY, "voice", T0 + 16 * MIN)).toEqual({ ms: 14 * MIN, misses: 2 });
    s.started(KEY, "voice", VOICE, T0 + 30 * MIN, "大家在聊什麼", "");
    s.started(KEY, "voice", VOICE, T0 + 80 * MIN, "我回來了", "");
    // Capped at 8×.
    expect(s.gapMs(KEY, "voice", T0 + 200 * MIN)).toBe(40 * MIN);
    // Someone addresses her there: back to the base gap.
    s.started(KEY, "voice", VOICE, T0 + 200 * MIN, "有人在嗎", "");
    s.engaged(KEY, T0 + 201 * MIN);
    expect(s.wait(KEY, "voice", T0 + 210 * MIN)).toEqual({ ms: 0, misses: 0 });
    // Text has its own, longer base gap.
    expect(s.gapMs("discord:g1:c1", "text", T0)).toBe(10 * MIN);
  });

  it("lists ignored topics (not answered ones) and recognizes them said again", () => {
    const s = ledger();
    s.started(KEY, "voice", VOICE, T0, "那個 bypass 別找了", "叫他別再找 bypass");
    s.started(KEY, "voice", VOICE, T0 + 1000, "我好想吃拉麵", "");
    s.engaged(KEY, T0 + 2000);
    // Both were answered by that exchange: nothing is unanswered.
    expect(s.unanswered(KEY, T0 + 10 * MIN)).toEqual([]);
    s.started(KEY, "voice", VOICE, T0 + 20 * MIN, "過來陪我玩麥塊", "想找人玩");
    expect(s.unanswered(KEY, T0 + 22 * MIN)).toEqual([]); // still waiting
    expect(s.repeats(KEY, "我開麥塊游過去 過來陪我玩麥塊嘛", T0 + 22 * MIN)).toBe("過來陪我玩麥塊");
    expect(s.unanswered(null, T0 + 26 * MIN)).toEqual([
      expect.objectContaining({ text: "過來陪我玩麥塊", status: "ignored", context: VOICE }),
    ]);
    // Answered topics may come up again; stale ones are forgotten after `stale_topic_mins`.
    expect(s.repeats(KEY, "你那個 bypass 找不到就先放著啦", T0 + 26 * MIN)).toBeNull();
    expect(s.unanswered(KEY, T0 + 70 * MIN)).toEqual([]);
    expect(s.repeats(KEY, "過來陪我玩麥塊", T0 + 70 * MIN)).toBeNull();
  });
});

describe("blocks", () => {
  const situation = (over: Partial<Situation> = {}): Situation => ({
    game: null,
    gameSeenAt: null,
    voice: null,
    live: "|false",
    scene: null,
    streamers: "",
    ...over,
  });

  it("lifts a failed watch once the people streaming change or she moves", () => {
    const now = situation({ streamers: "discord:u1" });
    const b: Block = {
      capability: "watch.start",
      reason: "看不到",
      at: T0,
      condition: conditionOf("watch.start", now),
    };
    const retry = 30 * MIN;
    expect(blockLifted(b, now, T0 + MIN, retry)).toBe(false);
    expect(blockLifted(b, { ...now, game: "Minecraft" }, T0 + MIN, retry)).toBe(false);
    for (const streamers of ["discord:u1,discord:u2", "discord:u2", ""]) {
      expect(blockLifted(b, { ...now, streamers }, T0 + MIN, retry)).toBe(true);
    }
    expect(blockLifted(b, { ...now, voice: "discord:g1:voice:v2" }, T0 + MIN, retry)).toBe(true);
    expect(blockLifted(b, now, T0 + retry, retry)).toBe(true);
  });

  it("lifts a failed game action once the game shows up, or after the retry time", () => {
    const b: Block = {
      capability: "game.start",
      reason: "Minecraft 還沒開",
      at: T0,
      condition: conditionOf("game.start", situation()),
    };
    const retry = 30 * MIN;
    expect(blockLifted(b, situation(), T0 + MIN, retry)).toBe(false);
    expect(blockLifted(b, situation({ gameSeenAt: T0 - 1000 }), T0 + MIN, retry)).toBe(false);
    expect(blockLifted(b, situation({ gameSeenAt: T0 + 1000 }), T0 + MIN, retry)).toBe(true);
    expect(blockLifted(b, situation({ game: "Minecraft" }), T0 + MIN, retry)).toBe(true);
    expect(blockLifted(b, situation(), T0 + retry, retry)).toBe(true);
    // Something unrelated changing does not.
    expect(blockLifted(b, situation({ voice: "discord:g1:voice:v1" }), T0 + MIN, retry)).toBe(
      false,
    );
  });
});
