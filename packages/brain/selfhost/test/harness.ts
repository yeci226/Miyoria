// The agent module with the text runner installed, on a real supervisor: a scripted model behind
// a real router, a scheduler stand-in that settles every line like the platform did (and checks
// the one-mouth rule), an in-memory store with the transcripts. Nothing reaches a network.

import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  LlmRouter,
  LlmRouterKey,
  parseModelRef,
  type StreamEvent,
} from "@miyoria/llm/llm";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import { type TranscriptEntry, transcriptTables } from "@miyoria/memory/transcript";
import { type ModuleContext, type Subscription, Supervisor, sleep } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type Action,
  type ActionSink,
  ActionSinkKey,
  type ContextKey,
  type Envelope,
  Events,
  type IncomingMessage,
  type JsonValue,
  MouthKey,
  toTimestamp,
} from "@miyoria/types";
import { AgentModule, type FetchLike, type TextRunnerFactory } from "../../agent/src/index.js";
import { profile, Stub } from "../../agent/test/harness.js";
import { ArbiterModule } from "../../arbiter/src/index.js";
import { SelfHost, type SelfHostOptions } from "../src/index.js";

export const HER: AccountRef = { platform: "test", id: "her" };

export function channel(id: string): ContextKey {
  return { platform: "test", scope: "guild", channel: id, kind: "channel" };
}

export function dm(id: string): ContextKey {
  return { platform: "test", scope: null, channel: id, kind: "dm" };
}

export function account(id: string): AccountRef {
  return { platform: "test", id };
}

let nextMessage = 0;

export function line(
  context: ContextKey,
  who: string,
  text: string,
  extra: Partial<IncomingMessage> = {},
): IncomingMessage {
  const n = nextMessage++;
  return {
    id: { context, id: `m${n}` },
    author: { account: account(who), display_name: who, is_bot: false },
    text,
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(Date.now()),
    ...extra,
  };
}

export function mention(context: ContextKey, who: string, text: string): IncomingMessage {
  return line(context, who, text, { mentions_self: true });
}

// ---- the model -------------------------------------------------------------------------------

export const done = (finish = "stop"): StreamEvent => ({
  type: "done",
  finish_reason: finish,
  usage: { prompt_tokens: 100, completion_tokens: 10, cached_prompt_tokens: 0 },
});

/** A step that writes `text`. */
export function says(text: string): StreamEvent[] {
  return [{ type: "text_delta", text }, done()];
}

/** A step that calls `name` with `args`. */
export function calls(name: string, args: JsonValue, id = `call-${name}`): StreamEvent[] {
  return [
    { type: "tool_call_delta", index: 0, id, name, arguments: JSON.stringify(args) },
    done("tool_calls"),
  ];
}

export interface Step {
  events: StreamEvent[] | ((request: ChatRequest) => StreamEvent[]);
  /** Waited before the first event (the signal cuts it). */
  delay?: number;
}

/** Answers each request with the next step of its script; an empty step when it runs out. */
export class Scripted implements ChatProvider {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];
  readonly script: Step[] = [];

  push(...steps: (Step | StreamEvent[])[]): void {
    for (const s of steps) this.script.push(Array.isArray(s) ? { events: s } : s);
  }

  async stream(request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const step = this.script.shift() ?? { events: [done()] };
    const events = typeof step.events === "function" ? step.events(request) : step.events;
    const delay = step.delay ?? 0;
    return (async function* (): ChatStream {
      if (delay > 0) await sleep(delay, signal);
      for (const ev of events) {
        signal?.throwIfAborted();
        yield ev;
      }
    })();
  }
}

