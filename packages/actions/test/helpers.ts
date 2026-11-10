// Fakes for the gate tests: services in a plain `ServiceRegistry`, a stub LLM router, an
// in-memory store, owners and a reply sink that records approval cards.

import {
  CommandRegistry,
  CommandRegistryKey,
  type CommandReply,
  Permissions,
  type ReplySink,
  ReplySinkKey,
} from "@miyoria/commands";
import { ServiceRegistry } from "@miyoria/kernel";
import { type ChatRequest, type ChatResponse, type LlmRouter, LlmRouterKey } from "@miyoria/llm";
import { AuditLogKey, openStore, SettingsStoreKey, type Store } from "@miyoria/store";
import { ToolRegistry } from "@miyoria/tools";
import {
  type AccountRef,
  type Attitude,
  type Authorizer,
  AuthorizerKey,
  BaseAuthorizer,
  type ContextKey,
  type Envelope,
  type Event,
  type MessageRef,
  SocialSignalsKey,
  type Subject,
} from "@miyoria/types";
import { z } from "zod";
import { type Capability, defineCapability } from "../src/index.js";
import { ActuatorRegistry } from "../src/registry.js";

export const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
export const OWEN: AccountRef = { platform: "discord", id: "100" };
export const AMY: AccountRef = { platform: "discord", id: "200" };
export const OWNER: AccountRef = { platform: "discord", id: "900" };

/** Grants exactly the listed `(account id, node)` pairs. */
export class FakeAuthorizer extends BaseAuthorizer implements Authorizer {
  readonly grants = new Set<string>();

  grant(account: AccountRef, node: string): this {
    this.grants.add(`${account.id}|${node}`);
    return this;
  }

  allowsSubject(subject: Subject, node: string): boolean {
    return this.grants.has(`${subject.account.id}|${node}`);
  }
}

/** Router stub: budget state, scripted review replies, recorded requests. */
export class FakeRouter {
  budget: "ok" | "degraded" | "exhausted" = "ok";
  readonly replies: (string | Error)[] = [];
  readonly requests: [string, ChatRequest][] = [];
  hasReview = true;
  /** Never answers (for timeouts). */
  hang = false;

  budgetState() {
    return this.budget;
  }

  configures(purpose: string): boolean {
    return purpose !== "review" || this.hasReview;
  }

  async complete(
    purpose: string,
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    this.requests.push([purpose, structuredClone(request)]);
    if (this.hang) {
      await new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    const next = this.replies.shift() ?? '{"verdict": "deny", "reason": "no script"}';
    if (next instanceof Error) throw next;
    return { text: next, reasoning: "", tool_calls: [], finish_reason: "stop", usage: null };
  }
}

export class FakeReplySink implements ReplySink {
  readonly platform = "discord";
  readonly sent: [AccountRef, CommandReply][] = [];
  /** Cards posted into a channel (receipts). */
  readonly cards: [ContextKey, CommandReply][] = [];
  fail = false;

  async sendCard(context: ContextKey, reply: CommandReply): Promise<MessageRef> {
    this.cards.push([context, reply]);
    return { context, id: "card1" };
  }

  async sendDirect(account: AccountRef, reply: CommandReply): Promise<MessageRef> {
    if (this.fail) throw new Error("cannot DM");
    this.sent.push([account, reply]);
    return { context: { platform: "discord", scope: null, channel: "dm1", kind: "dm" }, id: "m1" };
  }
}

export class FakeSocial {
  readonly attitudes = new Map<string, Attitude>();

  set(account: AccountRef, patch: Partial<Attitude>): void {
    this.attitudes.set(account.id, {
      person: `p${account.id}`,
      affinity: 0,
      trust: 50,
      familiarity: 50,
      blocked: false,
      label: "朋友",
      call_name: null,
      ...patch,
    });
  }

  attitude(account: AccountRef): Attitude | null {
    return this.attitudes.get(account.id) ?? null;
  }
}

export interface Gate {
  services: ServiceRegistry;
  registry: ActuatorRegistry;
  tools: ToolRegistry;
  authorizer: FakeAuthorizer;
  router: FakeRouter;
  replies: FakeReplySink;
  social: FakeSocial;
  store: Store;
  events: Event[];
  /** Runs of the test capabilities, by name. */
  runs: string[];
}

/** A registry with every fake service and the test capabilities `t.low`, `t.medium`, `t.high`. */
export async function gate(): Promise<Gate> {
  const services = new ServiceRegistry();
  const store = await openStore("memory://");
  const authorizer = new FakeAuthorizer();
  const router = new FakeRouter();
  const replies = new FakeReplySink();
  const social = new FakeSocial();
  const k = "test";
  services.provide(k, SettingsStoreKey, store.settings);
  services.provide(k, AuditLogKey, store.audit);
  services.provide(k, AuthorizerKey, authorizer);
  services.provide(k, LlmRouterKey, router as unknown as LlmRouter);
  services.provide(k, ReplySinkKey, replies);
  services.provide(k, SocialSignalsKey, social);
  const commands = new CommandRegistry(new Permissions([OWNER]), { services });
  services.provide(k, CommandRegistryKey, commands);
  const tools = new ToolRegistry();
  const events: Event[] = [];
  const registry = new ActuatorRegistry({ services, tools, publish: (e) => events.push(e) });
  const runs: string[] = [];
  for (const c of testCapabilities(runs)) registry.register(c);
  return { services, registry, tools, authorizer, router, replies, social, store, events, runs };
}

const Note = z.object({ note: z.string().min(1).nullish(), to: z.string().nullish() });
type Note = z.output<typeof Note>;

export function testCapabilities(runs: string[]): Capability[] {
  const make = (name: string, risk: "low" | "medium" | "high"): Capability =>
    defineCapability<Note>({
      name,
      summary: `test ${risk}`,
      risk,
      args: Note,
      permission: `test.${risk}`,
      tool: {
        name: name.replace(".", "_"),
        description: "測試。",
        properties: { note: { type: "string" } },
      },
      target: (args) => (args.to ? { platform: "discord", id: args.to } : null),
      lane: () => "act:test",
      async execute(args) {
        runs.push(name);
        return `ran ${name}${args.note ? `: ${args.note}` : ""}`;
      },
    }) as Capability;
  return [make("t.low", "low"), make("t.medium", "medium"), make("t.high", "high")];
}

/** The `gate.decision` payloads published so far. */
export function decisions(events: readonly Event[]): Record<string, unknown>[] {
  return events.flatMap((e) =>
    e.type === "custom" && e.data.topic === "gate.decision"
      ? [e.data.payload as Record<string, unknown>]
      : [],
  );
}

export type { Envelope };
