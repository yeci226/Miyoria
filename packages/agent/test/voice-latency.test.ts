// She answers sooner in voice (docs/design/v4-plan.md §7.5): the wait before her turn counts from
// the person's last sound, a turn that someone called her in starts during that wait and speaks
// only after it, what the prompt needs that does not depend on the line is read warm, and the
// agent marks where its time went (for the voice module's measurement and the outcome row).

import { ArbiterModule } from "@miyoria/arbiter";
import { FactsModule } from "@miyoria/facts";
import { type ServiceRegistry, sleep } from "@miyoria/kernel";
import type { ChatProvider, ChatRequest, ChatStream, StreamEvent } from "@miyoria/llm";
import {
  type ContextKey,
  type JsonValue,
  type MessageRef,
  newId,
  PipelineKey,
  PromptContributors,
  PromptContributorsKey,
  type TurnId,
  type TurnOutcomeRecord,
  toTimestamp,
  type VoiceTurnMark,
  type VoiceTurnStages,
  VoiceTurnsKey,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speculations, speculationWaste } from "../src/coordinator.js";
import { done, Harness, noCheck, stopHarnesses, textDelta, wait } from "./harness.js";

const VOICE: ContextKey = { platform: "test", scope: "guild", channel: "v1", kind: "voice" };

