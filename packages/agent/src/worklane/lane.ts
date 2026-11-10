// The work lane (docs/design/v4-plan.md §4.3): tasks that take many steps run here, each as its
// own loop of model calls with tools, with its own transcript that grows while it runs, off the
// Floor. The main line starts and steers them and is told what came of them; nothing here speaks.
//
// The walls (§15): a task's tools are fixed when it starts (`allow.ts`: never more than the
// Directives' filter offers where it was started, never one that talks), every capability it calls
// still goes through the gate with the principal of whoever asked (or hers, when nobody did), and
// it has three budgets besides the daily total of the lane: model calls, minutes and tokens. Out
// of any of them it hands back what it has (§4.3 "到了就交回目前的成果").
//
// What it reports goes back the way the hands' results do: `worklane.task.done|failed` events the
// hands follow by task id (a result turn where someone waits, her next prompt otherwise), and a
// task cut by a restart is told once after it, from the row the lane kept while it ran.

import { errorMessage, type Logger, SerialQueue, type ServiceLookup } from "@miyoria/kernel";
import {
  assistantMessage,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LlmRouter,
  systemMessage,
  type ToolCall,
  type ToolSpec,
  toolResultMessage,
  userMessage,
} from "@miyoria/llm";
import type { SettingsStore } from "@miyoria/store";
import type { Tool, ToolContext, ToolRegistry } from "@miyoria/tools";
import {
  type AccountRef,
  type ContextKey,
  DirectivesKey,
  type DrivenStep,
  type DrivenWork,
  type DrivenWorkSpec,
  inspectInput,
  isJsonObject,
  type JsonValue,
  neutralize,
  newId,
  type Principal,
  Principals,
  type ProfileId,
  type TaskEvent,
  type TaskFailureCode,
  type TurnId,
  taskTopic,
  toTimestamp,
  WORK_OWNER,
  WORK_PURPOSE,
  type WorkEnd,
  WorkEndedError,
  type WorkLane,
  type WorkMessage,
  type WorkState,
  type WorkTaskView,
} from "@miyoria/types";
import type { WorkConfig } from "../config.js";
import { ACTING_ALONE } from "../mainline/main.js";
import { TimeoutError, timeout } from "../util.js";
import { talks } from "./allow.js";
import {
  clip,
  didLine,
  GIVE_UP_SPEC,
  GIVE_UP_TOOL,
  goalChangedMessage,
  goalMessage,
  hintMessage,
  NOT_ALLOWED,
  report,
  STOPPED_CALL,
  systemPrompt,
  TOO_MANY_CALLS,
  toolResult,
} from "./prompt.js";

/** Settings key prefix of the tasks that run (a restart finds them there). */
export const TASK_PREFIX = "agent:work:task:";
/** Settings key of today's token count. */
export const DAY_KEY = "agent:work:day";
/** Settings key prefix of what owners keep (`<owner>:<key>`). */
export const KEPT_PREFIX = "agent:work:kept:";

/** Why a task a restart cut ended, as she is told. */
export const RESTART_REASON = "被重啟打斷了,沒做完";

const MINUTE_MS = 60_000;

/** What the lane needs around it. */
export interface LaneDeps {
  config: WorkConfig;
  now(): number;
  router(): LlmRouter | null;
  tools(): ToolRegistry;
  services: ServiceLookup;
  /** Publishes a custom bus event (the fact layer, the panel, her life log read it). */
  publish(topic: string, payload: JsonValue): void;
  /** The hands follow `worklane.task.*` by task id (the agent does not subscribe to its own). */
  follow(topic: string, payload: JsonValue): void;
  store(): SettingsStore | null;
  profile(): ProfileId;
  /** Her own account on `platform` (the account a task of hers acts as). */
  self(platform: string): AccountRef;
  /** Her name and the core of her persona, for a task's instructions. */
  persona(): { name: string; text: string };
  /** The owner's rules where a task works (they bind it as they bind her). */
  rules(context: ContextKey | null): string[];
  /** A task a restart cut: tell her once (where it was started, whoever asked). */
  retell(input: { context: ContextKey | null; requester: AccountRef | null; detail: string }): void;
  log: Logger;
}

