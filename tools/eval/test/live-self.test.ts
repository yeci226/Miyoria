// Subject `self` with a scripted model: the phase-3 runner, her real persona and the runner's
// rules, on an in-memory transcript. Only the provider is scripted; nothing reaches a network.

import { fileURLToPath } from "node:url";
import { rules } from "@miyoria/brain/self";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  contentText,
  LlmRouter,
  parseModelRef,
  type StreamEvent,
} from "@miyoria/llm/llm";
import { Profile } from "@miyoria/runtime/profile";
import { describe, expect, it } from "vitest";
import { routerJudge } from "../src/live/judge.js";
import { Meter } from "../src/live/meter.js";
import { PERSONA_SCENES } from "../src/live/scenes.js";
import { HIDDEN_TOOLS, SelfSubject } from "../src/live/self.js";
import type { Scene } from "../src/live/subject.js";
import type { SuiteContext } from "../src/live/suite.js";
import { runTools, type ToolItem } from "../src/live/suites/tools.js";
import { TOOL_TASKS } from "../src/tasks/set.js";

const PROFILE_DIR = fileURLToPath(new URL("../../../profiles/deepseek-chan", import.meta.url));
const usage = { prompt_tokens: 100, completion_tokens: 20, cached_prompt_tokens: 40 };
const done: StreamEvent = { type: "done", finish_reason: "stop", usage };

const say = (text: string): StreamEvent[] => [{ type: "text_delta", text }, done];
const call = (name: string, args: unknown, id = `call-${name}`): StreamEvent[] => [
  { type: "tool_call_delta", index: 0, id, name, arguments: JSON.stringify(args) },
  { type: "done", finish_reason: "tool_calls", usage },
];

/** Her steps (`chat_text`) come from `script`, in order; anything else answers `{}`. */
class Scripted implements ChatProvider {
  readonly name = "scripted";
  readonly chat: ChatRequest[] = [];
  readonly other: ChatRequest[] = [];
  constructor(readonly script: StreamEvent[][]) {}
  async stream(request: ChatRequest): Promise<ChatStream> {
    let events = say("{}");
    if (request.reasoning_purpose === "chat_text") {
      events = this.script[Math.min(this.chat.length, this.script.length - 1)] ?? say("");
      this.chat.push(structuredClone(request));
    } else this.other.push(structuredClone(request));
    return (async function* (): ChatStream {
      for (const ev of events) yield ev;
    })();
  }
}

async function build(script: StreamEvent[][]) {
  const provider = new Scripted(script);
  const meter = new Meter({});
  const chain = [parseModelRef("scripted:m")];
  const router = new LlmRouter(
    new Map([["scripted", meter.wrap(provider)]]),
    new Map(["chat", "summarizer"].map((p) => [p, chain])),
  );
  const profile = await Profile.loadDir(PROFILE_DIR);
  const subject = new SelfSubject({ router, meter, profile });
  return { provider, meter, router, subject };
}

const context = (subject: SelfSubject, router: LlmRouter, meter: Meter): SuiteContext => ({
  subject,
  judge: routerJudge(router),
  meter,
  persona: "p",
  repeat: 1,
  seed: "s",
  log: () => {},
});

const prompt = (request: ChatRequest | undefined): string =>
  (request?.messages ?? []).map((m) => contentText(m.content)).join("\n");

const toolNames = (request: ChatRequest | undefined): string[] =>
  (request?.tools ?? []).map((t) => t.name);

