// Module-level test harness: a real supervisor with a stub `llm` module (mock providers) and a
// fake `scheduler` that records actions. Tests run with Vitest fake timers.

import { type ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/actions";
import { CommandsModule, type InvocationData, splitPath } from "@miyoria/commands";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  type Subscription,
  Supervisor,
  sleep,
} from "@miyoria/kernel";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  LlmRouter,
  LlmRouterKey,
  type ModelRef,
  parseModelRef,
  type StreamEvent,
} from "@miyoria/llm";
import { Profile, ProfileManifestSchema } from "@miyoria/profile";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import { type Tool, type ToolContext, ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  type Action,
  type ActionSink,
  ActionSinkKey,
  type ContextKey,
  type DecisionTrace,
  type Envelope,
  type Event,
  type IncomingMessage,
  type JsonValue,
  type MessageRef,
  type Priority,
  type TurnId,
  toTimestamp,
  type VoiceSink,
  VoiceSinkKey,
} from "@miyoria/types";
import { vi } from "vitest";
import { type AgentHandle, AgentHandleKey, AgentModule, type FetchLike } from "../src/index.js";

export class FakeSink implements ActionSink {
  readonly actions: Action[] = [];
  readonly cancelled: TurnId[] = [];

  async submit(action: Action): Promise<void> {
    this.actions.push(structuredClone(action));
  }

  async cancelTurn(turn: TurnId): Promise<void> {
    this.cancelled.push(turn);
  }

  sent(): [string, Priority][] {
    return this.actions.flatMap((a) =>
      a.payload.type === "send_message"
        ? [[a.payload.message.text, a.priority] as [string, Priority]]
        : [],
    );
  }

  texts(): string[] {
    return this.sent().map(([t]) => t);
  }

  reactions(): [MessageRef, string][] {
    return this.actions.flatMap((a) =>
      a.payload.type === "react"
        ? [[a.payload.message, a.payload.emoji] as [MessageRef, string]]
        : [],
    );
  }

  typing(): number {
    return this.actions.filter((a) => a.payload.type === "typing").length;
  }

  speakActions(): Action[] {
    return this.actions.filter((a) => a.payload.type === "speak");
  }

  /** `[text, emotion]` of every `speak` action, in submission order. */
  speeches(): [string, string | null][] {
    return this.actions.flatMap((a) =>
      a.payload.type === "speak"
        ? [[a.payload.text, a.payload.emotion] as [string, string | null]]
        : [],
    );
  }
}

export class Stub implements Module {
  readonly manifest;

  constructor(
    id: string,
    readonly provide: (ctx: ModuleContext) => void,
  ) {
    this.manifest = defineManifest(id, `${id} stub`);
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.provide(ctx);
  }
}

/** Chat provider that waits `delay` ms before answering `reply {n}` (n = call number). */
export class SlowProvider implements ChatProvider {
  readonly name = "slow";
  calls = 0;
  readonly requests: ChatRequest[] = [];

  constructor(readonly delay: number) {}

  async stream(request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    const n = ++this.calls;
    this.requests.push(structuredClone(request));
    const delay = this.delay;
    return (async function* (): ChatStream {
      await sleep(delay, signal);
      yield { type: "text_delta", text: `reply ${n}` };
      yield { type: "done", finish_reason: null, usage: null };
    })();
  }
}

/** Streams `[delayMs, event]` pairs, each after its delay; the last script repeats. */
export class Paced implements ChatProvider {
  readonly name = "paced";
  readonly requests: ChatRequest[] = [];

  constructor(readonly script: [number, StreamEvent][][]) {}

  async stream(request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const events = (this.script.length > 1 ? this.script.shift() : this.script[0]) ?? [];
    return (async function* (): ChatStream {
      for (const [delay, event] of events) {
        await sleep(delay, signal);
        yield event;
      }
    })();
  }
}

