// Replays a log through the real pipeline: the agent with the conversations' runner
// (`@miyoria/brain/selfhost`), the gate (`actions`), the Arbiter, the ActivityManager, world,
// self and the mind, on one supervisor and one bus, as the core runs them. Only the edges are fake: the LLM
// (`ScriptedLlm`), the scheduler and the platforms (`ReplaySink`), and time (`ReplayClock`, the
// caller's fake timers: the kernel's timers and `Date.now()` are the global ones).

import { ActivityModule } from "@miyoria/brain/activity";
import { AgentModule } from "@miyoria/brain/agent";
import { ArbiterModule } from "@miyoria/brain/arbiter";
import { selfHost } from "@miyoria/brain/selfhost";
import { ActionsModule, ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { MindModule } from "@miyoria/heart/mind";
import { SelfModule } from "@miyoria/heart/self";
import { LlmRouter, LlmRouterKey, type ModelRef, parseModelRef } from "@miyoria/llm/llm";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import { FactsModule } from "@miyoria/memory/facts";
import { transcriptTables } from "@miyoria/memory/transcript";
import { WorldModule } from "@miyoria/memory/world";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  type Subscription,
  Supervisor,
} from "@miyoria/runtime/kernel";
import { Profile, ProfileManifestSchema } from "@miyoria/runtime/profile";
import {
  isReplayInput,
  type ReplayEntry,
  type ReplayLog,
  ReplayLogError,
} from "@miyoria/runtime/replay-log";
import { MemorySettingsStore, SettingsStoreKey, SqliteStore, StoreKey } from "@miyoria/store";
import {
  type AccountRef,
  ActionSinkKey,
  ActivityManagerKey,
  type ActivitySnapshot,
  type ActivityTask,
  type AnyEventDefinition,
  type BusEnvelope,
  Events,
  is,
  isJsonObject,
  type JsonValue,
  type Mouth,
  MouthKey,
  PromptContributors,
  PromptContributorsKey,
  sameAccount,
} from "@miyoria/types";
import { ReplaySink, ScriptedLlm } from "./fakes.js";

/** Fake time, driven by the caller (Vitest's fake timers in tests and in `pnpm replay`). */
export interface ReplayClock {
  /** Sets the wall clock (ms since the epoch) before anything runs. */
  setNow(ms: number): void;
  /** Lets `ms` pass, running every timer that falls due. */
  advance(ms: number): Promise<void>;
}

export interface ReplayRunOptions {
  clock: ReplayClock;
  /** Kept for callers that still pass one: nothing is left to the dice. */
  seed?: number;
}

/** Everything a replay produced, for the report. */
export interface ReplayRun {
  name: string;
  /** Her names (who addresses her by name). */
  names: string[];
  /** Her accounts (from `platform.ready`). */
  selfAccounts: AccountRef[];
  /** The input events replayed. */
  inputs: ReplayEntry[];
  /** Everything published on the bus while it ran, in order. */
  events: BusEnvelope[];
  sink: ReplaySink;
  llm: ScriptedLlm;
  /** `v3`: the mouth, to ask whose lines the sink saw. */
  mouth: Mouth | null;
  /** The ActivityManager at the end. */
  activity: { snapshot: ActivitySnapshot; tasks: ActivityTask[] } | null;
  /** Fake time replayed (ms). */
  durationMs: number;
}

const PROFILE_ID = "replay";
const DEFAULT_TAIL_MS = 60_000;
/** Longest single step of fake time (the bus subscription is drained in between). */
const MAX_STEP_MS = 5_000;

/** The replay's defaults per module (the log's `meta.modules` are merged over them). */
const DEFAULT_MODULES: Record<string, JsonValue> = {
  // No gray-zone `fast` checks: the scripted LLM would only decide by fiat.
  agent: {},
};

class Stub implements Module {
  readonly manifest;
  constructor(
    id: string,
    readonly provide: (ctx: ModuleContext) => void,
  ) {
    this.manifest = defineManifest(id, `${id} (replay)`);
  }
  async start(ctx: ModuleContext): Promise<void> {
    this.provide(ctx);
  }
}

