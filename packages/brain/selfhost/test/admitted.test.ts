// What other modules ask her to say, on the new runner: what the Arbiter admits (a game's
// narration, a song's announcement, a notice) is a run of the place's lane under the turn the
// Arbiter booked, never queued behind a run; a long task asked for in voice (the old work lane's
// `work_start`) is a helper's job.

import { defineTool } from "@miyoria/llm/tools";
import { sleep } from "@miyoria/runtime/kernel";
import {
  type ArbiterDecision,
  type ContextKey,
  Events,
  FloorKey,
  type Impulse,
  ImpulseHostKey,
  type ImpulseInput,
  newImpulse,
  type PlaybackState,
  type TurnOutcomeRecord,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  account,
  calls,
  channel,
  Rig,
  type RigOptions,
  says,
  stopRigs,
  textOf,
  until,
} from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const VC: ContextKey = { platform: "test", scope: "guild", channel: "vc", kind: "voice" };

function member(id: string, self = false): VoiceParticipant {
  return { account: account(id), display_name: id, is_self: self, muted: false, deafened: false };
}

const VOICE = {
  default_mode: "normal",
  debounce_ms: 150,
  direct_debounce_ms: 80,
  turn_debounce_ms: 20,
  max_debounce_ms: 1_500,
  speculate: false,
  live_context_ms: 50,
};

async function voiceRig(o: RigOptions = {}): Promise<Rig> {
  const rig = await Rig.create({ ...o, config: { ...o.config, voice: VOICE } });
  rig.sup.bus.publish("voice.test", Events.VoiceJoined, {
    context: VC,
    participants: [member("owen"), member("amy"), member("her", true)],
  });
  await sleep(20);
  return rig;
}

let nextUtterance = 0;

function hear(rig: Rig, who: string, text: string): void {
  const now = Date.now();
  rig.sup.bus.publish("voice.test", Events.VoiceUtteranceEvent, {
    id: `u${nextUtterance++}`,
    context: VC,
    speaker: { account: account(who), display_name: who, is_bot: false },
    text,
    language: "zh",
    emotion: null,
    audio_events: [],
    started_at: toTimestamp(now - 800),
    ended_at: toTimestamp(now),
    asr_ms: 200,
  });
}

function play(rig: Rig, turn: string, state: PlaybackState, text: string): void {
  rig.sup.bus.publish("voice.test", Events.VoicePlaybackEvent, { context: VC, turn, state, text });
}

function impulse(input: Partial<ImpulseInput> & Pick<ImpulseInput, "source">): Impulse {
  return newImpulse(
    { context: C1, ttlMs: 60_000, why: input.source, hint: "", reason: input.source, ...input },
    Date.now(),
  );
}

function desk(rig: Rig) {
  const host = rig.sup.services.get(ImpulseHostKey);
  if (host === undefined) throw new Error("no impulse host");
  return host;
}

/** `[text, turn]` of every `speak` action. */
function speeches(rig: Rig): [string, string | null][] {
  return rig.sink.actions.flatMap((a) =>
    a.payload.type === "speak" ? [[a.payload.text, a.turn] as [string, string | null]] : [],
  );
}

const outcomes = (rig: Rig) => rig.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);