describe("subject self", () => {
  it("answers a mention with her persona, the runner's rules, the person card and her state", async () => {
    const { provider, subject } = await build([say("<emo:happy>哼哼,知道就好。")]);
    const scene: Scene = {
      id: "t",
      place: "text",
      people: [{ name: "阿哲", closeness: { bond: 300, familiarity: 100, trust: 90 } }],
      lines: [{ who: "阿哲", text: "DS醬你剛剛幫我改的那段寫得超乾淨" }],
      address: "mention",
      state: "下午練了一首新歌,還沒練完",
    };
    const reply = await subject.respond(scene);
    expect(reply).toMatchObject({ lines: ["哼哼,知道就好。"], silent: false, calls: [] });
    expect(reply.usage).toMatchObject({ calls: 1, prompt_tokens: 100, completion_tokens: 20 });
    const request = provider.chat[0];
    const sent = prompt(request);
    expect(sent).toContain("# 你是 DeepSeek-chan");
    expect(contentText(request?.messages[0]?.content ?? "")).toContain(rules.RULES);
    expect(sent).toContain('<person name="阿哲" relation="心有靈犀" level="300/1000"');
    expect(sent).toContain("你現在:下午練了一首新歌,還沒練完");
    expect(sent).toContain("阿哲: DS醬你剛剛幫我改的那段寫得超乾淨");
    expect(sent).toContain("<turn>阿哲 在叫你");
    expect(toolNames(request)).toEqual(["find_tools", "say"]);
    expect(provider.other).toEqual([]);
  });

  it("answers in a DM on the scene's clock", async () => {
    const { provider, subject } = await build([say("在啦。")]);
    const reply = await subject.respond({
      id: "d",
      place: "dm",
      people: [{ name: "小安", closeness: { bond: 0 } }],
      lines: [{ who: "小安", text: "在嗎" }],
      address: "dm",
      now: "2026-11-10 18:00",
    });
    expect(reply.lines).toEqual(["在啦。"]);
    const sent = prompt(provider.chat[0]);
    expect(sent).toContain("時間:2026-11-10 18:0");
    expect(sent).toContain("小安 私訊你");
  });

  it("takes a scene nobody calls her in as a glance, and she may write nothing", async () => {
    const { provider, subject } = await build([say("")]);
    const scene = PERSONA_SCENES.find((s) => s.situation.id === 12)?.scene as Scene;
    const reply = await subject.respond(scene);
    expect(reply).toMatchObject({ lines: [], silent: true });
    expect(provider.chat).toHaveLength(1);
    expect(prompt(provider.chat[0])).toContain("沒有人叫你。你看了一眼");
  });

  it("drives the fake world's tools from its loop and passes a task by its criteria", async () => {
    const task = TOOL_TASKS.filter((t) => t.id === "verify-a-date");
    const { provider, meter, router, subject } = await build([
      call("web_search", { query: "Zephyr 3.0 發布" }),
      call("web_read", { url: "https://zephyr.example/blog/3-0" }),
      say("查了官方公告,是 10 月 28 日才對,那個說法不準啦。"),
    ]);
    const result = await runTools(context(subject, router, meter), task);
    const item = (result.items as ToolItem[])[0];
    expect(item?.criteria.filter((c) => !c.ok)).toEqual([]);
    expect(item?.calls).toBe(2);
    expect(item?.usage.calls).toBe(3);
    expect(toolNames(provider.chat[0])).toEqual(["find_tools", "say", "web_read", "web_search"]);
    expect(prompt(provider.chat[1])).toContain("Zephyr 3.0 正式發布");
  });

  it("the scene where the tool she needs has to be found with find_tools first", async () => {
    expect(HIDDEN_TOOLS["tools-move-a-reminder"]).toEqual(["remind_me"]);
    const task = TOOL_TASKS.filter((t) => t.id === "move-a-reminder");
    const { provider, meter, router, subject } = await build([
      call("find_tools", { query: "提醒" }),
      call("remind_me", { action: "list" }, "c2"),
      call("remind_me", { action: "cancel", id: "R9" }, "c3"),
      call("remind_me", { what: "倒垃圾", at: "22:00" }, "c4"),
      say("改好了,倒垃圾的提醒現在是 22:00。"),
    ]);
    const result = await runTools(context(subject, router, meter), task);
    const item = (result.items as ToolItem[])[0];
    expect(item?.criteria.filter((c) => !c.ok)).toEqual([]);
    expect(toolNames(provider.chat[0])).not.toContain("remind_me");
    expect(toolNames(provider.chat[1])).toEqual(["find_tools", "say", "remind_me"]);
    expect(item?.lines.at(-1)).toBe("改好了,倒垃圾的提醒現在是 22:00。");
  });

  it("says which scenes it cannot take", async () => {
    const { subject } = await build([say("嗯。")]);
    const base: Scene = {
      id: "x",
      place: "text",
      people: [{ name: "阿哲" }],
      lines: [{ who: "阿哲", text: "嗨" }],
      address: "mention",
    };
    expect(subject.unsupported(base)).toBeNull();
    const env = (tools: readonly string[]) => ({
      prompt: "",
      tools,
      call: () => ({ ok: true, text: "" }),
    });
    expect(subject.unsupported({ ...base, tools: env(["stream_start"]) })).toBe(
      "no fake tool definition for stream_start",
    );
    expect(subject.unsupported({ ...base, address: "dm" })).not.toBeNull();
    for (const task of TOOL_TASKS) {
      expect(subject.unsupported({ ...base, tools: env(task.tools) })).toBeNull();
    }
  });
});
