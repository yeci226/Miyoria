// The kinds of sub-agent (docs/design/v5-brain.md 「子代理」, v5-architecture.md §7.3, §14), each a
// row of one typed table: who it is (its system text), the tools it has for the whole run, what
// its tools may do to the world, its limits and its budget. A sub-agent runs on the same turn
// runner as she does, on the `subagent` profile, and differs from her only here:
//
// - its tool list is fixed when the job starts and never grows (no `find_tools`, no `skill`);
// - nothing with effect `say` or `spend` is ever offered to it, and a call of one is refused even
//   if the model makes it; a kind that reads outside content (`research`) may call nothing that
//   is not a read, whatever its list says;
// - it has no way out: a line it writes is a result, never said to anyone.

import { LoadedTools, type ToolEffect, type ToolEntry } from "@miyoria/llm/tools";
import type { TranscriptStore } from "@miyoria/memory/transcript";
import {
  CURATOR_SYSTEM,
  GOAL_AUTHOR,
  goalEntry,
  HELPER_REFUSALS,
  jobNow,
  REFLECT_SYSTEM,
  RESEARCH_SYSTEM,
} from "./delegate-texts.js";
import { PROFILES, type RunLimits, type RunProfile, withLimits } from "./profiles.js";
import {
  ALLOW,
  type Delivery,
  type Guard,
  type GuardCall,
  type GuardContext,
  type GuardVerdict,
  type Outlet,
  type PromptSource,
  type RunTools,
  refuse,
} from "./types.js";

export type SubagentKind = "research" | "curator" | "reflect";

export const SUBAGENT_KINDS: readonly SubagentKind[] = ["research", "curator", "reflect"];

/** Tokens a USD buys when a model has no price: `profiles.ts` counts 3M an hour for 1 USD. */
export const TOKENS_PER_USD = 3_000_000;

export interface KindSpec {
  kind: SubagentKind;
  /** She may start it. `false`: it is the program's own (the nightly reflection). */
  callable: boolean;
  /** Who it is: block 1 of its prompt (the runner adds its rules after it). */
  system: string;
  /** Its tools, fixed for the run; the ones not registered are left out. */
  tools: readonly string[];
  /** What its tools may do to the world; a listed tool of another effect is dropped. */
  effects: readonly ToolEffect[];
  /** The `subagent` profile's limits with the kind's own on top. */
  limits: Partial<RunLimits>;
  /** What one job may spend (USD): the default and the most she may ask for. */
  budget: { defaultUsd: number; maxUsd: number };
}

/**
 * Tools of a helper by name, never by the registry's core flag: a helper has what its row says.
 * `recall` is her memory search, `notebook_*` her notebook; the web tools only read.
 */
export const KINDS: Readonly<Record<SubagentKind, KindSpec>> = {
  research: {
    kind: "research",
    callable: true,
    system: RESEARCH_SYSTEM,
    tools: ["web_search", "web_read", "recall", "notebook_read"],
    effects: ["read"],
    limits: {
      rounds: 16,
      callsPerRound: 4,
      wallMs: 8 * 60_000,
      toolMs: 45_000,
      tokens: 500_000,
    },
    budget: { defaultUsd: 0.25, maxUsd: 1 },
  },
  curator: {
    kind: "curator",
    callable: true,
    system: CURATOR_SYSTEM,
    tools: ["notebook_read", "notebook_write", "notebook_delete", "recall"],
    effects: ["read", "act"],
    limits: {
      rounds: 20,
      callsPerRound: 6,
      wallMs: 8 * 60_000,
      toolMs: 30_000,
      tokens: 500_000,
    },
    budget: { defaultUsd: 0.25, maxUsd: 0.75 },
  },
  reflect: {
    kind: "reflect",
    callable: false,
    system: REFLECT_SYSTEM,
    tools: [],
    effects: ["read"],
    limits: { ...PROFILES.reflect.limits },
    budget: { defaultUsd: 0.5, maxUsd: 0.5 },
  },
};

export function isSubagentKind(value: string): value is SubagentKind {
  return (SUBAGENT_KINDS as readonly string[]).includes(value);
}

/** The kinds she may start, in the table's order. */
export const CALLABLE_KINDS: readonly SubagentKind[] = SUBAGENT_KINDS.filter(
  (k) => KINDS[k].callable,
);