beforeEach(() => {
  vi.useFakeTimers();
  // 14:00 local (UTC+8): outside quiet hours.
  vi.setSystemTime(Date.UTC(2026, 10, 7, 6, 0, 0));
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

/** Plays `script` call by call (the last one repeats); a call may hang until it is cancelled. */
class Scripted implements ChatProvider {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];
  /** Calls cancelled before they ended. */
  cancelled = 0;

  constructor(readonly script: (StreamEvent[] | "hang")[]) {}

  async stream(request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const step = (this.script.length > 1 ? this.script.shift() : this.script[0]) ?? [];
    signal?.addEventListener("abort", () => this.cancelled++, { once: true });
    return (async function* (): ChatStream {
      if (step === "hang") {
        await new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return;
      }
      for (const event of step) yield event;
    })();
  }
}

const reply = (text: string): StreamEvent[] => [textDelta(text), done()];

/** What the voice module is told. */
class Turns {
  marks: [TurnId, VoiceTurnMark, MessageRef[]][] = [];
  expected: TurnId[] = [];
  settled: TurnId[] = [];

  provide(services: ServiceRegistry): void {
    services.provide("app", VoiceTurnsKey, {
      mark: (turn, focus, mark) => this.marks.push([turn, mark, [...focus]]),
      expect: (_context, turn) => this.expected.push(turn),
      settle: (turn) => this.settled.push(turn),
    });
  }

  of(turn: TurnId): VoiceTurnMark[] {
    return this.marks.filter(([t]) => t === turn).map(([, m]) => m);
  }
}

async function rig(
  chat: ChatProvider,
  config: JsonValue = {},
  provide: (services: ServiceRegistry) => void = () => undefined,
): Promise<Harness> {
  const h = await Harness.build(
    "normal",
    { ...(noCheck() as object), ...(config as object) },
    chat,
    null,
    {
      provide: (services) => {
        services.provide("app", PipelineKey, { pipeline: "v3" as const });
        provide(services as unknown as ServiceRegistry);
      },
      before: [[new FactsModule(null, "p"), null]],
      modules: [[new ArbiterModule("p"), { quiet_start_hour: 0, quiet_end_hour: 0 }]],
    },
  );
  // Two people: with one, everything said is said to her.
  const participants = ["p0", "p1"].map((id) => ({
    account: { platform: "test", id },
    display_name: id.toUpperCase(),
    is_self: false,
    muted: false,
    deafened: false,
  }));
  h.publish({ type: "voice_joined", data: { context: VOICE, participants } });
  await wait(10);
  return h;
}

/** P0 said `text`, ending `endedAgoMs` ago (the transcript arrives now). */
function utter(h: Harness, text: string, endedAgoMs = 0): string {
  const id = newId();
  const ended = toTimestamp(Date.now() - endedAgoMs);
  h.publish({
    type: "voice_utterance",
    data: {
      id,
      context: VOICE,
      speaker: { account: { platform: "test", id: "p0" }, display_name: "P0", is_bot: false },
      text,
      language: null,
      emotion: null,
      audio_events: [],
      started_at: ended,
      ended_at: ended,
      asr_ms: 10,
    },
  });
  return id;
}

const said = (h: Harness) => h.sink.speeches().map(([t]) => t);

function outcomes(h: Harness): (TurnOutcomeRecord & { voice_stages?: VoiceTurnStages })[] {
  return h
    .drain()
    .flatMap((e) =>
      e.event.type === "custom" && e.event.data.topic === "agent.turn.outcome"
        ? [e.event.data.payload as unknown as TurnOutcomeRecord]
        : [],
    );
}

const promptText = (r: ChatRequest | undefined) => JSON.stringify(r?.messages ?? []);

describe("the wait before her turn counts from the person's last sound", () => {
  it("a transcript that came after the wait was over starts her turn at once", async () => {
    const llm = new Scripted([reply("嗯?")]);
    const h = await rig(llm, { voice: { speculate: false } });
    // The node's silence and ASR took 900 ms: the 400 ms she waits for someone calling her is over.
    utter(h, "DeepSeek 今天好熱", 900);
    await wait(20);
    expect(llm.requests).toHaveLength(1);
  });

  it("counted from the transcript when told so, as before", async () => {
    const llm = new Scripted([reply("嗯?")]);
    const h = await rig(llm, { voice: { speculate: false, debounce_from_speech_end: false } });
    utter(h, "DeepSeek 今天好熱", 900);
    await wait(390);
    expect(llm.requests).toHaveLength(0);
    await wait(20);
    expect(llm.requests).toHaveLength(1);
  });
});

describe("a turn someone called her in starts during the wait", () => {
  it("the model runs while the wait ends, and nothing is said before it does", async () => {
    const before = speculations.get({ result: "confirmed" });
    const llm = new Scripted([reply("怎麼了?")]);
    const h = await rig(llm);
    utter(h, "DeepSeek 你在嗎");
    await wait(50);
    expect(llm.requests, "the model is asked at once").toHaveLength(1);
    expect(h.sink.speakActions(), "but she waits for the wait").toHaveLength(0);
    await wait(400);
    expect(said(h)).toEqual(["怎麼了?"]);
    expect(speculations.get({ result: "confirmed" })).toBe(before + 1);
    const out = outcomes(h);
    expect(out).toHaveLength(1);
    expect(out[0]?.voice_stages?.speculative).toBe(true);
  });

  it("they go on: the early turn is dropped without a trace, the merged one answers both lines", async () => {
    const dropped = speculations.get({ result: "dropped" });
    const wasted = speculationWaste.get({ part: "model" });
    const llm = new Scripted([reply("第一個回答"), reply("合起來的回答")]);
    const h = await rig(llm);
    utter(h, "DeepSeek 我跟你說");
    await wait(200);
    utter(h, "今天考完試了");
    await wait(1000);
    expect(llm.requests).toHaveLength(2);
    expect(llm.cancelled, "the dropped call is cut").toBeGreaterThanOrEqual(1);
    expect(promptText(llm.requests[1])).toContain("我跟你說");
    expect(promptText(llm.requests[1])).toContain("今天考完試了");
    expect(said(h)).toEqual(["合起來的回答"]);
    // One turn as far as the outcomes go: the dropped one never was.
    const out = outcomes(h);
    expect(out.map((o) => o.outcome.type)).toEqual(["sent"]);
    // What it cost is counted.
    expect(speculations.get({ result: "dropped" })).toBe(dropped + 1);
    expect(speculationWaste.get({ part: "model" })).toBeGreaterThan(wasted);
  });

  it("is bounded: past `speculate_max_per_min` dropped starts she waits as before", async () => {
    const llm = new Scripted([reply("嗯")]);
    const h = await rig(llm, { voice: { speculate_max_per_min: 1 } });
    utter(h, "DeepSeek 我跟你說");
    await wait(100);
    expect(llm.requests).toHaveLength(1);
    utter(h, "DeepSeek 等一下喔");
    await wait(100);
    // The early start was dropped and the bound is reached: no second one.
    expect(llm.requests).toHaveLength(1);
    await wait(400);
    expect(llm.requests).toHaveLength(2);
    expect(said(h)).toEqual(["嗯"]);
  });

  it("not while somebody is talking, nor for a line nobody called her in", async () => {
    const llm = new Scripted([reply("嗯")]);
    const h = await rig(llm, { default_mode: "always", voice: { default_mode: "always" } });
    utter(h, "今天好熱");
    await wait(100);
    expect(llm.requests).toHaveLength(0);
    h.publish({
      type: "voice_speaking",
      data: { context: VOICE, account: { platform: "test", id: "p0" }, speaking: true },
    });
    utter(h, "DeepSeek 你覺得呢");
    await wait(100);
    expect(llm.requests).toHaveLength(0);
  });
});

describe("where a voice turn's time goes", () => {
  it("each step is marked for the voice module, and the outcome keeps the stages", async () => {
    const turns = new Turns();
    const llm = new Scripted([reply("你好啊")]);
    const h = await rig(llm, {}, (s) => turns.provide(s));
    const id = utter(h, "DeepSeek 你好", 1200);
    await wait(1000);
    const out = outcomes(h);
    expect(out).toHaveLength(1);
    const turn = out[0]?.turn as TurnId;
    expect(turns.of(turn)).toEqual(["started", "decided", "context", "request", "first_token"]);
    expect(turns.marks[0]?.[2].map((r) => r.id)).toEqual([id]);
    const stages = out[0]?.voice_stages as VoiceTurnStages;
    expect(stages.heard_ms).toBe(1200);
    expect(stages.speculative).toBe(false);
    expect(stages.held_ms).toBe(0);
    const parts = Object.entries(stages).filter(([k]) => k.endsWith("_ms"));
    const sum = parts.reduce((s, [, v]) => s + ((v as number | null) ?? 0), 0);
    expect(sum).toBe(out[0]?.latency_ms);
    // She was called: the voice module may fill the silence; the end of the turn ends that.
    expect(turns.expected).toEqual([turn]);
    expect(turns.settled).toContain(turn);
  });

  it("no filler for a line nobody called her in", async () => {
    const turns = new Turns();
    const llm = new Scripted([reply("真的好熱")]);
    const h = await rig(llm, { voice: { default_mode: "always" } }, (s) => turns.provide(s));
    utter(h, "今天好熱", 1000);
    await wait(1000);
    expect(turns.expected).toEqual([]);
  });
});

describe("what a voice turn does not wait for", () => {
  it("a slow contributor cannot delay it; what is kept warm is read without waiting", async () => {
    const registry = new PromptContributors();
    let notebook = 0;
    registry.register({
      key: "notebook",
      contribute: async () => {
        notebook += 1;
        if (notebook > 1) return await new Promise(() => undefined); // never again
        await sleep(2000);
        return [{ key: "notebook", title: "你的筆記本", body: "- 主題/貓", order: 30 }];
      },
    });
    // Depends on the line, and hangs.
    registry.register({ key: "knowledge", contribute: () => new Promise(() => undefined) });
    const llm = new Scripted([reply("嗯")]);
    const h = await rig(llm, { voice: { speculate: false } }, (s) =>
      s.provide("app", PromptContributorsKey, registry),
    );
    utter(h, "DeepSeek 在嗎", 1000);
    await wait(390);
    expect(llm.requests, "the line's context gets 400 ms").toHaveLength(0);
    await wait(30);
    expect(llm.requests).toHaveLength(1);
    expect(promptText(llm.requests[0])).not.toContain("主題/貓");
    // The notebook comes in the background; the next turn has it without waiting for it.
    await wait(3000);
    utter(h, "DeepSeek 再說一次", 1000);
    await wait(430);
    expect(llm.requests).toHaveLength(2);
    expect(promptText(llm.requests[1])).toContain("主題/貓");
    expect(notebook).toBe(2);
    expect(h.sink.speakActions().length).toBeGreaterThan(0);
  });
});
