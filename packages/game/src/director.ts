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
  type DrivenWork,
  dataBlock,
  type Envelope,
  escapeData,
  gameTaskOwner,
  type JsonObject,
  type JsonValue,
  newId,
  newImpulse,
  Principals,
  ProposalBoardKey,
  parseGameOutcome,
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
  WorkEndedError,
  WorkLaneKey,
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
  impliedWant,
  judge,
  type MoodNudge,
  type PromptParts,
  parseDecision,
  prompts,
  type Verdict,
  verdictDebug,
  type Want,
  wantMet,
  wantText,
} from "./decision.js";
import {
  activeGuard,
  afterSuccess,
  type FailureGuard,
  guardAfter,
  guardNote,
  withheld,
} from "./guard.js";
import { MethodGuard, methodKey, normalizeItem } from "./methods.js";
import { type About, eventKey, goalKey, isNoted, matchesEvent, Narration } from "./narration.js";
import { type Attempt, AttemptRecord, type AttemptResult, attemptLine } from "./record.js";
import { SkillShelf } from "./skill-store.js";
import { SKILL_TOPIC, type Skill, SkillBook } from "./skills.js";
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
  /** Its tasks kept ending without changing anything until its attempts ran out. */
  | "no_progress"
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
  /** Failed attempts (failures and tasks without progress). */
  attempts: number;
  /** Tasks started for it (its step budget is `max_goal_steps`). */
  steps: number;
  /** Its success condition, if it has one (§11.2 item 2). */
  want: Want | null;
}

function newGoal(text: string, source: GoalSource, now: number, want: Want | null = null): Goal {
  return {
    text,
    source,
    setAt: now,
    action: null,
    task: null,
    running: false,
    attempts: 0,
    steps: 0,
    want,
  };
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
  /** Its method (`methodKey`). */
  method: string;
  verdict: Verdict;
  goalText: string | null;
  /** The success condition of the goal it starts (`replace`) or adds (`step`). */
  want: Want | null;
  /** It starts a survival goal. */
  survival: boolean;
  /** `starting`: the start is in flight; an end that arrives meanwhile waits in `early`. */
  phase: "starting" | "running";
  early: TaskEnd | null;
}

/** Tasks tracked at once (old ones are forgotten; their events are then ignored). */
const MAX_TRACKED = 32;
/** A learned skill is kept this long after the last one (one write for a burst). */
const SAVE_SKILLS_MS = 2_000;
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
  /** Methods held after failing the same way twice (see methods.ts). */
  methods: MethodGuard;
  /** What she tried this session and how it ended (see record.ts). */
  record: AttemptRecord;
  /** A survival goal to start at `due` (night, after a death). */
  survival: { action: string; goal: string; due: number } | null;
  /** The goal a survival goal interrupted; it comes back when that ends. */
  suspended: Goal | null;
  tasks: Map<TaskId, Track>;
  /** The work-lane task its decisions are steps of (`director_lane`), once opened. */
  work: DrivenWork | null;
  /** The lane said no more (its day is spent): one-shot decisions for the rest of the session. */
  laneOff: boolean;
}

/** The decision trace: the thought plus what she saw and what was on hold (§11.2 item 9). */
type DirectorTrace = DirectorThoughtBody & {
  /** The observation summary the decision was made from. */
  observation: string;
  want: Want | null;
  /** Methods and goals on hold at the time. */
  held: string[];
};

/** Characters of the observation summary kept in the trace. */
const TRACE_OBSERVATION_CHARS = 800;

/** `state.inventory` of an observation as item counts, if the game reports one. */
function inventoryOf(state: JsonObject): Record<string, number> | null {
  const raw = state.inventory;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(raw)) if (typeof n === "number") out[id] = n;
  return out;
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
  /** Her record of attempts, the holds and her skills (prompt lines). */
  attempts: string[];
  held: string[];
  skills: string[];
  /** The session's work-lane task, when decisions are its steps (`director_lane`). */
  work: DrivenWork | null;
}

/** Characters of the game state a decision keeps in its task's transcript. */
const KEPT_OBSERVATION_CHARS = 300;

