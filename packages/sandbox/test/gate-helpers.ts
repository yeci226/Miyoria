// An app-like actuator registry for the gate tests: scripted review replies, an owner reachable
// by DM, grants per account, a fake sandbox and proposed tools in memory.

import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/actions";
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
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import { type ToolContext, ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  ARBITER_IMPULSE_TOPIC,
  AuthorizerKey,
  BaseAuthorizer,
  type ContextKey,
  type Event,
  impulseReason,
  type MessageRef,
  type Principal,
  Principals,
  type Subject,
  v2Payload,
} from "@miyoria/types";
import {
  ProposedTools,
  type RunRequest,
  type RunResult,
  type Sandbox,
  SandboxGate,
  type SessionInfo,
  type ToolProposal,
} from "../src/index.js";

export const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
export const AMY: AccountRef = { platform: "discord", id: "200" };
export const OWNER: AccountRef = { platform: "discord", id: "900" };

export class Grants extends BaseAuthorizer {
  readonly grants = new Set<string>();
  grant(account: AccountRef, node: string): this {
    this.grants.add(`${account.id}|${node}`);
    return this;
  }
  allowsSubject(subject: Subject, node: string): boolean {
    return this.grants.has(`${subject.account.id}|${node}`);
  }
}

export class ScriptedRouter {
  readonly replies: string[] = [];
  readonly requests: ChatRequest[] = [];
  /** How long a review takes. */
  delayMs = 0;
  budgetState() {
    return "ok" as const;
  }
  configures(): boolean {
    return true;
  }
  async complete(_purpose: string, request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const text = this.replies.shift() ?? '{"verdict": "deny", "reason": "no script"}';
    return { text, reasoning: "", tool_calls: [], finish_reason: "stop", usage: null };
  }
  /** Queues a review verdict. */
  verdict(verdict: "allow" | "deny" | "uncertain", reason: string = verdict): this {
    this.replies.push(JSON.stringify({ verdict, reason }));
    return this;
  }
}

export class Cards implements ReplySink {
  /** Change it to make the owners (on Discord) unreachable. */
  platform = "discord";
  readonly sent: [AccountRef, CommandReply][] = [];
  #waiters: (() => void)[] = [];
  async sendDirect(account: AccountRef, reply: CommandReply): Promise<MessageRef> {
    this.sent.push([account, reply]);
    for (const wake of this.#waiters.splice(0)) wake();
    return { context: { platform: "discord", scope: null, channel: "dm", kind: "dm" }, id: "m" };
  }
  next(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

export class FakeSandbox implements Sandbox {
  readonly requests: RunRequest[] = [];
  stdout = "42\n";
  stderr = "";
  readonly tools = {
    list: async () => [],
    read: async () => null,
    save: async () => {
      throw new Error("unused");
    },
    remove: async () => false,
  };
  /** Thrown by the next `run`. */
  nextError: Error | null = null;
  async run(request: RunRequest): Promise<RunResult> {
    this.requests.push(structuredClone(request));
    const error = this.nextError;
    this.nextError = null;
    if (error) throw error;
    return {
      run_id: "01J00000000000000000000000",
      language: request.language,
      exit_code: 0,
      stdout: request.stdin === undefined ? this.stdout : `stdin=${request.stdin}`,
      stderr: this.stderr,
      stdout_truncated: false,
      stderr_truncated: false,
      files_out: [],
      files_out_truncated: false,
      duration_ms: 7,
      killed_reason: null,
      session:
        request.session === undefined || request.session === "fresh"
          ? null
          : { name: request.session, created: this.sessions.length === 0, closed: null },
    };
  }
  /** Session names `listSessions` reports. */
  sessions: string[] = [];
  readonly closed: string[] = [];
  async listSessions(): Promise<SessionInfo[]> {
    return this.sessions.map((name) => ({
      name,
      language: "python",
      created_at: 0,
      last_used_at: 0,
      runs: 1,
      disk_bytes: 2048,
      expires_at: Date.now() + 10 * 60_000,
      busy: false,
    }));
  }
  async closeSession(name: string): Promise<boolean> {
    if (!this.sessions.includes(name)) return false;
    this.sessions = this.sessions.filter((s) => s !== name);
    this.closed.push(name);
    return true;
  }
  async health() {
    return { available: true, server_version: "29", error: null, checked_at: 1 };
  }
}

export interface Harness {
  services: ServiceRegistry;
  registry: ActuatorRegistry;
  tools: ToolRegistry;
  proposed: ProposedTools;
  sandbox: FakeSandbox;
  router: ScriptedRouter;
  cards: Cards;
  grants: Grants;
  events: Event[];
  gate: SandboxGate;
}

/** `real`: run on this sandbox instead of the fake one (live tests). */
export function harness(real: Sandbox | null = null): Harness {
  const services = new ServiceRegistry();
  const k = "test";
  const store = new MemorySettingsStore();
  const router = new ScriptedRouter();
  const cards = new Cards();
  const grants = new Grants();
  services.provide(k, SettingsStoreKey, store);
  services.provide(k, LlmRouterKey, router as unknown as LlmRouter);
  services.provide(k, ReplySinkKey, cards);
  services.provide(k, AuthorizerKey, grants);
  services.provide(
    k,
    CommandRegistryKey,
    new CommandRegistry(new Permissions([OWNER]), { services }),
  );
  const tools = new ToolRegistry();
  services.provide(k, ToolRegistryKey, tools);
  const events: Event[] = [];
  const registry = new ActuatorRegistry({
    services,
    tools,
    publish: (e) => events.push(e),
    builtins: false,
  });
  services.provide(k, ActuatorRegistryKey, registry);
  // No cooldowns in tests (the defaults allow one medium / high run per 20 s).
  registry.configure({
    ...registry.config,
    medium: { per_day: 100, per_person_per_day: 100, cooldown_ms: 0 },
  });
  const sandbox = new FakeSandbox();
  const used = real ?? sandbox;
  const proposed = new ProposedTools({
    store,
    profile: "deepseek-chan",
    sandbox: used,
    maxTools: 10,
    maxCodeBytes: 64 * 1024,
  });
  const gate = new SandboxGate(registry, {
    sandbox: used,
    tools: proposed,
    resultChars: 900,
    toolTimeoutMs: real ? 60_000 : 5000,
  });
  return { services, registry, tools, proposed, sandbox, router, cards, grants, events, gate };
}

/** A reactive-turn tool context for `principal` (default: Amy asking). */
export function toolContext(principal: Principal = Principals.user(AMY, CTX)): ToolContext {
  return {
    turn: "01J0000000000000000000TURN",
    context: CTX,
    account: principal.requester ?? AMY,
    principal,
    message: { context: CTX, id: "m1" },
    priority: "request",
    signal: new AbortController().signal,
  };
}

export const SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

export function proposal(over: Partial<ToolProposal> = {}): ToolProposal {
  return {
    name: "shout",
    description: "Repeats text in capitals",
    language: "python",
    code: "import json,sys\nprint(json.load(sys.stdin)['text'].upper())\n",
    args_schema: SCHEMA,
    ...over,
  };
}

/** The follow-up impulses published so far (in the old `agent_initiative` shape). */
export function initiatives(events: readonly Event[]) {
  return events.flatMap((e) => {
    const impulse = v2Payload(e, ARBITER_IMPULSE_TOPIC);
    if (!impulse) return [];
    return [
      {
        context: impulse.target.context,
        reason: impulseReason(impulse),
        hint: impulse.hint ?? "",
        about: impulse.about,
      },
    ];
  });
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
