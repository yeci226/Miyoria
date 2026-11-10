// Steer (docs/design/v3-architecture.md §10.6): changing a running task's goal without losing its
// progress. This is the manager's half; the executor's half is `TaskExecutor.steer`.
//
// What it guarantees on top of the executor:
//
// 1. Only the main line (`Principals.self`) may steer. A steer never comes from chat or the panel.
// 2. The task must be live. One that ended is `too_late`, one nobody knows is `rejected`.
// 3. The patch cannot touch the budget or the clock: `budget_s` and the start time stay as they
//    were (rule 6), so a steer cannot stretch a task for ever.
// 4. The patched goal goes through the same checks as any other action: the rules
//    (`Directives.check` on the goal as it would be after the patch, fail closed; anything short
//    of an allow refuses, a steer cannot wait for an answer), a hold on the capability, and then
//    the gate, as `game.act` for a game task (the rules again, pause, prohibitions, budget). A
//    steer cannot get around "do not play Minecraft".
// 5. Two-step receipt: `steer` returns once the executor accepted the patch; `steered` follows
//    with `applied` / `rejected` / `too_late`. Whatever ends a steer without the executor saying
//    so (the task ended first) is turned into `too_late` here, so each steer gets one outcome.
// 6. An executor without `steer`, and single-step tasks (a scene switch), answer `unsupported`:
//    the caller cancels and starts again, knowing the progress is lost.
// 7. The request is a `steer` line of the EventLog whose id is the steer's id and whose cause is
//    the event that triggered it; every outcome is a `steered` bus event whose `steer` names that
//    id (the facts layer writes it under it), so the whole chain can be followed.

import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import {
  type ActivityRequest,
  ArbiterKey,
  customEvent,
  DirectivesKey,
  type Event,
  EventLogKey,
  isJsonObject,
  isSteerOutcome,
  isTaskSteer,
  type JsonObject,
  type JsonValue,
  type Principal,
  type SteerableTask,
  type SteerOutcome,
  type SteerReceipt,
  type SteerRefusal,
  type SteerRequest,
  type SteerRequestBody,
  type SteerRoute,
  type TaskEvent,
  TaskExecutorsKey,
  type TaskId,
  type TaskSpec,
  type TaskSteer,
  type TaskSteerService,
  type Timestamp,
  taskTopic,
  toTimestamp,
} from "@miyoria/types";
import type { ActivityPort } from "./port.js";
import { failureCode, StepError } from "./port.js";

const log = getLogger("activity.steer");

/** Keys of a patch that would reach the budget or the clock (a steer never changes them). */
const RESERVED_KEYS = new Set([
  "id",
  "task",
  "budget",
  "budget_s",
  "timeout",
  "timeout_s",
  "deadline",
  "started_at",
]);

/** A patch may not be larger than this (JSON characters). */
const MAX_PATCH_CHARS = 4_000;

/** Ended task ids, live tasks and answered steers remembered. */
const MEMORY = 256;

/** A rule or a hold on any of these stops a game task from being steered. */
const GAME_CAPABILITIES = ["game.start", "game.act"] as const;

/** The game executors' capability: it runs a goal (or, with `steer`, steers it) through the gate. */
export const GAME_ACT_CAPABILITY = "game.act";

/** A task of an executor, as far as the bus and `track` told. */
interface Live {
  owner: string;
  goal: string;
  args: JsonObject;
  budget_s: number | null;
  started_at: Timestamp | null;
}

/** A steer the executor is being asked (or accepted) and has not answered yet. */
interface Pending {
  owner: string;
  task: TaskId;
  patch: JsonObject;
}

export interface SteerDeskOptions {
  port: ActivityPort;
  services: ServiceLookup | null;
  publish: (event: Event) => void;
  now: () => number;
  /** How long the executor may take to accept a steer. */
  timeoutMs: number;
  /** The request of a task the manager itself runs (those cannot be steered), or `null`. */
  managerTask: (task: TaskId) => ActivityRequest | null;
}

