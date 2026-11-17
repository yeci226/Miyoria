// The work lane (docs/design/v4-plan.md §4.3), as far as it is left: tasks an owner drives one step
// at a time (`WorkLane.open`: the game director), off the Floor. The owner decides when to think and
// what each step does; the lane keeps the transcript (what it saw, what it tried, what came of it),
// counts the tokens against the lane's daily total and shows the task (`worklane`-owned task
// events, its owner's own id). What owners learn across restarts is kept here too (`keep`, `kept`).
//
// The tasks the main line started (`work.start`) are gone: her long tasks are the new runner's
// sub-agent jobs (`delegate`). A row such a task left when a restart cut it ends on the next start
// as stopped (`recover`), so the fact layer stops showing it as running.

import {
  assistantMessage,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LlmRouter,
  systemMessage,
  userMessage,
} from "@miyoria/llm/llm";
import { errorMessage, type Logger, SerialQueue } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type DrivenStep,
  type DrivenWork,
  type DrivenWorkSpec,
  isJsonObject,
  type JsonValue,
  newId,
  type ProfileId,
  type Publish,
  publishTaskEvent,
  type TaskEvent,
  type TaskFailureCode,
  toTimestamp,
  WORK_OWNER,
  type WorkEnd,
  WorkEndedError,
  type WorkLane,
  type WorkMessage,
  type WorkState,
  type WorkTaskView,
} from "@miyoria/types";
import type { WorkConfig } from "../config.js";
import { timeout } from "../util.js";
import { report } from "./prompt.js";

/** Settings key prefix of the rows tasks of the main line left (a restart finds them there). */
export const TASK_PREFIX = "agent:work:task:";
/** Settings key of today's token count. */
export const DAY_KEY = "agent:work:day";
/** Settings key prefix of what owners keep (`<owner>:<key>`). */
export const KEPT_PREFIX = "agent:work:kept:";

/** Why a task a restart cut ended. */
export const RESTART_REASON = "被重啟打斷了,沒做完";

/** What the lane needs around it. */
export interface LaneDeps {
  config: WorkConfig;
  now(): number;
  router(): LlmRouter | null;
  /** Publishes on the bus (the fact layer, the panel, her life log read its task events). */
  publish: Publish;
  store(): SettingsStore | null;
  profile(): ProfileId;
  log: Logger;
}

interface Task {
  id: string;
  owner: string;
  goal: string;
  state: WorkState;
  steps: number;
  tokens: number;
  createdAt: number;
  endedAt: number | null;
  result: string | null;
  did: string[];
}

function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function failureCode(end: WorkEnd): TaskFailureCode {
  switch (end) {
    case "stopped":
      return "cancelled";
    case "out_of_budget":
      return "timeout";
    default:
      return "internal";
  }
}

function tokensOf(response: ChatResponse, request: ChatRequest): number {
  const u = response.usage;
  if (u !== null) return u.prompt_tokens + u.completion_tokens;
  // A provider that reports nothing still costs: about two characters a token.
  const chars = JSON.stringify(request.messages).length + response.text.length;
  return Math.ceil(chars / 2);
}

export class WorkLaneService implements WorkLane {
  readonly #d: LaneDeps;
  readonly #cfg: WorkConfig;
  /** Tasks not ended, by id. */
  readonly #live = new Map<string, Task>();
  /** Ended tasks, newest first. */
  #ended: Task[] = [];
  #day: { date: string; tokens: number };
  readonly #writes = new SerialQueue();

  constructor(deps: LaneDeps) {
    this.#d = deps;
    this.#cfg = deps.config;
    this.#day = { date: utcDay(deps.now()), tokens: 0 };
  }

  get config(): WorkConfig {
    return this.#cfg;
  }

