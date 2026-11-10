// A real supervisor with the learning modules, a stub `llm` module (mock or custom provider),
// an in-memory settings store and message log, and the app's prompt contributor / tool
// registries.

import { defineManifest, type Module, type ModuleContext, Supervisor } from "@miyoria/kernel";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  LlmRouter,
  LlmRouterKey,
  type ModelRef,
  parseModelRef,
} from "@miyoria/llm";
import {
  type AuthoredEntry,
  type LogEntry,
  MemorySettingsStore,
  type MessageLog,
  MessageLogKey,
  SettingsStoreKey,
} from "@miyoria/store";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  type Attitude,
  type ContextKey,
  contextKeyEquals,
  type Envelope,
  type Event,
  type IncomingMessage,
  newId,
  type ProfileId,
  PromptContributors,
  PromptContributorsKey,
  type PromptRequest,
  SocialSignalsKey,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { vi } from "vitest";
import { ConversationModule, KnowledgeModule, ReflectModule } from "../src/index.js";

export const P: ProfileId = "p";
export const TEXT: ContextKey = {
  platform: "discord",
  scope: "g1",
  channel: "c1",
  kind: "channel",
};
export const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
export const OWEN: AccountRef = { platform: "discord", id: "100" };
export const AMY: AccountRef = { platform: "discord", id: "200" };
export const HER: AccountRef = { platform: "discord", id: "999" };

export class FakeLog implements MessageLog {
  readonly entries: LogEntry[] = [];
  async append(entry: LogEntry): Promise<void> {
    this.entries.push(structuredClone(entry));
  }
  async recent(profile: ProfileId, context: ContextKey, limit: number): Promise<LogEntry[]> {
    const all = this.entries.filter(
      (e) => e.profile === profile && contextKeyEquals(e.context, context),
    );
    return all.slice(Math.max(all.length - limit, 0)).map((e) => structuredClone(e));
  }

  async authoredSince(
    profile: ProfileId,
    authors: readonly AccountRef[],
    since: Timestamp,
    limit: number,
  ): Promise<AuthoredEntry[]> {
    const from = Date.parse(since);
    const all = this.entries
      .filter(
        (e) =>
          e.profile === profile &&
          !e.is_self &&
          Date.parse(e.ts) >= from &&
          authors.some((a) => a.platform === e.author.platform && a.id === e.author.id),
      )
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    return all
      .slice(Math.max(all.length - limit, 0))
      .map((e) => ({ ts: e.ts, kind: e.context.kind }));
  }
  async purge(): Promise<number> {
    const n = this.entries.length;
    this.entries.length = 0;
    return n;
  }
}

