// Game adapter interface (docs/ARCHITECTURE.md §12.3) and its mapping onto the task contract
// (docs/design/v2-architecture.md §3.8): the adapter is the task executor of `game.<id>`
// (`ctx.tasks.register`), its events are published as `game.<id>.<type>`, and
// `describe().prompt` becomes a prompt section.
//
// The `game.<id>.*` namespace belongs to the extension whose manifest has
// kind `game-adapter` and `game = "<id>"`; the host refuses game topics and
// tools from anyone else (docs/protocols/extension-rpc.md, "Game adapters").
//
// The core picks goals and starts them as tasks (id + budget); it learns how they ended from the
// task events, never from event names or result texts. An adapter with its own executor
// (`tasks`, usually a `TaskRunner`) reports real completion; one without gets its `act` wrapped
// as one-step tasks (done / failed when `act` returns). There are no raw `observe` / `act`
// tools any more: nothing outside the executor can drive the game.

import type { ExtensionContext } from "./extension.js";
import { type TaskExecutor, TaskFailure, type TaskFailureCode, TaskRunner, type TaskWorker } from "./task.js";
import { isValidTopic } from "./topics.js";
import type { JsonSchema } from "./types.js";

export interface GameActionSpec {
  /** e.g. `"goto"`, `"mine"`, `"chat"`. */
  name: string;
  description: string;
  /** JSON Schema of the action arguments. */
  parameters?: JsonSchema;
  /** Suggested task budget (seconds) of this goal. */
  budget_s?: number;
}

export interface GameInfo {
  /** Short id used in tool and topic names: `[a-z0-9_-]+`, e.g. `"minecraft"`. */
  id: string;
  /** Display name, e.g. `"Minecraft"`. */
  name: string;
  /** The goals the core may start (task `goal` = action name). */
  actions: GameActionSpec[];
  /** Prompt fragment added while the adapter is registered. */
  prompt?: string;
  /**
   * How to play (progression, rules of thumb), sent with the executor so the game's decision
   * loop sees it; chat turns do not pay for it.
   */
  guide?: string;
}

export interface GameObservation {
  /** Structured state (health, position, inventory, ...). */
  state: Record<string, unknown>;
  /** Short text summary for the model. */
  summary: string;
  /** Optional screenshot for multimodal models (not sent through tools yet). */
  screenshot?: { mime: string; data: string };
}

export interface GameAction {
  name: string;
  args?: Record<string, unknown>;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  data?: unknown;
  /** Why it failed (`ok: false`), as a task failure code; `internal` when missing. */
  code?: TaskFailureCode;
}

export interface GameEvent {
  /** Topic suffix, e.g. `"death"`, `"chat"`, `"player.joined"`. */
  type: string;
  data?: unknown;
  /** Worth live commentary. */
  important?: boolean;
}

export interface GameAdapter {
  describe(): GameInfo;
  /** `signal`: aborted when the host stops waiting. */
  observe(signal?: AbortSignal): Promise<GameObservation>;
  /**
   * One action. Used by the default executor (`tasks` missing): `ok` = the task is done.
   * `signal`: aborted when the task is cancelled or out of budget; stop rather than finish late.
   */
  act(action: GameAction, signal?: AbortSignal): Promise<ActionResult>;
  events(): AsyncIterable<GameEvent>;
  /** The adapter's own task executor (real completion, budgets, cancellation). */
  readonly tasks?: TaskExecutor;
}

/** Handle returned by `ctx.game.registerAdapter`. */
export interface RegisteredAdapter {
  info: GameInfo;
  /** The executor registered for `game.<id>`. */
  executor: TaskExecutor;
  /** Resolves when the adapter's event stream ends. */
  done: Promise<void>;
}

const GAME_ID = /^[a-z0-9_-]{1,32}$/;

/** `act` as a one-step task: done when it returns `ok`, else failed with its code. */
export function actWorker(adapter: GameAdapter, info: GameInfo): TaskWorker {
  return {
    observe: (signal) => adapter.observe(signal),
    async run(spec, task) {
      if (!info.actions.some((a) => a.name === spec.goal)) {
        throw new TaskFailure("invalid", `沒有「${spec.goal}」這個動作`);
      }
      const result = await adapter.act({ name: spec.goal, args: spec.args }, task.signal);
      if (!result.ok) throw new TaskFailure(result.code ?? "internal", result.message ?? "失敗");
      return { detail: result.message ?? "", data: result.data ?? null };
    },
  };
}

/**
 * The goals and the guide as the decision loop's prompt shows them (`@miyoria/game` builds the
 * same text from the registered executor).
 */
export function describeActions(info: GameInfo): string {
  const lines = info.actions.map((a) => {
    const params = a.parameters ? ` 參數:${JSON.stringify(a.parameters)}` : "";
    return `- ${a.name}:${a.description}${params}`;
  });
  const guide = info.guide?.trim() ? `\n\n${info.guide.trim()}` : "";
  return `在 ${info.name} 裡做一個高階動作。可用動作:\n${lines.join("\n")}${guide}`;
}

/** Text the model sees for an observation (summary, then the state as JSON). */
export function formatObservation(obs: GameObservation): string {
  return `${obs.summary}\n\n狀態:${JSON.stringify(obs.state)}`;
}

/** Implementation of `ctx.game.registerAdapter`. */
export async function registerGameAdapter(
  ctx: ExtensionContext,
  adapter: GameAdapter,
): Promise<RegisteredAdapter> {
  const info = adapter.describe();
  if (!GAME_ID.test(info.id)) throw new Error(`invalid game id "${info.id}"`);
  if (ctx.game.id !== info.id) {
    throw new Error(
      ctx.game.id === undefined
        ? `game adapter "${info.id}" needs kind = ["game-adapter", ...] and game = "${info.id}" in miyoria.extension.toml`
        : `game adapter id "${info.id}" does not match the manifest game "${ctx.game.id}"`,
    );
  }
  const base = `game.${info.id}`;

  const executor = adapter.tasks ?? new TaskRunner(actWorker(adapter, info));
  await ctx.tasks.register(executor, {
    name: info.name,
    goals: info.actions.map((a) => ({
      name: a.name,
      description: a.description,
      ...(a.parameters ? { parameters: a.parameters } : {}),
      ...(a.budget_s !== undefined ? { budget_s: a.budget_s } : {}),
    })),
    ...(info.guide ? { guide: info.guide } : {}),
  });
  if (info.prompt) {
    const prompt = info.prompt;
    await ctx.prompt.register(base, () => [{ title: info.name, body: prompt, order: 50 }]);
  }

  const done = (async () => {
    for await (const event of adapter.events()) {
      const topic = `${base}.${event.type}`;
      // `game.<id>.task.*` carries the task events (sent by the executor, not as game events).
      if (!isValidTopic(topic) || event.type === "task" || event.type.startsWith("task.")) {
        ctx.log.warn("game event with an invalid type skipped", { type: event.type });
        continue;
      }
      try {
        await ctx.events.publish(topic, event);
      } catch (error) {
        ctx.log.warn("publishing a game event failed", { topic, error: String(error) });
      }
    }
  })().catch((error: unknown) => {
    ctx.log.error("game event stream failed", { game: info.id, error: String(error) });
  });
  return { info, executor, done };
}
