// The sub-agent jobs on today's services (the engine is `Delegator` in `@miyoria/brain/self`).
//
// Her tools. `delegate` (core), `delegate_list`, `delegate_cancel` and `delegate_read` are
// registered for the new runner only. They replace the old work lane's `work_start`, `work_list`
// and `work_steer`; the lane itself stays only for the game director's driven tasks.
//
// Results. A job that ends wakes the place that started it as a `result`, with the job's id,
// kind, goal and summary as the data of the wake (the runner frames it); one a restart cut is told
// the same way once the host is up. A job she cancelled herself is not told: she knows.
//
// Events. A job publishes the work lane's task events under the owner `delegate`
// (`delegate.task.started|progress|done|failed`), so the fact layer and the panel's task list show
// it like any task; its transcript is the session `delegate:<id>`.
//
// Keeping. Jobs and the days' spending are rows of the settings store (`delegate:job:<id>`,
// `delegate:day:<pool>`), the store the work lane keeps its task rows in.

import { LlmRouterKey } from "@miyoria/llm/llm";
import type { Tool } from "@miyoria/llm/tools";
import type { TranscriptStore } from "@miyoria/memory/transcript";
import { errorMessage, SerialQueue, sleep } from "@miyoria/runtime/kernel";
import { type SettingsStore, SettingsStoreKey, StoreKey } from "@miyoria/store";
import {
  type ContextKey,
  DirectivesKey,
  isJsonObject,
  type JsonValue,
  type ProfileId,
  publishTaskEvent,
  ReflectGuardKey,
  type TaskEvent,
  type TaskFailureCode,
  toTimestamp,
} from "@miyoria/types";
import { type Agent, pinnedSection } from "../../agent/src/index.js";
import type { LocalTime } from "../../arbiter/src/index.js";
import {
  type DayState,
  type DelegateEvent,
  type DelegateLimits,
  Delegator,
  delegateTexts,
  delegateTools,
  isSubagentKind,
  type JobRow,
  type JobState,
  type JobStore,
  type RunModel,
  serviceGuard,
  type Wake,
} from "../../self/src/index.js";

/** The owner of the jobs' task events: `delegate.task.started|progress|done|failed`. */
export const DELEGATE_OWNER = "delegate";
/** Settings key prefixes. */
export const JOB_PREFIX = "delegate:job:";
export const DAY_PREFIX = "delegate:day:";

const RECOVER_DELAY_MS = 5_000;

const JOB_STATES: readonly JobState[] = [
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
  "out_of_budget",
];

// ---- keeping -----------------------------------------------------------------------------------

function parseRow(value: JsonValue): JobRow | null {
  if (!isJsonObject(value)) return null;
  const { id, kind, goal, state, session } = value;
  if (typeof id !== "string" || typeof goal !== "string" || typeof session !== "string") {
    return null;
  }
  if (typeof kind !== "string" || !isSubagentKind(kind)) return null;
  if (typeof state !== "string" || !JOB_STATES.includes(state as JobState)) return null;
  return value as unknown as JobRow;
}

function parseDay(value: JsonValue | null): DayState | null {
  if (!isJsonObject(value ?? null)) return null;
  const v = value as Record<string, JsonValue>;
  if (typeof v.date !== "string") return null;
  const num = (x: JsonValue | undefined) => (typeof x === "number" ? x : 0);
  return {
    date: v.date,
    usd: num(v.usd),
    tokens: num(v.tokens),
    unpriced_tokens: num(v.unpriced_tokens),
  };
}

/** The jobs in the settings store: writes go one after another, a failed one is logged. */
export function settingsJobStore(
  store: SettingsStore,
  profile: ProfileId,
  warn: (what: string, error: unknown) => void,
): JobStore {
  const writes = new SerialQueue();
  const write = (key: string, value: JsonValue | null): void => {
    void writes
      .run(() => store.set(profile, key, value))
      .catch((error: unknown) => {
        warn("could not keep a sub-agent job", error);
      });
  };
  return {
    async load() {
      await writes.run(async () => {});
      const rows = await store.list(profile, JOB_PREFIX);
      const jobs: JobRow[] = [];
      for (const value of rows.values()) {
        const row = parseRow(value);
        if (row !== null) jobs.push(row);
      }
      return {
        jobs,
        day: parseDay(await store.get(profile, `${DAY_PREFIX}delegate`)),
        reflectDay: parseDay(await store.get(profile, `${DAY_PREFIX}reflect`)),
      };
    },
    saveJob: (row) => write(`${JOB_PREFIX}${row.id}`, structuredClone(row) as unknown as JsonValue),
    removeJob: (id) => write(`${JOB_PREFIX}${id}`, null),
    saveDay: (pool, day) => write(`${DAY_PREFIX}${pool}`, { ...day }),
  };
}

