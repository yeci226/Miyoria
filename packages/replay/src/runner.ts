// Replays a log through the real pipeline: the agent (coordinator, attention, turns, prompt
// compiler), the gate (`actions`), the Arbiter, the ActivityManager, world, self and the mind,
// on one supervisor and one bus, as the core runs them. Only the edges are fake: the LLM
// (`ScriptedLlm`), the scheduler and the platforms (`ReplaySink`), and time (`ReplayClock`, the
// caller's fake timers: the kernel's timers and `Date.now()` are the global ones).

import { ActionsModule, ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/actions";
import { ActivityModule } from "@miyoria/activity";
import { AgentModule } from "@miyoria/agent";
import { ArbiterModule } from "@miyoria/arbiter";
import { FactsModule } from "@miyoria/facts";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  type Subscription,
  Supervisor,
} from "@miyoria/kernel";
import { LlmRouter, LlmRouterKey, type ModelRef, parseModelRef } from "@miyoria/llm";
import { MindModule } from "@miyoria/mind";
import { Profile, ProfileManifestSchema } from "@miyoria/profile";
import { SelfModule } from "@miyoria/self";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  ActionSinkKey,
  ActivityManagerKey,
  type ActivitySnapshot,
  type ActivityTask,
  type Envelope,
  isJsonObject,
  type JsonValue,
  type Mouth,
  MouthKey,
  type Pipeline,
  PipelineKey,
  PromptContributors,
  PromptContributorsKey,
  sameAccount,
} from "@miyoria/types";
import { WorldModule } from "@miyoria/world";
import { ReplaySink, ScriptedLlm } from "./fakes.js";
import { entryTopic, isReplayInput, type ReplayEntry, type ReplayLog } from "./log.js";

/** Fake time, driven by the caller (Vitest's fake timers in tests and in `pnpm replay`). */
export interface ReplayClock {
  /** Sets the wall clock (ms since the epoch) before anything runs. */
  setNow(ms: number): void;
  /** Lets `ms` pass, running every timer that falls due. */
  advance(ms: number): Promise<void>;
}

export interface ReplayRunOptions {
  clock: ReplayClock;
  /** Seed of her attention's dice (default 1). */
  seed?: number;
  /** Which brain runs (default `v2`, what the scenarios were recorded against). */
  pipeline?: Pipeline;
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
  events: Envelope[];
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
  agent: { attention: { llm_check: false } },
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

/** A small deterministic PRNG (mulberry32), so a replay is repeatable. */
function seeded(seed: number): { nextF32(): number } {
  let a = seed >>> 0;
  return {
    nextF32() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
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
  const e = entry.event;
  if (e.type === "platform_message_created") {
    return self.some((a) => sameAccount(a, e.data.author.account));
  }
  if (e.type === "voice_utterance") return self.some((a) => sameAccount(a, e.data.speaker.account));
  return false;
}

/** Runs `log` and returns everything it produced. */
export async function replay(log: ReplayLog, options: ReplayRunOptions): Promise<ReplayRun> {
  const { clock } = options;
  const first = log.entries[0];
  const start = first ? Date.parse(first.at) : Date.UTC(2026, 10, 3, 6, 0, 0);
  clock.setNow(start);
  const now = () => Date.now();

  const sup = new Supervisor();
  const events: Envelope[] = [];
  const all: Subscription = sup.bus.subscribe("*");
  const drain = () => {
    for (let env = all.tryRecv(); env !== null; env = all.tryRecv()) events.push(env);
  };

  const services = sup.services;
  const pipeline = options.pipeline ?? "v2";
  services.provide("app", PipelineKey, { pipeline });
  services.provide("app", SettingsStoreKey, new MemorySettingsStore());
  const tools = new ToolRegistry();
  services.provide("app", ToolRegistryKey, tools);
  services.provide("app", PromptContributorsKey, new PromptContributors());
  const actuators = new ActuatorRegistry({
    services,
    tools,
    publish: (event) => sup.bus.publish("actions", event),
  });
  services.provide("app", ActuatorRegistryKey, actuators);

  const llm = new ScriptedLlm(log.meta.llm ?? {});
  const chain: ModelRef[] = [parseModelRef("scripted:m")];
  const router = new LlmRouter(
    new Map([["scripted", llm]]),
    new Map(["chat", "fast", "mind", "summarizer"].map((p) => [p, chain])),
  );
  const sink = new ReplaySink(sup.bus, now);
  const profile = profileOf(log);
  const config = (id: string) => merge(DEFAULT_MODULES[id], log.meta.modules?.[id]);

  await sup.register(new Stub("llm", (ctx) => ctx.provide(LlmRouterKey, router)), null, true);
  await sup.register(new Stub("scheduler", (ctx) => ctx.provide(ActionSinkKey, sink)), null, true);
  const agent = new AgentModule(profile).withRandom(seeded(options.seed ?? 1));
  const modules: Module[] = [
    // First, as in the core: the main line and the Floor read the log.
    ...(pipeline === "v3" ? [new FactsModule(null, PROFILE_ID, { names: profile.names() })] : []),
    agent,
    new ActionsModule(profile.displayName),
    new ActivityModule(),
    new WorldModule(),
    new SelfModule(PROFILE_ID),
    new ArbiterModule(PROFILE_ID),
    new MindModule(PROFILE_ID, {
      name: profile.displayName,
      persona: () => profile.personaPrompt(),
    }),
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
      const e = entry.event;
      if (
        e.type === "platform_ready" &&
        !selfAccounts.some((a) => sameAccount(a, e.data.self_account))
      ) {
        selfAccounts.push(e.data.self_account);
      }
      if (!isReplayInput(entryTopic(entry), entry.source) || isHers(entry, selfAccounts)) continue;
      inputs.push(entry);
      sup.bus.publish(entry.source, entry.event);
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
    all.close();
  }
}
