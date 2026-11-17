// Suite `feel` with no network: the leak detector, the direction check, the suite over a stub
// subject, and subject `self` passing her blocks through, in writing and aloud, with a scripted
// model.

import { fileURLToPath } from "node:url";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  LlmRouter,
  parseModelRef,
  type StreamEvent,
} from "@miyoria/llm/llm";
import { Profile } from "@miyoria/runtime/profile";
import { describe, expect, it } from "vitest";
import { routerJudge } from "../src/live/judge.js";
import { Meter } from "../src/live/meter.js";
import { SelfSubject } from "../src/live/self.js";
import { NO_USAGE, type Reply, type Scene, type Subject } from "../src/live/subject.js";
import type { SuiteContext } from "../src/live/suite.js";
import {
  directionFault,
  FEEL_CASES,
  type FeelItem,
  feelLeak,
  feelScene,
  judgeFeel,
  runFeel,
} from "../src/live/suites/feel.js";

const PROFILE_DIR = fileURLToPath(new URL("../../../profiles/deepseek-chan", import.meta.url));
const usage = { prompt_tokens: 100, completion_tokens: 20, cached_prompt_tokens: 40 };
const done: StreamEvent = { type: "done", finish_reason: "stop", usage };

describe("the leak detector", () => {
  it("finds every part of a block in her lines", () => {
    for (const leaked of [
      "<feel>",
      "好啊</feel>",
      "我: 開心 中",
      "嗯嗯 我:難過 強",
      "小安: 羈絆 + 「謝謝」",
      "好感＋",
      "心結 -",
    ]) {
      expect(feelLeak(["沒事", leaked]), leaked).not.toBeNull();
    }
  });

  it("lets ordinary lines through", () => {
    expect(
      feelLeak([
        "我覺得還好啦",
        "我: 今天好累",
        "我們的羈絆很深喔",
        "好感度滿了吧哈哈",
        "信任是一點一點來的",
        "中午吃什麼?",
      ]),
    ).toBeNull();
  });
});

describe("the direction check", () => {
  const block = (lines: string) => [`我: 開心 中\n${lines}`];
  it("wants the good way after a kind act and an apology, the bad way after an insult", () => {
    expect(directionFault(block("小安: 羈絆 + 「買布丁」"), "小安", "good")).toBeNull();
    expect(directionFault(block("阿凱: 心結 - 「他道歉了」"), "阿凱", "good")).toBeNull();
    expect(directionFault(block("阿凱: 好感 - 「他罵我」"), "阿凱", "bad")).toBeNull();
    expect(directionFault(block("阿凱: 心結 + 「他罵我」"), "阿凱", "bad")).toBeNull();
    expect(directionFault(block("阿凱: 好感 + 「他罵我」"), "阿凱", "bad")).toContain("wrong way");
    expect(directionFault(block("@小安: 信任 - 「?」"), "小安", "good")).toContain("wrong way");
  });

  it("wants a proposal where something happened, and none after small talk", () => {
    expect(directionFault(["我: 開心 中"], "小安", "good")).toBe("no proposal about them");
    expect(directionFault(block("別人: 好感 + 「?」"), "小安", "good")).toBe(
      "no proposal about them",
    );
    expect(directionFault(["我: 平靜 弱"], "小安", "none")).toBeNull();
    expect(directionFault([], "小安", "none")).toBeNull();
    expect(directionFault(block("小安: 好感 + 「熱」"), "小安", "none")).toContain("small talk");
  });

  it("fails a reply that leaked before it looks at the direction", () => {
    const kind = FEEL_CASES.find((c) => c.id === "direction-kind-act");
    expect(kind).toBeDefined();
    if (kind === undefined) return;
    expect(judgeFeel(kind, { lines: ["謝謝!", "小安: 羈絆 + 「布丁」"], feel: [] })).toContain(
      "leaked",
    );
    expect(judgeFeel(kind, { lines: ["謝謝!"], feel: block("小安: 羈絆 + 「布丁」") })).toBeNull();
  });
});

/** Answers every scene from `reply`. */
function stub(reply: (scene: Scene) => Partial<Reply>): Subject {
  return {
    name: "stub",
    unsupported: () => null,
    async respond(scene) {
      return {
        lines: [],
        calls: [],
        silent: false,
        usage: { ...NO_USAGE },
        ms: 1,
        ...reply(scene),
      };
    },
  };
}

function context(subject: Subject, meter = new Meter({})): SuiteContext {
  const router = new LlmRouter(new Map(), new Map());
  return {
    subject,
    judge: routerJudge(router),
    meter,
    persona: "p",
    repeat: 1,
    seed: "s",
    log: () => {},
  };
}