/**
 * What a decision's transcript keeps of what it saw: the trigger, the goal, the last action and
 * the start of the game state. The record, the holds and the skills are in every prompt anew.
 */
export function keptPrompt(p: PromptParts): string {
  const lines = [`觸發:${escapeData(p.trigger)}`, `目前目標:${escapeData(p.goal ?? "沒有")}`];
  if (p.lastAction !== null) lines.push(`上一個動作:${escapeData(p.lastAction)}`);
  lines.push(`遊戲狀態(開頭):${escapeData(firstChars(p.observation, KEPT_OBSERVATION_CHARS))}`);
  return dataBlock("game", "那時看到的", lines.join("\n"));
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
    attempts: input.attempts,
    held: input.held,
    skills: input.skills,
  };
  const { system, user } = prompts(parts);
  const work = input.work;
  if (work !== null && !work.ended) {
    // A step of the session's work-lane task (§11.2 item 1): it sees its earlier decisions and
    // what came of each, not only this moment.
    try {
      const text = await work.step(
        {
          system,
          user,
          kept: keptPrompt(parts),
          purpose: cfg.purpose,
          json: true,
          reasoning: cfg.reasoning,
          temperature: cfg.temperature,
          max_tokens: cfg.max_tokens,
          session: sessionId(input.persona.profile, `game-${input.game}`),
          timeout_ms: cfg.llm_timeout_secs * 1000,
        },
        signal,
      );
      return parseDecision(text);
    } catch (error) {
      // The lane's budget is spent (or the task ended): the one-shot decision, as before.
      if (!(error instanceof WorkEndedError)) throw error;
    }
  }
  const request: ChatRequest = {
    messages: [
      { role: "system", content: system, name: null, tool_calls: [], tool_call_id: null },
      { role: "user", content: user, name: null, tool_calls: [], tool_call_id: null },
    ],
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
    json_mode: true,
    session: sessionId(input.persona.profile, `game-${input.game}`),
    // A little thinking before choosing (§11.2 item 9): with it off she answered every failure
    // with the same goal in other words.
    ...(cfg.reasoning !== null ? { reasoning: cfg.reasoning } : {}),
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
  /** Ways she reached goals, kept across sessions while the module runs (see skills.ts). */
  readonly #skills = new SkillBook();
  #voices: ContextKey[] = [];
  #session: Session | null = null;
  #generation = 0;
  /** The running background step, if any (aborted when a session starts or stops). */
  #work: AbortController | null = null;
  /** A goal set while the game was still starting (applied when the session starts). */
  #pendingGoal: { text: string; by: string } | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  /** Where her skills are kept across restarts (§11.2 item 8). */
  readonly #shelf: SkillShelf;
  /** Games whose kept skills were read (once per run). */
  readonly #loaded = new Set<string>();
  #saveTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.#shelf = new SkillShelf({
      has: (capability) => actuators.get(capability) !== undefined,
      // Her skill store, through the gate as the director, like its game steps.
      act: (call, signal) =>
        actuators.invoke(
          {
            principal: Principals.director(this.#session?.context ?? null),
            capability: call.capability,
            args: call.args,
            why: call.why,
            turn: null,
          },
          signal ? { signal } : {},
        ),
      lane: () => ctx.services.get(WorkLaneKey) ?? null,
      now: () => this.#now(),
    });
  }

  // ----- what she keeps -----

  /** Reads the skills kept for `game` (once per run): she knows what she managed before. */
  #loadSkills(game: string): void {
    if (!this.#cfg.keep_skills || this.#loaded.has(game)) return;
    this.#loaded.add(game);
    void this.#shelf.load(game).then(
      (skills) => {
        for (const skill of skills) this.#skills.restore(skill);
        if (skills.length > 0) log.info({ game, count: skills.length }, "skills she kept");
      },
      (error: unknown) => log.debug({ game, err: errorMessage(error) }, "no kept skills"),
    );
  }

  /** Keeps `game`'s skills soon (one write for a burst of goals). */
  #saveSkills(game: string): void {
    if (!this.#cfg.keep_skills || this.#saveTimer !== null) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#shelf.save(game, this.#skills.forGame(game)).then(
        (where) => log.debug({ game, where }, "skills kept"),
        (error: unknown) => log.warn({ game, err: errorMessage(error) }, "could not keep skills"),
      );
    }, SAVE_SKILLS_MS);
  }

  /**
   * The session's work-lane task (§11.2 item 1), opened at its first decision; `null` when the
   * lane is off, not there, or said no more for this session.
   */
  #workTask(s: Session): DrivenWork | null {
    if (!this.#cfg.director_lane || s.laneOff) return null;
    if (s.work !== null) {
      if (!s.work.ended) return s.work;
      s.work = null;
      s.laneOff = true;
      return null;
    }
    const lane = this.#ctx.services.get(WorkLaneKey);
    if (!lane) return null;
    try {
      s.work = lane.open({
        owner: gameTaskOwner(s.game),
        goal: `玩 ${s.gameName}`,
        keep_steps: this.#cfg.director_steps,
      });
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "could not open the director's work task");
      s.laneOff = true;
    }
    return s.work;
  }

  /** What came of something she tried, for the next step of the session's task. */
  #told(s: Session, line: string): void {
    if (s.work !== null && !s.work.ended) s.work.result(line);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Stops all background activity (module stop). */
  close(): void {
    if (this.#saveTimer !== null) {
      // What she learned last is kept before the module goes.
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
      const game = this.#session?.game;
      if (game !== undefined) {
        void this.#shelf.save(game, this.#skills.forGame(game)).catch(() => undefined);
      }
    }
    if (!this.#closed && this.#session) {
      this.#session.work?.end("stopped", "遊戲模組停了");
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
      methods: new MethodGuard(this.#cfg),
      record: new AttemptRecord(this.#cfg.record_attempts),
      survival: null,
      suspended: null,
      tasks: new Map(),
      work: null,
      laneOff: false,
    };
    this.#publishSession("started", this.#session);
    this.#loadSkills(game);
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
    s.work?.end("stopped", `遊戲斷了(${code})`);
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
    s.work?.end("done", "不玩了");
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
    // Someone asked for this now: it replaces a survival goal and the goal that one interrupted.
    for (const prev of [old, s.suspended]) {
      if (prev?.source.type === "queue") {
        // The viewer's goal waits for its turn again.
        s.backlog.unshift({
          item: prev.source.item,
          text: prev.text,
          requester: prev.source.requester,
        });
      }
    }
    s.suspended = null;
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
    const instant = this.#cfg.instant_actions.includes(action.name);
    const text = end.detail === "" ? (end.type === "done" ? "好了" : end.code) : end.detail;
    const outcome = end.type === "done" ? parseGameOutcome(end.data) : null;
    // An executor that reports no outcome: a `done` is progress, as before.
    const progressed = end.type === "done" && (outcome?.progressed ?? true);
    const note = outcome !== null && outcome.note !== "" ? `(${outcome.note})` : "";
    const result = end.type === "done" ? (progressed ? "" : "沒有進展:") : `失敗(${end.code}):`;
    s.lastAction = `${action.display()} → ${result}${firstLine(text, 120)}${note}`;
    log.debug(
      { action: action.display(), end: end.type, task: end.task, progressed },
      "game task ended",
    );
    const g = s.goal;
    const ofGoal = g !== null && g.task === end.task;
    if (ofGoal) g.running = false;
    const why = firstLine(`${text}${note}`, 80);
    if (end.type === "done") {
      // Instant actions (stop, look, chat...) are nobody's progress and end no failure.
      if (instant) return;
      this.#attempt(s, track, progressed ? "progress" : "no_progress", null, why);
      if (!progressed) {
        // Done, but nothing changed (an explore that saw nothing new, an empty mine, something
        // she already had): not a success, and doing it again the same way is the repeat the
        // guard stops. The goal may be met all the same.
        s.guard = guardAfter(this.#cfg, why, now) ?? s.guard;
        s.methods.failed(track.method, "no_progress", why, now);
        if (ofGoal && g?.want && wantMet(g.want, outcome?.inventory ?? null)) {
          this.#finishGoal({ type: "reached", code: "done", detail: text });
        } else if (ofGoal && g) {
          g.task = null;
          this.#goalAttemptFailed(g, "no_progress", why);
        }
        return;
      }
      s.guard = afterSuccess(s.guard, action.name, now);
      s.methods.progressed(track.method);
      // She got somewhere: a hold this may help (what it said was missing) can come back.
      if (outcome?.inventory) s.methods.seen(outcome.inventory, track.method);
      else
        s.methods.changed({ gained: outcome?.gained ?? {}, fresh: [], progressed: track.method });
      if (!ofGoal || !g) return;
      const inventory = outcome?.inventory ?? null;
      if (g.want !== null) {
        // Reached when the game shows it, or when the `obtain` of that very item finished.
        const obtained =
          inventory === null &&
          action.name === "obtain" &&
          impliedWant(action)?.item === g.want.item;
        if (wantMet(g.want, inventory) || obtained) {
          this.#finishGoal({ type: "reached", code: "done", detail: text });
        } else if (!this.#stepsLeft(g)) {
          this.#finishGoal({ type: "failed", code: "timeout", why: "步數用完了,還沒拿到" });
        } else {
          g.task = null;
          this.#trigger(
            `這一步有進展,但背包裡還沒有 ${wantText(g.want)}:${firstLine(text, 60)}`,
            false,
          );
        }
      } else if (!goalLocked(g.source) || g.source.type === "survival") {
        this.#finishGoal({ type: "reached", code: "done", detail: text });
      } else {
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
        this.#attempt(s, track, "interrupted", end.code, why);
        if (ofGoal && g) g.task = null;
        return;
      case "cancelled":
      case "superseded":
      case "busy":
        // Interrupted (a reflex took her body, someone stopped it): not a failure of the goal.
        if (!instant) this.#attempt(s, track, "interrupted", end.code, why);
        if (ofGoal && g) {
          g.task = null;
          this.#trigger(
            end.code === "busy" ? "被身體的本能反應打斷了" : "上一個動作被中斷了",
            false,
          );
        }
        return;
      default: {
        this.#attempt(s, track, "failed", end.code, why);
        if (!instant) {
          s.guard = guardAfter(this.#cfg, why, now) ?? s.guard;
          s.methods.failed(track.method, end.code, why, now);
        }
        if (!ofGoal || !g) {
          this.#trigger(`上一個動作失敗了(${end.code})`, false);
          return;
        }
        g.task = null;
        this.#goalAttemptFailed(g, end.code, firstLine(text, 60));
      }
    }
  }

  /** Writes how an action ended into her record. */
  #attempt(
    s: Session,
    track: Track,
    result: AttemptResult,
    code: string | null,
    detail: string,
  ): void {
    const attempt: Attempt = {
      at: this.#now(),
      action: track.action.display(),
      method: track.method,
      goal: track.verdict.type === "replace" ? track.goalText : (s.goal?.text ?? null),
      result,
      code: result === "no_progress" ? "no_progress" : code,
      detail,
    };
    s.record.add(attempt);
    // What came of what she tried, in the transcript of the session's task.
    this.#told(s, attemptLine(attempt, attempt.at).replace(/^\[[^\]]*\] /, ""));
  }

  /** Whether goal `g` may start another task (its step budget). */
  #stepsLeft(g: Goal): boolean {
    return g.steps < Math.max(this.#cfg.max_goal_steps, 1);
  }

  /**
   * One attempt of the current goal failed (or ended without progress): the goal stays, so the
   * next decision can try another method, until its attempts or steps run out.
   */
  #goalAttemptFailed(g: Goal, code: Exclude<GoalEndCode, "done" | "reported">, why: string): void {
    g.attempts += 1;
    // A survival goal is one try: what it interrupted comes back, and she decides from there.
    if (g.attempts >= Math.max(this.#cfg.max_attempts, 1) || g.source.type === "survival") {
      this.#finishGoal({ type: "failed", code, why });
    } else if (!this.#stepsLeft(g)) {
      this.#finishGoal({ type: "failed", code: "timeout", why: `步數用完了(${why})` });
    } else {
      const what = code === "no_progress" ? "沒有進展" : `失敗了(${code})`;
      this.#trigger(`上一步${what}:${why},目標還在,換個做法`, false);
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
          this.#cancelGoalTask(cur);
          if (g && g.source.type !== "survival" && goalLocked(g.source)) {
            // A requested goal survives the death; it is retried.
            g.action = null;
          } else {
            // Her own goal dies with her; a survival goal too (the one it interrupted waits).
            cur.goal = null;
          }
          // She respawns first, then goes back for what she dropped (§11.2 item 7).
          this.#scheduleSurvival(
            cur,
            this.#cfg.death_action,
            "回去撿死掉時掉的東西",
            this.#secs(this.#cfg.death_action_delay_secs),
          );
        }
        this.#commentEvent(text, about);
        break;
      }
      case "night_started": {
        const cur = this.#session;
        const action = this.#cfg.night_action;
        const g = cur?.goal;
        const sheltering = g?.source.type === "survival" && g.action?.name === action;
        if (cur && !sheltering) this.#scheduleSurvival(cur, action, "天黑了,先躲起來過夜", 0);
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
    const now = this.#now();
    if (goal.want !== null) {
      if (outcome.type === "reached") {
        s.methods.goalReached(goal.want.item);
        this.#learn(s, goal, goal.want);
      } else if (outcome.code !== "cancelled" && outcome.code !== "superseded") {
        // Not proposed again a few seconds later (2026-11-08: `obtain bread`, 35 times).
        s.methods.holdGoal(goal.want.item, outcome.code, outcome.why, now);
      }
    }
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
    const back = goal.source.type === "survival" ? s.suspended : null;
    if (back !== null) {
      // The goal the night (or a death) interrupted comes back, from its start.
      s.suspended = null;
      Object.assign(back, { action: null, task: null, running: false, setAt: now });
      s.goal = back;
      this.#trigger(`${line};回到原本的目標:${back.text}`, false);
      return;
    }
    const next = this.#session?.backlog.shift();
    if (next) this.#beginQueued(next);
    else this.#trigger(line, false);
  }

  /** A goal with a success condition was reached: the methods that got there become a skill. */
  #learn(s: Session, goal: Goal, want: Want): void {
    const steps: string[] = [];
    for (const a of s.record.forGoal(goal.text, goal.setAt)) {
      if (a.result === "progress" && steps.at(-1) !== a.action) steps.push(a.action);
    }
    const skill: Skill = {
      game: s.game,
      target: want.item,
      goal: goal.text,
      steps,
      at: this.#now(),
    };
    if (this.#skills.learn(skill)) {
      this.#ctx.publish(customEvent(SKILL_TOPIC, skill as unknown as JsonValue));
      this.#saveSkills(s.game);
    }
  }

  /**
   * Starts survival goal `action` (`text`) by itself in `delayMs`, when the game offers it:
   * no decision is asked for in between.
   */
  #scheduleSurvival(s: Session, action: string | null, text: string, delayMs: number): void {
    if (action === null) return;
    const executor = this.#executor(s.game);
    if (!executor || !offersGoal(executor.info, action)) return;
    const due = this.#now() + delayMs;
    s.survival = { action, goal: text, due };
    if (due < s.nextDecide) s.nextDecide = due;
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
    if (s.survival !== null) {
      // Survival does not wait for a decision: it starts when due, and nothing else meanwhile.
      if (now >= s.survival.due) return this.#startSurvival(s, s.survival);
      s.nextDecide = s.survival.due;
      return null;
    }
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
      attempts: s.record.lines(now),
      held: s.methods.lines(now),
      skills: this.#skills.lines(s.game, s.goal?.want?.item ?? null),
      work: this.#workTask(s),
    };
    return (signal) => decide(input, signal);
  }

  /** Starts the survival goal `plan` without asking the model. */
  #startSurvival(s: Session, plan: NonNullable<Session["survival"]>): Work | null {
    s.survival = null;
    const action = new ActionCall(plan.action, {});
    const verdict: Verdict = { type: "replace" };
    const trace: DirectorTrace = {
      game: s.game,
      trigger: ["求生"],
      goal: plan.goal,
      action: action.display(),
      verdict: verdictDebug(verdict),
      commentary: null,
      busy: s.busy,
      observation: s.summary,
      want: null,
      held: s.methods.lines(this.#now()),
    };
    this.#ctx.publish(customEvent(DECISION_TOPIC, trace as unknown as JsonValue));
    return this.#actWork(s, action, verdict, plan.goal, null, true);
  }

  /**
   * `還沒開始` / `進行中,已 N 秒` / `上一步結束了,已 N 秒`, with what it wants and how its
   * attempts went.
   */
  #goalProgress(g: Goal): string {
    const parts: string[] = [];
    if (g.want !== null) parts.push(`要:${wantText(g.want)}`);
    if (g.action === null) {
      parts.push("還沒開始");
    } else {
      const secs = Math.floor(Math.max(this.#now() - g.setAt, 0) / 1000);
      parts.push(g.running ? `進行中,已 ${secs} 秒` : `上一步結束了,已 ${secs} 秒`);
    }
    if (g.steps > 0) parts.push(`第 ${g.steps}/${Math.max(this.#cfg.max_goal_steps, 1)} 步`);
    if (g.attempts > 0) parts.push(`失敗 ${g.attempts}/${Math.max(this.#cfg.max_attempts, 1)} 次`);
    return parts.join(",");
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
    const due = s.survival?.due ?? Number.POSITIVE_INFINITY;
    s.nextDecide = Math.max(Math.min(next, due), now);
  }

  #onDecided(
    trigger: Trigger,
    observation: Res<StructuredState>,
    decisionRes: Res<Decision> | null,
  ): Work | null {
    const cfg = this.#cfg;
    const s = this.#session;
    if (!s) return null;
    let inventory: Record<string, number> | null = null;
    if (observation.ok) {
      s.busy = observation.value.task !== null;
      s.summary = observation.value.summary.trim();
      inventory = inventoryOf(observation.value.state);
      // Whatever got it there (a step, a reflex picking things up), what is new counts.
      s.methods.seen(inventory);
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
    // The success condition is the game's state, whoever's step got there.
    const want = s.goal?.want ?? null;
    if (want !== null && wantMet(want, inventory)) {
      this.#finishGoal({ type: "reached", code: "done", detail: `背包裡有 ${wantText(want)} 了` });
    }
    if (!decisionRes) return null;
    if (!decisionRes.ok) {
      log.warn({ error: decisionRes.error }, "game decision failed");
      return null;
    }
    const decision = decisionRes.value;
    const claimed = s.goal?.want ?? null;
    if (decision.status === "done" && claimed !== null && inventory !== null) {
      // Her word is not the success condition: the inventory is.
      if (!wantMet(claimed, inventory))
        this.#remember(`目標還沒達成:背包裡還沒有 ${wantText(claimed)}`);
      else this.#finishGoal({ type: "reached", code: "reported", detail: "她說完成了" });
    } else if (decision.status === "done") {
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
    const now = this.#now();
    let verdict: Verdict | null = null;
    const proposedWant = decision.want ?? impliedWant(decision.action);
    if (decision.action) {
      const g = cur.goal;
      const facts: GoalFacts | null = g
        ? {
            text: g.text,
            locked: goalLocked(g.source),
            pending: g.action === null,
            action: g.action,
            ageMs: now - g.setAt,
            running: g.running,
            survival: g.source.type === "survival",
          }
        : null;
      verdict = judge(cfg, facts, decision.action, decision.goal, trigger.important);
      verdict = this.#holdRepeats(cur, decision.action, verdict, proposedWant, now);
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
    const trace: DirectorTrace = {
      game: cur.game,
      trigger: trigger.text,
      goal: decision.goal,
      action: decision.action ? decision.action.display() : null,
      verdict: verdict ? verdictDebug(verdict) : null,
      commentary: decision.commentary,
      busy: cur.busy,
      observation: firstChars(cur.summary, TRACE_OBSERVATION_CHARS),
      want: proposedWant,
      held: cur.methods.lines(now),
    };
    this.#ctx.publish(customEvent(DECISION_TOPIC, trace as unknown as JsonValue));
    if (!decision.action || !verdict) return null;
    if (verdict.type === "keep") {
      log.debug({ action: decision.action.display(), why: verdict.why }, "kept the current goal");
      return null;
    }
    return this.#actWork(cur, decision.action, verdict, decision.goal, proposedWant, false);
  }

  /**
   * The method guard (§11.2 item 5): a method that failed the same way twice, or a goal for an
   * item that just ran out of attempts, is not started; she is told why and asked once more.
   */
  #holdRepeats(
    s: Session,
    action: ActionCall,
    verdict: Verdict,
    want: Want | null,
    now: number,
  ): Verdict {
    if (verdict.type === "keep" || this.#cfg.instant_actions.includes(action.name)) return verdict;
    const method = methodKey(action.name, action.args);
    const newGoalFor =
      verdict.type === "replace" && want !== null && s.goal?.want?.item !== want.item
        ? normalizeItem(want.item)
        : null;
    const hold =
      s.methods.held(method, now) ??
      (newGoalFor !== null ? s.methods.goalHeld(newGoalFor, now) : null);
    if (hold === null) return verdict;
    const what = hold.method === method ? "這個做法" : "這個目標";
    s.lastAction = `${action.display()} → 暫時不行:${what}一直失敗(${hold.code}:${firstLine(hold.why, 60)}),換別的做法或目標`;
    this.#told(s, `${action.display()} 沒有執行:${what}一直失敗,情況沒變之前不會再試`);
    if (!hold.nudged) {
      hold.nudged = true;
      this.#trigger(`${action.display()} 被暫停了,換個做法或目標`, false);
    }
    return { type: "keep", why: `held: ${hold.method} failed the same way again (${hold.code})` };
  }

  /** Starts `action` as a task through the gate (the background step of a decision). */
  #actWork(
    s: Session,
    action: ActionCall,
    verdict: Verdict,
    goalText: string | null,
    want: Want | null,
    survival: boolean,
  ): Work | null {
    const cfg = this.#cfg;
    const executor = this.#executor(s.game);
    if (!executor) return null;
    const id = newId();
    const budget = budgetFor(executor.info, action.name, cfg.task_budget_secs, cfg.max_goal_secs);
    this.#track(s, id, {
      action,
      method: methodKey(action.name, action.args),
      verdict,
      goalText,
      want,
      survival,
      phase: "starting",
      early: null,
    });
    const generation = s.generation;
    const actuators = this.#actuators;
    return async (signal) => {
      const result = await attempt(() =>
        actThroughGate(
          actuators,
          s,
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
      const why = firstLine(result.error, 80);
      s.lastAction = `${action.display()} → 失敗(${result.code}):${firstLine(result.error, 120)}`;
      log.debug({ action: action.display(), code: result.code }, "game task not started");
      this.#attempt(s, track, "failed", result.code, why);
      if (!instant) {
        s.guard = guardAfter(this.#cfg, why, now) ?? s.guard;
        s.methods.failed(track.method, result.code, why, now);
      }
      const g = s.goal;
      if (verdict.type === "step" && !instant && g) {
        this.#goalAttemptFailed(g, result.code, firstLine(result.error, 60));
        return;
      }
      this.#trigger(`上一個動作失敗了(${result.code})`, false);
      return;
    }
    track.phase = "running";
    s.lastAction = `${action.display()} → 開始了`;
    if (verdict.type === "replace") {
      this.#cancelGoalTask(s);
      const old = s.goal;
      if (track.survival && old !== null && old.source.type !== "survival") {
        // It comes back when the survival goal ends.
        Object.assign(old, { task: null, running: false });
        s.suspended = old;
      } else if (old?.source.type === "queue") {
        s.backlog.unshift({
          item: old.source.item,
          text: old.text,
          requester: old.source.requester,
        });
      }
      const source: GoalSource = track.survival ? { type: "survival" } : { type: "director" };
      const goal = newGoal(track.goalText ?? action.display(), source, now, track.want);
      goal.action = action;
      goal.task = id;
      goal.running = true;
      goal.steps = 1;
      s.goal = goal;
    } else if (verdict.type === "step" && !instant) {
      const g = s.goal;
      if (g) {
        if (g.task !== null && g.task !== id) this.#cancelGoalTask(s);
        g.action = action;
        g.task = id;
        g.running = true;
        g.steps += 1;
        g.want ??= track.want;
      }
    }
    if (track.early !== null) this.#taskEnded(s, track, track.early);
  }
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function firstChars(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
}