/** What starting a task needs. */
export interface StartSpec {
  goal: string;
  why: string;
  /** Whom it is for, by name (`null`: herself). */
  for: string | null;
  /** Whoever asked, the principal its capability calls run as. */
  principal: Principal;
  context: ContextKey | null;
  /** Its allowance, already decided (`allow.ts`). */
  tools: readonly string[];
  /** Model calls it may make (at most the lane's `max_steps`). */
  maxSteps?: number;
  turn: TurnId | null;
  /** The row of her activity table it is, when she started it on her own (`browse`, `code`). */
  activity: string | null;
}

export type StartOutcome =
  | { ok: true; id: string; state: "running" | "queued"; ahead: number }
  | { ok: false; why: string };

/** A change of a running or waiting task (v3 §10.6: hint and goal keep the progress). */
export interface SteerSpec {
  hint?: string | null;
  goal?: string | null;
  stop?: boolean;
  /** Why it is stopped (her words). */
  why?: string | null;
}

interface Task {
  id: string;
  owner: string;
  goal: string;
  why: string;
  for: string | null;
  principal: Principal;
  context: ContextKey | null;
  tools: string[];
  maxSteps: number;
  turn: TurnId | null;
  activity: string | null;
  state: WorkState;
  steps: number;
  calls: number;
  tokens: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  result: string | null;
  did: string[];
  messages: ChatMessage[];
  /** User messages for the next step (hints, a changed goal). */
  pending: string[];
  /** Why it was asked to stop, once it was. */
  stop: string | null;
  controller: AbortController | null;
  /** Its last words before tools, kept as what it has so far. */
  lastText: string;
  /** Driven by its owner, not by the lane's loop. */
  driven: boolean;
}

/** A row of a task that runs, as kept for a restart. */
interface Row {
  id: string;
  goal: string;
  for: string | null;
  context: ContextKey | null;
  requester: AccountRef | null;
}