describe("what the Arbiter admits", () => {
  it("a song's announcement runs in the voice channel she is in, as the turn it booked", async () => {
    const rig = await voiceRig({ arbiter: {} });
    rig.model.push(says("要開始唱囉!"));
    // The singer names the server's text channel; she is in voice there.
    rig.sup.bus.publish(
      "sing",
      Events.ArbiterImpulse,
      impulse({
        source: "song",
        context: C1,
        hint: "你要開始唱〈小星星〉了(owen 點的)。用一句話開場,說完就開始。",
        reason: "song_start",
      }),
    );
    await until(() => speeches(rig).length === 1, 3_000, "her opening line");
    const [[text, turn] = ["", null]] = speeches(rig);
    expect(text).toBe("要開始唱囉!");
    const accepted = rig
      .of<ArbiterDecision>(Events.ArbiterDecided.type)
      .find((d) => d.source === "song" && d.verdict === "accepted");
    expect(accepted?.turn).toBe(turn);
    const last = String(rig.model.requests[0]?.messages.at(-1)?.content ?? "");
    expect(last).toContain("唱歌的事:你要開始唱〈小星星〉了");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(outcomes(rig)[0]).toMatchObject({ turn, context: VC, reason: "initiative" });
  });

  it("a game's urgent line holds the Floor as urgent; another claim meanwhile is busy", async () => {
    const rig = await voiceRig({ arbiter: {} });
    rig.model.push({ events: says("哇啊!"), delay: 400 });
    const first = await desk(rig).open(
      impulse({ source: "game", context: VC, hint: "剛剛死掉了!馬上用一兩句話反應。" }),
    );
    expect(first.status).toBe("started");
    const turn = first.status === "started" ? first.turn : null;
    await until(() => rig.model.requests.length === 1, 3_000, "the run");
    expect(rig.sup.services.get(FloorKey)?.holder(VC)).toMatchObject({ turn, kind: "urgent" });
    const second = await desk(rig).open(
      impulse({ source: "game", context: VC, hint: "又受傷了", attention: null }),
    );
    expect(second).toMatchObject({ status: "busy" });
    expect(textOf(rig.model.requests[0])).toContain("你正在玩的遊戲:剛剛死掉了!");
    await until(() => speeches(rig).length === 1, 3_000, "her line");
    expect(speeches(rig)[0]).toEqual(["哇啊!", turn]);
  });

  it("a watched stream's line is a wake that speaks of the stream, not of a game", async () => {
    const rig = await voiceRig({ arbiter: {} });
    rig.model.push({ events: says("哈哈,好扯!"), delay: 100 });
    const opened = await desk(rig).open(
      impulse({ source: "watch", context: VC, hint: "朋友剛剛在直播裡翻車了" }),
    );
    expect(opened.status).toBe("started");
    await until(() => rig.model.requests.length === 1, 3_000, "the run");
    const text = textOf(rig.model.requests[0]);
    expect(text).toContain("你正在看的直播:朋友剛剛在直播裡翻車了");
    expect(text).not.toContain("你正在玩的遊戲");
    await until(() => speeches(rig).length === 1, 3_000, "her line");
  });

  it("a notice is a result run with what came of it, told once", async () => {
    const rig = await Rig.create();
    rig.sup.bus.publish("actions", Events.AgentNotice, {
      id: "n1",
      at: toTimestamp(Date.now()),
      source: "actions",
      task: "t1",
      turn: null,
      context: C1,
      ok: true,
      code: null,
      text: "幫 amy 訂好位子了",
      expires_at: toTimestamp(Date.now() + 60_000),
    });
    await sleep(20);
    rig.model.push(says("訂好囉"));
    const run = await desk(rig).open(impulse({ source: "notice", context: C1, reason: "notice" }));
    expect(run.status).toBe("started");
    await until(() => rig.sink.texts().length === 1, 3_000, "her line");
    const request = textOf(rig.model.requests[0]);
    expect(request).toContain("剛回來的結果");
    expect(request).toContain("- 成功:幫 amy 訂好位子了");
    expect(request).toContain("通知,代號 t1");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    // Nothing left to tell: the Arbiter hears it was said.
    const again = await desk(rig).open(
      impulse({ source: "notice", context: C1, reason: "notice" }),
    );
    expect(again).toMatchObject({ status: "refused", reason: "repeat" });
  });

  it("her own run that has said nothing gives way", async () => {
    const rig = await Rig.create();
    rig.model.push({ events: says("我想說…"), delay: 800 }, says("這局好險"));
    rig.sup.bus.publish("mind", Events.MindReminder, {
      state: "fired",
      reminder: {
        id: "r1",
        key: "R1",
        what: "提醒 amy 喝水",
        due: toTimestamp(Date.now()),
        daily: false,
        context: C1,
        person: null,
        for_account: null,
        fired: 1,
        created_at: toTimestamp(Date.now() - 60_000),
      },
    });
    await until(() => rig.model.requests.length === 1, 3_000, "her own run");
    expect(textOf(rig.model.requests[0])).toContain("提醒 amy 喝水");
    const run = await desk(rig).open(
      impulse({ source: "game", context: C1, hint: "贏了這一局", claim: "notable" }),
    );
    expect(run.status).toBe("started");
    await until(() => rig.sink.texts().length === 1, 3_000, "the game's line");
    expect(rig.sink.texts()).toEqual(["這局好險"]);
    await until(() => outcomes(rig).length === 2, 3_000, "both outcomes");
    const cut = outcomes(rig).find((o) => o.outcome.type === "cancelled");
    expect(cut?.outcome).toMatchObject({ cause: "superseded" });
  });

  it("a long task asked for in voice goes to a helper; its result comes back to the channel", async () => {
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
    const rig = await voiceRig({ provide: (_sup, tools) => tools.register(search) });
    for (let i = 0; i < 8; i++) {
      rig.model.push({
        events: (request) => {
          const helper = String(request.messages[0]?.content ?? "").includes("小幫手");
          const text = textOf(request);
          if (helper) {
            return text.includes("三個結果")
              ? says("結論:A 比較好。")
              : calls("web_search", { q: "A B" });
          }
          if (text.includes("結論:A 比較好。")) return says("查好了,A 比較好");
          if (text.includes("交給小幫手了")) return says("我請小幫手去查");
          return calls("delegate", { kind: "research", goal: "查 A 和 B 哪個好" });
        },
      });
    }
    hear(rig, "owen", "小鯨魚幫我查 A 和 B 哪個好");
    await until(() => speeches(rig).length === 1, 5_000, "the receipt");
    const [[receipt, turn] = ["", null]] = speeches(rig);
    expect(receipt).toBe("我請小幫手去查");
    play(rig, turn ?? "", "started", receipt);
    play(rig, turn ?? "", "finished", receipt);
    await until(() => speeches(rig).length === 2, 5_000, "the result");
    expect(speeches(rig)[1]?.[0]).toBe("查好了,A 比較好");
    // Said in the voice channel: nothing went to a text channel.
    expect(rig.sink.texts()).toEqual([]);
  });
});

