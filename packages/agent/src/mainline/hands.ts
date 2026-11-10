// The hands (docs/design/v3-architecture.md §10.3): the mouth never waits for them. Every action
// of an output runs here, in the background, and leaves two kinds of lines in the log: `action`
// when it goes out and `result` for what came of it, `accepted`, then `done` or `failed`. Accepted
// is a receipt and nothing else (§10.1): a line that says it is done waits for `done`.
//
// A tool that answers with a task in its data, or whose turn started an ActivityManager task, only
// got accepted. The task's end decides. Anything else is done when it answers.

import {
  ACTIVITY_DONE_TOPIC,
  ACTIVITY_FAILED_TOPIC,
  type ActionState,
  type ActivityManager,
  type ActivityTaskEvent,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  type EventLog,
  isJsonObject,
  type JsonValue,
  type MainActionBody,
  type MainResultBody,
  newId,
  parseTaskEvent,
  parseTaskTopic,
  type TaskEvent,
  type TaskId,
  type TurnId,
} from "@miyoria/types";
import type { ParkedLine } from "./gate.js";

/** How long a result backs what she says about it. */
const FRESH_MS = 2 * 60_000;
/** Finished actions remembered per context. */
const MEMORY = 32;
/** Results a turn is told of. */
const MAX_RESULTS = 5;
/** A failure of her own like one she was told of this recently is no new turn. */
const REPEAT_MS = 5 * 60_000;

export const HANDS_SOURCE = "mainline.hands";

/** What the hands need around them. */
export interface HandsDeps {
  log(): Pick<EventLog, "append"> | null;
  now(): number;
  activity(): ActivityManager | null;
  /** A result is in: tell her in `context` (the Floor decides when). */
  told(context: ContextKey, job: Job): void;
  /** A line that waited for `tools` may go out now. */
  release(context: ContextKey, line: ParkedLine): void;
  /** `tool` finished (commitments it keeps, proposals it took up). */
  finished(tool: string, cause: string | null): void;
}

/** How a task that is not the ActivityManager's ended, if it did already. */
export type EndedLookup = (task: TaskId) => { state: "done" | "failed"; detail: string } | null;

/** One action of an output. */
export interface Job {
  id: string;
  /** Its `action` event. */
  event: string | null;
  turn: TurnId;
  context: ContextKey;
  tool: string;
  state: ActionState | "running";
  detail: string;
  task: TaskId | null;
  /** A steer waits for this (`steered` event) instead of a task end. */
  steer: string | null;
  at: number;
  /**
   * How she hears how it went: `turn`, a result turn (the Floor decides when); `prompt`, nobody
   * waits (a muted turn), so only a failure, in her next prompt; `none`, not at all.
   */
  report: Report;
  /** Result turns this one came from. */
  depth: number;
  /** Runs after the result: who asked, so a follow-up acts for them too. */
  requester: unknown;
  /**
   * A work-lane task (v4 §4.3): what it found is news even when nobody waits, so a muted turn's
   * job keeps its `done` for her next prompt too, not only a failure.
   */
  work?: boolean;
}

export type Report = "turn" | "prompt" | "none";

export interface Run {
  ok: boolean;
  text: string;
  /** The capability's structured result, when there is one. */
  data: JsonValue;
}

function taskOf(data: JsonValue): TaskId | null {
  if (!isJsonObject(data)) return null;
  return typeof data.task === "string" && data.task !== "" ? data.task : null;
}

export class Hands {
  readonly #d: HandsDeps;
  readonly #jobs = new Map<string, Job>();
  /** Jobs waiting for a task, by task id. */
  readonly #byTask = new Map<TaskId, Job>();
  readonly #bySteer = new Map<string, Job>();
  /** Finished jobs by context, newest last. */
  readonly #finished = new Map<string, Job[]>();
  /** Results she was not told of yet, by context. */
  readonly #unsaid = new Map<string, Job[]>();
  /** Failures a result turn was opened for, by context, newest last. */
  readonly #toldFailures = new Map<string, Job[]>();
  #parked: { context: ContextKey; line: ParkedLine; left: Set<string> }[] = [];
  #ended: EndedLookup | null = null;

  constructor(deps: HandsDeps) {
    this.#d = deps;
  }

  /**
   * Where to look up a task that ended before the receipt of its start reached the hands (a
   * work-lane task can: it runs on its own as soon as it is accepted).
   */
  lookUpEnded(lookup: EndedLookup | null): void {
    this.#ended = lookup;
  }

  // ---- running --------------------------------------------------------------------------------