/** Test tool that records its calls and answers `"done"`. */
export class Probe implements Tool {
  readonly spec;
  readonly calls: [ToolContext, JsonValue][] = [];

  constructor(
    name: string,
    readonly permission: string | null = null,
    readonly delay = 0,
  ) {
    this.spec = { name, description: "probe", parameters: { type: "object" } };
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    this.calls.push([ctx, args]);
    await sleep(this.delay);
    return "done";
  }
}

/** Optional extras for the harness. */
export interface Setup {
  /** Run the real `commands` module with these owners. */
  owners?: string[];
  store?: MemorySettingsStore;
  tools?: Tool[];
  /** Provided by the "app" before the agent starts. */
  appTools?: ToolRegistry;
  /** Fixed decision roll (default 0: every positive probability passes). */
  roll?: number;
  /** Provided by the "app" as the voice module's sink. */
  voiceSink?: VoiceSink;
  /** Provided by the "app" as the actuator registry. */
  actuators?: ActuatorRegistry;
  /** `[llm.thinking]` of the router. */
  thinking?: Map<string, boolean>;
  /** `[llm.image_input]` of the router. */
  imageInput?: Map<string, boolean>;
  /** Image downloads of the agent (default: none allowed). */
  fetchImage?: FetchLike;
  /** Provides more "app" services before the agent starts. */
  provide?: (services: Supervisor["services"]) => void;
  /** More modules to run next to the agent (e.g. the arbiter), with their config. */
  modules?: [Module, JsonValue][];
  /** Modules the agent needs up before it starts (the fact layer). */
  before?: [Module, JsonValue][];
  /** The next model in the `chat` chain, for when the first one fails. */
  second?: ChatProvider;
  /** Her profile (default: the one-line stub of `profile(mode)`). */
  profile?: Profile;
}

export function profile(mode: string): Profile {
  const manifest = ProfileManifestSchema.parse({
    id: "test-chan",
    display_name: "DeepSeek-chan",
    nicknames: ["DeepSeek", "小鯨魚"],
    behavior: { default_channel_mode: mode },
  });
  return new Profile({
    dir: "",
    manifest,
    sections: [{ key: "identity", body: "你是住在深海的鯨魚娘。" }],
    examples: [],
    voice: null,
    avatar: null,
  });
}

const running: Harness[] = [];

/** Stops every harness created in the current test (call in `afterEach`). */
export async function stopHarnesses(): Promise<void> {
  for (const h of running.splice(0)) await h.sup.stopAll();
}

export class Harness {
  private constructor(
    readonly sup: Supervisor,
    readonly sink: FakeSink,
    readonly events: Subscription,
  ) {}

  static create(
    mode: string,
    config: JsonValue,
    chat: ChatProvider,
    fast: ChatProvider | null = null,
  ): Promise<Harness> {
    return Harness.build(mode, config, chat, fast, {});
  }

