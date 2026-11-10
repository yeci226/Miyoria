import { describe, expect, it } from "vitest";
import { make } from "./helpers.js";

const LINES = [
  "好的，我來看看這個要怎麼做，等我一下喔",
  "はい、ちょっと待ってね。今から見てみるよ",
  "Alright, give me a second, I'll take a look at that now.",
  "今天天氣真好，要不要一起去挖鑽石？我剛剛在地下找到一個很大的洞穴",
];

describe("speed", () => {
  it("screen() of a typical line is well under a millisecond", () => {
    const { moderation } = make();
    // Warm up the regex engine, then measure.
    for (let i = 0; i < 2_000; i++) moderation.screen({ path: "tts", voice: LINES[i % 4] });
    const n = 20_000;
    const started = performance.now();
    for (let i = 0; i < n; i++) {
      moderation.screen({ path: "tts", visible: LINES[i % 4], voice: LINES[(i + 1) % 4] });
    }
    const perLine = ((performance.now() - started) / n) * 1000;
    console.log(
      `screen(): ${perLine.toFixed(1)} us per call (visible + voice, ${LINES.length} typical lines)`,
    );
    expect(perLine).toBeLessThan(1_000);
  });

  it("a very long text stays bounded by the scan limit", () => {
    const { moderation } = make();
    const text = "好的，我來看看這個。".repeat(20_000);
    const started = performance.now();
    moderation.screen({ path: "reply", visible: text });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("hostile repetitive input does not make a rule backtrack for long", () => {
    const { moderation } = make();
    const nasty = [
      "小學生".repeat(3_000),
      `${"a ".repeat(5_000)}x`,
      "0".repeat(10_000),
      `${"1 ".repeat(5_000)}`,
      "(".repeat(5_000),
    ];
    for (const text of nasty) {
      const started = performance.now();
      moderation.screen({ path: "reply", visible: text, voice: text });
      moderation.inspect({ text, source: "chat", author: { id: "x", owner: false } });
      expect(performance.now() - started, text.slice(0, 10)).toBeLessThan(500);
    }
  });
});