  #finish(task: Task, end: WorkEnd, result: string | null): void {
    if (!this.#live.has(task.id)) return;
    this.#live.delete(task.id);
    task.state = end;
    task.endedAt = this.#d.now();
    task.result = result;
    this.#ended = [task, ...this.#ended].slice(0, Math.max(this.#cfg.keep_ended, 1));
    const detail = this.#report(task.goal, end, result, task.did);
    const at = toTimestamp(this.#d.now());
    if (end === "done") {
      this.#emit({
        type: "done",
        task: task.id,
        detail,
        data: { state: end, goal: task.goal, steps: task.steps, did: [...task.did] },
        at,
      });
    } else {
      this.#emit({ type: "failed", task: task.id, code: failureCode(end), detail, at });
    }
  }

  #report(goal: string, end: WorkEnd, result: string | null, did: readonly string[]): string {
    return report({
      goal,
      end,
      result,
      did,
      resultChars: this.#cfg.result_chars,
      didLines: this.#cfg.did_lines,
    });
  }

  #emit(event: TaskEvent): void {
    publishTaskEvent(this.#d.publish, WORK_OWNER, event);
  }

  // ---- budget -----------------------------------------------------------------------------------

  #dayLeft(): number {
    const today = utcDay(this.#d.now());
    if (this.#day.date !== today) this.#day = { date: today, tokens: 0 };
    return this.#cfg.daily_tokens - this.#day.tokens;
  }

  #spend(task: Task, tokens: number): void {
    task.tokens += tokens;
    this.#dayLeft();
    this.#day.tokens += tokens;
    this.#write(DAY_KEY, { ...this.#day });
  }

  // ---- what is there ----------------------------------------------------------------------------

  tasks(): WorkTaskView[] {
    const live = [...this.#live.values()].sort((a, b) => a.createdAt - b.createdAt);
    return [...live, ...this.#ended].map((t) => ({
      id: t.id,
      owner: t.owner,
      goal: t.goal,
      why: "",
      for: null,
      context: null,
      state: t.state,
      steps: t.steps,
      calls: 0,
      tokens: t.tokens,
      tools: [],
      created_at: toTimestamp(t.createdAt),
      ended_at: t.endedAt === null ? null : toTimestamp(t.endedAt),
      result: t.result,
      did: [...t.did],
    }));
  }

  // ---- driven tasks (the game director) ----------------------------------------------------------

  open(spec: DrivenWorkSpec): DrivenWork {
    const now = this.#d.now();
    const task: Task = {
      id: newId(),
      owner: spec.owner,
      goal: spec.goal,
      state: "running",
      steps: 0,
      tokens: 0,
      createdAt: now,
      endedAt: null,
      result: null,
      did: [],
    };
    this.#live.set(task.id, task);
    this.#emit({ type: "started", task: task.id, goal: task.goal, at: toTimestamp(now) });
    return new Driven(task, Math.max(1, spec.keep_steps), {
      router: () => this.#d.router(),
      spend: (tokens) => this.#spend(task, tokens),
      dayLeft: () => this.#dayLeft(),
      finish: (end, detail) => this.#finish(task, end, detail),
    });
  }

  // ---- what owners keep ---------------------------------------------------------------------------

  async keep(owner: string, key: string, value: JsonValue | null): Promise<void> {
    const store = this.#d.store();
    if (store === null) return;
    const profile = this.#d.profile();
    await this.#writes.run(() => store.set(profile, `${KEPT_PREFIX}${owner}:${key}`, value));
  }

  async kept(owner: string, key: string): Promise<JsonValue | null> {
    const store = this.#d.store();
    if (store === null) return null;
    return await store.get(this.#d.profile(), `${KEPT_PREFIX}${owner}:${key}`);
  }

  // ---- restart ----------------------------------------------------------------------------------

  #write(key: string, value: JsonValue | null): void {
    const store = this.#d.store();
    if (store === null) return;
    const profile = this.#d.profile();
    void this.#writes
      .run(() => store.set(profile, key, value))
      .catch((error: unknown) => {
        this.#d.log.warn({ key, error: errorMessage(error) }, "could not keep the lane's day");
      });
  }

  /** Waits for what the lane is writing (tests, shutdown). */
  flush(): Promise<void> {
    return this.#writes.run(async () => {});
  }

  /**
   * Reads what the last run left: today's tokens, and the rows of tasks of the main line that
   * were running when it stopped. Each ends here as stopped by the restart (the fact layer still
   * shows it running from the log); the row goes.
   */
  async recover(): Promise<number> {
    const store = this.#d.store();
    if (store === null) return 0;
    const profile = this.#d.profile();
    const day = await store.get(profile, DAY_KEY);
    if (isJsonObject(day) && day.date === utcDay(this.#d.now()) && typeof day.tokens === "number") {
      this.#day = { date: day.date, tokens: Math.max(this.#day.tokens, day.tokens) };
    }
    const rows = await store.list(profile, TASK_PREFIX);
    let n = 0;
    for (const [key, value] of rows) {
      await store.set(profile, key, null);
      if (!isJsonObject(value) || typeof value.id !== "string" || typeof value.goal !== "string") {
        continue;
      }
      n += 1;
      this.#emit({
        type: "failed",
        task: value.id,
        code: "cancelled",
        detail: this.#report(value.goal, "stopped", RESTART_REASON, []),
        at: toTimestamp(this.#d.now()),
      });
    }
    return n;
  }

  /** Module stop: a driven task is its owner's to end, so nothing is ended here. */
  close(): void {
    this.#live.clear();
  }
}