/** A provider whose calls never finish (until aborted). */
export class HangingProvider implements ChatProvider {
  readonly name = "hang";
  calls = 0;
  async stream(_request: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    this.calls++;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
}

class Stub implements Module {
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

const PEOPLE: Record<string, string> = { [OWEN.id]: "p-owen", [AMY.id]: "p-amy" };

export interface Rig {
  sup: Supervisor;
  store: MemorySettingsStore;
  log: FakeLog;
  contributors: PromptContributors;
  tools: ToolRegistry;
  publish(event: Event): void;
  /** Says a line: appended to the log and published like the recorder does. */
  say(context: ContextKey, author: AccountRef, name: string, text: string): Promise<void>;
  contribute(key: string, request: PromptRequest): Promise<string | null>;
  events(topic: string): Envelope[];
}

const running: Supervisor[] = [];

export async function stopRigs(): Promise<void> {
  for (const s of running.splice(0)) await s.stopAll();
}

export interface RigOptions {
  provider: ChatProvider;
  store?: MemorySettingsStore;
  log?: FakeLog;
  conversation?: unknown;
  knowledge?: unknown;
  reflect?: unknown;
  modules?: ("conversation" | "knowledge" | "reflect")[];
  extra?: (sup: Supervisor) => Promise<void>;
}

export async function rig(options: RigOptions): Promise<Rig> {
  const sup = new Supervisor();
  running.push(sup);
  const store = options.store ?? new MemorySettingsStore();
  const log = options.log ?? new FakeLog();
  const contributors = new PromptContributors();
  const tools = new ToolRegistry();
  sup.services.provide("app", SettingsStoreKey, store);
  sup.services.provide("app", MessageLogKey, log);
  sup.services.provide("app", PromptContributorsKey, contributors);
  sup.services.provide("app", ToolRegistryKey, tools);
  const purposes = new Map<string, ModelRef[]>([
    ["summarizer", [parseModelRef("p:sum")]],
    ["chat", [parseModelRef("p:chat")]],
  ]);
  const router = new LlmRouter(new Map([["p", options.provider]]), purposes);
  await sup.register(new Stub("llm", (ctx) => ctx.provide(LlmRouterKey, router)), null, true);
  await sup.register(
    new Stub("social", (ctx) =>
      ctx.provide(SocialSignalsKey, {
        attitude: (a: AccountRef): Attitude | null =>
          PEOPLE[a.id]
            ? {
                person: PEOPLE[a.id] as string,
                affinity: 30,
                trust: 40,
                familiarity: 50,
                blocked: false,
                label: "朋友",
                call_name: null,
              }
            : null,
      }),
    ),
    null,
    true,
  );
  await options.extra?.(sup);
  const want = options.modules ?? ["knowledge", "conversation"];
  if (want.includes("knowledge")) {
    await sup.register(new KnowledgeModule(P), (options.knowledge ?? null) as never, true);
  }
  if (want.includes("conversation")) {
    await sup.register(new ConversationModule(P), (options.conversation ?? null) as never, true);
  }
  if (want.includes("reflect")) {
    await sup.register(
      new ReflectModule(P, { name: "DeepSeek-chan", names: ["deepseek", "小鯨"] }),
      (options.reflect ?? null) as never,
      true,
    );
  }
  const sub = sup.bus.subscribe("*");
  const seen: Envelope[] = [];
  await sup.startAll();
  const drain = () => {
    for (let e = sub.tryRecv(); e !== null; e = sub.tryRecv()) seen.push(e);
  };
  return {
    sup,
    store,
    log,
    contributors,
    tools,
    publish: (event) => sup.bus.publish("test", event),
    say: async (context, author, name, text) => {
      const isSelf = author.id === HER.id;
      const msg: IncomingMessage = {
        id: { context, id: newId() },
        author: { account: author, display_name: name, is_bot: false },
        text,
        mentions_self: false,
        reply_to_self: false,
        attachments: [],
        ts: toTimestamp(Date.now()),
      };
      await log.append({
        id: newId(),
        profile: P,
        context,
        author,
        author_name: name,
        text,
        is_self: isSelf,
        ts: msg.ts,
        turn: null,
      });
      if (context.kind === "voice" && !isSelf) {
        sup.bus.publish("voice", {
          type: "voice_utterance",
          data: {
            id: msg.id.id,
            context,
            speaker: msg.author,
            text,
            language: null,
            emotion: null,
            audio_events: [],
            started_at: msg.ts,
            ended_at: msg.ts,
            asr_ms: 0,
          },
        });
      } else {
        sup.bus.publish("discord", { type: "platform_message_created", data: msg });
      }
    },
    contribute: async (key, request) => {
      const c = contributors.all().find((x) => x.key === key);
      const sections = (await c?.contribute(request)) ?? [];
      return sections[0]?.body ?? null;
    },
    events: (topic) => {
      drain();
      return seen.filter((e) => e.event.type === "custom" && e.event.data.topic === topic);
    },
  };
}

export function request(context: ContextKey, people: AccountRef[] = [OWEN]): PromptRequest {
  return {
    profile: P,
    turn: newId(),
    context,
    participants: people.map((a) => ({
      account: a,
      display_name: a.id === OWEN.id ? "Owen" : "Amy",
      person: PEOPLE[a.id] ?? null,
    })),
    speakers: people.slice(0, 1),
    query: "",
    recent: [],
    voice: context.kind === "voice",
    now: toTimestamp(Date.now()),
  };
}

export function wait(ms: number): Promise<void> {
  return vi.advanceTimersByTimeAsync(ms).then(() => undefined);
}