  static async build(
    mode: string,
    config: JsonValue,
    chat: ChatProvider,
    fast: ChatProvider | null,
    setup: Setup,
  ): Promise<Harness> {
    const sup = new Supervisor();
    if (setup.store) sup.services.provide("app", SettingsStoreKey, setup.store);
    if (setup.appTools) sup.services.provide("app", ToolRegistryKey, setup.appTools);
    if (setup.voiceSink) sup.services.provide("app", VoiceSinkKey, setup.voiceSink);
    if (setup.actuators) sup.services.provide("app", ActuatorRegistryKey, setup.actuators);
    setup.provide?.(sup.services);
    if (setup.owners) {
      await sup.register(new CommandsModule(), { owners: setup.owners }, true);
    }
    const events = sup.bus.subscribe("agent.*");

    const providers = new Map<string, ChatProvider>([["chat", chat]]);
    const purposes = new Map<string, ModelRef[]>([["chat", [parseModelRef("chat:m")]]]);
    if (setup.second) {
      providers.set("second", setup.second);
      purposes.get("chat")?.push(parseModelRef("second:m"));
    }
    if (fast) {
      providers.set("fast", fast);
      purposes.set("fast", [parseModelRef("fast:m")]);
    }
    const router = new LlmRouter(providers, purposes, {
      ...(setup.thinking ? { thinking: setup.thinking } : {}),
      ...(setup.imageInput ? { imageInput: setup.imageInput } : {}),
    });
    await sup.register(new Stub("llm", (ctx) => ctx.provide(LlmRouterKey, router)), null, true);
    const sink = new FakeSink();
    await sup.register(
      new Stub("scheduler", (ctx) => ctx.provide(ActionSinkKey, sink)),
      null,
      true,
    );
    for (const [module, cfg] of setup.before ?? []) await sup.register(module, cfg, true);
    const roll = setup.roll ?? 0;
    const agent = new AgentModule(setup.profile ?? profile(mode))
      .withRandom({ nextF32: () => roll })
      .withImageFetch(
        setup.fetchImage ??
          (async () => {
            throw new Error("no network in tests");
          }),
      );
    for (const tool of setup.tools ?? []) agent.tools().register(tool);
    await sup.register(agent, config, true);
    for (const [module, cfg] of setup.modules ?? []) await sup.register(module, cfg, true);
    await sup.startAll();
    const h = new Harness(sup, sink, events);
    running.push(h);
    return h;
  }

  publish(event: Event): void {
    this.sup.bus.publish("platform.test", event);
  }

  say(msg: IncomingMessage): void {
    this.publish({ type: "platform_message_created", data: msg });
  }

  drain(): Envelope[] {
    const out: Envelope[] = [];
    for (let env = this.events.tryRecv(); env !== null; env = this.events.tryRecv()) out.push(env);
    return out;
  }

  handle(): AgentHandle {
    return this.sup.services.require(AgentHandleKey);
  }

  /** Every decision published so far. */
  traces(): DecisionTrace[] {
    return this.drain().flatMap((e) => (e.event.type === "agent_decision" ? [e.event.data] : []));
  }

  /** `respond` of every decision published so far. */
  decisions(): boolean[] {
    return this.traces().map((d) => d.respond);
  }
}

export function noCheck(): JsonValue {
  return { attention: { llm_check: false } };
}

export function channel(id: string): ContextKey {
  return { platform: "test", scope: "guild", channel: id, kind: "channel" };
}

export function account(id: string): AccountRef {
  return { platform: "test", id };
}

let nextMessage = 0;
let lastTs = 0;

/** Strictly increasing timestamps, so ordering by time never ties. */
export function nextTs(): number {
  lastTs = Math.max(Date.now(), lastTs + 1);
  return lastTs;
}

export function incoming(ctx: ContextKey, who: string, text: string): IncomingMessage {
  const n = nextMessage++;
  return {
    id: { context: ctx, id: String(n) },
    author: { account: account(who), display_name: who, is_bot: false },
    text,
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(nextTs()),
  };
}

export function mention(ctx: ContextKey, who: string, text: string): IncomingMessage {
  return { ...incoming(ctx, who, text), mentions_self: true };
}

export function wait(ms: number): Promise<void> {
  return vi.advanceTimersByTimeAsync(ms).then(() => undefined);
}

export function done(): StreamEvent {
  return { type: "done", finish_reason: null, usage: null };
}

export function textDelta(text: string): StreamEvent {
  return { type: "text_delta", text };
}

export function toolCall(
  index: number,
  id: string | null,
  name: string | null,
  args: string,
): StreamEvent {
  return { type: "tool_call_delta", index, id, name, arguments: args };
}

export function command(
  path: string,
  who: string,
  args: Record<string, string> = {},
): InvocationData {
  return {
    path: splitPath(path),
    args,
    invoker: account(who),
    invoker_display_name: who,
    context: channel("c"),
    invoker_is_guild_admin: false,
  };
}

export { MemorySettingsStore, ToolRegistry };
