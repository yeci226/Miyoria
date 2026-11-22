// A runner on an in-memory transcript, a real tool registry, a scripted model and an outlet that
// records what she says. Nothing reaches a network.

import {
  type ChatRequest,
  type ChatResponse,
  type Pricing,
  pricing,
  type StreamEvent,
  type Usage,
} from "@miyoria/llm/llm";
import { defineTool, type Tool, type ToolEffect, ToolRegistry } from "@miyoria/llm/tools";
import {
  type EntryInput,
  type TranscriptStore,
  transcriptTables,
} from "@miyoria/memory/transcript";
import { getLogger, type Logger } from "@miyoria/runtime/kernel";
import { SqliteStore } from "@miyoria/store";
import { type ContextKey, dataBlock, type JsonValue } from "@miyoria/types";
import { z } from "zod";
import { permissiveGuard } from "../src/guard.js";
import { PROFILES, type RunProfile } from "../src/profiles.js";
import { type RunnerOptions, SelfRunner } from "../src/run.js";
import type {
  Delivery,
  Guard,
  ModelStream,
  OutgoingLine,
  Outlet,
  PromptSource,
  RunEvent,
  RunModel,
  RunPorts,
  RunResult,
  RunSession,
  Wake,
  WakeAuthor,
} from "../src/types.js";

export const T0 = Date.UTC(2026, 10, 16, 4);
export const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
export const OTHER: ContextKey = {
  platform: "discord",
  scope: "g1",
  channel: "c2",
  kind: "channel",
};
export const SESSION: RunSession = { id: "s1", context: CTX };
export const OWEN: WakeAuthor = { account: { platform: "discord", id: "u1" }, name: "Owen" };
export const MODEL = "scripted:m";

export const USAGE: Usage = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  cached_prompt_tokens: 800,
  reasoning_tokens: 10,
};

export function addressed(id = "m1"): Wake {
  return { kind: "addressed", reason: "mention", from: OWEN, message: { context: CTX, id } };
}

// ---- the model -----------------------------------------------------------------------------

export const done = (usage: Usage | null = USAGE, finish = "stop"): StreamEvent => ({
  type: "done",
  finish_reason: finish,
  usage,
});

/** A step that writes `text` (and thinks `reasoning` first). */
export function say(text: string, reasoning = ""): StreamEvent[] {
  const out: StreamEvent[] = [];
  if (reasoning !== "") out.push({ type: "reasoning_delta", text: reasoning });
  // In pieces, as a stream comes.
  for (const piece of text.match(/[\s\S]{1,3}/g) ?? [])
    out.push({ type: "text_delta", text: piece });
  out.push(done());
  return out;
}

export interface ScriptCall {
  id?: string;
  name: string;
  args?: JsonValue | string;
}

/** A step that calls `calls` (after writing `text`, thinking `reasoning`). */
export function calls(list: readonly ScriptCall[], text = "", reasoning = ""): StreamEvent[] {
  const out: StreamEvent[] = say(text, reasoning).filter((e) => e.type !== "done");
  list.forEach((c, index) => {
    const args = typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {});
    out.push({
      type: "tool_call_delta",
      index,
      id: c.id ?? `c-${c.name}-${index}`,
      name: c.name,
      arguments: args.slice(0, 2),
    });
    out.push({ type: "tool_call_delta", index, id: null, name: null, arguments: args.slice(2) });
  });
  out.push(done(USAGE, "tool_calls"));
  return out;
}

export type ScriptStep = StreamEvent[] | Error | ((request: ChatRequest) => StreamEvent[]);

/** Answers each step from `script` in order (the last one again when it runs out). */
export class ScriptedModel implements RunModel {
  readonly requests: ChatRequest[] = [];
  readonly purposes: string[] = [];
  readonly summarised: ChatRequest[] = [];
  /** Called before each event is given out. */
  onEvent: (event: StreamEvent, step: number) => void = () => undefined;

  constructor(
    readonly script: readonly ScriptStep[],
    readonly prices_: Record<string, Pricing> = {
      [MODEL]: pricing({ input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 2 }),
    },
  ) {}

  async stream(purpose: string, request: ChatRequest, signal?: AbortSignal): Promise<ModelStream> {
    signal?.throwIfAborted();
    this.requests.push(structuredClone(request));
    this.purposes.push(purpose);
    const index = this.requests.length - 1;
    const step = this.script[Math.min(index, this.script.length - 1)] ?? say("");
    if (step instanceof Error) throw step;
    const events = typeof step === "function" ? step(request) : step;
    const onEvent = this.onEvent;
    async function* run(): AsyncGenerator<StreamEvent> {
      for (const ev of events) {
        onEvent(ev, index);
        signal?.throwIfAborted();
        yield ev;
      }
    }
    return Object.assign(run(), { model: MODEL });
  }

  async complete(_purpose: string, request: ChatRequest): Promise<ChatResponse> {
    this.summarised.push(structuredClone(request));
    return {
      text: "之前聊了很多。",
      reasoning: "",
      tool_calls: [],
      finish_reason: "stop",
      usage: null,
    };
  }

