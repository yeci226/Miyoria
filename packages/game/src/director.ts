// The director: one game session at a time, a decision every `decide_secs` (sooner on important
// events), goal tracking, queue goals, commentary and mood nudges.
//
// The director (and its model) only chooses goals and commentary. Every goal is a task on the
// game's executor (v2 §3.8): the director picks the task id and budget, starts it through the
// gate (`game.act`, principal `director`) and learns how it ended from the executor's
// `game.<id>.task.done|failed` events, each failure with a code. Nothing is guessed from event
// names, settle times or "失敗" prefixes; stale tasks (replaced, cancelled) are ignored by id.

import { type ActuatorRegistry, deniedText } from "@miyoria/actions";
import { errorMessage, getLogger, type ModuleContext, withTimeout } from "@miyoria/kernel";
import { type ChatRequest, type LlmRouter, LlmRouterKey, sessionId } from "@miyoria/llm";
import { RequestQueueKey } from "@miyoria/queue";
import {
  type AccountRef,
  ActivityManagerKey,
  ARBITER_IMPULSE_TOPIC,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  customEvent,
  type DirectorThoughtBody,
  type Envelope,
  gameTaskOwner,
  type JsonObject,
  type JsonValue,
  newId,
  newImpulse,
  Principals,
  ProposalBoardKey,
  parseTaskEvent,
  parseTaskTopic,
  type RegisteredTaskExecutor,
  type RestoredGame,
  type StructuredState,
  serviceKey,
  type TaskEvent,
  TaskExecutorsKey,
  type TaskFailureCode,
  type TaskId,
  type Timestamp,
  toTimestamp,
  v2Event,
} from "@miyoria/types";
import { GAME_ACT } from "./actions.js";
import type { GameConfig } from "./config.js";
import {
  ActionCall,
  type Decision,
  type GoalFacts,
  type GoalSource,
  goalLocked,
  goalNote,
  goalRequested,
  judge,
  type MoodNudge,
  type PromptParts,
  parseDecision,
  prompts,
  type Verdict,
  verdictDebug,
} from "./decision.js";
import {
  activeGuard,
  afterSuccess,
  type FailureGuard,
  guardAfter,
  guardNote,
  withheld,
} from "./guard.js";
import { type About, eventKey, goalKey, isNoted, matchesEvent, Narration } from "./narration.js";
import {
  budgetFor,
  codeOf,
  GameTaskError,
  gameExecutor,
  goalCatalog,
  observationText,
  observeWithin,
  offersGoal,
  stateObject,
  type TaskEnd,
} from "./tasks.js";

const log = getLogger("game");

/** Who started a session picked up after a restart (nobody asked in this run). */
const RESUMED_BY: AccountRef = { platform: "core", id: "resume" };

/** Topic of the director's decision traces (for the panel / overlay). */
export const DECISION_TOPIC = "game.director.decision";
/** Initiative reason of commentary requests. */
export const INITIATIVE_REASON = "game";
/**
 * Topic of session changes, `{state: "started" | "stopped", game, game_name, context}` (the
 * stage's scene director switches to the game scene and back on it). A session that ended by
 * itself also carries `code` (`disconnected`, `crashed`) and `reason`; the ActivityManager turns
 * that into `failed(code)`.
 */
export const SESSION_TOPIC = "game.director.session";
/**
 * Topic of a goal that ended, `GoalEnd`: every goal completion and failure carries a code
 * (`done` / `reported` when reached, a `TaskFailureCode` or `gave_up` when not).
 */
export const GOAL_TOPIC = "game.director.goal";

/** Why a goal ended. */
export type GoalEndCode =
  /** Its task reported `done`. */
  | "done"
  /** The model said it is done (`goal_status: "done"`). */
  | "reported"
  /** The model gave up on it (`goal_status: "failed"`). */
  | "gave_up"
  /** Its task failed with this code (`timeout` also: the goal ran past `max_goal_secs`). */
  | TaskFailureCode;

/** Payload of `GOAL_TOPIC`. */
export interface GoalEnd {
  game: string;
  goal: string;
  source: GoalSource["type"];
  status: "done" | "failed";
  code: GoalEndCode;
  /** The goal's last task, if it had one. */
  task: TaskId | null;
  detail: string;
  at: Timestamp;
  /** What it was about (`goalKey`). */
  attention_key: string;
}

/** Whether in-game chat of a game is its own conversation (then the director only notes it). */
export interface ChatHandled {
  handles(game: string): boolean;
}

/** Provided by module `game.chat`. */
export const GameChatKey = serviceKey<ChatHandled>("GameChat");

/** What `Director.preflight` found out about the game before a session starts. */
export interface Preflight {
  /** The adapter reaches the game but she is not in a world yet (main menu, loading). */
  inMenu: boolean;
}

/** Persona bits used in the decision prompt. */
export interface Persona {
  /** Profile id (for the LLM session id). */
  profile: string;
  name: string;
  text: string;
}

/** Where `game start` sends commentary. */
export type Placement =
  /** Her voice channel, else the stream context, else where the command ran. */
  "auto" | "voice" | "here" | "stream";

/** Current goal as shown by `game status` and the prompt section. */
export interface GoalView {
  text: string;
  /** `(觀眾 Owen 的請求)`, empty for her own goals. */
  note: string;
  age_secs: number;
  action: string | null;
  /** Request queue item id for viewer goals. */
  queue_item: number | null;
}

/** Snapshot of the running session (serialized like the Rust struct). */
export interface GameStatus {
  game: string;
  game_name: string;
  context: ContextKey;
  started_at: Timestamp;
  goal: GoalView | null;
  backlog: string[];
  summary: string;
  busy: boolean | null;
  last_action: string | null;
  recent: string[];
}

/** Shared slot the director writes its status to (read by commands and the prompt section). */
export class View {
  current: GameStatus | null = null;
}

/** A refused control request; the message is user-facing (zh-TW), `code` says why. */
export class GameError extends Error {
  override readonly name = "GameError";

  constructor(
    message: string,
    readonly code: TaskFailureCode = "precondition",
  ) {
    super(message);
  }
}

interface Goal {
  text: string;
  source: GoalSource;
  setAt: number;
  action: ActionCall | null;
  /** The task of its current action (`null`: none started yet, or it ended). */
  task: TaskId | null;
  /** That task has not ended yet. */
  running: boolean;
  attempts: number;
}

function newGoal(text: string, source: GoalSource, now: number): Goal {
  return { text, source, setAt: now, action: null, task: null, running: false, attempts: 0 };
}

function goalLabel(goal: Goal): string {
  return `${goal.text}${goalNote(goal.source)}`;
}

interface QueuedGoal {
  item: number;
  text: string;
  requester: string;
}

interface Trigger {
  text: string[];
  important: boolean;
}

type Outcome =
  | { type: "reached"; code: "done" | "reported"; detail: string }
  | { type: "failed"; code: Exclude<GoalEndCode, "done" | "reported">; why: string };

