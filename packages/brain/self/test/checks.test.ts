// The six output checks the runner keeps (`[modules.agent.corrections]`): each one is on by
// default and each can be switched off alone, taking only that check out.

import { describe, expect, it } from "vitest";
import { AgentConfigSchema, ExpressionParser, FALLBACK_LINES } from "../../agent/src/index.js";
import { ALL_CHECKS, type OutputChecks, StepText } from "../src/screens.js";
import { rig, say } from "./harness.js";

const PLAN = "回覆要短，一兩句到三句。且正在唱歌。";
const SELF_TALK = "莎露朵在問我上面訊息寫什麼,直接念給她聽就好。";
const THINK = "<emo:thinking>話題跟我沒關係，一句收。</emo:thinking>好啊";

const off = (key: keyof OutputChecks): OutputChecks => ({ ...ALL_CHECKS, [key]: false });

/** Everything a text step (one line at a time) lets out of `raw`. */
function lines(raw: string, checks: OutputChecks, unit: "line" | "sentence" = "line"): string[] {
  const screen = new StepText(unit, checks);
  return [...screen.push(raw), ...screen.finish()].map((l) => l.text);
}

describe("the output checks", () => {
  it("are all on unless the config says otherwise", () => {
    const parsed = AgentConfigSchema.parse({}).corrections;
    expect(parsed).toEqual({
      leak_screen: true,
      leak_screen_spoken: true,
      thinking_block: true,
      fallback_line: true,
      tag_strip: true,
      self_talk: true,
    });
    expect(Object.values(ALL_CHECKS)).toEqual([true, true, true, true, true, true]);
  });

  it("#9 leak screen: a reply that is her reasoning is dropped, or kept with the switch off", () => {
    const raw = `${PLAN}\n可以說：「嗯，過關了。」加一點得意。\n`;
    expect(lines(raw, ALL_CHECKS)).toEqual([]);
    expect(lines(raw, off("leakScreen")).join("\n")).toContain("回覆要短");
  });

  it("#10 spoken leak: a sentence that is her reasoning is not said, or is with the switch off", () => {
    const sentence = "回覆要短，一兩句到三句。";
    expect(lines(sentence, ALL_CHECKS, "sentence")).toEqual([]);
    expect(lines(sentence, off("leakScreenSpoken"), "sentence").join("")).toContain("回覆要短");
    // The text screen (#9) is not the spoken one: switching one off leaves the other.
    expect(lines(sentence, off("leakScreen"), "sentence")).toEqual([]);
  });

  it("#11 thinking block: what is inside is never shown, or shown with the switch off", () => {
    expect(lines(THINK, ALL_CHECKS).join("")).toBe("好啊");
    expect(lines(THINK, off("thinkingBlock")).join("")).toContain("話題跟我沒關係");
    const on = new ExpressionParser();
    const text = (p: ExpressionParser) =>
      [...p.push(THINK), ...p.finish()].flatMap((s) => (s.type === "text" ? [s.text] : []));
    expect(text(on).join("")).toBe("好啊");
    expect(text(new ExpressionParser({ thinkingBlock: false })).join("")).toContain(
      "話題跟我沒關係",
    );
  });

  it("#18 tag strip: tools written as tags are taken out, or left with the switch off", () => {
    const raw = "好喔<sing_start>等一下\n";
    const on = new StepText("line", ALL_CHECKS);
    expect([...on.push(raw), ...on.finish()].map((l) => l.text).join("")).not.toContain(
      "<sing_start>",
    );
    expect(on.tagsStripped).toBe(1);
    const kept = new StepText("line", off("tagStrip"));
    expect([...kept.push(raw), ...kept.finish()].map((l) => l.text).join("")).toContain(
      "<sing_start>",
    );
    expect(kept.tagsStripped).toBe(0);
  });

  it("#19 self-talk: a note to herself is left out, or sent with the switch off", () => {
    const raw = `${SELF_TALK}\n好，我念給你聽。\n`;
    const on = new StepText("line", ALL_CHECKS);
    const out = [...on.push(raw), ...on.finish()].map((l) => l.text);
    expect(out.join("")).not.toContain("直接念給她聽");
    expect(out.join("")).toContain("我念給你聽");
    expect(on.selfTalkCut).toBe(1);
    expect(lines(raw, off("selfTalk")).join("")).toContain("直接念給她聽");
    // Spoken: the same check, per sentence.
    expect(lines(SELF_TALK, ALL_CHECKS, "sentence")).toEqual([]);
    expect(lines(SELF_TALK, off("selfTalk"), "sentence").join("")).toContain("直接念給她聽");
  });

  it("#15 fixed line: someone left waiting gets it, or nothing with the switch off", async () => {
    const waiting = await rig([say("")]);
    waiting.line("Owen", "@她 在嗎");
    await waiting.run();
    expect(waiting.outlet.texts()).toEqual([FALLBACK_LINES[0]]);

    const quiet = await rig([say("")], {
      runner: { compaction: null, checks: { fallbackLine: false } },
    });
    quiet.line("Owen", "@她 在嗎");
    const result = await quiet.run();
    expect(result.outcome).not.toBe("failed");
    expect(quiet.outlet.texts()).toEqual([]);

    const failing = await rig([new Error("provider down")], {
      runner: { compaction: null, checks: { fallbackLine: false } },
    });
    failing.line("Owen", "@她 在嗎");
    await failing.run();
    expect(failing.outlet.texts()).toEqual([]);
  });
});
