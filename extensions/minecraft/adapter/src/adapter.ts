// `GameAdapter` for Minecraft on top of the bridge client, and its task executor
// (docs/design/v2-architecture.md §3.8).
//
// Every goal the core starts is a task (`tasks`, a `TaskRunner`): it begins with the mod's
// requests (`act`) and ends with exactly one `done` / `failed` with a code. How it ends:
//
// - The mod reports task lifecycle (`hello_ack` `capabilities.tasks`, PROTOCOL.md §6.1): the
//   request carries the task id and the mod's `task_done` / `task_failed` for that id ends it.
//   Nothing is guessed from Baritone's path events.
// - An older mod: the adapter reads the job's own events (`craft_finished`, `baritone_idle`, a
//   `goto`'s `goal_reached` ...), knowing which kind of job it sent, as before.
//
// Instant goals (chat, look, select ...) are done once the mod accepted them. `obtain` is the one
// entry for getting an item; its strategies are the three old paths, kept as they were:
// `plan` (the planner + `ObtainRunner`, when it knows the item), `altoclef` (AltoClef's `get`,
// when installed) and `craft` (one craft of the item itself). `launch` ends when the game is
// connected (and the world loaded), `quit` when the mod accepted it.
//
// Tasks that use her body supersede each other (a new one ends the old with `superseded`);
// `chat` runs alongside. A cancelled or timed-out task stops the mod's work (`stop`).
//
// Steer (v3 §10.6): the executor can change the target of a running `obtain` plan (`item`,
// `count`) without losing what it already got. The step boundary is the adapter's, not the mod's:
// the mod only runs one job at a time (a Baritone job, one craft, one smelt) and reports when it
// ends; `ObtainRunner` is what chains the jobs, and it reads a queued change between two of them
// (obtain.ts). Every other goal is one mod job without a step boundary the adapter can see, so a
// steer of it is refused (cancel and start again).

import {
  type ActionResult,
  type GameAction,
  type GameAdapter,
  type GameEvent,
  type GameInfo,
  type GameObservation,
  type TaskContext,
  TaskFailure,
  type TaskFailureCode,
  type TaskResult,
  type TaskSpec,
} from "@miyoria/sdk";
import { ACTIONS, ActionError, HIDDEN_ACTIONS, describeAction, errorText, failureCode, toRequests } from "./actions.js";
import { BridgeError, type BridgeClient, type BridgeEvent } from "./bridge.js";
import { type EventOptions, mapEvent } from "./events.js";
import { GUIDE } from "./guide.js";
import { LaunchError, type Launcher } from "./launcher.js";
import { ObtainRunner, parsePlanPatch, type RunnerOptions, STEP_EVENTS, worldOf } from "./obtain.js";
import { PlanError, countOf, describeStep, itemName, knows, normalizeItem, plan } from "./planner.js";
import { type SteerRequest, SteerableTasks } from "./steer.js";
import { type Snapshot, compactState, summarize } from "./summary.js";

export const GAME_ID = "minecraft";

/** Most events buffered while nobody reads the stream (oldest dropped). */
const MAX_BUFFERED = 256;

export interface AdapterOptions extends EventOptions {
  allowCommands?: boolean;
  /** Starts / closes the game (`launch` / `quit`); without it both refuse. */
  launcher?: Launcher;
  /** Timeouts of `obtain` plans (tests shorten them). */
  runner?: RunnerOptions;
  /**
   * How long an `act` refused with `reflex_active` waits for the reflex to end when no task
   * bounds it (inside a task its budget does).
   */
  reflexWaitMs?: number;
  /** How often `launch` checks whether the world finished loading. */
  launchPollMs?: number;
}

/** Goals that are done once the mod accepted them. */
const INSTANT = new Set(["chat", "look", "attack", "use", "select", "respawn", "place", "stop"]);
/** Baritone goals that never end by themselves; at the end of their budget they are done. */
const OPEN_ENDED = new Set(["follow", "explore", "farm"]);
/** Goals that end with their own events. */
const JOBS = new Set(["goto", "mine", "follow", "explore", "farm", "build", "craft", "smelt", "get"]);
/** Strategies of `obtain`. */
export const OBTAIN_STRATEGIES = ["plan", "altoclef", "craft"] as const;
export type ObtainStrategy = (typeof OBTAIN_STRATEGIES)[number];