function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The short id she sees and steers by (the end of the ULID: its random part). */
export function shortId(id: string): string {
  return id.slice(-6).toLowerCase();
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
  /** Every task not ended, by id (running and queued, driven too). */
  readonly #live = new Map<string, Task>();
  readonly #queue: Task[] = [];
  /** Ended tasks, newest first. */
  #ended: Task[] = [];
  #day: { date: string; tokens: number };
  readonly #writes = new SerialQueue();
  #closed = false;

  constructor(deps: LaneDeps) {
    this.#d = deps;
    this.#cfg = deps.config;
    this.#day = { date: utcDay(deps.now()), tokens: 0 };
  }

  get config(): WorkConfig {
    return this.#cfg;
  }

  // ---- starting ---------------------------------------------------------------------------------

  start(spec: StartSpec): StartOutcome {
    const cfg = this.#cfg;
    if (!cfg.enabled || this.#closed) return { ok: false, why: "工作車道沒有開" };
    const goal = spec.goal.trim();
    if (goal === "") return { ok: false, why: "要寫清楚要做什麼" };
    const directives = this.#d.services.get(DirectivesKey);
    const rule = directives?.forbids({
      what: goal,
      why: spec.why,
      steps: [],
      person: null,
      context: spec.context,
    });
    if (rule != null) return { ok: false, why: `主人的規則不准:${rule.text}` };
    if (this.#dayLeft() <= 0) return { ok: false, why: "今天工作的額度用完了" };
    const budget = this.#d.router()?.budgetState() ?? "ok";
    if (budget === "exhausted") return { ok: false, why: "今天的模型額度用完了" };
    const running = this.#running();
    if (running >= cfg.max_running && this.#queue.length >= cfg.max_queued) {
      return { ok: false, why: `手上已經有 ${running + this.#queue.length} 件事了,先等一件做完` };
    }
    const task = this.#task({
      owner: WORK_OWNER,
      goal,
      why: spec.why.trim(),
      for: spec.for,
      principal: spec.principal,
      context: spec.context,
      tools: [...spec.tools],
      maxSteps: Math.max(1, Math.min(spec.maxSteps ?? cfg.max_steps, cfg.max_steps)),
      turn: spec.turn,
      activity: spec.activity,
      driven: false,
    });
    this.#persist(task);
    if (running < cfg.max_running) {
      this.#begin(task);
      return { ok: true, id: task.id, state: "running", ahead: 0 };
    }
    this.#queue.push(task);
    return { ok: true, id: task.id, state: "queued", ahead: this.#queue.length - 1 };
  }

  #task(input: Omit<Task, TaskRuntime>): Task {
    const task: Task = {
      ...input,
      id: newId(),
      state: "queued",
      steps: 0,
      calls: 0,
      tokens: 0,
      createdAt: this.#d.now(),
      startedAt: null,
      endedAt: null,
      result: null,
      did: [],
      messages: [],
      pending: [],
      stop: null,
      controller: null,
      lastText: "",
    };
    this.#live.set(task.id, task);
    return task;
  }

  #running(): number {
    let n = 0;
    for (const t of this.#live.values()) if (t.state === "running" && !t.driven) n += 1;
    return n;
  }

  /** Starts the next waiting tasks while there is room. */
  #pump(): void {
    while (!this.#closed && this.#queue.length > 0 && this.#running() < this.#cfg.max_running) {
      const next = this.#queue.shift();
      if (next) this.#begin(next);
    }
  }

  #begin(task: Task): void {
    task.state = "running";
    task.startedAt = this.#d.now();
    task.controller = new AbortController();
    this.#emit({ type: "started", task: task.id, goal: task.goal, at: toTimestamp(this.#d.now()) });
    const signal = task.controller.signal;
    // Never inside the call that started it: whoever started it learns its id first.
    setTimeout(() => {
      void this.#run(task, signal);
    }, 0);
  }

  async #run(task: Task, signal: AbortSignal): Promise<void> {
    let end: WorkEnd;
    let result: string | null;
    try {
      ({ end, result } = await this.#loop(task, signal));
    } catch (error) {
      if (task.stop !== null) {
        end = "stopped";
        result = task.stop;
      } else {
        this.#d.log.warn({ task: task.id, error: errorMessage(error) }, "a work task failed");
        end = "gave_up";
        result = `出錯了:${errorMessage(error)}`;
      }
    }
    this.#finish(task, end, result);
    this.#pump();
  }

  // ---- the loop ---------------------------------------------------------------------------------

  /** Why it may not take another step, or `null`. */
  #over(task: Task, deadline: number): string | null {
    if (task.steps >= task.maxSteps) return `${task.maxSteps} 步用完了`;
    if (this.#d.now() >= deadline) return `${this.#cfg.max_minutes} 分鐘到了`;
    if (task.tokens >= this.#cfg.max_tokens) return "這件事的 token 用完了";
    if (this.#dayLeft() <= 0) return "今天工作的額度用完了";
    return null;
  }

  /** What it has so far, for a task out of budget. */
  #sofar(task: Task, why: string): string {
    const text = task.lastText.trim();
    return text === "" ? why : `${why};${text}`;
  }

  async #loop(task: Task, signal: AbortSignal): Promise<{ end: WorkEnd; result: string | null }> {
    const cfg = this.#cfg;
    const router = this.#d.router();
    if (router === null) return { end: "gave_up", result: "沒有模型可以用" };
    const persona = this.#d.persona();
    task.messages = [
      systemMessage(
        systemPrompt({
          name: persona.name,
          persona: persona.text,
          tools: task.tools,
          maxSteps: task.maxSteps,
          maxMinutes: cfg.max_minutes,
          rules: this.#d.rules(task.context),
        }),
      ),
      userMessage(goalMessage(task)),
    ];
    const started = task.startedAt ?? this.#d.now();
    const deadline = started + cfg.max_minutes * MINUTE_MS;
    for (;;) {
      if (task.stop !== null) return { end: "stopped", result: task.stop };
      const over = this.#over(task, deadline);
      if (over !== null) return { end: "out_of_budget", result: this.#sofar(task, over) };
      for (const text of task.pending.splice(0)) task.messages.push(userMessage(text));
      const registry = this.#d.tools();
      const specs: ToolSpec[] = [
        ...task.tools.flatMap((name) => {
          const tool = registry.get(name);
          return tool === undefined ? [] : [tool.spec];
        }),
        GIVE_UP_SPEC,
      ];
      const request: ChatRequest = {
        messages: [...task.messages],
        tools: specs,
        reasoning_purpose: WORK_PURPOSE,
        session: `work-${task.id}`,
      };
      let response: ChatResponse;
      try {
        response = await timeout(Math.max(1, deadline - this.#d.now()), signal, (s) =>
          router.complete(WORK_PURPOSE, request, s),
        );
      } catch (error) {
        if (task.stop !== null) return { end: "stopped", result: task.stop };
        if (error instanceof TimeoutError) {
          return { end: "out_of_budget", result: this.#sofar(task, `${cfg.max_minutes} 分鐘到了`) };
        }
        throw error;
      }
      task.steps += 1;
      this.#spend(task, tokensOf(response, request));
      const text = response.text.trim();
      const calls = response.tool_calls;
      if (calls.length === 0) {
        return { end: "done", result: text === "" ? task.lastText || null : text };
      }
      if (text !== "") task.lastText = text;
      task.messages.push(assistantMessage(response.text, calls));
      let ran = 0;
      for (const call of calls) {
        if (call.name === GIVE_UP_TOOL) {
          const args = parseArgs(call.arguments);
          const reason =
            isJsonObject(args) && typeof args.reason === "string" && args.reason.trim() !== ""
              ? args.reason.trim()
              : "沒寫原因";
          return { end: "gave_up", result: reason };
        }
        let result: string;
        if (task.stop !== null) {
          result = STOPPED_CALL;
        } else if (!this.#allowed(task, call.name)) {
          this.#d.log.warn(
            { task: task.id, tool: call.name },
            "a work task called a tool it may not",
          );
          result = NOT_ALLOWED;
        } else if (ran >= cfg.calls_per_step) {
          result = TOO_MANY_CALLS;
        } else {
          ran += 1;
          result = await this.#call(task, call, signal, deadline);
        }
        task.messages.push(toolResultMessage(call.id, result));
      }
      this.#trim(task);
      const last = task.did.at(-1);
      this.#emit({
        type: "progress",
        task: task.id,
        progress: null,
        detail: last === undefined ? `第 ${task.steps} 步` : last,
        at: toTimestamp(this.#d.now()),
      });
    }
  }

  /** In its allowance, registered, and not a tool that talks (checked again at every call). */
  #allowed(task: Task, name: string): boolean {
    if (!task.tools.includes(name)) return false;
    const tool = this.#d.tools().get(name);
    return tool !== undefined && !talks(name, tool);
  }

  async #call(task: Task, call: ToolCall, signal: AbortSignal, deadline: number): Promise<string> {
    const tool = this.#d.tools().get(call.name) as Tool;
    const args = parseArgs(call.arguments);
    task.calls += 1;
    if (args === undefined) {
      task.did.push(didLine(call.name, {}, false));
      return toolResult(call.name, "error: 參數不是合法的 JSON");
    }
    // A task of hers with no place of its own acts where her muted turns do.
    const context = task.context ?? ACTING_ALONE;
    const principal = task.principal;
    const account = principal.requester ?? this.#d.self(context.platform);
    let ok = false;
    let text: string;
    try {
      const limit = Math.max(1, Math.min(this.#cfg.tool_timeout_ms, deadline - this.#d.now()));
      text = await timeout(limit, signal, (s) => {
        const ctx: ToolContext = {
          turn: task.id,
          context,
          account,
          principal,
          message: { context, id: task.id },
          priority: "idle",
          signal: s,
        };
        return tool.call(ctx, args);
      });
      ok = true;
    } catch (error) {
      if (signal.aborted) throw error;
      text = error instanceof TimeoutError ? "error: timed out" : `error: ${errorMessage(error)}`;
    }
    task.did.push(didLine(call.name, args, ok));
    const verdict = inspectInput(this.#d.services, { text, source: "tool", context });
    const note =
      verdict?.note && !verdict.flags.every((f) => f === "flood") ? `${verdict.note}\n` : "";
    return toolResult(call.name, clip(`${note}${neutralize(text)}`, this.#cfg.tool_result_chars));
  }

  /** Over `transcript_chars`, the oldest tool results become a line: the conclusions stay. */
  #trim(task: Task): void {
    const max = this.#cfg.transcript_chars;
    let total = task.messages.reduce((n, m) => n + contentLength(m), 0);
    for (const m of task.messages) {
      if (total <= max) return;
      if (m.role !== "tool" || typeof m.content !== "string" || m.content.length <= 200) continue;
      const before = m.content.length;
      m.content = `${[...m.content].slice(0, 160).join("")}\n…(舊的結果,已經讀過,只留開頭)`;
      total -= before - m.content.length;
    }
  }

  #finish(task: Task, end: WorkEnd, result: string | null): void {
    if (!this.#live.has(task.id)) return;
    this.#live.delete(task.id);
    task.state = end;
    task.endedAt = this.#d.now();
    task.result = result;
    task.controller = null;
    task.messages = [];
    if (!task.driven) this.#unpersist(task.id);
    this.#ended = [task, ...this.#ended].slice(0, Math.max(this.#cfg.keep_ended, 1));
    const detail = this.#report(task);
    const at = toTimestamp(this.#d.now());
    // What it has is a result even out of budget; a stop or giving up is not.
    const done = end === "done" || (end === "out_of_budget" && task.lastText.trim() !== "");
    if (done) {
      const minutes = task.startedAt === null ? 0 : (task.endedAt - task.startedAt) / MINUTE_MS;
      this.#emit({
        type: "done",
        task: task.id,
        detail,
        data: {
          state: end,
          goal: task.goal,
          for: task.for,
          activity: task.activity,
          self: task.principal.kind === "self",
          steps: task.steps,
          calls: task.calls,
          minutes: Math.round(minutes * 10) / 10,
          did: [...task.did],
        },
        at,
      });
    } else {
      this.#emit({ type: "failed", task: task.id, code: failureCode(end), detail, at });
    }
  }

  #report(task: Task): string {
    const end = isEnd(task.state) ? task.state : "stopped";
    return report({
      goal: task.goal,
      end,
      result: task.result,
      did: task.did,
      resultChars: this.#cfg.result_chars,
      didLines: this.#cfg.did_lines,
    });
  }

  #emit(event: TaskEvent): void {
    const topic = taskTopic(WORK_OWNER, event.type);
    const payload = event as unknown as JsonValue;
    this.#d.publish(topic, payload);
    this.#d.follow(topic, payload);
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

  /** Tokens spent today by every task. */
  spentToday(): number {
    return this.#cfg.daily_tokens - this.#dayLeft();
  }

  // ---- steering ---------------------------------------------------------------------------------

  /** The task `ref` names (its id or the short id she sees), running, waiting or ended. */
  #find(ref: string): Task | null {
    const r = ref.trim().toLowerCase();
    if (r === "") return null;
    const match = (t: Task) => t.id.toLowerCase() === r || shortId(t.id) === r;
    for (const t of this.#live.values()) if (match(t)) return t;
    return this.#ended.find(match) ?? null;
  }

  /**
   * Changes a task: a hint or a new goal keeps what it did and its budget (v3 §10.6 rule 6), a
   * stop ends it at once (a call in flight is aborted). Answers what happened, in her terms.
   */
  steer(ref: string, change: SteerSpec): { ok: boolean; text: string } {
    const task = this.#find(ref);
    if (task === null) return { ok: false, text: `沒有任務 ${ref}` };
    if (task.driven) return { ok: false, text: "這個任務是遊戲自己在跑的,改不了" };
    if (isEnd(task.state)) {
      return { ok: false, text: `任務 ${shortId(task.id)} 已經結束了(${task.state})` };
    }
    if (change.stop === true) {
      const why = change.why?.trim() || "你叫它停的";
      task.stop = why;
      const i = this.#queue.indexOf(task);
      if (i >= 0) {
        this.#queue.splice(i, 1);
        this.#finish(task, "stopped", why);
      } else {
        task.controller?.abort(new Error("stopped"));
      }
      return { ok: true, text: `任務 ${shortId(task.id)} 停掉了` };
    }
    const done: string[] = [];
    const goal = change.goal?.trim() ?? "";
    if (goal !== "") {
      const rule = this.#d.services.get(DirectivesKey)?.forbids({
        what: goal,
        why: task.why,
        steps: [],
        person: null,
        context: task.context,
      });
      if (rule != null) return { ok: false, text: `主人的規則不准:${rule.text}` };
      task.goal = goal;
      task.pending.push(goalChangedMessage(goal));
      done.push("目標改了");
    }
    const hint = change.hint?.trim() ?? "";
    if (hint !== "") {
      task.pending.push(hintMessage(hint));
      done.push("補充收到了");
    }
    if (done.length === 0) return { ok: false, text: "沒有要改什麼(給 hint、goal 或 stop)" };
    const when = task.state === "queued" ? "開始做的時候就會照新的" : "下一步開始生效";
    return { ok: true, text: `任務 ${shortId(task.id)}:${done.join(",")},${when}` };
  }

  // ---- what is there ----------------------------------------------------------------------------

  tasks(): WorkTaskView[] {
    const live = [...this.#live.values()].sort((a, b) => a.createdAt - b.createdAt);
    return [...live, ...this.#ended].map((t) => this.#view(t));
  }

  /** How `id` ended, if it did (the hands ask when its end may have come before its receipt). */
  ended(id: string): { state: "done" | "failed"; detail: string } | null {
    const task = this.#ended.find((t) => t.id === id);
    if (!task || !isEnd(task.state)) return null;
    const done =
      task.state === "done" || (task.state === "out_of_budget" && task.lastText.trim() !== "");
    return { state: done ? "done" : "failed", detail: this.#report(task) };
  }

  #view(t: Task): WorkTaskView {
    return {
      id: t.id,
      owner: t.owner,
      goal: t.goal,
      why: t.why,
      for: t.for,
      context: t.context === null ? null : { ...t.context },
      state: t.state,
      steps: t.steps,
      calls: t.calls,
      tokens: t.tokens,
      tools: [...t.tools],
      created_at: toTimestamp(t.createdAt),
      ended_at: t.endedAt === null ? null : toTimestamp(t.endedAt),
      result: t.result,
      did: [...t.did],
    };
  }

  /** Lines for `work_list`: what runs, what waits, what ended lately. */
  lines(limit = 8): string[] {
    const label: Record<WorkState, string> = {
      queued: "排隊中",
      running: "進行中",
      done: "做完了",
      gave_up: "放棄了",
      stopped: "停掉了",
      out_of_budget: "預算用完",
    };
    return this.tasks()
      .slice(0, limit)
      .map((t) => {
        const who = t.for === null ? "" : `(幫 ${t.for})`;
        const steps = t.steps > 0 ? `,${t.steps} 步` : "";
        return `- ${shortId(t.id)} ${label[t.state]}${steps}:${t.goal}${who}`;
      });
  }

  // ---- driven tasks (the game director) ----------------------------------------------------------

  open(spec: DrivenWorkSpec): DrivenWork {
    const task = this.#task({
      owner: spec.owner,
      goal: spec.goal,
      why: "",
      for: null,
      principal: Principals.director(null),
      context: null,
      tools: [],
      maxSteps: Number.POSITIVE_INFINITY,
      turn: null,
      activity: null,
      driven: true,
    });
    task.state = "running";
    task.startedAt = this.#d.now();
    this.#emit({ type: "started", task: task.id, goal: task.goal, at: toTimestamp(this.#d.now()) });
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

  #persist(task: Task): void {
    const row: Row = {
      id: task.id,
      goal: task.goal,
      for: task.for,
      context: task.context,
      requester: task.principal.requester,
    };
    this.#write(`${TASK_PREFIX}${task.id}`, row as unknown as JsonValue);
  }

  #unpersist(id: string): void {
    this.#write(`${TASK_PREFIX}${id}`, null);
  }

  #write(key: string, value: JsonValue | null): void {
    const store = this.#d.store();
    if (store === null) return;
    const profile = this.#d.profile();
    void this.#writes
      .run(() => store.set(profile, key, value))
      .catch((error: unknown) => {
        this.#d.log.warn({ key, error: errorMessage(error) }, "could not keep a work task");
      });
  }

  /** Waits for what the lane is writing (tests, shutdown). */
  flush(): Promise<void> {
    return this.#writes.run(async () => {});
  }

  /**
   * Reads what the last run left: today's tokens, and the tasks that were running when it stopped.
   * Those never finished; each ends here as stopped by the restart, her state is told so (the fact
   * layer still shows them running from the log) and she is told once. The row goes, so a second
   * restart does not tell her again.
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
      const row = parseRow(value);
      if (row === null) continue;
      n += 1;
      const detail = report({
        goal: row.goal,
        end: "stopped",
        result: RESTART_REASON,
        did: [],
        resultChars: this.#cfg.result_chars,
        didLines: this.#cfg.did_lines,
      });
      this.#emit({
        type: "failed",
        task: row.id,
        code: "cancelled",
        detail,
        at: toTimestamp(this.#d.now()),
      });
      this.#d.retell({ context: row.context, requester: row.requester, detail });
    }
    return n;
  }

  /** Stops everything (module stop): what runs is aborted, nothing is told now. */
  close(): void {
    this.#closed = true;
    this.#queue.splice(0);
    for (const task of this.#live.values()) {
      task.stop = "agent 停了";
      task.controller?.abort(new Error("closed"));
    }
  }
}

/** What `Task` gets when it is created, not from the caller. */
type TaskRuntime =
  | "id"
  | "state"
  | "steps"
  | "calls"
  | "tokens"
  | "createdAt"
  | "startedAt"
  | "endedAt"
  | "result"
  | "did"
  | "messages"
  | "pending"
  | "stop"
  | "controller"
  | "lastText";

function isEnd(state: WorkState): state is WorkEnd {
  return state !== "queued" && state !== "running";
}

function contentLength(m: ChatMessage): number {
  return typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
}

function parseArgs(raw: string): JsonValue | undefined {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return undefined;
  }
}

function parseRow(value: JsonValue): Row | null {
  if (!isJsonObject(value) || typeof value.id !== "string" || typeof value.goal !== "string") {
    return null;
  }
  const context = isJsonObject(value.context ?? null)
    ? (value.context as unknown as ContextKey)
    : null;
  const requester = isJsonObject(value.requester ?? null)
    ? (value.requester as unknown as AccountRef)
    : null;
  return {
    id: value.id,
    goal: value.goal,
    for: typeof value.for === "string" ? value.for : null,
    context,
    requester,
  };
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
