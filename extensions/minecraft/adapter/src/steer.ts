// The adapter's task executor with `steer` (docs/design/v3-architecture.md §10.6): changing the
// goal of a running task without losing its progress.
//
// It is a `TaskRunner` (budget, `cancel`, `superseded`... are the SDK's) plus:
//
// - `steer(steer)`: accepts the patch and answers with a `steered` event, `applied`, `rejected` or
//   `too_late`. What a patch may change, and where it is read, is the runner's business (for an
//   `obtain` plan: `ObtainRunner`, between two steps); this class only keeps the books: which
//   tasks exist, and the events.
// - `events()`: the runner's events with the `steered` ones merged in.

import {
  type SteerOutcome,
  type TaskEvent,
  TaskRunner,
  type TaskSpec,
  type TaskSteer,
  type TaskWorker,
} from "@miyoria/sdk";

export type SteerRequest = TaskSteer;

export type { SteerOutcome };

/** The `steered` task event. */
export type SteeredEvent = Extract<TaskEvent, { type: "steered" }>;

/**
 * Looks at a steer of a running task. `null`: it is queued, the answer comes later through
 * `reportSteer` (at the next safe point). Otherwise the outcome to report at once.
 */
export type SteerHandler = (steer: SteerRequest) => { outcome: "rejected" | "too_late"; detail: string } | null;

/** Task ids remembered, to tell a task that ended from one nobody started. */
const MAX_KNOWN = 256;

export class SteerableTasks extends TaskRunner {
  readonly #handler: SteerHandler;
  readonly #listeners = new Set<(event: SteeredEvent) => void>();
  readonly #known = new Set<string>();
  readonly #clock: () => number;

  constructor(worker: TaskWorker, handler: SteerHandler, now: () => number = Date.now) {
    super(worker, { now });
    this.#handler = handler;
    this.#clock = now;
  }

  override async start(spec: TaskSpec): Promise<void> {
    if (typeof spec?.id === "string") {
      this.#known.delete(spec.id);
      this.#known.add(spec.id);
      if (this.#known.size > MAX_KNOWN) {
        const oldest = this.#known.values().next().value;
        if (oldest !== undefined) this.#known.delete(oldest);
      }
    }
    return super.start(spec);
  }

  /** Accepts `steer`; its outcome is a `steered` event. */
  async steer(steer: SteerRequest): Promise<void> {
    if (!this.running.includes(steer.task)) {
      if (this.#known.has(steer.task)) {
        this.reportSteer(steer.task, steer.id, "too_late", "任務已經結束了,來不及調整");
      } else {
        this.reportSteer(steer.task, steer.id, "rejected", "沒有這個任務");
      }
      return;
    }
    let answer: ReturnType<SteerHandler>;
    try {
      answer = this.#handler(steer);
    } catch (error) {
      answer = { outcome: "rejected", detail: error instanceof Error ? error.message : String(error) };
    }
    if (answer !== null) this.reportSteer(steer.task, steer.id, answer.outcome, answer.detail);
  }

  /** Publishes the outcome of a steer. */
  reportSteer(task: string, steer: string, outcome: SteerOutcome, detail: string): void {
    const event: SteeredEvent = {
      type: "steered",
      task,
      steer,
      outcome,
      detail,
      at: new Date(this.#clock()).toISOString(),
    };
    for (const listener of [...this.#listeners]) listener(event);
  }

  override events(): AsyncIterable<TaskEvent> {
    const base = super.events();
    const listeners = this.#listeners;
    return {
      [Symbol.asyncIterator](): AsyncIterator<TaskEvent> {
        const inner = base[Symbol.asyncIterator]();
        const queue: TaskEvent[] = [];
        const waiting: { wake: (() => void) | null } = { wake: null };
        let closed = false;
        const push = (event: TaskEvent) => {
          queue.push(event);
          waiting.wake?.();
        };
        const listener = (event: SteeredEvent) => push(event);
        listeners.add(listener);
        void (async () => {
          for (;;) {
            const next = await inner.next();
            if (next.done) break;
            push(next.value);
          }
          closed = true;
          waiting.wake?.();
        })().catch(() => {
          closed = true;
          waiting.wake?.();
        });
        return {
          async next(): Promise<IteratorResult<TaskEvent>> {
            for (;;) {
              const value = queue.shift();
              if (value !== undefined) return { value, done: false };
              if (closed) {
                listeners.delete(listener);
                return { value: undefined, done: true };
              }
              await new Promise<void>((resolve) => {
                waiting.wake = resolve;
              });
              waiting.wake = null;
            }
          },
          async return(): Promise<IteratorResult<TaskEvent>> {
            listeners.delete(listener);
            await inner.return?.();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}