// ---- events ------------------------------------------------------------------------------------

const clip = (text: string, max: number): string => {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
};

/** Whether what a job ended with counts as a result (what it has, even out of budget). */
function resulted(job: JobRow): boolean {
  return job.state === "done" || (job.state === "out_of_budget" && job.summary !== null);
}

function failureCode(job: JobRow): TaskFailureCode {
  if (job.state === "cancelled") return "cancelled";
  if (job.state === "out_of_budget") return "timeout";
  return "internal";
}

/** The work lane's task event for a job event (the shapes are the lane's own). */
export function taskEventOf(event: DelegateEvent, now: number): TaskEvent {
  const { job } = event;
  const at = toTimestamp(now);
  if (event.type === "started") {
    return { type: "started", task: job.id, goal: `${job.kind}: ${job.goal}`, at };
  }
  if (event.type === "progress") {
    return { type: "progress", task: job.id, progress: null, detail: event.detail, at };
  }
  const detail = clip(job.summary ?? job.note ?? job.state, 600);
  if (resulted(job)) {
    return {
      type: "done",
      task: job.id,
      detail,
      data: {
        state: job.state,
        kind: job.kind,
        goal: job.goal,
        rounds: job.rounds,
        calls: job.usage.calls,
        cost_usd: Math.round(job.usage.cost_usd * 10_000) / 10_000,
        tokens: job.usage.prompt_tokens + job.usage.completion_tokens,
      },
      at,
    };
  }
  return { type: "failed", task: job.id, code: failureCode(job), detail, at };
}

// ---- the reflection ----------------------------------------------------------------------------

export interface RunReflectDeps<T> {
  delegator: Delegator;
  /** The reflection as it is today (`Reflector.reflect`), given the signal the budget may cut. */
  run: (signal: AbortSignal) => Promise<T>;
  /** The tokens of a finished call, for a model with no price (`router.calls.get(id)?.usage`). */
  usageOf?: (callId: string) => { prompt_tokens: number; completion_tokens: number } | null;
  summarise?: (result: T) => string;
  goal?: string;
  signal?: AbortSignal;
}

/**
 * Runs the nightly reflection under the sub-agents' accounting, as a job of kind `reflect`: its
 * calls count against the nightly figure (`[modules.agent.delegate] reflect_daily_usd`), a call
 * that takes the figure past its cap cuts the run, and nothing runs once the day's figure is used
 * up. The reflection itself is not changed: it still calls the router with its own prompt and no
 * tools, so it does not run on `SelfRunner` yet.
 */
