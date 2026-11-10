import {
  type AccountRef,
  type ContextKey,
  type ConversationFacts,
  contextKeyString,
  type Event,
  type Impulse,
  type ImpulseHost,
  type ImpulseInput,
  type ImpulseRun,
  newId,
  newImpulse,
  type TurnOutcomeRecord,
  toTimestamp,
} from "@miyoria/types";
import { type ArbiterConfig, ArbiterCore, type ArbiterEnv, arbiterConfig } from "../src/index.js";

/** 2026-11-03 14:00 local (UTC+8). */
export const T0 = Date.UTC(2026, 10, 3, 6, 0, 0);
export const MIN = 60_000;

export function textCtx(channel: string): ContextKey {
  return { platform: "discord", scope: "g", channel, kind: "channel" };
}

export function voiceCtx(channel: string): ContextKey {
  return { platform: "discord", scope: "g", channel, kind: "voice" };
}

export function acct(id: string): AccountRef {
  return { platform: "discord", id };
}

export class ManualClock {
  constructor(public t: number = T0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** A host that opens every turn unless told the place is busy or refuses. */
export class FakeHost implements ImpulseHost {
  readonly opened: Impulse[] = [];
  readonly facts_ = new Map<string, Partial<ConversationFacts>>();
  readonly busy = new Set<string>();
  next: ImpulseRun | null = null;

  facts(context: ContextKey): ConversationFacts {
    return {
      mode: context.kind === "channel" ? "normal" : null,
      start_gap_ms: 0,
      present: true,
      last_spoke_at: null,
      ...(this.facts_.get(contextKeyString(context)) ?? {}),
    };
  }

  set(context: ContextKey, facts: Partial<ConversationFacts>): void {
    this.facts_.set(contextKeyString(context), facts);
  }

  async open(impulse: Impulse): Promise<ImpulseRun> {
    const ctx = impulse.target.context;
    if (ctx !== null && this.busy.has(contextKeyString(ctx))) {
      return { status: "busy", detail: "a turn is in flight" };
    }
    if (this.next !== null) {
      const run = this.next;
      this.next = null;
      return run;
    }
    this.opened.push(impulse);
    return { status: "started", turn: newId(), task: null, detail: "" };
  }
}

export interface Rig {
  clock: ManualClock;
  host: FakeHost;
  events: Event[];
  arbiter: ArbiterCore;
  env: { paused: boolean; budget: "ok" | "degraded" | "exhausted"; blocked: Set<string> };
}

export function rig(overrides: Partial<ArbiterConfig> = {}, clock = new ManualClock()): Rig {
  const host = new FakeHost();
  const events: Event[] = [];
  const env = {
    paused: false,
    budget: "ok" as "ok" | "degraded" | "exhausted",
    blocked: new Set<string>(),
  };
  const deps: ArbiterEnv = {
    now: () => clock.now(),
    publish: (e) => events.push(e),
    paused: () => env.paused,
    budget: () => env.budget,
    blocked: (a) => env.blocked.has(a.id),
    host: () => host,
  };
  return { clock, host, events, env, arbiter: new ArbiterCore(arbiterConfig(overrides), deps) };
}

export function impulse(
  clock: ManualClock,
  input: Partial<ImpulseInput> & Pick<ImpulseInput, "source" | "context">,
): Impulse {
  return newImpulse({ ttlMs: 10 * MIN, why: "想聊天", hint: "聊點什麼", ...input }, clock.now());
}

/** Payloads of the custom events of `topic`. */
export function payloads<T>(events: readonly Event[], topic: string): T[] {
  return events.flatMap((e) =>
    e.type === "custom" && e.data.topic === topic ? [e.data.payload as unknown as T] : [],
  );
}

export function outcome(
  turn: string,
  context: ContextKey,
  type: "sent" | "silence",
  reason: TurnOutcomeRecord["reason"] = "initiative",
  at = T0,
): TurnOutcomeRecord {
  return {
    turn,
    context,
    reason,
    outcome: type === "sent" ? { type: "sent", parts: 1 } : { type: "silence" },
    addressed_by: [],
    focus: [],
    restarts: 0,
    reasoning: null,
    latency_ms: null,
    at: toTimestamp(at),
  };
}