/** Remembers `value` under `key`, forgetting the oldest beyond `MEMORY`. */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MEMORY) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function patchSize(patch: JsonObject): number {
  try {
    return JSON.stringify(patch).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The steer part of the ActivityManager. */
export class SteerDesk implements TaskSteerService {
  readonly #o: SteerDeskOptions;
  readonly #live = new Map<TaskId, Live>();
  readonly #ended = new Map<TaskId, string>();
  readonly #pending = new Map<string, Pending>();
  /** Steer id → how it ended. */
  readonly #settled = new Map<string, SteerOutcome>();
  readonly #receipts = new Map<string, SteerReceipt>();
  readonly #routes = new Map<string, SteerRoute>();

  constructor(options: SteerDeskOptions) {
    this.#o = options;
  }

  // ---- what the executors say ---------------------------------------------------------------

  track(owner: string, spec: TaskSpec, at?: Timestamp): void {
    if (this.#ended.has(spec.id)) return;
    const known = this.#live.get(spec.id);
    remember(this.#live, spec.id, {
      owner,
      goal: spec.goal,
      args: structuredClone(spec.args),
      budget_s: spec.budget_s,
      started_at: known?.started_at ?? at ?? toTimestamp(this.#o.now()),
    });
  }

  registerRoute(owner: string, route: SteerRoute): () => void {
    this.#routes.set(owner, route);
    return () => {
      if (this.#routes.get(owner) === route) this.#routes.delete(owner);
    };
  }

  /** One task event of `owner` (the bus: `<owner>.task.*`). */
  observeTask(owner: string, event: TaskEvent): void {
    switch (event.type) {
      case "started": {
        if (this.#ended.has(event.task)) return;
        const known = this.#live.get(event.task);
        if (known === undefined) {
          remember(this.#live, event.task, {
            owner,
            goal: event.goal,
            args: {},
            budget_s: null,
            started_at: event.at,
          });
        } else {
          known.started_at = event.at;
        }
        return;
      }
      case "steered": {
        const patch = this.#pending.get(event.steer)?.patch;
        this.#settle(event.steer, event.outcome);
        const live = this.#live.get(event.task);
        if (event.outcome === "applied" && live !== undefined && patch !== undefined) {
          live.args = { ...live.args, ...patch };
        }
        return;
      }
      case "done":
      case "failed": {
        this.#live.delete(event.task);
        remember(this.#ended, event.task, owner);
        // A steer the executor never answered ended with the task: it came too late.
        for (const [id, p] of [...this.#pending]) {
          if (p.task === event.task) {
            this.#publishOutcome(id, p.owner, p.task, "too_late", "任務在調整生效之前就結束了");
          }
        }
        return;
      }
      default:
        return;
    }
  }

  // ---- steer --------------------------------------------------------------------------------

  async steer(request: SteerRequest): Promise<SteerReceipt> {
    const steer = request?.steer;
    if (!isTaskSteer(steer) || typeof request.owner !== "string" || request.owner === "") {
      const loose = (steer ?? {}) as { id?: unknown; task?: unknown };
      return {
        status: "rejected",
        steer: typeof loose.id === "string" ? loose.id : "",
        task: typeof loose.task === "string" ? loose.task : "",
        reason: "invalid",
        detail: "調整的格式不對(要有 id、task、patch、why、cause 和 owner)",
      };
    }
    const done = this.#receipts.get(steer.id);
    if (done !== undefined) return done;
    const receipt = await this.#steer(request, steer);
    remember(this.#receipts, steer.id, receipt);
    return receipt;
  }

  async #steer(request: SteerRequest, steer: TaskSteer): Promise<SteerReceipt> {
    const { owner, principal } = request;
    this.#logRequest(request);
    const reject = (reason: SteerRefusal, detail: string): SteerReceipt => {
      this.#publishOutcome(steer.id, owner, steer.task, "rejected", detail);
      return { status: "rejected", steer: steer.id, task: steer.task, reason, detail };
    };
    const unsupported = (detail: string): SteerReceipt => ({
      status: "unsupported",
      steer: steer.id,
      task: steer.task,
      detail,
      fallback: "cancel_then_start",
      progress_lost: true,
    });
    const tooLate = (detail: string): SteerReceipt => {
      this.#publishOutcome(steer.id, owner, steer.task, "too_late", detail);
      return { status: "too_late", steer: steer.id, task: steer.task, detail };
    };

    // 1. Only the main line.
    if (principal.kind !== "self") {
      return reject("not_main_line", "只有主線可以改任務的方向(聊天和面板要先變成主線的判斷)");
    }
    // Single steps cannot be steered: a scene switch, a join, a launch...
    if (
      this.#o.managerTask(steer.task) !== null ||
      owner === "stage" ||
      owner.startsWith("stage.")
    ) {
      return unsupported("切換是單一步驟,沒有可以保留的進度;要改就取消再重開(或直接取代)");
    }
    // 3. The budget and the clock stay as they were.
    const bad = Object.keys(steer.patch).find((k) => RESERVED_KEYS.has(k));
    if (bad !== undefined) {
      return reject("invalid", `調整不能動 ${bad}(預算和開始時間照舊,不能用調整延長任務)`);
    }
    if (patchSize(steer.patch) > MAX_PATCH_CHARS) return reject("invalid", "調整的內容太長了");

    const route = this.#routes.get(owner) ?? null;
    const game = route === null && owner.startsWith("game.");
    if (route === null && !game) {
      return unsupported(`${owner} 沒有開放中途改方向;要改就取消再重開`);
    }
    // 2. The task is live.
    let task: SteerableTask;
    let budget: number | null = null;
    let started: Timestamp | null = null;
    if (route !== null) {
      const found = route.live(steer.task);
      if (found === "over") return tooLate("任務已經結束了,來不及調整");
      if (found === null) return reject("unknown_task", "沒有這個任務");
      task = found;
    } else {
      const live = this.#live.get(steer.task);
      if (live === undefined || live.owner !== owner) {
        if (this.#ended.has(steer.task)) return tooLate("任務已經結束了,來不及調整");
        return reject("unknown_task", "沒有這個任務(或不是這個執行器的)");
      }
      task = { goal: live.goal, args: live.args };
      budget = live.budget_s;
      started = live.started_at;
    }
    // 6. No `steer` on the executor: she cancels and starts again.
    if (game) {
      const executor = this.#o.services?.get(TaskExecutorsKey)?.get(owner);
      if (executor === undefined) return reject("failed", "這個遊戲的執行器沒有在執行");
      if (typeof executor.steer !== "function") {
        return unsupported(`${executor.info.name} 的執行器不支援中途改方向;要改就取消再重開`);
      }
    }
    // 4. The same rules as everything else, on the goal as it would be after the patch: the
    // rules and holds first (fail closed), then the gate.
    const capability = route?.capability ?? GAME_ACT_CAPABILITY;
    const capabilities = route === null ? GAME_CAPABILITIES : [capability];
    const patched: SteerableTask = { goal: task.goal, args: { ...task.args, ...steer.patch } };
    const ruled = await this.#ruled(capabilities, owner, patched, principal);
    if (ruled !== null) return reject("rule", `規則擋住了:${ruled}`);
    const held = this.#held(capabilities);
    if (held !== null) return reject("rule", `規則擋住了:${held}`);
    if (!this.#o.port.has(capability)) {
      return reject("denied", `\`${capability}\` 沒有啟用,調整過不了閘門`);
    }
    const args = route !== null ? route.args(steer, patched) : gameArgs(owner, steer, patched);
    this.#pending.set(steer.id, { owner, task: steer.task, patch: steer.patch });
    let answer: { outcome: SteerOutcome; detail: string } | null = null;
    try {
      const result = await this.#o.port.run({
        capability,
        args,
        principal,
        why: steer.why,
        turn: null,
        task: steer.id,
        signal: AbortSignal.timeout(Math.max(this.#o.timeoutMs, 1)),
        primary: null,
      });
      answer = answerOf(result.data);
    } catch (error) {
      this.#pending.delete(steer.id);
      const code = failureCode(error);
      const detail = error instanceof StepError ? error.message : errorMessage(error);
      log.info({ steer: steer.id, task: steer.task, code, detail }, "steer refused");
      return reject(code === "denied" ? "denied" : "failed", detail);
    }
    // The executor answered at once (an in-process one), or the task ended while we asked.
    if (answer !== null) {
      this.#publishOutcome(steer.id, owner, steer.task, answer.outcome, answer.detail);
    }
    const final = this.#settled.get(steer.id);
    if (final === "too_late") {
      return {
        status: "too_late",
        steer: steer.id,
        task: steer.task,
        detail: answer?.detail || "任務已經結束了,來不及調整",
      };
    }
    if (final === "rejected") {
      return {
        status: "rejected",
        steer: steer.id,
        task: steer.task,
        reason: "failed",
        detail: answer?.detail || "執行器拒絕了這個調整",
      };
    }
    return {
      status: "accepted",
      steer: steer.id,
      task: steer.task,
      budget_s: budget,
      started_at: started,
    };
  }

  /**
   * Why the rules stop `task`, as it would be after the patch, under one of `capabilities`, or
   * `null`. Only an allow lets it through: a steer has no one to wait for.
   */
  async #ruled(
    capabilities: readonly string[],
    owner: string,
    task: SteerableTask,
    principal: Principal,
  ): Promise<string | null> {
    const directives = this.#o.services?.get(DirectivesKey);
    if (directives === undefined) return null;
    const game = owner.startsWith("game.") ? owner.slice("game.".length) : owner;
    for (const capability of capabilities) {
      try {
        const verdict = await directives.check({
          capability,
          args: { game, goal: task.goal, args: task.args },
          principal,
        });
        if (verdict.outcome !== "allow") return verdict.reason;
      } catch (error) {
        return `讀不到規則(${errorMessage(error)})`;
      }
    }
    return null;
  }

  /** Why a hold stops one of `capabilities` (the first), or `null`. */
  #held(capabilities: readonly string[]): string | null {
    const arbiter = this.#o.services?.get(ArbiterKey);
    for (const capability of capabilities) {
      let why: string | null = null;
      try {
        why = arbiter?.held?.(capability) ?? null;
      } catch (error) {
        // Fail closed: a rule that cannot be read is a rule that holds.
        return `讀不到規則(${errorMessage(error)})`;
      }
      if (why !== null) return why;
    }
    return null;
  }

  // ---- outcomes -----------------------------------------------------------------------------

  /** Records the outcome of `steer`; `false` when it already had one. */
  #settle(steer: string, outcome: SteerOutcome): boolean {
    this.#pending.delete(steer);
    if (this.#settled.has(steer)) return false;
    remember(this.#settled, steer, outcome);
    return true;
  }

  /** Publishes `steered` unless the steer already has its outcome. */
  #publishOutcome(
    steer: string,
    owner: string,
    task: TaskId,
    outcome: SteerOutcome,
    detail: string,
  ): void {
    if (!this.#settle(steer, outcome)) return;
    const event: Extract<TaskEvent, { type: "steered" }> = {
      type: "steered",
      task,
      steer,
      outcome,
      detail,
      at: toTimestamp(this.#o.now()),
    };
    this.#o.publish(customEvent(taskTopic(owner, "steered"), event as unknown as JsonValue));
    log.info({ steer, task, outcome, detail }, "steer ended");
  }

  /** The request as a `steer` line of the log: its id is the steer's, its cause the trigger's. */
  #logRequest(request: SteerRequest): void {
    const eventLog = this.#o.services?.get(EventLogKey);
    if (eventLog === undefined) return;
    const { steer, owner, principal } = request;
    try {
      eventLog.append({
        id: steer.id,
        kind: "steer",
        source: "activity",
        cause: steer.cause === "" ? null : steer.cause,
        context: principal.context,
        body: {
          phase: "request",
          owner,
          task: steer.task,
          patch: steer.patch,
          why: steer.why,
          by: principal.kind,
        } satisfies SteerRequestBody,
      });
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot log the steer");
    }
  }
}

/** Arguments of `game.act` that steer `steer.task` of the game of `owner` (`game.<id>`). */
function gameArgs(owner: string, steer: TaskSteer, task: SteerableTask): JsonObject {
  return {
    game: owner.slice("game.".length),
    call: { action: task.goal, args: task.args },
    steer: {
      id: steer.id,
      task: steer.task,
      patch: steer.patch,
      why: steer.why,
      cause: steer.cause,
    },
  };
}

/** The `{outcome, detail}` an in-process executor answered with, if its data is one. */
function answerOf(data: JsonValue): { outcome: SteerOutcome; detail: string } | null {
  if (!isJsonObject(data)) return null;
  const outcome = data.outcome;
  if (!isSteerOutcome(outcome)) return null;
  return { outcome, detail: typeof data.detail === "string" ? data.detail : "" };
}