export function runReflect<T>(deps: RunReflectDeps<T>) {
  return deps.delegator.trackReflect({
    goal: deps.goal ?? "每晚的反思",
    run: deps.run,
    ...(deps.usageOf === undefined ? {} : { usageOf: deps.usageOf }),
    ...(deps.summarise === undefined ? {} : { summarise: deps.summarise }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
}

// ---- the host ----------------------------------------------------------------------------------

export interface JobsHostOptions {
  /** Jobs at once, the queue, caps and so on: over `[modules.agent.delegate]`. */
  limits?: Partial<DelegateLimits>;
  /** Where jobs are kept; default: the settings store, else nowhere. */
  store?: JobStore;
  /** Wait before jobs a restart cut are told (ms). */
  recoverDelayMs?: number;
}

export interface JobsHostDeps {
  transcript: TranscriptStore;
  model: RunModel;
  /** The Arbiter's clock, for the quiet hours and the day's start; `null`: none. */
  quiet: LocalTime | null;
  /** Wakes `context`'s lane. */
  wake: (context: ContextKey, wake: Wake) => void;
}

export class JobsHost {
  readonly delegator: Delegator;
  readonly #agent: Agent;
  readonly #tools: Tool[];
  #stopped = false;

  constructor(agent: Agent, deps: JobsHostDeps, options: JobsHostOptions = {}) {
    this.#agent = agent;
    const services = agent.ctx.services;
    const cfg = agent.config.delegate;
    const profile = agent.persona.read((p) => p.id);
    const kept = services.get(SettingsStoreKey) ?? services.get(StoreKey)?.settings ?? null;
    const dayStart = deps.quiet?.day_start_hour ?? 4;
    const store: JobStore =
      options.store ??
      (kept === null
        ? emptyStore()
        : settingsJobStore(kept, profile, (what, error) =>
            agent.log.warn({ err: errorMessage(error) }, what),
          ));
    this.delegator = new Delegator({
      transcript: deps.transcript,
      tools: agent.tools,
      model: deps.model,
      guard: serviceGuard({ services, quiet: deps.quiet }),
      clock: agent.ctx.clock,
      log: agent.log,
      store,
      limits: {
        maxRunning: cfg.max_running,
        maxQueued: cfg.max_queued,
        dailyUsd: cfg.daily_usd,
        dailyTokens: cfg.daily_tokens,
        reflectDailyUsd: cfg.reflect_daily_usd,
        reflectDailyTokens: cfg.reflect_daily_tokens,
        resultChars: cfg.result_chars,
        readChars: cfg.read_chars,
        keepEnded: cfg.keep_ended,
        ...options.limits,
      },
      dayKey: (now) => new Date(now - dayStart * 3_600_000).toISOString().slice(0, 10),
      rules: (context) =>
        pinnedSection(agent.mainline.ownerRules(context), [], agent.ctx.clock.now(), 0),
      forbids: (goal, context) =>
        services
          .get(DirectivesKey)
          ?.forbids({ what: goal, why: "", steps: [], person: null, context })?.text ?? null,
      llmExhausted: () => services.get(LlmRouterKey)?.budgetState() === "exhausted",
      ended: (job) => this.#told(job, deps),
      onEvent: (event) => this.#publish(event),
      selfAccount: (platform) => agent.selfAccount(platform),
    });
    this.#tools = delegateTools({
      delegator: this.delegator,
      nameOf: (account) => agent.handleOf(account, account.id),
    });
    for (const tool of this.#tools) agent.tools.register(tool);
    // The `reflect` module runs its daily reflection through this, under the nightly figure.
    agent.ctx.provide(ReflectGuardKey, {
      run: async (run, signal, options) => {
        const out = await this.runReflect({
          run,
          ...(signal === undefined ? {} : { signal }),
          ...(options?.goal === undefined ? {} : { goal: options.goal }),
          ...(options?.summarise === undefined ? {} : { summarise: options.summarise }),
        });
        return { ran: out.ran, result: out.result, why: out.why };
      },
    });
    // After the host is up: telling her opens a run through the Floor.
    agent.ctx.spawn("selfhost.jobs", async (signal) => {
      await sleep(options.recoverDelayMs ?? RECOVER_DELAY_MS, signal);
      const cut = await this.delegator.recover();
      if (cut > 0) agent.log.info({ count: cut }, "sub-agent jobs cut by the restart were told");
    });
  }

  /** The reflection under the sub-agents' accounting (`runReflect`), with the router's call log. */
  runReflect<T>(deps: Omit<RunReflectDeps<T>, "delegator" | "usageOf">) {
    const router = this.#agent.ctx.services.get(LlmRouterKey);
    return runReflect({
      ...deps,
      delegator: this.delegator,
      usageOf: (id) => router?.calls.get(id)?.usage ?? null,
    });
  }

  #publish(event: DelegateEvent): void {
    try {
      const now = this.#agent.ctx.clock.now();
      publishTaskEvent(this.#agent.ctx.publisher, DELEGATE_OWNER, taskEventOf(event, now));
    } catch (error) {
      this.#agent.log.warn({ err: errorMessage(error) }, "could not publish a job event");
    }
  }

  /** The place that asked hears how its job ended (a voice channel only while she is in it). */
  #told(job: JobRow, deps: JobsHostDeps): void {
    if (this.#stopped || job.context === null) return;
    deps.wake(job.context, {
      kind: "result",
      tool: delegateTexts.WAKE_TOOL,
      job: job.id,
      ok: resulted(job),
      text: this.delegator.resultFor(job),
      from: job.from,
    });
  }

  stop(): void {
    this.#stopped = true;
    this.delegator.close();
    const registry = this.#agent.tools;
    for (const tool of this.#tools) registry.unregister(tool.spec.name);
  }
}

function emptyStore(): JobStore {
  return {
    load: async () => ({ jobs: [], day: null, reflectDay: null }),
    saveJob: () => undefined,
    removeJob: () => undefined,
    saveDay: () => undefined,
  };
}