  /** Writes `action` to the log. Returns the job; `run` does the work. */
  begin(input: {
    turn: TurnId;
    context: ContextKey;
    tool: string;
    args: JsonValue;
    report: Report;
    depth: number;
    requester: unknown;
    cause: string | null;
  }): Job {
    const id = newId();
    const body: MainActionBody = { turn: input.turn, call: id, tool: input.tool, args: input.args };
    const event =
      this.#d.log()?.append({
        kind: "action",
        source: HANDS_SOURCE,
        cause: input.cause,
        context: input.context,
        body: body as unknown as JsonValue,
      }).id ?? null;
    const job: Job = {
      id,
      event,
      turn: input.turn,
      context: input.context,
      tool: input.tool,
      state: "running",
      detail: "",
      task: null,
      steer: null,
      at: this.#d.now(),
      report: input.report,
      depth: input.depth,
      requester: input.requester,
    };
    this.#jobs.set(id, job);
    return job;
  }

  /** The work of `job` answered. */
  answered(job: Job, run: Run): void {
    if (!run.ok) {
      this.#end(job, "failed", run.text);
      return;
    }
    const task = taskOf(run.data) ?? this.#activityTask(job);
    if (task === null) {
      this.#end(job, "done", run.text);
      return;
    }
    const known = this.#d.activity()?.task(task) ?? null;
    if (known?.status === "done") {
      this.#end(job, "done", known.detail ?? run.text);
      return;
    }
    if (known?.status === "failed") {
      this.#end(job, "failed", known.failure?.detail ?? run.text);
      return;
    }
    const ended = this.#ended?.(task) ?? null;
    if (ended !== null) {
      this.#end(job, ended.state, ended.detail);
      return;
    }
    if (isJsonObject(run.data) && run.data.work === true) job.work = true;
    job.state = "accepted";
    job.task = task;
    job.detail = run.text;
    this.#byTask.set(task, job);
    this.#record(job);
  }

  /**
   * A result no job of this run waits for (a work-lane task a restart cut): kept and told like
   * one, once. `turn` where someone waits for it, `prompt` otherwise.
   */
  report(input: {
    context: ContextKey;
    tool: string;
    state: "done" | "failed";
    detail: string;
    requester: unknown;
    report: "turn" | "prompt";
  }): void {
    const job: Job = {
      id: newId(),
      event: null,
      turn: newId(),
      context: input.context,
      tool: input.tool,
      state: input.state,
      detail: input.detail,
      task: null,
      steer: null,
      at: this.#d.now(),
      report: input.report,
      depth: 0,
      requester: input.requester,
      work: true,
    };
    const key = contextKeyString(job.context);
    this.#finished.set(key, [...(this.#finished.get(key) ?? []), job].slice(-MEMORY));
    this.#keep(key, job);
    if (input.report === "turn") this.#d.told(job.context, job);
  }

  /** The ActivityManager task the tool of `job` started, when it does not say. */
  #activityTask(job: Job): TaskId | null {
    const tasks = this.#d.activity()?.tasks(16) ?? [];
    const claimed = new Set(this.#byTask.keys());
    for (const task of tasks) {
      if (task.turn === job.turn && !claimed.has(task.id) && task.ended_at === null) return task.id;
    }
    return null;
  }

  /** A steer was accepted: `steered` will say how it went. */
  awaitSteer(job: Job, steer: string, detail: string): void {
    job.state = "accepted";
    job.steer = steer;
    job.detail = detail;
    this.#bySteer.set(steer, job);
    this.#record(job);
  }

  #record(job: Job): void {
    if (job.state === "running") return;
    const body: MainResultBody = {
      turn: job.turn,
      call: job.id,
      tool: job.tool,
      state: job.state,
      detail: job.detail,
      task: job.task,
    };
    this.#d.log()?.append({
      kind: "result",
      source: HANDS_SOURCE,
      cause: job.event,
      context: job.context,
      body: body as unknown as JsonValue,
    });
  }

  #end(job: Job, state: "done" | "failed", detail: string): void {
    job.state = state;
    job.detail = detail;
    job.at = this.#d.now();
    this.#jobs.delete(job.id);
    if (job.task !== null) this.#byTask.delete(job.task);
    if (job.steer !== null) this.#bySteer.delete(job.steer);
    this.#record(job);
    const key = contextKeyString(job.context);
    const done = [...(this.#finished.get(key) ?? []), job].slice(-MEMORY);
    this.#finished.set(key, done);
    if (state === "done") this.#d.finished(job.tool, job.event);
    const released = this.#settleParked(job, state);
    if (released || job.report === "none") return;
    if (job.report === "prompt") {
      // Nobody waits for a turn on it; what failed and why is in her next prompt (and what a
      // work-lane task of hers found: it is something she did, worth telling).
      if (state === "failed" || job.work === true) this.#keep(key, job);
      return;
    }
    this.#keep(key, job);
    if (state === "failed") {
      // Her own retry failing the same way again: she just explained it, the next turn merges it.
      if (this.#repeats(key, job)) return;
      const told = (this.#toldFailures.get(key) ?? []).filter((j) => j.at >= job.at - REPEAT_MS);
      this.#toldFailures.set(key, [...told, job].slice(-MEMORY));
    }
    this.#d.told(job.context, job);
  }

  /**
   * Jobs that ran inside a turn (`report: "none"`) whose turn ended before she said what came of
   * them: they become results like the hands' own. `turn`: a result turn tells them (the call after
   * the tools failed, and nobody heard the answer); `prompt`: her next turn's prompt shows them (she
   * was cut off, and whoever cut in gets that turn). A job still waiting for its task already has
   * its way of being told.
   */
  retell(jobs: readonly Job[], report: "turn" | "prompt"): void {
    const ended = jobs.filter((j) => j.state === "done" || j.state === "failed");
    for (const job of ended) {
      job.report = report;
      this.#keep(contextKeyString(job.context), job);
    }
    // One turn tells them all: they are in the same place, and each shows the rest.
    const last = ended.at(-1);
    if (report === "turn" && last !== undefined) this.#d.told(last.context, last);
  }

  #keep(key: string, job: Job): void {
    this.#unsaid.set(key, [...(this.#unsaid.get(key) ?? []), job].slice(-MAX_RESULTS));
  }

  /** A failure of a turn of her own (nobody asked) that she was told of lately, word for word. */
  #repeats(key: string, job: Job): boolean {
    if (job.requester !== undefined && job.requester !== null) return false;
    const from = job.at - REPEAT_MS;
    return (this.#toldFailures.get(key) ?? []).some(
      (j) => j.tool === job.tool && j.detail === job.detail && j.at >= from,
    );
  }

  // ---- what ended -----------------------------------------------------------------------------

  /** An ActivityManager transition ended. */
  activityEnded(topic: string, event: ActivityTaskEvent): void {
    const job = this.#byTask.get(event.task);
    if (!job) return;
    if (topic === ACTIVITY_DONE_TOPIC && event.type === "done") {
      this.#end(job, "done", event.detail);
    } else if (topic === ACTIVITY_FAILED_TOPIC && event.type === "failed") {
      this.#end(job, "failed", event.detail);
    }
  }

  /** A `<owner>.task.*` event. */
  taskEvent(topic: string, payload: JsonValue): void {
    if (parseTaskTopic(topic) === null) return;
    const event: TaskEvent | null = parseTaskEvent(payload);
    if (event === null) return;
    if (event.type === "steered") {
      const job = this.#bySteer.get(event.steer);
      if (job) this.#end(job, event.outcome === "applied" ? "done" : "failed", event.detail);
      return;
    }
    if (event.type !== "done" && event.type !== "failed") return;
    const job = this.#byTask.get(event.task);
    if (job) this.#end(job, event.type, event.detail);
  }

  /** A task the hands follow: its notice is told through them. */
  follows(task: TaskId | null): boolean {
    return task !== null && this.#byTask.has(task);
  }

  // ---- what the gate reads --------------------------------------------------------------------

  done(context: ContextKey, tool: string): boolean {
    const from = this.#d.now() - FRESH_MS;
    return (this.#finished.get(contextKeyString(context)) ?? []).some(
      (j) => j.tool === tool && j.state === "done" && j.at >= from,
    );
  }

  /** The tools of what is out in `context` with no result yet. */
  pending(context: ContextKey): string[] {
    return [...this.#jobs.values()]
      .filter((j) => contextKeyEquals(j.context, context))
      .map((j) => j.tool);
  }

  /** The newest finished actions of `context`, newest last. */
  recent(context: ContextKey, limit: number): Job[] {
    return (this.#finished.get(contextKeyString(context)) ?? []).slice(-limit);
  }

  /** Results of `context` she was not told of yet; they count as told. */
  takeResults(context: ContextKey): Job[] {
    const key = contextKeyString(context);
    const jobs = this.#unsaid.get(key) ?? [];
    this.#unsaid.delete(key);
    return jobs;
  }

  /**
   * Results of `context` she was not told of yet, still unsaid until `told`: a turn that shows
   * them may be cancelled before it says anything (2026-11-08 15:33: a refused feed was lost so).
   */
  peekResults(context: ContextKey): Job[] {
    return [...(this.#unsaid.get(contextKeyString(context)) ?? [])];
  }

  /** A turn that showed `jobs` got to its end: they count as told. */
  toldOf(jobs: readonly Job[]): void {
    if (jobs.length === 0) return;
    const ids = new Set(jobs.map((j) => j.id));
    for (const [key, list] of this.#unsaid) {
      const left = list.filter((j) => !ids.has(j.id));
      if (left.length === 0) this.#unsaid.delete(key);
      else this.#unsaid.set(key, left);
    }
  }

  // ---- lines waiting for results --------------------------------------------------------------

  /** `line` goes out when every one of its tools came back done. */
  /** The emergency stop: nothing that waited for a result is said once she is back. */
  dropParked(): void {
    this.#parked = [];
  }

  park(context: ContextKey, line: ParkedLine): void {
    this.#parked.push({ context, line, left: new Set(line.tools) });
  }

  /** Whether a parked line was released for what `job` did. */
  #settleParked(job: Job, state: "done" | "failed"): boolean {
    let released = false;
    for (const parked of [...this.#parked]) {
      if (!contextKeyEquals(parked.context, job.context) || !parked.left.has(job.tool)) continue;
      if (state === "failed") {
        // What she meant to say is not true: she hears why instead.
        this.#parked = this.#parked.filter((p) => p !== parked);
        continue;
      }
      parked.left.delete(job.tool);
      if (parked.left.size > 0) continue;
      this.#parked = this.#parked.filter((p) => p !== parked);
      this.#d.release(parked.context, parked.line);
      released = true;
    }
    return released;
  }
}