/** The mod's task failure code (PROTOCOL.md §6.1) → the contract's. */
export function modFailureCode(code: unknown): TaskFailureCode {
  switch (code) {
    case "superseded":
    case "cancelled":
    case "unreachable":
    case "not_found":
    case "died":
    case "precondition":
    case "timeout":
      return code;
    case "interrupted":
      return "busy";
    default:
      return "internal";
  }
}

/** Push queue exposed as an async iterable. */
class EventQueue implements AsyncIterable<GameEvent> {
  #items: GameEvent[] = [];
  #waiters: Array<(r: IteratorResult<GameEvent>) => void> = [];
  #ended = false;

  push(e: GameEvent): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: e, done: false });
      return;
    }
    this.#items.push(e);
    if (this.#items.length > MAX_BUFFERED) this.#items.shift();
  }

  end(): void {
    this.#ended = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<GameEvent> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

/** How a job ends: `undefined` = not yet (keep waiting), else the task's result or failure. */
type Ending = TaskResult | TaskFailure | undefined;

interface Watch {
  match(e: BridgeEvent): Ending;
  resolve(end: TaskResult | TaskFailure): void;
}

/** Waits for `ms` or until `signal` aborts (then rejects with its reason). */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const fail = (result: ActionResult): never => {
  throw new TaskFailure(result.code ?? "internal", result.message ?? "失敗");
};

export class MinecraftAdapter implements GameAdapter {
  readonly #bridge: BridgeClient;
  readonly #opts: AdapterOptions;
  readonly #queue = new EventQueue();
  /** The running `obtain` plan, and the task it runs for. */
  #runner: ObtainRunner | null = null;
  #planTask: string | null = null;
  /** Actions waiting for an interrupting reflex to end. */
  readonly #reflexWaiters = new Set<() => void>();
  /** Running jobs waiting for the event that ends them. */
  readonly #watches = new Set<Watch>();
  /** Wakes `launch` when the mod connects. */
  readonly #connectWaiters = new Set<() => void>();
  /** The task executor (the core's only way to drive the game). */
  readonly tasks: SteerableTasks;

  constructor(bridge: BridgeClient, opts: AdapterOptions = {}) {
    this.#bridge = bridge;
    this.#opts = opts;
    this.tasks = new SteerableTasks(
      {
        observe: (signal) => this.observe(signal),
        run: (spec, task) => this.#run(spec, task),
        resource: (spec) => (spec.goal === "chat" ? null : spec.goal === "launch" || spec.goal === "quit" ? "session" : "body"),
      },
      (steer) => this.#steer(steer),
    );
    bridge.onEvent((raw) => this.#onEvent(raw));
    bridge.onStatus((hello) => {
      this.#cancelPlan();
      if (hello) {
        opts.launcher?.connected();
        for (const wake of [...this.#connectWaiters]) wake();
        const caps = hello.capabilities ?? {};
        const tools = [caps.baritone ? "Baritone" : "", caps.altoclef ? "AltoClef" : ""].filter(Boolean).join("、");
        this.#queue.push({
          type: "connected",
          data: { ...hello, text: `連上 Minecraft ${hello.minecraft ?? ""}${tools ? `(${tools})` : ""}` },
        });
      } else {
        // Whatever ran is gone with the connection.
        this.#endWatches(new TaskFailure("disconnected", "跟 Minecraft 的連線斷了"));
        this.#queue.push({ type: "disconnected", data: { text: "跟 Minecraft 的連線斷了" }, important: true });
      }
    });
  }

  /** The mod reports task lifecycle itself (PROTOCOL.md §6.1). */
  get modTasks(): boolean {
    return this.#bridge.hello?.capabilities?.tasks === true;
  }

  #onEvent(raw: BridgeEvent): void {
    if (raw.name === "reflex_end") for (const wake of [...this.#reflexWaiters]) wake();
    const runner = this.#runner;
    if (runner) runner.feed(raw);
    for (const w of [...this.#watches]) {
      const end = w.match(raw);
      if (end !== undefined) w.resolve(end);
    }
    // A task's lifecycle and its steps are the executor's business, not commentary.
    if (raw.name.startsWith("task_") || STEP_EVENTS.has(raw.name)) return;
    this.#push(raw);
  }

  #push(raw: BridgeEvent): void {
    const e = mapEvent(raw, this.#opts);
    if (e) this.#queue.push(e);
  }

  describe(): GameInfo {
    return { id: GAME_ID, name: "Minecraft", actions: ACTIONS, guide: GUIDE };
  }

  /** `state.launch` while the game is not connected: whether `launch` can start it and how far it got. */
  #launchState(): Record<string, unknown> {
    const launcher = this.#opts.launcher;
    if (!launcher) return { available: false, problem: "沒有設定啟動器" };
    const problem = launcher.problem();
    const status = launcher.status();
    return {
      available: problem === null,
      ...(problem ? { problem } : {}),
      state: status.state,
      ...(status.state === "failed" ? { error: status.error } : {}),
      ...(status.state === "starting" ? { world: status.world, timeout_secs: launcher.timeoutMs / 1000 } : {}),
    };
  }

  async observe(_signal?: AbortSignal): Promise<GameObservation> {
    if (!this.#bridge.ready) {
      const launch = this.#launchState();
      const starting = launch.state === "starting" ? "遊戲正在用 Prism 開,等模組連上。" : "";
      return { summary: `${errorText("not_connected", "")}。${starting}`, state: { connected: false, launch } };
    }
    try {
      const snapshot = (await this.#bridge.request("observe")) as Snapshot;
      const caps = this.#bridge.hello?.capabilities;
      const state = compactState(snapshot);
      if (caps) state.capabilities = { baritone: !!caps.baritone, altoclef: !!caps.altoclef };
      let summary = summarize(snapshot);
      const runner = this.#runner;
      if (runner) {
        const p = runner.status();
        state.plan = p;
        state.busy = true;
        summary += `\n正在取得 ${itemName(p.target)}${p.count > 1 ? `×${p.count}` : ""}(第 ${p.step}/${p.total} 步${p.doing ? `:${p.doing}` : ""})`;
      }
      return { summary, state };
    } catch (error) {
      if (error instanceof BridgeError) {
        const inGame = error.code !== "not_in_game";
        return {
          summary: `${errorText(error.code, error.message)}。`,
          state: { connected: error.code !== "not_connected", in_game: inGame ? undefined : false },
        };
      }
      throw error;
    }
  }

  /**
   * Sends one action's requests and answers with the mod's acknowledgement (the start of a
   * task; its end is the executor's business). `task`: the id the mod should report under.
   * `launch` / `quit` work here too; `obtain` only runs as a task.
   */
  async act(action: GameAction, signal?: AbortSignal, task?: string): Promise<ActionResult> {
    switch (action.name) {
      case "launch":
        return this.#launch();
      case "quit":
        return this.#quit();
      case "obtain":
        return { ok: false, code: "invalid", message: "obtain 是一個任務(由執行器開始)" };
    }
    // Anything but talking replaces a running plan (she chose to do something else).
    if (action.name !== "chat") this.#cancelPlan();
    let requests: ReturnType<typeof toRequests>;
    try {
      requests = toRequests(action, {
        allowCommands: this.#opts.allowCommands,
        inventory: action.name === "mine" ? await this.#inventory() : undefined,
      });
    } catch (error) {
      if (error instanceof ActionError) return { ok: false, code: "invalid", message: error.message };
      throw error;
    }
    const caps = this.#bridge.hello?.capabilities;
    if (caps && requests.some((r) => r.type === "baritone") && caps.baritone === false) {
      return { ok: false, code: "precondition", message: errorText("baritone_unavailable", "") };
    }
    if (caps && requests.some((r) => r.type === "altoclef") && caps.altoclef === false) {
      return { ok: false, code: "precondition", message: errorText("altoclef_unavailable", "") };
    }
    const results: unknown[] = [];
    try {
      for (const r of requests) {
        // The work request carries the task id (an older mod ignores it).
        const tagged = task !== undefined && JOB_REQUESTS.has(r.type) ? { ...r.params, task } : r.params;
        results.push(await this.#request(r.type, tagged, signal));
      }
    } catch (error) {
      if (error instanceof BridgeError) {
        return { ok: false, code: failureCode(error.code), message: errorText(error.code, error.message) };
      }
      throw error;
    }
    return { ok: true, message: describeAction(action), data: results.length === 1 ? results[0] : results };
  }

  /**
   * A request; refused with `reflex_active` it waits for the reflex to end (bounded by `signal`,
   * else `reflexWaitMs`), then tries once more.
   */
  async #request(type: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      return await this.#bridge.request(type, params);
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "reflex_active") throw error;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", wake);
          this.#reflexWaiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, signal ? 2 ** 31 - 1 : (this.#opts.reflexWaitMs ?? 10_000));
        signal?.addEventListener("abort", wake, { once: true });
        this.#reflexWaiters.add(wake);
      });
      if (signal?.aborted) throw signal.reason;
      return this.#bridge.request(type, params);
    }
  }

  // ---- the executor ----------------------------------------------------------------------

  async #run(spec: TaskSpec, task: TaskContext): Promise<TaskResult> {
    const goal = spec.goal;
    const known = ACTIONS.some((a) => a.name === goal) || HIDDEN_ACTIONS.some((a) => a.name === goal);
    if (!known) throw new TaskFailure("invalid", `沒有「${goal}」這個動作`);
    switch (goal) {
      case "launch":
        return this.#runLaunch(task);
      case "quit": {
        const result = await this.#quit();
        return result.ok ? { detail: result.message ?? "" } : fail(result);
      }
      case "obtain":
        return this.#runObtain(spec, task, strategyOf(spec.args.strategy));
      case "get":
        return this.#runObtain(spec, task, "altoclef");
    }
    if (INSTANT.has(goal)) {
      const result = await this.act({ name: goal, args: spec.args }, task.signal, spec.id);
      return result.ok ? { detail: result.message ?? "", data: result.data ?? null } : fail(result);
    }
    if (!JOBS.has(goal)) throw new TaskFailure("invalid", `沒有「${goal}」這個動作`);
    return this.#runJob({ name: goal, args: spec.args }, spec, task);
  }

  /** A job that ends with its own events: start it, then wait for its end (or its budget). */
  async #runJob(action: GameAction, spec: TaskSpec, task: TaskContext): Promise<TaskResult> {
    let later: (end: TaskResult | TaskFailure) => void = () => {};
    const ended = this.#watch(
      jobEnd(action.name, spec.id, this.modTasks, () => this.#altoClefDone(), (end) => later(end)),
      task,
    );
    later = ended.finish;
    this.#stopOnAbort(task);
    const result = await this.act(action, task.signal, spec.id);
    if (!result.ok) {
      ended.cancel();
      fail(result);
    }
    if (OPEN_ENDED.has(action.name)) {
      // Following / exploring / farming go on until stopped: the budget is how long, not a limit.
      const left = Math.max(task.remainingMs() - 500, 0);
      const timer = setTimeout(() => ended.finish({ detail: `${describeAction(action)},做了 ${Math.round(left / 1000)} 秒` }), left);
      try {
        return await ended.done;
      } finally {
        clearTimeout(timer);
        if (!task.signal.aborted) void this.#bridge.request("stop").catch(() => undefined);
      }
    }
    return ended.done;
  }

  /** Registers a watch ended by `match` (or by the task's abort). */
  #watch(match: (e: BridgeEvent) => Ending, task: TaskContext) {
    let finish!: (end: TaskResult | TaskFailure) => void;
    const done = new Promise<TaskResult>((resolve, reject) => {
      const w: Watch = {
        match,
        resolve: (end) => {
          this.#watches.delete(w);
          task.signal.removeEventListener("abort", onAbort);
          if (end instanceof TaskFailure) reject(end);
          else resolve(end);
        },
      };
      const onAbort = () => w.resolve(task.signal.reason instanceof TaskFailure ? task.signal.reason : new TaskFailure("cancelled", "cancelled"));
      task.signal.addEventListener("abort", onAbort, { once: true });
      this.#watches.add(w);
      finish = w.resolve;
    });
    done.catch(() => undefined);
    return { done, finish, cancel: () => finish(new TaskFailure("cancelled", "not started")) };
  }

  #endWatches(failure: TaskFailure): void {
    for (const w of [...this.#watches]) w.resolve(failure);
  }

  /** A cancelled or timed-out body task stops the mod's work (a superseding one replaces it). */
  #stopOnAbort(task: TaskContext): void {
    task.signal.addEventListener(
      "abort",
      () => {
        const code = task.signal.reason instanceof TaskFailure ? task.signal.reason.code : "cancelled";
        if (code !== "superseded" && code !== "disconnected" && this.#bridge.ready) {
          void this.#bridge.request("stop").catch(() => undefined);
        }
      },
      { once: true },
    );
  }

  /** During an AltoClef `get` on an older mod: whether AltoClef itself is idle now. */
  async #altoClefDone(): Promise<boolean | null> {
    try {
      const busy = ((await this.#bridge.request("observe")) as Snapshot).altoclef?.busy;
      return busy === undefined || busy === null ? null : !busy;
    } catch {
      return null;
    }
  }

  async #runLaunch(task: TaskContext): Promise<TaskResult> {
    /** The world the launch joins (its load is waited for), if any. */
    let world: string | null = null;
    if (!this.#bridge.ready) {
      const started = await this.#launch();
      if (!started.ok) fail(started);
      const status = this.#opts.launcher?.status();
      world = status?.state === "starting" ? status.world : null;
      // Connected, or the launcher gave up.
      while (!this.#bridge.ready) {
        const status = this.#opts.launcher?.status();
        if (status?.state === "failed") throw new TaskFailure("crashed", status.error);
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            clearTimeout(timer);
            this.#connectWaiters.delete(wake);
            task.signal.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            wake();
            reject(task.signal.reason);
          };
          const timer = setTimeout(wake, this.#opts.launchPollMs ?? 1000);
          this.#connectWaiters.add(wake);
          task.signal.addEventListener("abort", abort, { once: true });
        });
      }
    }
    // Joining a world: wait for it to load. In the main menu otherwise (or when the budget is
    // nearly used up): that is fine too, the game is up.
    const pollMs = this.#opts.launchPollMs ?? 2000;
    for (;;) {
      const obs = await this.observe(task.signal);
      if (obs.state.connected === false) throw new TaskFailure("disconnected", "連上又斷了");
      const menu = obs.state.in_game === false;
      if (!menu || world === null || task.remainingMs() < pollMs + 1000) {
        return { detail: menu ? "連上 Minecraft 了(在主選單)" : "連上 Minecraft 了", data: { in_game: !menu } };
      }
      await pause(pollMs, task.signal);
    }
  }

  async #launch(): Promise<ActionResult> {
    if (this.#bridge.ready) return { ok: true, message: "Minecraft 已經開著了", data: { state: "running" } };
    const launcher = this.#opts.launcher;
    if (!launcher) return { ok: false, code: "precondition", message: "沒有設定啟動器,沒辦法自己開遊戲" };
    try {
      const status = launcher.launch();
      const world = status.state === "starting" && status.world ? `,直接進入世界「${status.world}」` : "";
      const secs = Math.round(launcher.timeoutMs / 1000);
      return {
        ok: true,
        message: `正在用 Prism Launcher 開 ${launcher.instance()}${world};等模組連上(最多 ${secs} 秒)`,
        data: this.#launchState(),
      };
    } catch (error) {
      if (error instanceof LaunchError) return { ok: false, code: "precondition", message: `沒辦法開遊戲:${error.message}` };
      throw error;
    }
  }

  async #quit(): Promise<ActionResult> {
    if (!this.#bridge.ready) return { ok: true, message: "遊戲本來就沒開" };
    const launcher = this.#opts.launcher;
    if (!launcher?.shouldQuit()) return { ok: true, message: "遊戲留著沒關(不是她開的,或設定不關)" };
    this.#cancelPlan();
    try {
      await this.#bridge.request("quit");
    } catch (error) {
      if (error instanceof BridgeError) {
        return { ok: false, code: failureCode(error.code), message: `關不掉遊戲:${errorText(error.code, error.message)}` };
      }
      throw error;
    }
    launcher.quitting();
    return { ok: true, message: "關掉 Minecraft 了" };
  }

  /**
   * `obtain`: one entry, three strategies (the old paths): `plan` when the planner knows the item,
   * else `altoclef` when it is installed, else `craft` (one craft of the item). `strategy`
   * forces one.
   */
  async #runObtain(spec: TaskSpec, task: TaskContext, forced: ObtainStrategy | null): Promise<TaskResult> {
    const args = spec.args;
    const item = normalizeItem(typeof args.item === "string" ? args.item : "");
    if (!/^#?[a-z0-9_]+$/.test(item)) throw new TaskFailure("invalid", "obtain 要給 item(物品 id)");
    const n = Number(args.count ?? 1);
    const count = Math.min(64, Math.max(1, Math.round(Number.isFinite(n) ? n : 1)));
    if (!this.#bridge.ready) throw new TaskFailure("disconnected", errorText("not_connected", ""));
    const altoclef = this.#bridge.hello?.capabilities?.altoclef === true;
    const strategy: ObtainStrategy = forced ?? (knows(item) ? "plan" : altoclef ? "altoclef" : "craft");
    switch (strategy) {
      case "plan":
        return this.#runPlan(item, count, task);
      case "altoclef":
        return this.#runJob({ name: "get", args: { item, count } }, spec, task);
      case "craft":
        return this.#runJob({ name: "craft", args: { item, count } }, spec, task);
    }
  }

  /**
   * A steer of running task `steer.task`. Only an `obtain` plan has a step boundary here: the
   * change is queued in its runner, which reads it between two steps and reports `applied` (or
   * `too_late` if the plan ends first). Returns the outcome to report now, or `null` (queued).
   */
  #steer(steer: SteerRequest): { outcome: "rejected" | "too_late"; detail: string } | null {
    const runner = this.#runner;
    if (runner === null || this.#planTask !== steer.task) {
      return {
        outcome: "rejected",
        detail: "這個任務是一個 mod 工作(走路、挖礦、合成或熔爐),中間沒有可以安全切換的步驟;要改就取消再重開",
      };
    }
    const patch = parsePlanPatch(steer.patch);
    if (typeof patch === "string") return { outcome: "rejected", detail: patch };
    return runner.steer(steer.id, patch) === "too_late"
      ? { outcome: "too_late", detail: "取得已經結束了,來不及調整" }
      : null;
  }

  async #runPlan(item: string, count: number, task: TaskContext): Promise<TaskResult> {
    if (!knows(item)) {
      throw new TaskFailure(
        "invalid",
        `不知道怎麼取得${itemName(item)}(只會砍樹、挖礦、合成和用熔爐燒的東西)`,
      );
    }
    let snapshot: Snapshot;
    try {
      snapshot = (await this.#bridge.request("observe")) as Snapshot;
    } catch (error) {
      if (error instanceof BridgeError) throw new TaskFailure(failureCode(error.code), errorText(error.code, error.message));
      throw error;
    }
    const inv = snapshot.inventory ?? {};
    const want = `${itemName(item)}${count > 1 ? `×${count}` : ""}`;
    if (countOf(inv, item) >= count) return { detail: `背包裡已經有${want}了` };
    let steps: ReturnType<typeof plan>;
    try {
      steps = plan(item, count, inv, worldOf(snapshot));
    } catch (error) {
      if (error instanceof PlanError) throw new TaskFailure("precondition", error.message);
      throw error;
    }
    this.#cancelPlan();
    const runner = new ObtainRunner(
      {
        request: (type, params) => this.#bridge.request(type, params),
        observe: async () => (await this.#bridge.request("observe")) as Snapshot,
        // Its steps are the task's progress.
        emit: (e) => task.progress(String((e.data as { text?: unknown } | undefined)?.text ?? e.type)),
        steered: (id, outcome, detail) => this.tasks.reportSteer(task.spec.id, id, outcome, detail),
      },
      item,
      count,
      this.#opts.runner,
    );
    this.#runner = runner;
    this.#planTask = task.spec.id;
    const onAbort = () => this.#cancelPlan();
    task.signal.addEventListener("abort", onAbort, { once: true });
    this.#stopOnAbort(task);
    task.progress(`開始取得${want}:${steps.map(describeStep).join(" → ")}(共 ${steps.length} 步)`, 0);
    try {
      const result = await runner.run();
      if (result.cancelled) throw task.signal.reason ?? new TaskFailure("cancelled", result.message);
      if (!result.ok) throw new TaskFailure(result.code ?? "internal", result.message);
      // A steer may have changed what she was getting.
      return { detail: result.message, data: { target: runner.item, count: runner.count } };
    } finally {
      task.signal.removeEventListener("abort", onAbort);
      if (this.#runner === runner) {
        this.#runner = null;
        this.#planTask = null;
      }
    }
  }

  #cancelPlan(): void {
    const runner = this.#runner;
    if (!runner) return;
    this.#runner = null;
    runner.cancel();
  }

  /** The running plan (tests). */
  get plan(): ObtainRunner | null {
    return this.#runner;
  }

  /** Her inventory right now, for the `mine` tool check; `undefined` when it cannot be read. */
  async #inventory(): Promise<Record<string, number> | undefined> {
    if (!this.#bridge.ready) return undefined;
    try {
      return ((await this.#bridge.request("observe")) as Snapshot).inventory;
    } catch {
      return undefined; // the mine request itself will report what is wrong
    }
  }

  events(): AsyncIterable<GameEvent> {
    return this.#queue;
  }

  /** Ends the event stream and every task. */
  close(): void {
    this.#cancelPlan();
    this.tasks.close("disconnected", "the adapter stopped");
    this.#queue.end();
  }
}

/** Request types that start work the mod can report a task for. */
const JOB_REQUESTS = new Set(["baritone", "altoclef", "craft", "smelt"]);

function strategyOf(value: unknown): ObtainStrategy | null {
  return typeof value === "string" && (OBTAIN_STRATEGIES as readonly string[]).includes(value) ? (value as ObtainStrategy) : null;
}

/** The mod's text of a failed craft / smelt job (`error`), or a fallback. */
function jobError(e: BridgeEvent, fallback: string): string {
  return typeof e.data.error === "string" && e.data.error !== "" ? e.data.error : fallback;
}

/**
 * How the job `goal` (task `id`) ends. With `modTasks` the mod says so (`task_done` /
 * `task_failed` for `id`); otherwise the job's own events are read, knowing what was sent:
 * a `goto` ends on `goal_reached` (other jobs see one per path segment), mining and the other
 * Baritone processes on `baritone_idle`, AltoClef's `get` when AltoClef itself is idle.
 */
export function jobEnd(
  goal: string,
  id: string,
  modTasks: boolean,
  altoClefDone: () => Promise<boolean | null> = async () => null,
  /** Ends the job later (after an asynchronous check). */
  later: (end: TaskResult | TaskFailure) => void = () => {},
): (e: BridgeEvent) => Ending {
  if (modTasks) {
    return (e) => {
      if (e.data.task !== id) return undefined;
      if (e.name === "task_done") return { detail: typeof e.data.detail === "string" ? e.data.detail : "做完了", data: e.data };
      if (e.name === "task_failed") {
        return new TaskFailure(modFailureCode(e.data.code), typeof e.data.message === "string" ? e.data.message : String(e.data.code ?? "failed"));
      }
      return undefined;
    };
  }
  const interrupted = (e: BridgeEvent): Ending =>
    e.name === "reflex" && typeof e.data.interrupted === "string"
      ? new TaskFailure("busy", "被身體的本能反應打斷")
      : e.name === "death"
        ? new TaskFailure("died", "死掉了")
        : undefined;
  const idle = (e: BridgeEvent, done: string): Ending => {
    if (e.data.cancelled === true) {
      return e.data.reason === "reflex" ? new TaskFailure("busy", "被身體的本能反應打斷") : new TaskFailure("cancelled", "被叫停了");
    }
    if (e.data.reason === "nothing_visible") return { detail: "看得到的都挖完了", data: e.data };
    return { detail: done, data: e.data };
  };
  switch (goal) {
    case "goto":
      return (e) =>
        e.name === "goal_reached"
          ? { detail: "抵達目標了", data: e.data }
          : e.name === "goal_failed"
            ? new TaskFailure("unreachable", "找不到路")
            : e.name === "baritone_idle"
              ? idle(e, "停下來了")
              : interrupted(e);
    case "craft":
    case "smelt":
      return (e) => {
        if (e.name === `${goal}_finished`) {
          const crafted = typeof e.data.crafted === "number" ? `×${e.data.crafted}` : "";
          return { detail: goal === "craft" ? `做好了${crafted}` : "熔爐弄好了", data: e.data };
        }
        if (e.name === `${goal}_failed`) {
          if (e.data.cancelled === true) return new TaskFailure("cancelled", "被叫停了");
          return new TaskFailure("precondition", jobError(e, `${goal} 失敗`));
        }
        return e.name === "death" ? new TaskFailure("died", "死掉了") : undefined;
      };
    case "get":
      return (e) => {
        if (e.name !== "baritone_idle") return interrupted(e);
        if (e.data.cancelled === true) return idle(e, "");
        // Baritone goes idle between AltoClef's sub-tasks: ask AltoClef itself (unknown: done).
        void altoClefDone().then((done) => {
          if (done !== false) later({ detail: "AltoClef 任務做完了", data: { ...e.data, altoclef_done: true } });
        });
        return undefined;
      };
    default:
      return (e) => (e.name === "baritone_idle" ? idle(e, "做完了") : interrupted(e));
  }
}