function merge(base: JsonValue | undefined, over: JsonValue | undefined): JsonValue {
  if (over === undefined) return base ?? null;
  if (!isJsonObject(base) || !isJsonObject(over)) return over;
  const out: Record<string, JsonValue> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

function profileOf(log: ReplayLog): Profile {
  const her = log.meta.her ?? {};
  return new Profile({
    dir: "",
    manifest: ProfileManifestSchema.parse({
      id: PROFILE_ID,
      display_name: her.display_name ?? "Miyoria",
      nicknames: her.nicknames ?? ["米優"],
      behavior: { default_channel_mode: "normal" },
    }),
    sections: [{ key: "identity", body: "你是 Miyoria,一個傲嬌的虛擬主播。" }],
    examples: [],
    voice: null,
    avatar: null,
  });
}

/** Her own messages and speech in a recorded log are her output: recomputed, not replayed. */
function isHers(entry: ReplayEntry, self: readonly AccountRef[]): boolean {
  if (is(Events.PlatformMessageCreated, entry)) {
    return self.some((a) => sameAccount(a, entry.data.author.account));
  }
  if (is(Events.VoiceUtteranceEvent, entry)) {
    return self.some((a) => sameAccount(a, entry.data.speaker.account));
  }
  return false;
}

/** Every bus topic's definition. */
const DEFINITIONS: readonly AnyEventDefinition[] = Object.values(Events);

/** The definition a line is published by: its type's own, else the family that covers it. */
function definitionOf(entry: ReplayEntry): AnyEventDefinition {
  const own = DEFINITIONS.find((d) => d.type === entry.type && d.v === entry.v);
  const definition = own ?? DEFINITIONS.find((d) => d.type.includes("*") && is(d, entry));
  if (definition === undefined) {
    throw new ReplayLogError(`no bus event definition for \`${entry.type}\` v${entry.v}`);
  }
  return definition;
}

/**
 * Publishes a recorded line again: the same type, payload and place, from the same module, now.
 * Its `id`, `parent` and `turn` name events of the recorded run, which the replay recomputes.
 */
function republish(sup: Supervisor, entry: ReplayEntry): void {
  sup.bus.publish(entry.source, definitionOf(entry), entry.data, {
    type: entry.type,
    session: entry.session,
    space_id: entry.space_id,
    room_id: entry.room_id,
    person_id: entry.person_id,
    account_id: entry.account_id,
    key: entry.key,
    scope: entry.scope,
  });
}

/** Runs `log` and returns everything it produced. */
export async function replay(log: ReplayLog, options: ReplayRunOptions): Promise<ReplayRun> {
  const { clock } = options;
  const first = log.entries[0];
  const start = first ? Date.parse(first.at) : Date.UTC(2026, 10, 3, 6, 0, 0);
  clock.setNow(start);
  const now = () => Date.now();

  const sup = new Supervisor();
  const events: BusEnvelope[] = [];
  const all: Subscription = sup.bus.subscribe("*");
  const drain = () => {
    for (let env = all.tryRecv(); env !== null; env = all.tryRecv()) events.push(env);
  };

  const services = sup.services;
  services.provide("app", SettingsStoreKey, new MemorySettingsStore());
  const tools = new ToolRegistry();
  services.provide("app", ToolRegistryKey, tools);
  services.provide("app", PromptContributorsKey, new PromptContributors());
  const actuators = new ActuatorRegistry({
    services,
    tools,
    publish: sup.bus.publisher("actions"),
  });
  services.provide("app", ActuatorRegistryKey, actuators);

  const llm = new ScriptedLlm(log.meta.llm ?? {});
  const chain: ModelRef[] = [parseModelRef("scripted:m")];
  const router = new LlmRouter(
    new Map([["scripted", llm]]),
    new Map(["chat", "fast", "summarizer"].map((p) => [p, chain])),
  );
  const sink = new ReplaySink(sup.bus, now);
  const profile = profileOf(log);
  const config = (id: string) => merge(DEFAULT_MODULES[id], log.meta.modules?.[id]);

  await sup.register(new Stub("llm", (ctx) => ctx.provide(LlmRouterKey, router)), null, true);
  await sup.register(new Stub("scheduler", (ctx) => ctx.provide(ActionSinkKey, sink)), null, true);
  // The conversations' runner keeps its transcripts in the store, as in the core.
  const store = await SqliteStore.open(":memory:", { plugins: [transcriptTables] });
  services.provide("app", StoreKey, store);
  const agent = new AgentModule(profile).withTextRunner(selfHost());
  const modules: Module[] = [
    // First, as in the core: the main line and the Floor read the log.
    new FactsModule(null, PROFILE_ID, { names: profile.names() }),
    agent,
    new ActionsModule(profile.displayName),
    new ActivityModule(),
    new WorldModule(),
    new SelfModule(PROFILE_ID),
    new ArbiterModule(PROFILE_ID),
    new MindModule(PROFILE_ID, { name: profile.displayName }),
  ];
  for (const m of modules) await sup.register(m, config(m.manifest.id), true);
  await sup.startAll();
  drain();
  const mouth = services.get(MouthKey) ?? null;

  const advance = async (ms: number) => {
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, MAX_STEP_MS);
      await clock.advance(step);
      drain();
      left -= step;
    }
  };

  const selfAccounts: AccountRef[] = [];
  const inputs: ReplayEntry[] = [];
  try {
    for (const entry of log.entries) {
      const delay = Date.parse(entry.at) - now();
      if (delay > 0) await advance(delay);
      if (
        is(Events.PlatformReady, entry) &&
        !selfAccounts.some((a) => sameAccount(a, entry.data.self_account))
      ) {
        selfAccounts.push(entry.data.self_account);
      }
      if (!isReplayInput(entry.type, entry.source) || isHers(entry, selfAccounts)) continue;
      inputs.push(entry);
      republish(sup, entry);
      await clock.advance(0);
      drain();
    }
    await advance(log.meta.tail_ms ?? DEFAULT_TAIL_MS);
    const manager = services.get(ActivityManagerKey);
    const activity = manager ? { snapshot: manager.snapshot(), tasks: manager.tasks() } : null;
    return {
      name: log.meta.name ?? "replay",
      names: profile.names(),
      selfAccounts,
      inputs,
      events,
      sink,
      llm,
      mouth,
      activity,
      durationMs: now() - start,
    };
  } finally {
    await sup.stopAll();
    await store.close();
    all.close();
  }
}