describe("an announcement that must come before something else starts", () => {
  /** A song's opening: worth saying for a few seconds only (scaled down from six). */
  const opening = (ttlMs: number) =>
    impulse({
      source: "song",
      context: C1,
      ttlMs,
      hint: "你要開始唱〈小星星〉了(owen 點的)。用一句話開場,說完就開始。",
      reason: "song_start",
    });

  it("waits for the answer she is giving and is said inside its window", async () => {
    const rig = await voiceRig({ arbiter: {} });
    rig.model.push({ events: says("在喔。"), delay: 400 }, says("要開始唱囉!"));
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => rig.model.requests.length === 1, 3_000, "the run that answers owen");
    const at = Date.now();
    const asked = desk(rig).open(opening(800));
    await until(() => speeches(rig).length === 1, 3_000, "her answer");
    const answer = speeches(rig)[0]?.[1] ?? "";
    play(rig, answer, "started", "在喔。");
    play(rig, answer, "finished", "在喔。");
    const run = await asked;
    expect(run.status).toBe("started");
    expect(Date.now() - at).toBeLessThan(800);
    await until(() => speeches(rig).length === 2, 3_000, "the announcement");
    expect(speeches(rig).map(([t]) => t)).toEqual(["在喔。", "要開始唱囉!"]);
    expect(rig.sink.cancelled).toEqual([]);
    await until(() => outcomes(rig).length === 2, 3_000, "both outcomes");
    expect(outcomes(rig).map((o) => o.outcome.type)).toEqual(["sent", "sent"]);
  });

  it("through the Arbiter: said once the answer is out, not retried past its window", async () => {
    const rig = await voiceRig({ arbiter: { retry_ms: 400 } });
    rig.model.push({ events: says("在喔。"), delay: 500 }, says("要開始唱囉!"));
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => rig.model.requests.length === 1, 3_000, "the run that answers owen");
    rig.sup.bus.publish("sing", Events.ArbiterImpulse, opening(1_200));
    await until(() => speeches(rig).length === 1, 3_000, "her answer");
    const answer = speeches(rig)[0]?.[1] ?? "";
    play(rig, answer, "started", "在喔。");
    play(rig, answer, "finished", "在喔。");
    await until(() => speeches(rig).length === 2, 3_000, "the announcement");
    expect(speeches(rig)[1]?.[0]).toBe("要開始唱囉!");
    const decisions = rig
      .of<ArbiterDecision>(Events.ArbiterDecided.type)
      .filter((d) => d.source === "song");
    expect(decisions.at(-1)).toMatchObject({ verdict: "accepted", turn: speeches(rig)[1]?.[1] });
  });

  it("says nothing when the answer outlasts the window", async () => {
    const rig = await voiceRig({ arbiter: {} });
    rig.model.push({ events: says("在喔。"), delay: 1_500 }, says("要開始唱囉!"));
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => rig.model.requests.length === 1, 3_000, "the run that answers owen");
    const at = Date.now();
    const run = await desk(rig).open(opening(400));
    expect(run.status).toBe("busy");
    // It asked until the window was over, not longer.
    expect(Date.now() - at).toBeGreaterThanOrEqual(300);
    expect(Date.now() - at).toBeLessThan(1_000);
    await until(() => speeches(rig).length === 1, 5_000, "her answer");
    await sleep(300);
    expect(speeches(rig).map(([t]) => t)).toEqual(["在喔。"]);
    expect(rig.model.requests).toHaveLength(1);
  });

  it("a run that has said nothing when the window is over is cancelled, not said late", async () => {
    const rig = await voiceRig({ arbiter: {} });
    rig.model.push({ events: says("要開始唱囉!"), delay: 900 });
    const run = await desk(rig).open(opening(300));
    expect(run.status).toBe("started");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(outcomes(rig)[0]?.outcome).toMatchObject({ type: "cancelled", cause: "expired" });
    expect(speeches(rig)).toEqual([]);
  });

  it("a long window is not waited for: the Arbiter retries as before", async () => {
    const rig = await voiceRig({ arbiter: {} });
    rig.model.push({ events: says("在喔。"), delay: 600 });
    hear(rig, "owen", "小鯨魚你在嗎");
    await until(() => rig.model.requests.length === 1, 3_000, "the run that answers owen");
    const at = Date.now();
    const run = await desk(rig).open(
      impulse({ source: "song", context: C1, ttlMs: 120_000, reason: "song_done", hint: "唱完了" }),
    );
    expect(run.status).toBe("busy");
    expect(Date.now() - at).toBeLessThan(200);
  });
});