interface DrivenDeps {
  router(): LlmRouter | null;
  spend(tokens: number): void;
  dayLeft(): number;
  finish(end: WorkEnd, detail: string): void;
}

/**
 * A task its owner drives (§11.2 item 1): each `step` is one model call whose messages are the
 * owner's instructions, the steps it kept (what it saw, what it answered, what came of it) and what
 * it sees now. Old steps fall out past `keep`; the newest stay whole.
 */
class Driven implements DrivenWork {
  readonly #task: Task;
  readonly #keep: number;
  readonly #d: DrivenDeps;
  /** Kept steps: what it saw (short), what it answered. */
  #steps: { user: string; assistant: string }[] = [];
  /** What came of what it tried since the last step. */
  #results: string[] = [];
  #ended = false;

  constructor(task: Task, keep: number, deps: DrivenDeps) {
    this.#task = task;
    this.#keep = keep;
    this.#d = deps;
  }

  get id(): string {
    return this.#task.id;
  }

  get ended(): boolean {
    return this.#ended;
  }

  #withResults(text: string): string {
    if (this.#results.length === 0) return text;
    return `上一步之後發生的事:\n${this.#results.map((r) => `- ${r}`).join("\n")}\n\n${text}`;
  }

  async step(input: DrivenStep, signal?: AbortSignal): Promise<string> {
    if (this.#ended) throw new WorkEndedError("stopped", "the task ended");
    if (this.#d.dayLeft() <= 0) {
      this.#end("out_of_budget", "今天工作的額度用完了");
      throw new WorkEndedError("out_of_budget", "the lane's daily tokens are spent");
    }
    const router = this.#d.router();
    if (router === null) throw new Error("no LLM router");
    const user = this.#withResults(input.user);
    const kept = this.#withResults(input.kept ?? input.user);
    const messages: ChatMessage[] = [systemMessage(input.system)];
    for (const s of this.#steps) {
      messages.push(userMessage(s.user), assistantMessage(s.assistant));
    }
    messages.push(userMessage(user));
    const request: ChatRequest = {
      messages,
      ...(input.json === true ? { json_mode: true } : {}),
      ...(input.reasoning != null ? { reasoning: input.reasoning } : {}),
      ...(input.temperature != null ? { temperature: input.temperature } : {}),
      ...(input.max_tokens != null ? { max_tokens: input.max_tokens } : {}),
      ...(input.session != null ? { session: input.session } : {}),
    };
    const parent = signal ?? new AbortController().signal;
    const response = await timeout(Math.max(1, input.timeout_ms), parent, (s) =>
      router.complete(input.purpose, request, s),
    );
    this.#d.spend(tokensOf(response, request));
    this.#task.steps += 1;
    this.#results = [];
    this.#steps = [...this.#steps, { user: kept, assistant: response.text }].slice(-this.#keep);
    return response.text;
  }

  result(text: string): void {
    if (this.#ended || text.trim() === "") return;
    this.#results.push(text.trim());
    this.#task.did = [...this.#task.did, text.trim()].slice(-20);
  }

  transcript(): WorkMessage[] {
    const out: WorkMessage[] = [];
    for (const s of this.#steps) {
      out.push({ role: "user", content: s.user }, { role: "assistant", content: s.assistant });
    }
    if (this.#results.length > 0) out.push({ role: "user", content: this.#withResults("") });
    return out;
  }

  end(state: Exclude<WorkEnd, "out_of_budget">, detail: string): void {
    this.#end(state, detail);
  }

  #end(state: WorkEnd, detail: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#steps = [];
    this.#d.finish(state, detail);
  }
}