/** A task the director started in this session, until it ended. */
interface Track {
  action: ActionCall;
  verdict: Verdict;
  goalText: string | null;
  /** `starting`: the start is in flight; an end that arrives meanwhile waits in `early`. */
  phase: "starting" | "running";
  early: TaskEnd | null;
}

/** Tasks tracked at once (old ones are forgotten; their events are then ignored). */
const MAX_TRACKED = 32;
/**
 * How long a line that must be said waits for a free moment. Longer than the Arbiter's retry, or
 * it would expire the moment she is talking; a result someone waits for outlasts a song.
 */
const URGENT_TTL_MS = 30_000;
const REQUESTED_TTL_MS = 5 * 60_000;

interface Session {
  generation: number;
  game: string;
  gameName: string;
  context: ContextKey;
  /** How `context` was chosen; `auto` follows her into a voice channel she joins later. */
  placement: Placement;
  /** Where the session was started from. */
  here: ContextKey;
  starter: AccountRef;
  startedAt: number;
  goal: Goal | null;
  backlog: QueuedGoal[];
  recent: string[];
  summary: string;
  busy: boolean | null;
  lastAction: string | null;
  nextDecide: number;
  decideStarted: number | null;
  trigger: Trigger | null;
  lastComment: number | null;
  /** Low-level actions withheld after a failure (see guard.ts). */
  guard: FailureGuard | null;
  tasks: Map<TaskId, Track>;
}

/**
 * Runs an adapter goal through the gate (`game.act`, principal `director`); a refusal or
 * failure throws (with the task failure code as `code` when there is one).
 */
async function actThroughGate(
  actuators: ActuatorRegistry,
  s: { game: string; context: ContextKey },
  args: JsonObject,
  signal: AbortSignal,
): Promise<string> {
  const outcome = await actuators.invoke(
    {
      principal: Principals.director(s.context),
      capability: GAME_ACT,
      args: { game: s.game, ...args },
      why: null,
      turn: null,
    },
    { signal },
  );
  switch (outcome.status) {
    case "done":
      return outcome.result.text;
    case "denied":
      throw new GameTaskError("denied", `the gate refused: ${outcome.decision.reason}`);
    case "failed":
      throw new GameTaskError(codeOf(outcome.cause), outcome.error, { cause: outcome.cause });
  }
}

/** `anyhow::Result<T>` stand-in for background steps. */
type Res<T> = { ok: true; value: T } | { ok: false; error: string; code: TaskFailureCode };

async function attempt<T>(fn: () => Promise<T>): Promise<Res<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: errorMessage(error), code: codeOf(error) };
  }
}

/** Result of a background step. */
type Done =
  | {
      type: "decided";
      generation: number;
      trigger: Trigger;
      observation: Res<StructuredState>;
      decision: Res<Decision> | null;
    }
  | {
      type: "acted";
      generation: number;
      task: TaskId;
      result: Res<string>;
    };

type Work = (signal: AbortSignal) => Promise<Done>;

function firstLine(s: string, max: number): string {
  const line = s.split("\n")[0]?.replace(/\r$/, "") ?? "";
  const chars = [...line];
  const out = chars.slice(0, max).join("");
  return chars.length > max ? `${out}…` : out;
}

/** Everything a decision needs, owned so it can run in the background. */
interface DecideInput {
  generation: number;
  trigger: Trigger;
  cfg: GameConfig;
  executor: RegisteredTaskExecutor;
  router: LlmRouter | undefined;
  persona: Persona;
  /** Game adapter id. */
  game: string;
  gameName: string;
  goal: string | null;
  lastAction: string | null;
  backlog: string[];
  recent: string[];
  /** The failure guard's prompt line, if it is on. */
  withheld: string | null;
  /** Her recent commentary. */
  said: string[];
}

async function decide(input: DecideInput, signal: AbortSignal): Promise<Done> {
  const observation = await attempt(() =>
    observeWithin(input.executor, input.cfg.tool_timeout_secs * 1000, signal),
  );
  const decision = observation.ok ? await decideFrom(input, observation.value, signal) : null;
  return {
    type: "decided",
    generation: input.generation,
    trigger: input.trigger,
    observation,
    decision,
  };
}

/** Asks the model, unless the game is not playable right now. */
async function decideFrom(
  input: DecideInput,
  obs: StructuredState,
  signal: AbortSignal,
): Promise<Res<Decision> | null> {
  if (obs.state.connected === false || obs.state.in_game === false) return null;
  return attempt(() => ask(input, observationText(obs), signal));
}

async function ask(
  input: DecideInput,
  observation: string,
  signal: AbortSignal,
): Promise<Decision> {
  const cfg = input.cfg;
  if (!input.router) throw new Error("no LLM router");
  const catalog = goalCatalog(input.executor.info);
  const trigger = input.trigger.text.length === 0 ? "定時檢查" : input.trigger.text.join(";");
  const parts: PromptParts = {
    name: input.persona.name,
    persona: input.persona.text,
    game: input.gameName,
    actDescription: catalog.description,
    actParameters: catalog.parameters,
    trigger,
    goal: input.goal,
    lastAction: input.lastAction,
    backlog: input.backlog,
    recent: input.recent,
    observation,
    withheld: input.withheld,
    said: input.said,
  };
  const { system, user } = prompts(parts);
  const request: ChatRequest = {
    messages: [
      { role: "system", content: system, name: null, tool_calls: [], tool_call_id: null },
      { role: "user", content: user, name: null, tool_calls: [], tool_call_id: null },
    ],
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
    json_mode: true,
    session: sessionId(input.persona.profile, `game-${input.game}`),
  };
  const response = await withTimeout(
    input.router.complete(cfg.purpose, request, signal),
    cfg.llm_timeout_secs * 1000,
  );
  if (response === undefined) throw new Error("the decision timed out");
  return parseDecision(response.text);
}

/**
 * Drives one game session at a time. All methods run to completion without awaiting, so they
 * never interleave; background steps (observe / ask / start) report back through `#onDone`, and
 * task events arrive through `onEvent`.
 */