/** The text of every message of a request. */
export function textOf(request: ChatRequest | undefined): string {
  return (request?.messages ?? [])
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

// ---- the scheduler -------------------------------------------------------------------------

/** Records every action; settles each line as the platform would, with a message id. */
export class SettlingSink implements ActionSink {
  readonly actions: Action[] = [];
  readonly cancelled: string[] = [];
  /** Turns whose sentence that plays was stopped. */
  readonly interrupted: string[] = [];
  /** Lines that were not the main line's. */
  readonly strays: Action[] = [];
  #ctx: ModuleContext | null = null;
  #sent = 0;

  attach(ctx: ModuleContext): void {
    this.#ctx = ctx;
  }

  async submit(action: Action): Promise<void> {
    this.actions.push(structuredClone(action));
    const ctx = this.#ctx;
    const p = action.payload;
    if (ctx === null || p.type !== "send_message") return;
    if (ctx.services.get(MouthKey)?.owns(action.turn) !== true) this.strays.push(action);
    const id = `sent-${++this.#sent}`;
    queueMicrotask(() =>
      ctx.publish(Events.ActionSettled, {
        action: action.id,
        turn: action.turn,
        type: "send_message",
        context: p.context,
        text: p.message.text,
        ok: true,
        error: null,
        message: { context: p.context, id },
        blocked: action.blocked ?? null,
      }),
    );
  }

  async cancelTurn(turn: string): Promise<void> {
    this.cancelled.push(turn);
  }

  async interruptTurn(turn: string): Promise<void> {
    this.interrupted.push(turn);
  }

  /** `[context channel, text]` of every line sent. */
  sent(): [string, string][] {
    return this.actions.flatMap((a) =>
      a.payload.type === "send_message"
        ? [[a.payload.context.channel, a.payload.message.text] as [string, string]]
        : [],
    );
  }

  texts(): string[] {
    return this.sent().map(([, t]) => t);
  }
}

// ---- the rig -------------------------------------------------------------------------------

export interface RigOptions {
  /** `[modules.agent]` (short waits unless set). */
  config?: Record<string, JsonValue>;
  /** The profile's default channel mode. */
  mode?: string;
  store?: SqliteStore;
  host?: SelfHostOptions;
  /** More app services before the agent starts. */
  provide?: (sup: Supervisor, tools: ToolRegistry) => void;
  /** How images are downloaded (no network). */
  fetchImage?: FetchLike;
  /** The scripted model takes image parts. Default `true`. */
  images?: boolean;
  /** Runs the Arbiter module (`[modules.arbiter]` as given) after the agent. */
  arbiter?: Record<string, JsonValue>;
}

const running: Rig[] = [];

export async function stopRigs(): Promise<void> {
  for (const r of running.splice(0)) await r.stop();
}

export class Rig {
  readonly model = new Scripted();
  readonly sink = new SettlingSink();
  readonly tools = new ToolRegistry();
  readonly sup = new Supervisor({ clock: { now: () => Date.now() + this.shift } });
  readonly events: Subscription;
  readonly seen: Envelope[] = [];
  /** Added to the clock (glances, caps). */
  shift = 0;
  host: SelfHost | null = null;
  factoryCalls = 0;

  private constructor(readonly store: SqliteStore) {
    this.events = this.sup.bus.subscribe("*");
  }

  static async create(options: RigOptions = {}): Promise<Rig> {
    const store =
      options.store ?? (await SqliteStore.open(":memory:", { plugins: [transcriptTables] }));
    const rig = new Rig(store);
    const sup = rig.sup;
    sup.services.provide("app", StoreKey, store);
    sup.services.provide("app", ToolRegistryKey, rig.tools);
    options.provide?.(sup, rig.tools);
    const router = new LlmRouter(
      new Map<string, ChatProvider>([["scripted", rig.model]]),
      new Map([["chat", [parseModelRef("scripted:m")]]]),
      { imageInput: new Map([["scripted:m", options.images ?? true]]) },
    );
    await sup.register(new Stub("llm", (ctx) => ctx.provide(LlmRouterKey, router)), null, true);
    await sup.register(
      new Stub("scheduler", (ctx) => {
        rig.sink.attach(ctx);
        ctx.provide(ActionSinkKey, rig.sink);
      }),
      null,
      true,
    );
    const factory: TextRunnerFactory = (agent) => {
      rig.factoryCalls += 1;
      // No chance draws on their own: a test that wants a reaction-only answer passes `random`.
      rig.host = new SelfHost(agent, { random: () => 1, ...options.host });
      return rig.host;
    };
    const agent = new AgentModule(profile(options.mode ?? "normal")).withTextRunner(factory);
    if (options.fetchImage !== undefined) agent.withImageFetch(options.fetchImage);
    await sup.register(
      agent,
      {
        debounce_ms: 40,
        max_debounce_ms: 400,
        typing_extend_ms: 150,
        ...options.config,
      },
      true,
    );
    if (options.arbiter !== undefined) {
      await sup.register(new ArbiterModule("test"), options.arbiter, true);
    }
    await sup.startAll();
    sup.bus.publish("platform.test", Events.PlatformReady, { platform: "test", self_account: HER });
    running.push(rig);
    await sleep(10);
    return rig;
  }

  say(msg: IncomingMessage): void {
    this.sup.bus.publish("platform.test", Events.PlatformMessageCreated, msg);
  }

  typing(context: ContextKey, who: string): void {
    this.sup.bus.publish("platform.test", Events.PlatformTyping, {
      context,
      account: account(who),
    });
  }

  /** Every event so far. */
  drain(): Envelope[] {
    for (let env = this.events.tryRecv(); env !== null; env = this.events.tryRecv()) {
      this.seen.push(env);
    }
    return this.seen;
  }

  of<T>(type: string): T[] {
    return this.drain()
      .filter((e) => e.type === type)
      .map((e) => e.data as T);
  }

  entries(context: ContextKey): TranscriptEntry[] {
    const host = this.host;
    if (host === null) return [];
    return host.transcript.tail(host.sessionOf(context)).entries;
  }

  async stop(): Promise<void> {
    const i = running.indexOf(this);
    if (i >= 0) running.splice(i, 1);
    await this.sup.stopAll();
  }
}

/** Waits until `check` holds (real time), or fails after `ms`. */
export async function until(
  check: () => boolean,
  ms = 3_000,
  what = "the condition",
): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