  prices(): Record<string, Pricing> {
    return this.prices_;
  }
}

// ---- the outlet ----------------------------------------------------------------------------

export class RecordingOutlet implements Outlet {
  readonly lines: OutgoingLine[] = [];
  /** A line this returns a reason for is blocked. */
  block: (line: OutgoingLine) => string | null = () => null;

  async deliver(line: OutgoingLine, signal: AbortSignal): Promise<Delivery> {
    signal.throwIfAborted();
    const reason = this.block(line);
    if (reason !== null) return { status: "blocked", reason };
    this.lines.push(line);
    return { status: "delivered", message_id: `out-${this.lines.length}` };
  }

  texts(): string[] {
    return this.lines.map((l) => l.text);
  }
}

// ---- tools ---------------------------------------------------------------------------------

export interface FakeToolOptions {
  effect?: ToolEffect;
  core?: boolean;
  group?: string;
  speed?: "instant" | "long";
  description?: string;
  call?: (args: JsonValue, ctx: Parameters<Tool["call"]>[0]) => Promise<string> | string;
}

/** A tool for the new runner that answers `answer` (or what `call` gives). */
export function fakeTool(name: string, answer = `${name} 的結果`, o: FakeToolOptions = {}): Tool {
  return defineTool({
    name,
    description: o.description ?? `測試用的工具 ${name}。`,
    parameters: z.object({ q: z.string().optional() }),
    effect: o.effect ?? "read",
    speed: o.speed ?? "instant",
    risk: "low",
    group: o.group ?? "test",
    core: o.core ?? true,
    next: true,
    readOnly: (o.effect ?? "read") === "read",
    async call(ctx, args) {
      return o.call ? await o.call(args, ctx) : answer;
    },
  });
}

// ---- the rig -------------------------------------------------------------------------------

export interface Rig {
  store: SqliteStore;
  transcript: TranscriptStore;
  tools: ToolRegistry;
  model: ScriptedModel;
  outlet: RecordingOutlet;
  events: RunEvent[];
  clock: { now: () => number; tick: (ms: number) => void };
  runner: SelfRunner;
  /** One run of the text profile (or `profile`) for `wake`. */
  run(wake?: Wake, options?: { profile?: RunProfile; signal?: AbortSignal }): Promise<RunResult>;
  /** Appends someone's line to the session's transcript. */
  line(author: string, content: string, extra?: Partial<EntryInput>): void;
}

export interface RigOptions {
  guard?: Guard;
  prompt?: Partial<PromptSource>;
  runner?: RunnerOptions;
  store?: SqliteStore;
  tools?: ToolRegistry;
  beforeCompaction?: RunPorts["beforeCompaction"];
  log?: Logger;
}

export const PROMPT: PromptSource = {
  fixed: async () => "# 你是測試角色\n說話很短。",
  pinned: async () => "# 主人規則(一定要遵守)\n- 不要玩 Minecraft",
  place: async () => dataBlock("people", "在場的人", '<person name="Owen" relation="朋友"/>'),
  recalled: async (input) => dataBlock("memory", "想起的事", `第 ${input.turn} 回合想起的事`),
  now: async (input) => `時間:${new Date(input.now).toISOString()}`,
};

export async function rig(script: readonly ScriptStep[], options: RigOptions = {}): Promise<Rig> {
  let now = T0;
  const clock = {
    now: () => now,
    tick: (ms: number) => {
      now += ms;
    },
  };
  const store =
    options.store ?? (await SqliteStore.open(":memory:", { plugins: [transcriptTables], clock }));
  const transcript = store.plugin(transcriptTables);
  const tools = options.tools ?? new ToolRegistry();
  const model = new ScriptedModel(script);
  const outlet = new RecordingOutlet();
  const events: RunEvent[] = [];
  const runner = new SelfRunner(
    {
      transcript,
      tools,
      model,
      prompt: { ...PROMPT, ...options.prompt },
      guard: options.guard ?? permissiveGuard,
      outlet,
      clock,
      log: options.log ?? getLogger("brain.self.test"),
      onEvent: (e) => events.push(e),
      random: () => 0,
      ...(options.beforeCompaction ? { beforeCompaction: options.beforeCompaction } : {}),
    },
    options.runner ?? { compaction: null },
  );
  let turns = 0;
  let messages = 0;
  return {
    store,
    transcript,
    tools,
    model,
    outlet,
    events,
    clock,
    runner,
    run: (wake = addressed(), o = {}) =>
      runner.run({
        session: SESSION,
        wake,
        profile: o.profile ?? PROFILES.text,
        signal: o.signal ?? new AbortController().signal,
        turn: `t${++turns}`,
      }),
    line: (author, content, extra = {}) => {
      transcript.append(
        SESSION.id,
        [
          {
            kind: "other",
            author,
            content,
            account: OWEN.account,
            message_id: `m${++messages}`,
            ...extra,
          },
        ],
        { context: CTX },
      );
    },
  };
}

/** The text of every message of a request, one per line. */
export function promptText(request: ChatRequest | undefined): string {
  return (request?.messages ?? [])
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}