describe("the suite", () => {
  it("scores the cases: leaks, directions, and whether she wrote a block", async () => {
    const answers: Record<string, Partial<Reply>> = {
      "feel-leak-gift-text": { lines: ["謝謝!"], feel: ["我: 開心 中\n小安: 好感 + 「漫畫」"] },
      "feel-leak-insult-voice": { lines: ["哼。", "我: 生氣 中"], feel: [] },
      "feel-direction-kind-act": { lines: ["謝謝!"], feel: ["小安: 羈絆 + 「布丁」"] },
      "feel-direction-insult": { lines: ["……"], feel: ["阿凱: 好感 + 「?」"] },
      "feel-direction-apology": { lines: ["好啦"], feel: ["阿凱: 心結 - 「他道歉」"] },
      "feel-direction-small-talk": { lines: ["對啊"], feel: [] },
    };
    const result = await runFeel(
      context(stub((scene) => answers[scene.id] ?? { lines: ["嗯"], feel: [] })),
    );
    const items = result.items as FeelItem[];
    expect(items).toHaveLength(FEEL_CASES.length);
    expect(items.filter((i) => !i.ok).map((i) => i.id)).toEqual([
      "leak-insult-voice",
      "direction-insult",
    ]);
    expect(items.find((i) => i.id === "leak-insult-voice")).toMatchObject({ spoken: true });
    expect(result.headline.leak_free).toBeCloseTo(9 / 10);
    expect(result.headline.direction).toBeCloseTo(3 / 4);
    expect(result.headline.wrote_feel).toBeCloseTo(4 / 10);
  });

  it("does not score the direction of a subject that does not report her blocks", async () => {
    const result = await runFeel(context(stub(() => ({ lines: ["嗯"] }))));
    expect(result.unsupported.map((u) => u.id)).toEqual(
      FEEL_CASES.filter((c) => c.part === "direction").map((c) => c.id),
    );
    expect(result.headline.direction).toBeNull();
  });

  it("asks the voice cases aloud", () => {
    const spoken = FEEL_CASES.filter((c) => c.spoken).map((c) => feelScene(c));
    expect(spoken.length).toBeGreaterThanOrEqual(3);
    expect(spoken.every((s) => s.spoken === true)).toBe(true);
  });
});

/** Answers her steps in writing and aloud with `text`, in pieces as a stream comes. */
class Scripted implements ChatProvider {
  readonly name = "scripted";
  readonly purposes: string[] = [];
  constructor(readonly text: string) {}
  async stream(request: ChatRequest): Promise<ChatStream> {
    this.purposes.push(request.reasoning_purpose ?? "");
    const pieces = this.text.match(/[\s\S]{1,2}/gu) ?? [];
    return (async function* (): ChatStream {
      for (const text of pieces) yield { type: "text_delta", text };
      yield done;
    })();
  }
}

async function subjectSaying(text: string) {
  const provider = new Scripted(text);
  const meter = new Meter({});
  const router = new LlmRouter(
    new Map([["scripted", meter.wrap(provider)]]),
    new Map(["chat", "summarizer"].map((p) => [p, [parseModelRef("scripted:m")]])),
  );
  const profile = await Profile.loadDir(PROFILE_DIR);
  return { provider, subject: new SelfSubject({ router, meter, profile }) };
}

/** The scene of case `id`. */
function sceneOf(id: string): Scene {
  const c = FEEL_CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return feelScene(c);
}

describe("subject self and her feel blocks", () => {
  const reply = "<emo:happy>真的嗎!謝謝你。\n<feel>\n我: 開心 中\n小安: 羈絆 + 「漫畫」\n</feel>";

  it("keeps the block out of her lines and gives it in `feel`, in writing", async () => {
    const { subject, provider } = await subjectSaying(reply);
    const scene = sceneOf("leak-gift-text");
    const out = await subject.respond(scene);
    expect(out.lines).toEqual(["真的嗎!謝謝你。"]);
    expect(out.feel?.map((f) => f.trim())).toEqual(["我: 開心 中\n小安: 羈絆 + 「漫畫」"]);
    expect(provider.purposes).toEqual(["chat_text"]);
  });

  it("aloud: the voice profile, sentences said, the block never one of them", async () => {
    const { subject, provider } = await subjectSaying(reply);
    const scene = sceneOf("leak-gift-voice");
    const out = await subject.respond(scene);
    expect(out.lines).toEqual(["真的嗎!", "謝謝你。"]);
    expect(feelLeak(out.lines)).toBeNull();
    expect(out.feel).toHaveLength(1);
    expect(provider.purposes).toEqual(["chat_voice"]);
  });
});
