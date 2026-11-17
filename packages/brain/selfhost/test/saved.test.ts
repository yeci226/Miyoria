// What the panel's prompt page reads: the prompt of each run (text and voice), kept by the host
// as the old turn kept it, with the same retention.

import { defineTool } from "@miyoria/llm/tools";
import { sleep } from "@miyoria/runtime/kernel";
import {
  type ContextKey,
  Events,
  type SavedPrompt,
  type TurnOutcomeRecord,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SavedPromptsKey } from "../../agent/src/index.js";
import { account, calls, dm, line, Rig, says, stopRigs, textOf, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const DM = dm("dm-owen");
const VC: ContextKey = { platform: "test", scope: "guild", channel: "vc", kind: "voice" };

const outcomes = (rig: Rig) => rig.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);
const archive = (rig: Rig) => {
  const saved = rig.sup.services.get(SavedPromptsKey);
  if (saved === undefined) throw new Error("no prompt archive");
  return saved;
};

/** The text of the last message with `role`. */
function last(prompt: SavedPrompt, role: string): string {
  return prompt.messages.findLast((m) => m.role === role)?.text ?? "";
}

describe("the prompt of a text run", () => {
  it("is kept for its turn: the messages as sent, the context, the time and the tokens", async () => {
    const rig = await Rig.create();
    rig.model.push(says("嗨 Owen"));
    rig.say(line(DM, "owen", "在嗎,想問你昨天的事"));
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    const turn = outcomes(rig)[0]?.turn ?? "";
    const prompt = archive(rig).get(turn);
    expect(prompt).not.toBeNull();
    if (prompt === null) return;
    expect(prompt).toMatchObject({
      turn,
      context: DM,
      purpose: "chat",
      reasoning: "off",
      // The provider's count (the scripted model reports 100).
      prompt_tokens: 100,
      blocks: [],
    });
    expect(Number.isNaN(Date.parse(prompt.at))).toBe(false);
    expect(last(prompt, "user")).toContain("在嗎,想問你昨天的事");
    // What was sent, role by role (tool results are not kept, as before).
    const sent = rig.model.requests[0]?.messages ?? [];
    expect(prompt.messages.map((m) => m.role)).toEqual(
      sent.filter((m) => m.role !== "tool").map((m) => m.role),
    );
    expect(prompt.messages.map((m) => m.role).every((r) => r !== ("tool" as string))).toBe(true);
    // The panel's list and the bus event see it too.
    expect(
      archive(rig)
        .recent(DM, 5)
        .map((p) => p.turn),
    ).toEqual([turn]);
    expect(rig.of<SavedPrompt>(Events.AgentPrompt.type).map((p) => p.turn)).toEqual([turn]);
  });

  it("is the run's first call only, once, when she calls tools", async () => {
    const search = defineTool({
      name: "web_search",
      description: "搜尋。",
      parameters: z.object({ q: z.string().optional() }),
      effect: "read",
      speed: "instant",
      risk: "low",
      group: "test",
      core: true,
      next: true,
      readOnly: true,
      call: async () => "三個結果",
    });
    const rig = await Rig.create({ provide: (_sup, tools) => tools.register(search) });
    rig.model.push(calls("web_search", { q: "鯨魚" }), says("查到了"));
    rig.say(line(DM, "owen", "幫我查鯨魚"));
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(rig.model.requests).toHaveLength(2);
    const turn = outcomes(rig)[0]?.turn ?? "";
    const all = archive(rig).recent(null, 10);
    expect(all.map((p) => p.turn)).toEqual([turn]);
    expect(textOf(rig.model.requests[1])).toContain("三個結果");
    expect(all[0]?.messages.some((m) => m.text.includes("三個結果"))).toBe(false);
    expect(last(all[0] as SavedPrompt, "user")).toContain("幫我查鯨魚");
  });

  it("keeps the newest `saved` runs, every `save_every`-th", async () => {
    const rig = await Rig.create({ config: { prompt: { saved: 2 } } });
    const turns: string[] = [];
    for (const text of ["一", "二", "三"]) {
      rig.model.push(says(`回${text}`));
      rig.say(line(DM, "owen", `第${text}句`));
      await until(() => outcomes(rig).length === turns.length + 1, 3_000, `outcome ${text}`);
      turns.push(outcomes(rig)[turns.length]?.turn ?? "");
    }
    expect(archive(rig).get(turns[0] ?? "")).toBeNull();
    expect(
      archive(rig)
        .recent(null, 10)
        .map((p) => p.turn),
    ).toEqual([turns[2], turns[1]]);

    const sparse = await Rig.create({ config: { prompt: { save_every: 2 } } });
    const seen: string[] = [];
    for (const text of ["一", "二", "三"]) {
      sparse.model.push(says(`回${text}`));
      sparse.say(line(DM, "owen", `第${text}句`));
      await until(() => outcomes(sparse).length === seen.length + 1, 3_000, `outcome ${text}`);
      seen.push(outcomes(sparse)[seen.length]?.turn ?? "");
    }
    expect(
      archive(sparse)
        .recent(null, 10)
        .map((p) => p.turn),
    ).toEqual([seen[2], seen[0]]);
  });
});

describe("the prompt of a voice run", () => {
  it("is kept with the voice note and the utterance it answers", async () => {
    const rig = await Rig.create({
      config: { voice: { default_mode: "normal", debounce_ms: 100, direct_debounce_ms: 60 } },
    });
    const member = (id: string, self = false): VoiceParticipant => ({
      account: account(id),
      display_name: id,
      is_self: self,
      muted: false,
      deafened: false,
    });
    rig.sup.bus.publish("voice.test", Events.VoiceJoined, {
      context: VC,
      participants: [member("owen"), member("her", true)],
    });
    await sleep(20);
    rig.model.push(says("在喔!"));
    const now = Date.now();
    rig.sup.bus.publish("voice.test", Events.VoiceUtteranceEvent, {
      id: "u-saved",
      context: VC,
      speaker: { account: account("owen"), display_name: "owen", is_bot: false },
      text: "小鯨魚你在嗎",
      language: "zh",
      emotion: null,
      audio_events: [],
      started_at: toTimestamp(now - 800),
      ended_at: toTimestamp(now),
      asr_ms: 200,
    });
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    const turn = outcomes(rig)[0]?.turn ?? "";
    const prompt = archive(rig).get(turn);
    expect(prompt).toMatchObject({ turn, context: VC, reasoning: "off", prompt_tokens: 100 });
    expect(prompt?.messages.map((m) => m.text).join("\n")).toContain("owen(語音): 小鯨魚你在嗎");
    expect(prompt === null ? "" : last(prompt, "system")).toContain("## 語音");
  });
});