export class Director {
  readonly #cfg: GameConfig;
  readonly #ctx: ModuleContext;
  readonly #persona: Persona;
  readonly #view: View;
  readonly #actuators: ActuatorRegistry;
  readonly #narration = new Narration();
  #voices: ContextKey[] = [];
  #session: Session | null = null;
  #generation = 0;
  /** The running background step, if any (aborted when a session starts or stops). */
  #work: AbortController | null = null;
  /** A goal set while the game was still starting (applied when the session starts). */
  #pendingGoal: { text: string; by: string } | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(
    cfg: GameConfig,
    ctx: ModuleContext,
    persona: Persona,
    view: View,
    /** Where its adapter goals go (`game.act`, through the gate). */
    actuators: ActuatorRegistry,
  ) {
    this.#cfg = cfg;
    this.#ctx = ctx;
    this.#persona = persona;
    this.#view = view;
    this.#actuators = actuators;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Stops all background activity (module stop). */
  close(): void {
    if (!this.#closed && this.#session) {
      this.#cancelGoalTask(this.#session);
      try {
        this.#publishSession("stopped", this.#session);
      } catch (error) {
        log.debug({ err: errorMessage(error) }, "cannot publish the session end");
      }
    }
    this.#closed = true;
    this.#work?.abort();
    this.#work = null;
    this.#disarm();
  }

  #now(): number {
    return this.#ctx.clock.now();
  }

  #secs(s: number): number {
    return s * 1000;
  }

  #disarm(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** (Re)arms the decision timer: only while a session runs and no step is in flight. */
  #arm(): void {
    this.#disarm();
    const s = this.#session;
    if (this.#closed || !s || this.#work) return;
    const delay = Math.max(s.nextDecide - this.#now(), 0);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const work = this.#startDecide();
      if (work) this.#run(work);
      this.#refreshView();
      this.#arm();
    }, delay);
  }

  #run(work: Work): void {
    const controller = new AbortController();
    this.#work = controller;
    void work(controller.signal).then(
      (done) => {
        if (this.#work !== controller) return;
        this.#work = null;
        try {
          const next = this.#onDone(done);
          if (next) this.#run(next);
        } catch (error) {
          log.error({ err: error }, "game director step failed");
        }
        this.#arm();
      },
      (error: unknown) => {
        if (this.#work !== controller) return;
        this.#work = null;
        log.error({ err: error }, "game director step failed");
        this.#arm();
      },
    );
  }

  #cancelWork(): void {
    this.#work?.abort();
    this.#work = null;
  }

  #executor(game: string): RegisteredTaskExecutor | null {
    return gameExecutor(this.#ctx.services, game);
  }

  #refreshView(): void {
    const s = this.#session;
    if (!s) {
      this.#view.current = null;
      return;
    }
    const now = this.#now();
    this.#view.current = {
      game: s.game,
      game_name: s.gameName,
      context: s.context,
      started_at: toTimestamp(s.startedAt),
      goal: s.goal
        ? {
            text: s.goal.text,
            note: goalNote(s.goal.source),
            age_secs: Math.floor(Math.max(now - s.goal.setAt, 0) / 1000),
            action: s.goal.action ? s.goal.action.display() : null,
            queue_item: s.goal.source.type === "queue" ? s.goal.source.item : null,
          }
        : null,
      backlog: s.backlog.map((q) => `#${q.item} ${q.text}(${q.requester})`),
      summary: s.summary,
      busy: s.busy,
      last_action: s.lastAction,
      recent: [...s.recent],
    };
  }

  // ----- commands -----

  /**
   * A voice channel her voice node is in (on `platform` when given), if any: the
   * ActivityManager's presence when it runs, else what the director saw on the bus.
   */
  voiceContext(platform: string | null = null): ContextKey | null {
    const presence = this.#ctx.services.get(ActivityManagerKey)?.snapshot().presence;
    if (presence !== undefined) {
      if (presence.type !== "in") return null;
      return platform === null || presence.channel.platform === platform
        ? { ...presence.channel }
        : null;
    }
    return this.#voices.find((v) => platform === null || v.platform === platform) ?? null;
  }

  /** Voice channels she is in (the manager's presence when it runs). */
  #voiceChannels(): ContextKey[] {
    const presence = this.#ctx.services.get(ActivityManagerKey)?.snapshot().presence;
    if (presence !== undefined) return presence.type === "in" ? [{ ...presence.channel }] : [];
    return this.#voices;
  }

  /** The session running now (what `game.director.session` `started` said), if any. */
  session(): { game: string; game_name: string; context: ContextKey } | null {
    const s = this.#session;
    return s === null ? null : { game: s.game, game_name: s.gameName, context: { ...s.context } };
  }

  /** Keeps a goal for the session about to start; returns the reply text. */
  pendingGoal(text: string, by: string): string {
    const goal = text.trim();
    if (goal === "") throw new GameError("請輸入目標。", "invalid");
    this.#pendingGoal = { text: goal, by };
    return `遊戲還在開,開好後就做:${goal}。`;
  }

  /** Refuses games the director does not play (no goals: Threads, v2 §3.8). */
  #directed(game: string): void {
    if (!this.#cfg.directed_games.includes(game)) {
      throw new GameError(
        `${game} 不是有目標的遊戲,遊戲導演不負責它([modules.game] directed_games)。`,
        "invalid",
      );
    }
  }

  /**
   * Checks that the game is running and its adapter is connected before a session starts
   * (`[modules.game] require_connected`). Throws `GameError` (user-facing, so she can tell the
   * owner, with a code) when the adapter does not reach the game. When the game is not running
   * but the adapter can start it, runs its `launch` task (id `task` when the ActivityManager
   * gave one, budget `launch_wait_secs`) and waits for that task's end. A missing adapter is left
   * to `start`.
   */
  async preflight(
    game: string,
    context: ContextKey,
    signal?: AbortSignal,
    task: TaskId | null = null,
  ): Promise<Preflight> {
    if (!this.#cfg.require_connected) return { inMenu: false };
    const executor = this.#executor(game);
    if (!executor) return { inMenu: false };
    this.#directed(game);
    const name = executor.info.name;
    let obs: StructuredState;
    try {
      obs = await observeWithin(executor, this.#secs(this.#cfg.tool_timeout_secs), signal);
    } catch (error) {
      throw new GameError(
        `看不到 ${name} 的狀態（${errorMessage(error)}），沒辦法開始玩。`,
        codeOf(error),
      );
    }
    let state = obs.state;
    if (state.connected === false) {
      const launch = stateObject(state, "launch");
      if (
        this.#cfg.auto_launch &&
        launch?.available === true &&
        offersGoal(executor.info, "launch")
      ) {
        state = await this.#launch(game, name, context, executor, task ?? newId(), signal);
      } else {
        const problem =
          launch?.available === false && typeof launch.problem === "string"
            ? `（沒辦法自己開：${launch.problem}）`
            : "";
        throw new GameError(
          `${name} 還沒開，或遊戲裡的模組沒有連上，沒辦法開始玩。請擁有者先在直播機開遊戲並進入世界。${problem}`,
        );
      }
    }
    return { inMenu: state.in_game === false };
  }

  /**
   * Runs the executor's `launch` task through the gate (as the director) and waits for its end:
   * `done` once the game connected (and loaded the world, when the launch joins one). A refused
   * or failed launch, a launcher error and running out of budget throw `GameError` with the
   * task's code.
   */
  async #launch(
    game: string,
    name: string,
    context: ContextKey,
    executor: RegisteredTaskExecutor,
    task: TaskId,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const cfg = this.#cfg;
    log.info({ game, task }, "launching the game");
    const outcome = await this.#actuators.invoke(
      {
        principal: Principals.director(context),
        capability: GAME_ACT,
        args: {
          game,
          call: { action: "launch", args: {} },
          task: { id: task, budget_s: cfg.launch_wait_secs },
        },
        why: "要開始玩了,先把遊戲開起來",
        turn: null,
      },
      signal ? { signal } : {},
    );
    if (outcome.status === "denied") {
      throw new GameError(
        `沒辦法開 ${name}：${deniedText(outcome.decision.stage)}（${outcome.decision.reason}）`,
        "denied",
      );
    }
    if (outcome.status === "failed") {
      const code = codeOf(outcome.cause);
      if (code === "timeout") {
        throw new GameError(
          `等了 ${cfg.launch_wait_secs} 秒，${name} 還是沒有連上，沒辦法開始玩。請擁有者看一下直播機。`,
          code,
        );
      }
      throw new GameError(`${name} 開不起來：${outcome.error}`, code);
    }
    try {
      return (await observeWithin(executor, this.#secs(cfg.tool_timeout_secs), signal)).state;
    } catch {
      return { connected: true };
    }
  }

  /**
   * Picks up the session the last run left open (`GameResume`). Only when the game is really
   * there: unlike `preflight` this never launches anything, and `waiting` means it cannot be
   * reached (yet). The session is the one it was, without a goal: the decision loop finds one.
   */
  async resume(restored: RestoredGame, signal?: AbortSignal): Promise<"resumed" | "waiting"> {
    if (this.#session) return "resumed";
    const executor = this.#executor(restored.game);
    if (!executor || restored.context === null) return "waiting";
    try {
      const obs = await observeWithin(executor, this.#secs(this.#cfg.tool_timeout_secs), signal);
      if (obs.state.connected === false) return "waiting";
    } catch (error) {
      log.debug({ game: restored.game, err: errorMessage(error) }, "game not reachable yet");
      return "waiting";
    }
    if (this.#session) return "resumed";
    const context = restored.context;
    log.info({ game: restored.game }, "picking up the game session of the last run");
    this.start(restored.game, "here", context, RESUMED_BY);
    return "resumed";
  }

  /** Starts a session. Throws `GameError` (user-facing message) when it cannot. */
  start(game: string, placement: Placement, here: ContextKey, invoker: AccountRef): string {
    try {
      const text = this.#start(game, placement, here, invoker);
      this.#cancelWork();
      return text;
    } finally {
      this.#refreshView();
      this.#arm();
    }
  }

  stop(): string {
    try {
      const text = this.#stop();
      this.#cancelWork();
      return text;
    } finally {
      this.#refreshView();
      this.#arm();
    }
  }

  goal(text: string, by: string): string {
    try {
      return this.#commandGoal(text, by);
    } finally {
      this.#refreshView();
      this.#arm();
    }
  }

  #resolveContext(placement: Placement, here: ContextKey): ContextKey {
    const voices = this.#voiceChannels();
    const voice = (): ContextKey | undefined =>
      voices.find((v) => v.platform === here.platform && v.scope === here.scope) ?? voices[0];
    const stream = (): ContextKey | null => this.#cfg.stream_context;
    switch (placement) {
      case "auto":
        return voice() ?? stream() ?? here;
      case "voice": {
        const v = voice();
        if (!v) throw new GameError("她目前不在語音頻道中，無法在語音裡實況。");
        return v;
      }
      case "here":
        return here;
      case "stream": {
        const s = stream();
        if (!s) throw new GameError("沒有設定直播頻道（[modules.game] stream_context）。");
        return s;
      }
    }
  }

  #start(game: string, placement: Placement, here: ContextKey, invoker: AccountRef): string {
    if (this.#session) {
      throw new GameError(
        `她已經在玩 ${this.#session.gameName}，要換遊戲請先使用 /game stop。`,
        "busy",
      );
    }
    if (!this.#ctx.services.get(TaskExecutorsKey)) {
      throw new GameError("擴充套件系統沒有啟用，無法玩遊戲。");
    }
    const executor = this.#executor(game);
    if (!executor) {
      throw new GameError(
        `找不到 ${game} 的遊戲 adapter（任務執行器 \`${gameTaskOwner(game)}\`），請確認擴充套件已啟用。`,
      );
    }
    this.#directed(game);
    const context = this.#resolveContext(placement, here);
    const name = executor.info.name;
    this.#generation += 1;
    log.info({ game, context: contextKeyString(context) }, "game session started");
    const where = context.kind === "voice" ? "語音頻道" : "這個頻道";
    const now = this.#now();
    this.#session = {
      generation: this.#generation,
      game,
      gameName: name,
      context,
      placement,
      here,
      starter: invoker,
      startedAt: now,
      goal: null,
      backlog: [],
      recent: [],
      summary: "",
      busy: null,
      lastAction: null,
      nextDecide: now,
      decideStarted: null,
      trigger: { text: ["剛開始玩"], important: true },
      lastComment: null,
      guard: null,
      tasks: new Map(),
    };
    this.#publishSession("started", this.#session);
    let text = `她開始玩 ${name} 了，實況會在${where}進行。`;
    const pending = this.#pendingGoal;
    this.#pendingGoal = null;
    if (pending !== null) text += this.#commandGoal(pending.text, pending.by);
    return text;
  }

  #publishSession(
    state: "started" | "stopped",
    s: Session,
    end: { code: TaskFailureCode; reason: string } | null = null,
  ): void {
    this.#ctx.publish(
      customEvent(SESSION_TOPIC, {
        state,
        game: s.game,
        game_name: s.gameName,
        context: { ...s.context },
        ...(end !== null ? { code: end.code, reason: end.reason } : {}),
      }),
    );
  }

  /**
   * Ends the session because the game went away (`disconnected`, its extension crashed): no
   * `stop` / `quit` (nothing to send them to); the session event carries the code.
   */
  #end(code: TaskFailureCode, reason: string): void {
    const s = this.#session;
    if (!s) return;
    this.#session = null;
    this.#generation += 1;
    this.#pendingGoal = null;
    log.warn({ game: s.game, code, reason }, "game session ended by itself");
    this.#publishSession("stopped", s, { code, reason });
    this.#cancelWork();
  }

  /** Cancels the goal's running task (the goal ended or the session stops). */
  #cancelGoalTask(s: Session): void {
    const g = s.goal;
    if (!g?.running || g.task === null) return;
    const id = g.task;
    g.running = false;
    g.task = null;
    s.tasks.delete(id);
    const executor = this.#executor(s.game);
    if (executor) void executor.cancel(id).catch(() => undefined);
  }

  #stop(): string {
    const s = this.#session;
    this.#pendingGoal = null;
    if (!s) throw new GameError("她目前沒有在玩遊戲。");
    this.#cancelGoalTask(s);
    this.#session = null;
    this.#generation += 1;
    log.info({ game: s.game }, "game session stopped");
    this.#publishSession("stopped", s);
    const executor = this.#executor(s.game);
    if (executor) {
      const actuators = this.#actuators;
      const calls = ["stop", ...(this.#cfg.close_on_stop ? ["quit"] : [])].filter((g) =>
        offersGoal(executor.info, g),
      );
      const budget = (goal: string): number =>
        budgetFor(executor.info, goal, this.#cfg.tool_timeout_secs, this.#cfg.max_goal_secs);
      this.#ctx.spawn("game-stop", async (signal) => {
        for (const goal of calls) {
          try {
            // `quit` closes the game when the adapter's own rule says so (e.g. she launched it).
            await actThroughGate(
              actuators,
              s,
              {
                call: new ActionCall(goal, {}).toolArgs(),
                task: { id: newId(), budget_s: budget(goal) },
              },
              signal,
            );
          } catch (error) {
            log.debug({ action: goal, error: errorMessage(error) }, "stopping the game failed");
          }
        }
      });
    }
    const open: number[] = s.backlog.map((q) => q.item);
    if (s.goal?.source.type === "queue") open.unshift(s.goal.source.item);
    let text = `她已停止玩 ${s.gameName}。`;
    if (open.length > 0) {
      text += `觀眾請求 ${open.map((i) => `#${i}`).join("、")} 尚未完成，已保留在佇列中。`;
    }
    return text;
  }

  #commandGoal(rawText: string, by: string): string {
    const s = this.#session;
    if (!s) throw new GameError("她目前沒有在玩遊戲。");
    const text = rawText.trim();
    if (text === "") throw new GameError("請輸入目標。", "invalid");
    const old = s.goal;
    this.#cancelGoalTask(s);
    s.goal = null;
    if (old?.source.type === "queue") {
      // The viewer's goal waits for its turn again.
      s.backlog.unshift({ item: old.source.item, text: old.text, requester: old.source.requester });
    }
    s.goal = newGoal(text, { type: "command", by }, this.#now());
    this.#trigger(`新目標:${text}`, true);
    return `已設定新目標：${text}。`;
  }

  // ----- events -----

  onEvent(env: Envelope): void {
    if (this.#closed || env.source === this.#ctx.id) return;
    const event = env.event;
    switch (event.type) {
      case "voice_joined":
      case "voice_participants":
        if (!this.#voices.some((v) => contextKeyEquals(v, event.data.context))) {
          this.#voices.push(event.data.context);
        }
        break;
      case "voice_left":
        this.#voices = this.#voices.filter((v) => !contextKeyEquals(v, event.data.context));
        break;
      case "module_state_changed": {
        // An extension that stopped or crashed takes the adapter's executor with it.
        const s = this.#session;
        const { module, state } = event.data;
        if (s && module.startsWith("ext.") && (state === "failed" || state === "stopped")) {
          if (!this.#executor(s.game)) {
            this.#end("crashed", `遊戲的擴充套件停止了(${module})`);
          }
        }
        break;
      }
      case "custom": {
        const { topic, payload } = event.data;
        if (topic === "queue.item_activated") {
          this.#onQueueItem(payload);
        } else {
          const s = this.#session;
          if (!s) return;
          const owner = gameTaskOwner(s.game);
          const task = parseTaskTopic(topic);
          if (task !== null) {
            if (task.owner !== owner) return;
            const e = parseTaskEvent(payload);
            if (e !== null) this.#onTask(e);
            break;
          }
          const prefix = `${owner}.`;
          if (!topic.startsWith(prefix)) return;
          const kind = asObject(payload)?.type;
          this.#onGameEvent(typeof kind === "string" ? kind : topic.slice(prefix.length), payload);
        }
        break;
      }
      default:
        return;
    }
    this.#refreshView();
    this.#arm();
  }

  #remember(line: string): void {
    const max = Math.max(this.#cfg.recent_events, 1);
    const s = this.#session;
    if (!s) return;
    s.recent.push(line);
    while (s.recent.length > max) s.recent.shift();
  }

  /** A task event of this session's game (ids it did not start, or forgot, are ignored). */
  #onTask(e: TaskEvent): void {
    const s = this.#session;
    if (!s) return;
    const track = s.tasks.get(e.task);
    if (!track) return;
    if (e.type === "started") return;
    if (e.type === "steered") {
      // Someone (the main line) changed the task's goal and it kept running: not an end.
      if (e.outcome === "applied" && e.detail !== "") this.#remember(e.detail);
      return;
    }
    if (e.type === "progress") {
      if (s.goal?.task === e.task && e.detail !== "") this.#remember(e.detail);
      return;
    }
    if (track.phase === "starting") {
      // The start's answer is still on its way: apply the end right after it.
      track.early = e;
      return;
    }
    this.#taskEnded(s, track, e);
  }

  /** A task the director started ended (`done` / `failed` with a code). */
  #taskEnded(s: Session, track: Track, end: TaskEnd): void {
    s.tasks.delete(end.task);
    const action = track.action;
    const now = this.#now();
    const text = end.detail === "" ? (end.type === "done" ? "好了" : end.code) : end.detail;
    s.lastAction = `${action.display()} → ${end.type === "done" ? "" : `失敗(${end.code}):`}${firstLine(text, 120)}`;
    log.debug({ action: action.display(), end: end.type, task: end.task }, "game task ended");
    const g = s.goal;
    const ofGoal = g !== null && g.task === end.task;
    if (ofGoal) g.running = false;
    if (end.type === "done") {
      if (!this.#cfg.instant_actions.includes(action.name)) {
        s.guard = afterSuccess(s.guard, action.name, now);
      }
      if (ofGoal && g && !goalLocked(g.source)) {
        this.#finishGoal({ type: "reached", code: "done", detail: text });
      } else if (ofGoal) {
        // A step of a requested goal: the model decides whether the goal is done.
        this.#trigger(`這一步做完了:${firstLine(text, 60)}`, false);
      }
      return;
    }
    switch (end.code) {
      case "disconnected":
      case "crashed":
        this.#end(end.code, text);
        return;
      case "died":
        // The `death` event resets the goal; the task just ended with her.
        if (ofGoal && g) g.task = null;
        return;
      case "cancelled":
      case "superseded":
      case "busy":
        // Interrupted (a reflex took her body, someone stopped it): not a failure of the goal.
        if (ofGoal && g) {
          g.task = null;
          this.#trigger(
            end.code === "busy" ? "被身體的本能反應打斷了" : "上一個動作被中斷了",
            false,
          );
        }
        return;
      default: {
        if (!this.#cfg.instant_actions.includes(action.name)) {
          s.guard = guardAfter(this.#cfg, firstLine(text, 80), now) ?? s.guard;
        }
        if (!ofGoal || !g) {
          this.#trigger("上一個動作失敗了", false);
          return;
        }
        g.task = null;
        g.attempts += 1;
        if (!goalLocked(g.source) || g.attempts >= Math.max(this.#cfg.max_attempts, 1)) {
          this.#finishGoal({ type: "failed", code: end.code, why: firstLine(text, 60) });
        } else {
          this.#trigger("上一個動作失敗了", false);
        }
      }
    }
  }

  #onGameEvent(kind: string, payload: JsonValue): void {
    const obj = asObject(payload);
    const data = obj?.data ?? null;
    const dataObj = asObject(data);
    const text = typeof dataObj?.text === "string" ? dataObj.text : kind;
    const important = obj?.important === true;
    log.debug({ kind, text, important }, "game event");
    if (this.#cfg.end_events.includes(kind)) {
      // The game went away: the session ends (scene back, activity failed), no commentary.
      this.#end("disconnected", text);
      return;
    }
    this.#remember(text);
    const about = this.#aboutEvent(kind, dataObj, text, important);

    switch (kind) {
      case "death": {
        this.#nudge({ valence: -0.15, arousal: 0.1, energy: 0.0, reason: "game: death" });
        const cur = this.#session;
        if (cur) {
          const g = cur.goal;
          // A requested goal survives the death; it is retried.
          if (g && goalLocked(g.source)) {
            this.#cancelGoalTask(cur);
            g.action = null;
          } else {
            this.#cancelGoalTask(cur);
            cur.goal = null;
          }
        }
        this.#commentEvent(text, about);
        break;
      }
      case "advancement":
        this.#nudge({ valence: 0.15, arousal: 0.1, energy: 0.0, reason: "game: advancement" });
        this.#commentEvent(text, about);
        break;
      case "chat":
        // Player chat is its own conversation when `game.chat` handles this game: she answers
        // there, so the director only notes it (as untrusted data for its next decision).
        // Otherwise a person is talking to her: an answer, not narration.
        if (important && !this.#chatHandled(dataObj)) this.#commentEvent(text, null);
        break;
      default:
        if (important) this.#commentEvent(text, about);
    }
    if (this.#cfg.trigger_events.includes(kind)) this.#trigger(text, important);
  }

  /** What a line about this event is about; `null`: urgent, nothing limits it. */
  #aboutEvent(
    kind: string,
    data: JsonObject | null,
    text: string,
    important: boolean,
  ): About | null {
    const cfg = this.#cfg;
    if (matchesEvent(cfg.urgent_events, kind, data)) return null;
    const key = eventKey(kind, data);
    if (kind !== "chat" && isNoted(kind, important)) this.#narration.note(key, text);
    const hazard = matchesEvent(cfg.hazard_events, kind, data);
    return {
      key,
      repeat_after_ms: hazard
        ? this.#secs(cfg.hazard_repeat_secs)
        : this.#secs(cfg.narration_repeat_mins * 60),
    };
  }

  /** A player's chat line that `game.chat` turns into a conversation. */
  #chatHandled(data: JsonObject | null): boolean {
    const s = this.#session;
    if (!s || data?.system === true) return false;
    return this.#ctx.services.get(GameChatKey)?.handles(s.game) ?? false;
  }

  #onQueueItem(payload: JsonValue): void {
    const obj = asObject(payload);
    const kind = typeof obj?.kind === "string" ? obj.kind : "";
    if (kind !== this.#cfg.queue_kind) return;
    const item = obj?.id;
    const text = obj?.text;
    if (
      typeof item !== "number" ||
      !Number.isInteger(item) ||
      item < 0 ||
      typeof text !== "string"
    ) {
      log.warn({ payload }, "queue item without id or text");
      return;
    }
    const requester = typeof obj?.requester_name === "string" ? obj.requester_name : "觀眾";
    const s = this.#session;
    if (!s) {
      log.debug({ item }, "game goal activated while not playing; ignored");
      return;
    }
    const queued: QueuedGoal = { item, text, requester };
    if (s.goal && goalLocked(s.goal.source)) {
      s.backlog.push(queued);
      return;
    }
    this.#beginQueued(queued);
  }

  /** Makes a viewer goal current and announces it. */
  #beginQueued(q: QueuedGoal): void {
    const s = this.#session;
    if (!s) return;
    const line = `觀眾 ${q.requester} 想要你:${q.text}`;
    this.#cancelGoalTask(s);
    s.goal = newGoal(q.text, { type: "queue", item: q.item, requester: q.requester }, this.#now());
    this.#remember(line);
    this.#comment(`${line}。回應一下,然後開始做。`, true, null, REQUESTED_TTL_MS);
    this.#trigger(line, true);
  }

  #finishGoal(outcome: Outcome): void {
    const s = this.#session;
    if (!s) return;
    const goal = s.goal;
    if (!goal) return;
    const task = goal.task;
    // Ended by the model or its age (not by its task): the task stops too.
    this.#cancelGoalTask(s);
    s.goal = null;
    const why = outcome.type === "reached" ? "" : `${outcome.why}`;
    let line: string;
    let hint: { text: string; urgent: boolean } | null;
    if (goal.source.type === "queue") {
      const requester = goal.source.requester;
      if (outcome.type === "reached") {
        line = `完成目標:${goalLabel(goal)}`;
        hint = {
          text: `完成了觀眾 ${requester} 的請求「${goal.text}」,跟大家說一聲`,
          urgent: true,
        };
      } else {
        line = `目標失敗:${goalLabel(goal)}(${why})`;
        hint = {
          text: `觀眾 ${requester} 的請求「${goal.text}」沒做成(${why}),找個藉口`,
          urgent: true,
        };
      }
    } else if (outcome.type === "reached") {
      line = `完成目標:${goalLabel(goal)}`;
      hint = { text: `剛完成「${goal.text}」`, urgent: false };
    } else {
      line = `目標失敗:${goalLabel(goal)}(${why})`;
      hint = null;
    }
    log.info(
      { goal: goal.text, reached: outcome.type === "reached", code: outcome.code },
      "game goal finished",
    );
    const end: GoalEnd = {
      game: s.game,
      goal: goal.text,
      source: goal.source.type,
      status: outcome.type === "reached" ? "done" : "failed",
      code: outcome.code,
      task,
      detail: outcome.type === "reached" ? outcome.detail : outcome.why,
      at: toTimestamp(this.#now()),
      attention_key: goalKey(goal.text, goal.action),
    };
    this.#ctx.publish(customEvent(GOAL_TOPIC, end as unknown as JsonValue));
    if (goal.source.type === "queue") {
      const queue = this.#ctx.services.get(RequestQueueKey);
      if (queue) {
        const item = goal.source.item;
        try {
          if (outcome.type === "reached") queue.complete(item);
          else queue.skip(item);
        } catch (error) {
          log.warn({ item, error: errorMessage(error) }, "could not finish the queue item");
        }
      }
    }
    this.#remember(line);
    if (hint) {
      if (goalRequested(goal.source)) {
        // Someone asked: this is a result she owes them, not narration.
        this.#comment(hint.text, hint.urgent, null, REQUESTED_TTL_MS);
      } else {
        const about = this.#narrated(goalKey(goal.text, goal.action));
        this.#narrate(goal.text, hint.text, hint.urgent, about);
      }
    }
    const next = this.#session?.backlog.shift();
    if (next) this.#beginQueued(next);
    else this.#trigger(line, false);
  }

  /** Asks for an early decision (at most every `min_decide_secs`). */
  #trigger(text: string, important: boolean): void {
    const min = this.#secs(this.#cfg.min_decide_secs);
    const s = this.#session;
    if (!s) return;
    s.trigger ??= { text: [], important: false };
    s.trigger.text.push(text);
    s.trigger.important ||= important;
    const now = this.#now();
    const earliest = s.decideStarted === null ? now : Math.max(s.decideStarted + min, now);
    if (earliest < s.nextDecide) s.nextDecide = earliest;
  }

  // ----- commentary and mood -----

  /** A line of narration; `line`: what it says, without the instructions around it in `hint`. */
  #narrate(line: string, hint: string, urgent: boolean, about: About): void {
    if (this.#comment(hint, urgent, about)) this.#narration.said(about.key, line);
  }

  /** `key` as narration of something that happens once. */
  #narrated(key: string): About {
    return { key, repeat_after_ms: this.#secs(this.#cfg.narration_repeat_mins * 60) };
  }

  /**
   * Requests a line. With `about` it is narration: rate-limited (`urgent`: only by the shorter
   * limit), and the Arbiter stops repeats and talking to nobody. Without it she has to say it
   * (`mustTtlMs`: how long it may wait): no rate limit, and it never merges with another line.
   * Returns whether it was sent.
   */
  #comment(hint: string, urgent: boolean, about: About | null, mustTtlMs = URGENT_TTL_MS): boolean {
    const cfg = this.#cfg;
    const s = this.#session;
    if (!s) return false;
    const gap = this.#secs(urgent ? cfg.urgent_commentary_min_secs : cfg.commentary_min_secs);
    const now = this.#now();
    if (about !== null && s.lastComment !== null && now - s.lastComment < gap) {
      log.debug({ hint, urgent }, "commentary rate-limited");
      return false;
    }
    s.lastComment = now;
    // `auto`: she may have joined (or left) a voice channel since the game started; comment
    // where she is now rather than where the game was started.
    if (s.placement === "auto") {
      s.context = this.#resolveContext("auto", s.here);
      // Not in voice and no stream channel: play quietly rather than fill a text channel with
      // running commentary (`where: "here"` asks for that explicitly).
      if (s.context.kind !== "voice" && s.context !== this.#cfg.stream_context) {
        log.debug({ hint }, "commentary skipped: not in voice");
        return false;
      }
    }
    const text = urgent
      ? `(你正在直播玩 ${s.gameName})${hint}`
      : `(你正在直播玩 ${s.gameName})實況:${hint}`;
    // V3: game events are Observations already and what the director would add is a proposal
    // (docs/design/v3-architecture.md §4). Only what cannot wait still claims the mic here.
    const board = this.#ctx.services.get(ProposalBoardKey);
    if (board !== undefined && about !== null) {
      void board
        .propose({
          what: text,
          why: `${s.gameName} 實況`,
          expires: toTimestamp(now + this.#secs(cfg.commentary_min_secs)),
          source: "game.director",
          context: s.context,
          about: null,
          person: null,
          goal: null,
          attention: about,
        })
        .catch((error: unknown) => {
          log.debug({ error: errorMessage(error) }, "could not propose a line");
        });
      return true;
    }
    // Commentary is an impulse of source `game` (never her own topic); newer narration replaces
    // one still waiting for a free moment.
    const narrationTtl = urgent ? cfg.urgent_commentary_min_secs : cfg.commentary_min_secs;
    const impulse = newImpulse(
      {
        source: "game",
        context: s.context,
        ttlMs: about === null ? mustTtlMs : this.#secs(narrationTtl),
        why: `${s.gameName} 實況`,
        hint: text,
        reason: INITIATIVE_REASON,
        coalesce_key: about === null ? null : `game:${contextKeyString(s.context)}`,
        attention: about,
      },
      now,
    );
    this.#ctx.publish(v2Event(ARBITER_IMPULSE_TOPIC, impulse));
    return true;
  }

  #commentEvent(text: string, about: About | null): void {
    const hint = `剛剛${text}!馬上用一兩句話反應。`;
    if (about === null) this.#comment(hint, true, null);
    else this.#narrate(text, hint, true, about);
  }

  #nudge(m: MoodNudge): void {
    this.#ctx.publish(
      customEvent("mood.nudge", {
        valence: m.valence,
        arousal: m.arousal,
        energy: m.energy,
        reason: m.reason,
      }),
    );
  }

  // ----- decisions -----

  #startDecide(): Work | null {
    const cfg = this.#cfg;
    const s0 = this.#session;
    if (!s0) return null;
    const now = this.#now();
    // Hold the next tick far away until the result arrives.
    s0.nextDecide = now + this.#secs(cfg.decide_secs);
    s0.decideStarted = now;
    const executor = this.#executor(s0.game);
    if (!executor) {
      // The adapter is gone (its extension crashed or was disabled): the session ends.
      this.#end("crashed", "遊戲的擴充套件不見了");
      return null;
    }
    const maxAge = this.#secs(cfg.max_goal_secs);
    if (s0.goal && now - s0.goal.setAt >= maxAge) {
      this.#finishGoal({ type: "failed", code: "timeout", why: "太久了,放棄" });
    }
    const s = this.#session;
    if (!s) return null;
    const trigger = s.trigger ?? { text: [], important: false };
    s.trigger = null;
    const input: DecideInput = {
      generation: s.generation,
      trigger,
      cfg,
      executor,
      router: this.#ctx.services.get(LlmRouterKey),
      persona: this.#persona,
      game: s.game,
      gameName: s.gameName,
      goal: s.goal ? `${goalLabel(s.goal)}(${this.#goalProgress(s.goal)})` : null,
      lastAction: s.lastAction,
      backlog: s.backlog.map((q) => `${q.text}(${q.requester})`),
      recent: [...s.recent],
      withheld: guardNote(s.guard, now),
      said: this.#narration.lines(),
    };
    return (signal) => decide(input, signal);
  }

  /** `還沒開始` / `進行中,已 N 秒` / `上一步結束了,已 N 秒`. */
  #goalProgress(g: Goal): string {
    if (g.action === null) return "還沒開始";
    const secs = Math.floor(Math.max(this.#now() - g.setAt, 0) / 1000);
    return g.running ? `進行中,已 ${secs} 秒` : `上一步結束了,已 ${secs} 秒`;
  }

  #onDone(done: Done): Work | null {
    if (this.#session?.generation !== done.generation) return null;
    let next: Work | null = null;
    if (done.type === "decided") {
      next = this.#onDecided(done.trigger, done.observation, done.decision);
    } else {
      this.#onStarted(done.task, done.result);
    }
    if (!next) this.#scheduleAfterWork();
    this.#refreshView();
    return next;
  }

  #scheduleAfterWork(): void {
    const cfg = this.#cfg;
    const s = this.#session;
    if (!s) return;
    const now = this.#now();
    const next = s.trigger
      ? s.decideStarted === null
        ? now
        : Math.max(s.decideStarted + this.#secs(cfg.min_decide_secs), now)
      : (s.decideStarted ?? now) + this.#secs(cfg.decide_secs);
    s.nextDecide = Math.max(next, now);
  }

  #onDecided(
    trigger: Trigger,
    observation: Res<StructuredState>,
    decisionRes: Res<Decision> | null,
  ): Work | null {
    const cfg = this.#cfg;
    const s = this.#session;
    if (!s) return null;
    if (observation.ok) {
      s.busy = observation.value.task !== null;
      s.summary = observation.value.summary.trim();
    } else {
      log.warn({ error: observation.error }, "observing the game failed");
      if (!this.#executor(s.game)) {
        // The adapter is gone (its extension crashed or was disabled): the session ends.
        this.#end("crashed", "遊戲的擴充套件不見了");
        return null;
      }
      s.summary = `看不到遊戲畫面(${observation.error})`;
      s.busy = null;
      return null;
    }
    if (!decisionRes) return null;
    if (!decisionRes.ok) {
      log.warn({ error: decisionRes.error }, "game decision failed");
      return null;
    }
    const decision = decisionRes.value;
    if (decision.status === "done") {
      this.#finishGoal({ type: "reached", code: "reported", detail: "她說完成了" });
    } else if (decision.status === "failed") {
      this.#finishGoal({ type: "failed", code: "gave_up", why: "做不到" });
    }
    if (decision.mood) {
      const max = Math.abs(cfg.max_llm_nudge);
      const clamp = (v: number): number => Math.min(Math.max(v, -max), max);
      const m: MoodNudge = {
        valence: clamp(decision.mood.valence),
        arousal: clamp(decision.mood.arousal),
        energy: clamp(decision.mood.energy),
        reason: decision.mood.reason,
      };
      if (m.valence !== 0 || m.arousal !== 0 || m.energy !== 0) {
        m.reason = `game: ${m.reason}`;
        this.#nudge(m);
      }
    }
    if (decision.commentary !== null) {
      const line = decision.commentary;
      this.#narrate(line, line, false, this.#narrated(this.#narration.keyOf(line)));
    }
    const cur = this.#session;
    if (!cur) return null;
    let verdict: Verdict | null = null;
    if (decision.action) {
      const g = cur.goal;
      const now = this.#now();
      const facts: GoalFacts | null = g
        ? {
            text: g.text,
            locked: goalLocked(g.source),
            pending: g.action === null,
            action: g.action,
            ageMs: now - g.setAt,
            running: g.running,
          }
        : null;
      verdict = judge(cfg, facts, decision.action, decision.goal, trigger.important);
      const guard = activeGuard(cur.guard, now);
      if (verdict.type !== "keep" && guard && withheld(guard, decision.action.name, now)) {
        // The same kind of low-level retry right after a failure: she has to change method.
        verdict = { type: "keep", why: `withheld after a failure: ${guard.why}` };
        cur.lastAction = `${decision.action.display()} → 暫時不行:剛剛失敗過(${guard.why}),換個方法或目標`;
        if (!guard.nudged) {
          guard.nudged = true;
          this.#trigger("動作被擋下了,換個方法或目標", false);
        }
      }
    }
    const trace: DirectorThoughtBody = {
      game: cur.game,
      trigger: trigger.text,
      goal: decision.goal,
      action: decision.action ? decision.action.display() : null,
      verdict: verdict ? verdictDebug(verdict) : null,
      commentary: decision.commentary,
      busy: cur.busy,
    };
    this.#ctx.publish(customEvent(DECISION_TOPIC, trace as unknown as JsonValue));
    if (!decision.action || !verdict) return null;
    if (verdict.type === "keep") {
      log.debug({ action: decision.action.display(), why: verdict.why }, "kept the current goal");
      return null;
    }
    const executor = this.#executor(cur.game);
    if (!executor) return null;
    const action = decision.action;
    const id = newId();
    const budget = budgetFor(executor.info, action.name, cfg.task_budget_secs, cfg.max_goal_secs);
    this.#track(cur, id, {
      action,
      verdict,
      goalText: decision.goal,
      phase: "starting",
      early: null,
    });
    const generation = cur.generation;
    const actuators = this.#actuators;
    return async (signal) => {
      const result = await attempt(() =>
        actThroughGate(
          actuators,
          cur,
          { call: action.toolArgs(), task: { id, budget_s: budget }, wait: false },
          signal,
        ),
      );
      return { type: "acted", generation, task: id, result };
    };
  }

  #track(s: Session, id: TaskId, track: Track): void {
    s.tasks.set(id, track);
    while (s.tasks.size > MAX_TRACKED) {
      const oldest = s.tasks.keys().next().value;
      if (oldest === undefined) break;
      s.tasks.delete(oldest);
    }
  }

  /** The start of task `id` was accepted (or refused) by the executor, through the gate. */
  #onStarted(id: TaskId, result: Res<string>): void {
    const s = this.#session;
    if (!s) return;
    const track = s.tasks.get(id);
    if (!track) return;
    const { action, verdict } = track;
    const now = this.#now();
    const instant = this.#cfg.instant_actions.includes(action.name);
    if (!result.ok) {
      // Not accepted (refused by the gate, invalid arguments, the game is busy...).
      s.tasks.delete(id);
      s.lastAction = `${action.display()} → 失敗(${result.code}):${firstLine(result.error, 120)}`;
      log.debug({ action: action.display(), code: result.code }, "game task not started");
      if (!instant) s.guard = guardAfter(this.#cfg, firstLine(result.error, 80), now) ?? s.guard;
      const g = s.goal;
      if (verdict.type === "step" && !instant && g) {
        g.attempts += 1;
        if (g.attempts >= Math.max(this.#cfg.max_attempts, 1)) {
          this.#finishGoal({ type: "failed", code: result.code, why: firstLine(result.error, 60) });
          return;
        }
      }
      this.#trigger("上一個動作失敗了", false);
      return;
    }
    track.phase = "running";
    s.lastAction = `${action.display()} → 開始了`;
    if (verdict.type === "replace") {
      this.#cancelGoalTask(s);
      const old = s.goal;
      if (old?.source.type === "queue") {
        s.backlog.unshift({
          item: old.source.item,
          text: old.text,
          requester: old.source.requester,
        });
      }
      const goal = newGoal(track.goalText ?? action.display(), { type: "director" }, now);
      goal.action = action;
      goal.task = id;
      goal.running = true;
      s.goal = goal;
    } else if (verdict.type === "step" && !instant) {
      const g = s.goal;
      if (g) {
        if (g.task !== null && g.task !== id) this.#cancelGoalTask(s);
        g.action = action;
        g.task = id;
        g.running = true;
      }
    }
    if (track.early !== null) this.#taskEnded(s, track, track.early);
  }
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