/** The USD a job may spend: what was asked, within the kind's maximum; the default when unset. */
export function jobBudget(kind: SubagentKind, asked: number | null | undefined): number {
  const { defaultUsd, maxUsd } = KINDS[kind].budget;
  if (asked === null || asked === undefined || !Number.isFinite(asked) || asked <= 0) {
    return defaultUsd;
  }
  return Math.min(asked, maxUsd);
}

/** The profile one job of `kind` runs on, with `budgetUsd` as its own cap. */
export function profileOf(
  kind: SubagentKind,
  tools: ReadonlySet<string>,
  budgetUsd: number,
): RunProfile {
  const spec = KINDS[kind];
  const base = kind === "reflect" ? PROFILES.reflect : PROFILES.subagent;
  return {
    ...withLimits(base, {
      ...spec.limits,
      sessionUsdPerHour: budgetUsd,
      sessionTokensPerHour: Math.round(budgetUsd * TOKENS_PER_USD),
    }),
    offers: (tool) => tools.has(tool.name) && spec.effects.includes(tool.effect),
  };
}

/**
 * The tools of one job: the row's list, as far as each is registered and of an effect the kind may
 * use. Unlike hers, the list never grows (`find_tools` is not in it).
 */
export function jobTools(
  kind: SubagentKind,
  entry: (name: string) => ToolEntry | undefined,
): string[] {
  const spec = KINDS[kind];
  return spec.tools.filter((name) => {
    const e = entry(name);
    return e !== undefined && spec.effects.includes(e.effect);
  });
}

/** What the runner sees of the registry for one job: exactly the job's tools. */
export function fixedTools(
  registry: Pick<RunTools, "entry" | "run">,
  names: readonly string[],
): RunTools {
  return {
    offered: () => names.flatMap((n) => registry.entry(n) ?? []),
    entry: (name) => registry.entry(name),
    run: (name, ctx, args) => registry.run(name, ctx, args),
    loaded: new LoadedTools(),
  };
}

/**
 * The guard of a helper, before the real one: it refuses what a helper never does whatever the
 * model asks (a tool of effect `say` or `spend`, any tool not in its list, a tool of an effect its
 * kind does not use) and every line. The refusal is the call's result, so it is in the transcript.
 */
export function helperGuard(kind: SubagentKind, tools: ReadonlySet<string>): Guard {
  const spec = KINDS[kind];
  return {
    async checkCall({ entry }: GuardCall, _ctx: GuardContext): Promise<GuardVerdict> {
      if (
        entry.effect === "say" ||
        entry.effect === "spend" ||
        !spec.effects.includes(entry.effect)
      ) {
        return refuse("effect", HELPER_REFUSALS.effect(entry.name));
      }
      if (!tools.has(entry.name)) return refuse("listed", HELPER_REFUSALS.listed(entry.name));
      return ALLOW;
    },
    async checkLine(): Promise<GuardVerdict> {
      return refuse("no_mouth", HELPER_REFUSALS.mouth);
    },
  };
}

/** No way out: nothing a helper writes reaches anyone. */
export const noMouth: Outlet = {
  async deliver(): Promise<Delivery> {
    return { status: "blocked", reason: HELPER_REFUSALS.mouth };
  },
};

/**
 * The blocks of a helper's prompt: its system text, the owner's rules (they bind it as they bind
 * her), and what the job is. Nothing of hers: no memory, no people, no mood.
 */
export function helperPrompt(
  spec: KindSpec,
  pinned: (input: Parameters<PromptSource["pinned"]>[0]) => Promise<string | null>,
): PromptSource {
  return {
    fixed: async () => spec.system,
    pinned,
    place: async () => null,
    recalled: async () => null,
    now: async () => jobNow(spec.kind),
  };
}

/** The entry that opens a helper's transcript. */
export function goalLine(goal: string, spec: KindSpec): { author: string; content: string } {
  const rounds = spec.limits.rounds ?? PROFILES.subagent.limits.rounds;
  const wallMs = spec.limits.wallMs ?? PROFILES.subagent.limits.wallMs;
  return { author: GOAL_AUTHOR, content: goalEntry(goal, rounds, Math.round(wallMs / 60_000)) };
}

/**
 * `store` for a helper's runner: the same store, but its writes do not name a platform context.
 * `TranscriptStore.sessionFor` finds a place's session by the context last written to it, so a
 * helper's session must never claim her conversation's place.
 */
export function isolatedTranscript(store: TranscriptStore): TranscriptStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "append") {
        return (session: string, entries: Parameters<TranscriptStore["append"]>[1]) =>
          target.append(session, entries);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
