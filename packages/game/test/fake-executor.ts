// A fake game task executor for the director's tests: records starts and cancels, ends tasks
// when the test says so (or at once for instant goals), and publishes every task event on the
// bus as `game.<id>.task.<type>` like the extension host does.

import type { ServiceRegistry } from "@miyoria/kernel";
import {
  customEvent,
  type Event,
  type JsonObject,
  type JsonValue,
  type RegisteredTaskExecutor,
  type StructuredState,
  type TaskEvent,
  type TaskExecutorInfo,
  type TaskExecutors,
  TaskExecutorsKey,
  type TaskFailureCode,
  type TaskGoalSpec,
  type TaskId,
  type TaskSpec,
  type TaskSteer,
  taskTopic,
  toTimestamp,
} from "@miyoria/types";

export type FakeEnd =
  | { type: "done"; detail: string }
  | { type: "failed"; code: TaskFailureCode; detail: string };

const goal = (name: string, description: string, budget_s: number | null = null): TaskGoalSpec => ({
  name,
  description,
  parameters: null,
  budget_s,
});

export const MINECRAFT_GOALS: TaskGoalSpec[] = [
  goal("goto", "走"),
  goal("mine", "挖", 300),
  goal("get", "取得"),
  goal("obtain", "取得(自己排步驟)", 600),
  goal("explore", "探索"),
  goal("chat", "說話", 10),
  goal("stop", "停下來", 10),
];

export class FakeExecutor implements RegisteredTaskExecutor {
  readonly info: TaskExecutorInfo;
  state: JsonObject = { connected: true, in_game: true };
  summary = "血量 20/20\n位置 (0, 64, 0)";
  /** What `observe` reports as running (`undefined`: the last task still running). */
  reportTask: TaskId | null | undefined = undefined;
  observeCalls = 0;
  readonly starts: TaskSpec[] = [];
  readonly cancels: TaskId[] = [];
  readonly running = new Set<TaskId>();
  /** Steers accepted (the executor has none unless a test sets `steer`). */
  readonly steers: TaskSteer[] = [];
  steer?: (steer: TaskSteer) => Promise<void>;
  /** A start throws this (refused), else it is accepted. */
  refuse: (spec: TaskSpec) => Error | null = () => null;
  /** How a task ends right after it started; `null` keeps it running. */
  autoEnd: (spec: TaskSpec) => FakeEnd | null = (spec) =>
    ["chat", "stop", "quit", "look"].includes(spec.goal) ? { type: "done", detail: "好" } : null;
  readonly #streams = new Set<(e: TaskEvent) => void>();

  constructor(
    readonly publish: (event: Event) => void,
    readonly now: () => number = Date.now,
    info: Partial<TaskExecutorInfo> = {},
  ) {
    this.info = {
      owner: "game.minecraft",
      name: "Minecraft",
      goals: MINECRAFT_GOALS,
      guide: null,
      ...info,
    };
  }

  /** Starts as `{action, args}`, like the old act tool's arguments. */
  acts(): Array<Record<string, JsonValue>> {
    return this.starts.map((s) => ({ action: s.goal, args: s.args }));
  }

  names(): string[] {
    return this.starts.map((s) => s.goal);
  }

  last(): TaskSpec {
    const s = this.starts.at(-1);
    if (!s) throw new Error("nothing started");
    return s;
  }

  emit(event: TaskEvent): void {
    this.publish(
      customEvent(taskTopic(this.info.owner, event.type), event as unknown as JsonValue),
    );
    for (const push of this.#streams) push(event);
  }

  #at(): string {
    return toTimestamp(this.now());
  }

  async observe(): Promise<StructuredState> {
    this.observeCalls += 1;
    const task =
      this.reportTask === undefined ? ([...this.running].at(-1) ?? null) : this.reportTask;
    return { at: this.#at(), state: structuredClone(this.state), task, summary: this.summary };
  }

  async start(spec: TaskSpec): Promise<void> {
    const refused = this.refuse(spec);
    if (refused) throw refused;
    this.starts.push(structuredClone(spec));
    this.running.add(spec.id);
    this.emit({ type: "started", task: spec.id, goal: spec.goal, at: this.#at() });
    const end = this.autoEnd(spec);
    if (end) this.#end(spec.id, end);
  }

  async cancel(id: TaskId): Promise<void> {
    this.cancels.push(id);
    if (this.running.has(id))
      this.#end(id, { type: "failed", code: "cancelled", detail: "cancelled" });
  }

  /** Ends `id` (default: the last start) with `done`. */
  done(detail = "好了", id: TaskId = this.last().id): void {
    this.#end(id, { type: "done", detail });
  }

  /** Ends `id` (default: the last start) with `failed` / `code`. */
  fail(code: TaskFailureCode, detail: string, id: TaskId = this.last().id): void {
    this.#end(id, { type: "failed", code, detail });
  }

  /** An event for a task id this executor never ran (stale or foreign). */
  stray(id: TaskId): void {
    this.emit({ type: "done", task: id, detail: "stale", data: null, at: this.#at() });
  }

  #end(id: TaskId, end: FakeEnd): void {
    this.running.delete(id);
    this.emit(
      end.type === "done"
        ? { type: "done", task: id, detail: end.detail, data: null, at: this.#at() }
        : { type: "failed", task: id, code: end.code, detail: end.detail, at: this.#at() },
    );
  }

  events(): AsyncIterable<TaskEvent> {
    const streams = this.#streams;
    return {
      [Symbol.asyncIterator]() {
        const items: TaskEvent[] = [];
        let wake: (() => void) | null = null;
        const push = (e: TaskEvent) => {
          items.push(e);
          wake?.();
        };
        streams.add(push);
        return {
          async next(): Promise<IteratorResult<TaskEvent>> {
            for (;;) {
              const item = items.shift();
              if (item) return { value: item, done: false };
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = null;
            }
          },
          async return(): Promise<IteratorResult<TaskEvent>> {
            streams.delete(push);
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

/** A `TaskExecutors` registry holding `executors` (mutable: tests remove one). */
export class FakeExecutors implements TaskExecutors {
  readonly byOwner = new Map<string, RegisteredTaskExecutor>();

  constructor(...executors: RegisteredTaskExecutor[]) {
    for (const e of executors) this.byOwner.set(e.info.owner, e);
  }

  get(owner: string): RegisteredTaskExecutor | undefined {
    return this.byOwner.get(owner);
  }

  list(): RegisteredTaskExecutor[] {
    return [...this.byOwner.values()];
  }

  /** Provides the registry as the extension host would. */
  provide(services: ServiceRegistry): this {
    services.provide("extensions", TaskExecutorsKey, this);
    return this;
  }
}
