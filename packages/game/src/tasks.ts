// The director's side of the task contract (v2 §3.8): find a game's executor, describe its
// goals to the model, run one task to its end. Completion and failure always come from the
// executor's task events (with a code), never from event names or result texts.

import type { ServiceLookup } from "@miyoria/kernel";
import {
  gameTaskOwner,
  isTaskFailureCode,
  isTerminalTaskEvent,
  type JsonObject,
  type JsonValue,
  type RegisteredTaskExecutor,
  type StructuredState,
  type TaskEvent,
  type TaskExecutorInfo,
  TaskExecutorsKey,
  type TaskFailureCode,
  type TaskSpec,
  toTimestamp,
} from "@miyoria/types";

/** The executor of `game`, if its adapter registered one. */
export function gameExecutor(services: ServiceLookup, game: string): RegisteredTaskExecutor | null {
  return services.get(TaskExecutorsKey)?.get(gameTaskOwner(game)) ?? null;
}

/**
 * A game step that failed, with its task failure code (the ActivityManager's `failureCode`
 * reads `code`, so `game.start` fails with e.g. `timeout` instead of a generic precondition).
 */
export class GameTaskError extends Error {
  override readonly name = "GameTaskError";

  constructor(
    readonly code: TaskFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The goal catalogue as the decision prompt shows it (same text as the SDK's `describeActions`). */
export function goalCatalog(info: TaskExecutorInfo): {
  description: string;
  parameters: JsonValue;
} {
  const lines = info.goals.map((g) => {
    const params = g.parameters !== null ? ` 參數:${JSON.stringify(g.parameters)}` : "";
    return `- ${g.name}:${g.description}${params}`;
  });
  const guide = info.guide?.trim() ? `\n\n${info.guide.trim()}` : "";
  return {
    description: `在 ${info.name} 裡做一個高階動作。可用動作:\n${lines.join("\n")}${guide}`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: info.goals.map((g) => g.name) },
        args: { type: "object", description: "動作參數,依動作而定" },
      },
      required: ["action"],
    },
  };
}

/** Whether the executor offers `goal`. */
export function offersGoal(info: TaskExecutorInfo, goal: string): boolean {
  return info.goals.some((g) => g.name === goal);
}

/** The budget of `goal`: the executor's suggestion, else `fallbackSecs`, at most `maxSecs`. */
export function budgetFor(
  info: TaskExecutorInfo,
  goal: string,
  fallbackSecs: number,
  maxSecs: number,
): number {
  const suggested = info.goals.find((g) => g.name === goal)?.budget_s ?? null;
  const budget = suggested !== null && suggested > 0 ? suggested : fallbackSecs;
  return Math.max(Math.min(budget, maxSecs), 0.001);
}

/** Text of an observation for the decision prompt (data for the model, never parsed again). */
export function observationText(obs: StructuredState): string {
  return `${obs.summary}\n\n狀態:${JSON.stringify(obs.state)}`;
}

/** `state.<key>` as an object, if it is one. */
export function stateObject(state: JsonObject, key: string): JsonObject | null {
  const v = state[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
}

/** Observes with a deadline (`timeoutMs`) on top of `signal`; failures throw `GameTaskError`. */
export async function observeWithin(
  executor: RegisteredTaskExecutor,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StructuredState> {
  const deadline = AbortSignal.timeout(Math.max(timeoutMs, 1));
  const both = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    return await executor.observe(both);
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) {
      throw new GameTaskError("timeout", `observe timed out after ${timeoutMs} ms`, {
        cause: error,
      });
    }
    throw new GameTaskError(codeOf(error), errorText(error), { cause: error });
  }
}

/** A terminal task event. */
export type TaskEnd = Extract<TaskEvent, { type: "done" | "failed" }>;

/**
 * Starts `spec` and waits for its terminal event. Aborting `signal` cancels the task (the
 * executor reports `cancelled`; this resolves with a `cancelled` end at once). A start the
 * executor refuses resolves with a `failed` end carrying the refusal's code.
 */
export async function runTask(
  executor: RegisteredTaskExecutor,
  spec: TaskSpec,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<TaskEnd> {
  const stream = executor.events()[Symbol.asyncIterator]();
  const cancelled = (): TaskEnd => ({
    type: "failed",
    task: spec.id,
    code: "cancelled",
    detail: "cancelled",
    at: toTimestamp(now()),
  });
  // Subscribe first so a fast task's end is not missed.
  const ended = (async (): Promise<TaskEnd | null> => {
    for (;;) {
      const next = await stream.next();
      if (next.done) return null;
      const e = next.value;
      if (e.task === spec.id && isTerminalTaskEvent(e)) return e;
    }
  })();
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<TaskEnd>((resolve) => {
    if (!signal) return;
    onAbort = () => {
      void executor.cancel(spec.id).catch(() => undefined);
      resolve(cancelled());
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    if (signal?.aborted) return cancelled();
    try {
      await executor.start(spec, signal);
    } catch (error) {
      if (signal?.aborted) return cancelled();
      return {
        type: "failed",
        task: spec.id,
        code: codeOf(error),
        detail: errorText(error),
        at: toTimestamp(now()),
      };
    }
    const end = await Promise.race([ended, aborted]);
    return (
      end ?? {
        type: "failed",
        task: spec.id,
        code: "disconnected",
        detail: "the executor went away",
        at: toTimestamp(now()),
      }
    );
  } finally {
    if (onAbort !== null && signal) signal.removeEventListener("abort", onAbort);
    void stream.return?.();
  }
}

/** The task failure code an error carries (`code`), else `internal`. */
export function codeOf(error: unknown): TaskFailureCode {
  const code = (error as { code?: unknown } | null)?.code;
  return isTaskFailureCode(code) ? code : "internal";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
