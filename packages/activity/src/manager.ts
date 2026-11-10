// The ActivityManager (docs/design/v2-architecture.md §3.2): three small state machines —
// presence, broadcast, activity — and the only place that changes them.
//
// * Every caller only *requests* a transition (`request`, or a capability call the gate allowed,
//   `route`). Requests are idempotent against the state she is in or heading to, and serialized
//   per resource: a task holds the mutexes of the resources it touches (in the fixed order
//   presence → broadcast → activity, so two tasks never wait on each other).
// * Every accepted transition is a task with an id that ends with exactly one `activity.done` /
//   `activity.failed` (reason code), a `Notice` for the conversation that asked, and a Ledger
//   entry when the Arbiter runs.
// * The snapshot is derived from what the bus says happened (`Facts`) plus the tasks in flight,
//   so a game that disconnects, a Go Live that dies or a song that starts show up the same way
//   for the scene, the prompt and the planner.
// * Steps run capabilities through a port (`GatePort`): the request's own capability as is (the
//   gate allowed it), implied ones (OBS following Go Live, stopping the broadcast before leaving)
//   through the gate.

import type { ActionResult, ActivityRouter, RoutedCall } from "@miyoria/actions";
import { errorMessage, getLogger, type ServiceLookup, sleep } from "@miyoria/kernel";
import {
  ACTIVITY_CHANGED_TOPIC,
  ACTIVITY_DONE_TOPIC,
  ACTIVITY_FAILED_TOPIC,
  ACTIVITY_RESTORE_TOPIC,
  ACTIVITY_STARTED_TOPIC,
  type ActivityFailure,
  type ActivityManager,
  type ActivityRequest,
  type ActivityResource,
  type ActivityRestore,
  type ActivitySnapshot,
  type ActivityTask,
  type ActivityTransition,
  type ActivityType,
  ArbiterKey,
  type Clock,
  type ContextKey,
  customEvent,
  type Envelope,
  type Event,
  GameResumeKey,
  type HerActivity,
  type HerBroadcast,
  type HerPresence,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  NOTICE_TOPIC,
  type Notice,
  newId,
  type Principal,
  Principals,
  parseTaskEvent,
  parseTaskTopic,
  principalActor,
  type RestoredGame,
  type SceneOverride,
  SceneRuleKey,
  type SteerReceipt,
  type SteerRequest,
  type SteerRoute,
  systemClock,
  type TaskEvent,
  type TaskFailureCode,
  type TaskId,
  type TaskSpec,
  type TaskSteerService,
  type Timestamp,
  type TransitionResult,
  toTimestamp,
  v2Event,
  voiceLane,
} from "@miyoria/types";
import { type ActivityConfig, defaultActivityConfig } from "./config.js";
import { BROWSE_CAPABILITIES, Facts, GATE_DECISION_TOPIC, startedSession } from "./facts.js";
import { type ActivityPort, failureCode, type PrimaryStep, StepError } from "./port.js";
import { SteerDesk } from "./steer.js";
import { answerText, doneText, endedText, failedText, what } from "./texts.js";

const log = getLogger("activity");

/** Resources in lock order. */
const ORDER: readonly ActivityResource[] = ["presence", "broadcast", "activity"];

/** The resources a request locks (presence changes may have to stop the broadcast first). */
export function resourcesOf(request: ActivityRequest): ActivityResource[] {
  switch (request.type) {
    case "ensure_voice":
    case "leave_voice":
    case "ensure_live":
      return ["presence", "broadcast"];
    case "stop_live":
      return ["broadcast"];
    case "start":
    case "stop":
      return ["activity"];
    case "scene_override":
    case "clear_override":
      return [];
  }
}

/** How long a step that only waits for the bus to confirm may wait. */
const CONFIRM_MS = 10_000;

interface Entry {
  record: ActivityTask;
  transition: ActivityTransition;
  resources: ActivityResource[];
  controller: AbortController;
  primary: PrimaryStep | null;
  /** Resolves when the task ended. */
  ended: Promise<void>;
  end: () => void;
  /** What made it fail (the executor's own error when there is one). */
  cause: unknown;
  data: JsonValue;
  /** Display name of the game it started / stopped, for the texts. */
  name: string | null;
  ledger: string | null;
}

interface Phase<T> {
  value: T;
  task: TaskId;
}

type PresencePhase = Phase<{ type: "joining" | "leaving"; channel: ContextKey }>;
type BroadcastPhase = Phase<{ type: "starting" | "stopping"; guild: string }>;
type ActivityPhase = Phase<{
  type: Exclude<ActivityType, "idle">;
  target: string | null;
  phase: "starting" | "stopping";
}>;

interface HeldFailure {
  type: Exclude<ActivityType, "idle">;
  target: string | null;
  task: TaskId | null;
  failure: ActivityFailure;
  until: number;
}

/** A game the last run left open, not seen again yet. */
interface Restoring {
  game: RestoredGame;
  /** Past this it counts as closed. */
  until: number;
  controller: AbortController;
}

interface Waiter {
  check: () => boolean;
  resolve: () => void;
}

/** Where a notice about what the bus did on its own goes (who asked for the thing that broke). */
interface Origin {
  context: ContextKey | null;
  turn: string | null;
}

export interface ActivityServiceOptions {
  port: ActivityPort;
  config?: ActivityConfig;
  clock?: Clock;
  /** Publishes `activity.*` and `agent.notice` (the module publishes on the bus). */
  publish?: (event: Event) => void;
  /** For the Arbiter's ledger (`ArbiterKey`) and the stage's scene rule (`SceneRuleKey`). */
  services?: ServiceLookup | null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function voiceContext(platform: string, guild: string, channel: string | null): ContextKey {
  return { platform, scope: guild, channel: channel ?? "", kind: "voice" };
}

/** Rejects with `signal`'s reason once it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Implied steps run as the one who asked when that is a command or the panel, else as the director. */
function impliedPrincipal(p: Principal): Principal {
  return p.kind === "command" || p.kind === "panel" ? p : Principals.director(p.context);
}

/** OBS did not start streaming (`error`: the last attempt's, null when it just did not). */
function obsFailure(error: unknown): StepError {
  return new StepError(
    error === null ? "precondition" : failureCode(error),
    error === null ? "OBS 沒有開始直播" : `OBS 沒有開始直播:${errorMessage(error)}`,
    { cause: error ?? undefined },
  );
}

export class ActivityService implements ActivityManager, ActivityRouter, TaskSteerService {
  readonly #port: ActivityPort;
  readonly #config: ActivityConfig;
  readonly #clock: Clock;
  readonly #publish: (event: Event) => void;
  readonly #services: ServiceLookup | null;
  readonly facts = new Facts();
  /** Changing a running executor task's goal (v3 §10.6). */
  readonly #steering: SteerDesk;

  /** Queued and running tasks, in submission order. */
  #pending: Entry[] = [];
  /** Ended tasks, newest last. */
  #history: Entry[] = [];
  readonly #tails = new Map<ActivityResource, Promise<void>>();
  #waiters: Waiter[] = [];

  #presencePhase: PresencePhase | null = null;
  #broadcastPhase: BroadcastPhase | null = null;
  #activityPhase: ActivityPhase | null = null;
  #failure: HeldFailure | null = null;
  #restoring: Restoring | null = null;
  #failureTimer: ReturnType<typeof setTimeout> | null = null;
  #chatting = false;
  /** Browsing the web (v4 §8.1), and what. */
  #browse: { target: string | null } | null = null;
  #browseTimer: ReturnType<typeof setTimeout> | null = null;
  #override: SceneOverride | null = null;
  #overrideTimer: ReturnType<typeof setTimeout> | null = null;

  /** Go Live was up in this broadcast (for following its end with OBS). */
  #goliveSeen = false;
  /** OBS already followed (or was asked to follow) this Go Live. */
  #adopted = false;
  #gameOrigin: Origin | null = null;
  #liveOrigin: Origin | null = null;

  #snapshot: ActivitySnapshot;
  #since = new Map<string, Timestamp>();
  #closed = false;

  constructor(options: ActivityServiceOptions) {
    this.#port = options.port;
    this.#config = options.config ?? defaultActivityConfig();
    this.#clock = options.clock ?? systemClock;
    this.#publish = options.publish ?? (() => {});
    this.#services = options.services ?? null;
    this.#steering = new SteerDesk({
      port: this.#port,
      services: this.#services,
      publish: this.#publish,
      now: () => this.#now(),
      timeoutMs: this.#config.steer_timeout_ms,
      managerTask: (id) =>
        this.#pending.concat(this.#history).find((e) => e.record.id === id)?.record.request ?? null,
    });
    this.#snapshot = { ...this.#derive(), version: 0 };
  }

  #now(): number {
    return this.#clock.now();
  }

  // ---- reads ------------------------------------------------------------------------------

  snapshot(): ActivitySnapshot {
    return structuredClone(this.#snapshot);
  }

  task(id: TaskId): ActivityTask | null {
    const entry = this.#find(id);
    return entry ? structuredClone(entry.record) : null;
  }

  tasks(limit = 20): ActivityTask[] {
    return [...this.#history, ...this.#pending]
      .sort((a, b) => Date.parse(b.record.created_at) - Date.parse(a.record.created_at))
      .slice(0, Math.max(limit, 0))
      .map((e) => structuredClone(e.record));
  }

  #find(id: TaskId): Entry | undefined {
    return (
      this.#pending.find((e) => e.record.id === id) ?? this.#history.find((e) => e.record.id === id)
    );
  }

  // ---- requests ---------------------------------------------------------------------------

  async request(transition: ActivityTransition, signal?: AbortSignal): Promise<TransitionResult> {
    return this.submit(transition, signal ?? null, null).result;
  }

  cancel(task: TaskId, reason: string): boolean {
    const entry = this.#pending.find((e) => e.record.id === task);
    if (!entry) return false;
    entry.controller.abort(new StepError("cancelled", reason));
    return true;
  }

  /**
   * Accepts or refuses a transition. `primary`: the capability that asked (already allowed by
   * the gate), run as the task's main step.
   */
  submit(
    transition: ActivityTransition,
    signal: AbortSignal | null,
    primary: PrimaryStep | null,
  ): { result: TransitionResult; entry: Entry | null } {
    const request = transition.request;
    const resources = resourcesOf(request);
    const resource = resources[0] ?? "broadcast";
    if (this.#closed) {
      return {
        result: { status: "refused", resource, code: "cancelled", detail: "正在關閉" },
        entry: null,
      };
    }
    const refused = this.#refusal(request);
    if (refused !== null) {
      return {
        result: { status: "refused", resource, code: refused.code, detail: refused.detail },
        entry: null,
      };
    }
    // "Stop playing" also means: do not pick the old session up.
    if (request.type === "stop" && (request.activity ?? "game") === "game") {
      this.#endRestore("dropped");
    }
    const plan = this.#plan(request);
    if (plan.type === "already") {
      return { result: { status: "already", task: plan.task, resource }, entry: null };
    }
    for (const old of plan.supersede) {
      old.controller.abort(new StepError("superseded", `${what(request)}取代了它`));
    }
    const entry = this.#entry(transition, resources, primary);
    const waits = resources.map((r) => this.#tails.get(r) ?? Promise.resolve());
    const busy = resources.some((r) =>
      this.#pending.some((e) => e !== entry && e.resources.includes(r)),
    );
    const all = Promise.all(waits).then(() => undefined);
    const ended = entry.ended;
    for (const r of resources)
      this.#tails.set(
        r,
        all.then(() => ended),
      );
    if (signal) {
      if (signal.aborted) entry.controller.abort(new StepError("cancelled", "要求被取消了"));
      else {
        const onAbort = () => entry.controller.abort(new StepError("cancelled", "要求被取消了"));
        signal.addEventListener("abort", onAbort, { once: true });
        void ended.then(() => signal.removeEventListener("abort", onAbort));
      }
    }
    if (request.type === "scene_override") this.#setOverride(request, transition.principal);
    if (!busy) this.#provisional(entry);
    void this.#run(entry, all);
    const status = busy ? "queued" : "started";
    return { result: { status, task: entry.record.id, resource }, entry };
  }

  #refusal(request: ActivityRequest): { code: TaskFailureCode; detail: string } | null {
    if (request.type === "start") {
      switch (request.activity) {
        // v4 §8.1: browsing is her web reading (`web.search` / `web.read`), not the old Threads
        // extension; it needs the web module and does not take over a game.
        case "browse":
          if (!this.#port.has("web.search")) {
            return { code: "precondition", detail: "網路搜尋沒有啟用,沒辦法逛網路" };
          }
          return this.facts.session === null
            ? null
            : { code: "precondition", detail: "正在玩遊戲,先停掉遊戲再去逛網路" };
        case "singing":
          return { code: "invalid", detail: "唱歌要用點歌,不是在這裡開始" };
        case "game":
          return request.target === null || request.target === ""
            ? { code: "invalid", detail: "沒有說要玩哪個遊戲" }
            : null;
        case "chatting":
          return null;
      }
    }
    if (request.type === "stop" && request.activity === "singing") {
      return { code: "invalid", detail: "停止唱歌要用點歌的停止" };
    }
    if (request.type === "scene_override" && request.scene.trim() === "") {
      return { code: "invalid", detail: "沒有場景名稱" };
    }
    return null;
  }

  /** The last queued / running task on `resource` whose request is one of `types`. */
  #last(resource: ActivityResource, types: ActivityRequest["type"][]): Entry | null {
    for (let i = this.#pending.length - 1; i >= 0; i--) {
      const e = this.#pending[i] as Entry;
      if (
        !e.controller.signal.aborted &&
        e.resources.includes(resource) &&
        types.includes(e.record.request.type)
      ) {
        return e;
      }
    }
    return null;
  }

  /** Idempotency: is there anything to do, and what does the new task replace? */
  #plan(
    request: ActivityRequest,
  ): { type: "already"; task: TaskId | null } | { type: "new"; supersede: Entry[] } {
    const fresh = (supersede: Entry[] = []) => ({ type: "new" as const, supersede });
    const already = (task: TaskId | null) => ({ type: "already" as const, task });
    switch (request.type) {
      case "ensure_voice": {
        const last = this.#last("presence", ["ensure_voice", "leave_voice", "ensure_live"]);
        if (last) {
          const r = last.record.request;
          if (r.type === "ensure_voice" && r.guild === request.guild) {
            if (request.channel === null || r.channel === request.channel)
              return already(last.record.id);
          }
          if (r.type === "ensure_live" && r.guild === request.guild && request.channel === null) {
            return already(last.record.id);
          }
          return fresh();
        }
        const here = this.facts.voice.get(request.guild);
        if (here && (request.channel === null || here.channel === request.channel))
          return already(null);
        return fresh();
      }
      case "leave_voice": {
        const last = this.#last("presence", ["ensure_voice", "leave_voice", "ensure_live"]);
        if (last?.record.request.type === "leave_voice") return already(last.record.id);
        const joining = this.#pending.filter(
          (e) =>
            !e.controller.signal.aborted &&
            (e.record.request.type === "ensure_voice" || e.record.request.type === "ensure_live"),
        );
        if (joining.length === 0 && this.facts.voice.size === 0) return already(null);
        return fresh(joining);
      }
      case "ensure_live": {
        const last = this.#last("broadcast", ["ensure_live", "stop_live", "leave_voice"]);
        if (last) {
          const r = last.record.request;
          if (r.type === "ensure_live" && r.guild === request.guild) return already(last.record.id);
          return fresh();
        }
        if (this.facts.golive.get(request.guild)?.state === "live" && this.#obsSatisfied()) {
          return already(null);
        }
        return fresh();
      }
      case "stop_live": {
        const last = this.#last("broadcast", ["ensure_live", "stop_live", "leave_voice"]);
        if (last?.record.request.type === "stop_live") return already(last.record.id);
        const starting = this.#pending.filter(
          (e) => !e.controller.signal.aborted && e.record.request.type === "ensure_live",
        );
        if (starting.length === 0 && !this.#broadcasting()) return already(null);
        return fresh(starting);
      }
      case "start": {
        const last = this.#last("activity", ["start", "stop"]);
        if (last) {
          const r = last.record.request;
          if (
            r.type === "start" &&
            r.activity === request.activity &&
            r.target === request.target
          ) {
            return already(last.record.id);
          }
          return fresh();
        }
        if (request.activity === "game" && this.facts.session?.game === request.target) {
          return already(null);
        }
        if (request.activity === "game" && this.#restoring?.game.game === request.target) {
          return already(null);
        }
        if (request.activity === "chatting" && this.#chatting) return already(null);
        if (request.activity === "browse" && this.#browse?.target === request.target) {
          return already(null);
        }
        return fresh();
      }
      case "stop": {
        const last = this.#last("activity", ["start", "stop"]);
        if (last?.record.request.type === "stop") return already(last.record.id);
        const starting = this.#pending.filter(
          (e) =>
            !e.controller.signal.aborted &&
            e.record.request.type === "start" &&
            (request.activity === null || e.record.request.activity === request.activity),
        );
        const current = this.#runningActivity();
        const matches =
          current !== null && (request.activity === null || request.activity === current);
        if (starting.length === 0 && !matches) return already(null);
        return fresh(starting);
      }
      case "scene_override":
        return fresh();
      case "clear_override":
        return this.#override === null ? already(null) : fresh();
    }
  }

  /** The activity running per the facts (game session, browsing, chatting). */
  #runningActivity(): Exclude<ActivityType, "idle"> | null {
    if (this.facts.session) return "game";
    if (this.#browse) return "browse";
    if (this.#chatting) return "chatting";
    return null;
  }

  // ---- browsing ---------------------------------------------------------------------------

  /**
   * She is browsing `target` (a search, a site) as of now: it shows until `browse_idle_ms` after
   * her last search or page, or until she stops it or starts something else.
   */
  #browsing(target: string | null): void {
    this.#browse = { target: target ?? this.#browse?.target ?? null };
    if (this.#browseTimer !== null) clearTimeout(this.#browseTimer);
    this.#browseTimer = setTimeout(() => {
      this.#browseTimer = null;
      this.#endBrowse();
    }, this.#config.browse_idle_ms);
    this.#browseTimer.unref?.();
    this.#changed();
  }

  #endBrowse(): void {
    if (this.#browseTimer !== null) clearTimeout(this.#browseTimer);
    this.#browseTimer = null;
    if (this.#browse === null) return;
    this.#browse = null;
    this.#changed();
  }

  /** A `gate.decision`: her own web call the gate allowed means she is browsing. */
  #decision(payload: JsonValue): void {
    if (!isJsonObject(payload) || payload.allowed !== true) return;
    const capability = typeof payload.capability === "string" ? payload.capability : "";
    if (!BROWSE_CAPABILITIES.includes(capability)) return;
    // What she looks up for someone, or in the middle of a game or a song, is not her browsing.
    const principal = isJsonObject(payload.principal) ? payload.principal : null;
    if (principal?.kind !== "self") return;
    if (this.facts.session !== null || this.facts.song !== null) return;
    const args = isJsonObject(payload.args) ? payload.args : {};
    let target: string | null = null;
    if (typeof args.query === "string" && args.query.trim() !== "") {
      target = [...args.query.trim()].slice(0, 60).join("");
    } else if (typeof args.url === "string") {
      try {
        target = new URL(args.url).hostname;
      } catch {
        target = null;
      }
    }
    this.#browsing(target);
  }

  /** Her broadcast is up: Go Live, or OBS (unless OBS streams to the hub on its own). */
  #broadcasting(): boolean {
    if (this.#config.obs_hub) return this.facts.liveGuild() !== null;
    return this.facts.liveGuild() !== null || this.facts.stage.streaming;
  }

  /** Ending the broadcast stops OBS too (not with `obs_hub`: the website owns OBS streaming). */
  #obsEndsWithLive(): boolean {
    return !this.#config.obs_hub && this.facts.stage.streaming && this.#port.has("stage.stream");
  }

  /** OBS is streaming, or it is not part of the broadcast. */
  #obsSatisfied(): boolean {
    if (!this.#obsWanted()) return true;
    return this.facts.stage.streaming;
  }

  /** OBS is a sub-step of the broadcast (configured, a stage node connected, `stage.stream`). */
  #obsWanted(): boolean {
    return this.#config.obs && this.facts.stage.connected && this.#port.has("stage.stream");
  }

  #entry(
    transition: ActivityTransition,
    resources: ActivityResource[],
    primary: PrimaryStep | null,
  ): Entry {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    const sorted = ORDER.filter((r) => resources.includes(r));
    const entry: Entry = {
      record: {
        id: newId(),
        resource: sorted[0] ?? "broadcast",
        request: structuredClone(transition.request),
        by: principalActor(transition.principal),
        turn: transition.turn,
        context: transition.context,
        status: "queued",
        created_at: toTimestamp(this.#now()),
        ended_at: null,
        failure: null,
        detail: null,
      },
      transition,
      resources: sorted,
      controller: new AbortController(),
      primary,
      ended,
      end,
      cause: null,
      data: null,
      name: null,
      ledger: null,
    };
    this.#pending.push(entry);
    return entry;
  }

  // ---- running tasks ----------------------------------------------------------------------

  async #run(entry: Entry, turn: Promise<void>): Promise<void> {
    const signal = entry.controller.signal;
    try {
      await abortable(turn, signal);
    } catch (error) {
      // Cancelled while queued: it ends now (its place in the queue opens once it is its turn).
      this.#finish(entry, error);
      return;
    }
    entry.record.status = "running";
    this.#provisional(entry);
    this.#emitStarted(entry);
    this.#changed();
    try {
      // A cancelled task ends now even if a step ignores its signal (its late result is
      // ignored; the facts on the bus stay the truth), so the resource is never stuck.
      const detail = await abortable(this.#perform(entry, signal), signal);
      if (signal.aborted) throw signal.reason;
      this.#finish(entry, null, detail);
    } catch (error) {
      this.#finish(entry, signal.aborted ? (signal.reason ?? error) : error);
    }
  }

  #finish(entry: Entry, error: unknown, detail = ""): void {
    if (entry.record.status === "done" || entry.record.status === "failed") return;
    this.#clearPhases(entry.record.id);
    const now = this.#now();
    entry.record.ended_at = toTimestamp(now);
    this.#pending = this.#pending.filter((e) => e !== entry);
    this.#history.push(entry);
    while (this.#history.length > this.#config.task_history) this.#history.shift();
    if (error === null) {
      entry.record.status = "done";
      entry.record.detail = detail;
      log.info(
        { task: entry.record.id, request: entry.record.request.type, detail },
        "activity task done",
      );
    } else {
      const code = failureCode(error);
      const message = errorMessage(error);
      entry.cause = error instanceof StepError && error.cause !== undefined ? error.cause : error;
      entry.record.status = "failed";
      entry.record.failure = { code, detail: message, at: toTimestamp(now) };
      log.info(
        { task: entry.record.id, request: entry.record.request.type, code, detail: message },
        "activity task failed",
      );
      const r = entry.record.request;
      if (
        r.type === "start" &&
        r.activity !== "chatting" &&
        code !== "superseded" &&
        code !== "cancelled"
      ) {
        this.#hold({
          type: r.activity,
          target: r.target,
          task: entry.record.id,
          failure: entry.record.failure,
        });
      }
      if (r.type === "scene_override") this.#setOverride(null, null);
    }
    this.#emitEnded(entry);
    entry.end();
    this.#changed();
  }

  /**
   * The phase a task shows from the moment it is accepted (it refines it while it runs), so
   * everyone reading the snapshot sees "joining" / "starting" at once.
   */
  #provisional(entry: Entry): void {
    const r = entry.record.request;
    const task = entry.record.id;
    switch (r.type) {
      case "ensure_voice":
        if (!this.facts.voice.has(r.guild) || r.channel !== null) {
          this.#presencePhase = {
            value: { type: "joining", channel: voiceContext(r.platform, r.guild, r.channel) },
            task,
          };
        }
        break;
      case "leave_voice": {
        const channel = this.facts.voiceChannel();
        if (channel !== null) this.#presencePhase = { value: { type: "leaving", channel }, task };
        break;
      }
      case "ensure_live":
        if (this.facts.golive.get(r.guild)?.state !== "live") {
          this.#broadcastPhase = { value: { type: "starting", guild: r.guild }, task };
        }
        break;
      case "stop_live":
        if (this.#broadcasting()) {
          this.#broadcastPhase = {
            value: { type: "stopping", guild: this.facts.liveGuild() ?? "" },
            task,
          };
        }
        break;
      case "start":
        if (r.activity === "game" && this.facts.session?.game !== r.target) {
          this.#activityPhase = {
            value: { type: "game", target: r.target, phase: "starting" },
            task,
          };
        }
        break;
      case "stop": {
        const session = this.facts.session;
        if (session !== null && (r.activity === null || r.activity === "game")) {
          this.#activityPhase = {
            value: { type: "game", target: session.game, phase: "stopping" },
            task,
          };
        }
        break;
      }
      default:
        break;
    }
    this.#changed();
  }

  #clearPhases(task: TaskId): void {
    if (this.#presencePhase?.task === task) this.#presencePhase = null;
    if (this.#broadcastPhase?.task === task) this.#broadcastPhase = null;
    if (this.#activityPhase?.task === task) this.#activityPhase = null;
  }

  #hold(failure: Omit<HeldFailure, "until">): void {
    const until = this.#now() + this.#config.failed_hold_ms;
    this.#failure = { ...failure, until };
    if (this.#failureTimer !== null) clearTimeout(this.#failureTimer);
    this.#failureTimer = setTimeout(() => {
      this.#failureTimer = null;
      if (this.#failure !== null && this.#failure.until <= this.#now()) {
        this.#failure = null;
        this.#changed();
      }
    }, this.#config.failed_hold_ms);
    this.#failureTimer.unref?.();
  }

  async #perform(entry: Entry, signal: AbortSignal): Promise<string> {
    const request = entry.record.request;
    // A new request makes an old failure history.
    if (request.type === "start" || request.type === "stop") this.#failure = null;
    switch (request.type) {
      case "ensure_voice":
        return this.#ensureVoice(entry, request, signal);
      case "leave_voice":
        return this.#leaveVoice(entry, signal);
      case "ensure_live":
        return this.#ensureLive(entry, request, signal);
      case "stop_live":
        return this.#stopLive(entry, true, signal);
      case "start":
        return this.#start(entry, request, signal);
      case "stop":
        return this.#stop(entry, request, signal);
      case "scene_override":
        if (entry.primary !== null) await this.#step(entry, "stage.scene", {}, true, signal);
        return "";
      case "clear_override":
        this.#setOverride(null, null);
        return "";
    }
  }

  /** Runs one capability step. */
  #step(
    entry: Entry,
    capability: string,
    args: JsonObject,
    primary: boolean,
    signal: AbortSignal,
    queue: { priority: "idle"; lane: string } | null = null,
  ): Promise<ActionResult> {
    const t = entry.transition;
    return this.#port.run({
      capability,
      args,
      principal: primary ? t.principal : impliedPrincipal(t.principal),
      why: t.why,
      turn: t.turn,
      task: entry.record.id,
      signal,
      primary: primary ? entry.primary : null,
      ...(queue ?? {}),
    });
  }

  /** Waits until `check()` holds (`true`) or `ms` passed (`false`). Rejects when aborted. */
  #until(check: () => boolean, ms: number, signal: AbortSignal): Promise<boolean> {
    if (check()) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      const waiter: Waiter = {
        check,
        resolve: () => {
          cleanup();
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(check());
      }, ms);
      const onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #wake(): void {
    for (const w of [...this.#waiters]) if (w.check()) w.resolve();
  }

  // ---- presence ---------------------------------------------------------------------------

  async #ensureVoice(
    entry: Entry,
    request: Extract<ActivityRequest, { type: "ensure_voice" }>,
    signal: AbortSignal,
  ): Promise<string> {
    const here = this.facts.voice.get(request.guild);
    if (here && (request.channel === null || here.channel === request.channel)) {
      return "已經在語音頻道了";
    }
    // In another server's (or another) voice channel: leave it first.
    for (const current of [...this.facts.voice.values()]) {
      if (current.scope !== request.guild || request.channel !== null) {
        await this.#leave(entry, current, false, signal);
      }
    }
    await this.#join(entry, request.platform, request.guild, request.channel, true, signal);
    return "";
  }

  async #join(
    entry: Entry,
    platform: string,
    guild: string,
    channel: string | null,
    primary: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    this.#presencePhase = {
      value: { type: "joining", channel: voiceContext(platform, guild, channel) },
      task: entry.record.id,
    };
    this.#changed();
    const result = await this.#step(entry, "voice.join", { guild, channel }, primary, signal);
    const data = result.data;
    const joined =
      data !== null &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      typeof data.channel === "string"
        ? data.channel
        : channel;
    const confirmed = await this.#until(
      () => this.facts.voice.has(guild),
      Math.min(this.#config.voice_timeout_ms, CONFIRM_MS),
      signal,
    );
    if (!confirmed && joined !== null) {
      // The node answered the join; its `voice.joined` is late. Trust the answer.
      this.facts.voice.set(guild, voiceContext(platform, guild, joined));
    }
  }

  async #leaveVoice(entry: Entry, signal: AbortSignal): Promise<string> {
    const channels = [...this.facts.voice.values()];
    if (channels.length === 0) return "本來就不在語音頻道裡";
    let primary = true;
    for (const channel of channels) {
      await this.#leave(entry, channel, primary, signal);
      primary = false;
    }
    return "";
  }

  /**
   * Leaves `channel`: the broadcast stops first, then (when a turn asked) her speech of that
   * turn finishes, then she leaves behind it in her speech lane.
   */
  async #leave(
    entry: Entry,
    channel: ContextKey,
    primary: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const guild = channel.scope ?? "";
    this.#presencePhase = { value: { type: "leaving", channel }, task: entry.record.id };
    this.#changed();
    if (this.#broadcasting()) await this.#stopLive(entry, false, signal);
    const turn = entry.transition.turn;
    if (turn !== null && this.facts.turnRunning(turn)) {
      await this.#until(() => !this.facts.turnRunning(turn), this.#config.speech_wait_ms, signal);
    }
    await this.#step(entry, "voice.leave", { guild }, primary, signal, {
      priority: "idle",
      lane: voiceLane(channel.platform, guild),
    });
    const left = await this.#until(
      () => !this.facts.voice.has(guild),
      this.#config.voice_timeout_ms,
      signal,
    );
    if (!left) throw new StepError("timeout", "語音節點沒有確認離開");
    this.#presencePhase = null;
  }

  // ---- broadcast --------------------------------------------------------------------------

  async #ensureLive(
    entry: Entry,
    request: Extract<ActivityRequest, { type: "ensure_live" }>,
    signal: AbortSignal,
  ): Promise<string> {
    const guild = request.guild;
    this.#liveOrigin = { context: entry.transition.context, turn: entry.transition.turn };
    for (const current of [...this.facts.voice.values()]) {
      if (current.scope !== guild) await this.#leave(entry, current, false, signal);
    }
    this.#broadcastPhase = { value: { type: "starting", guild }, task: entry.record.id };
    if (!this.facts.voice.has(guild)) {
      this.#presencePhase = {
        value: { type: "joining", channel: voiceContext(request.platform, guild, null) },
        task: entry.record.id,
      };
    }
    this.#adopted = true;
    this.#changed();
    // With the hub the node pulls OBS's stream from it: OBS publishes first.
    const hubNote = this.#config.obs_hub ? await this.#startObsFirst(entry, signal) : "";
    const before = this.facts.goliveLast.get(guild);
    const args: JsonObject = {
      guild,
      ...(request.source !== null ? { source: request.source } : {}),
    };
    await this.#step(entry, "stream.start", args, true, signal);
    const ended = (): "failed" | "stopped" | null => {
      const last = this.facts.goliveLast.get(guild);
      if (last === undefined || last === before) return null;
      return last.state === "failed" || last.state === "stopped" ? last.state : null;
    };
    // The node goes live on the source's first frames, so OBS starts while Go Live is `starting`:
    // waiting for `live` first would wait for itself.
    const note = this.#config.obs_hub ? hubNote : await this.#startObs(entry, guild, ended, signal);
    let outcome: "live" | "failed" | "stopped" | null = null;
    const up = await this.#until(
      () => {
        outcome = this.facts.golive.get(guild)?.state === "live" ? "live" : ended();
        return outcome !== null;
      },
      this.#config.golive_timeout_ms,
      signal,
    );
    if (this.#presencePhase?.task === entry.record.id) this.#presencePhase = null;
    if (!up || outcome !== "live") {
      const last = this.facts.goliveLast.get(guild);
      await this.#rollbackGolive(entry, guild);
      throw up
        ? new StepError(
            "internal",
            `Go Live ${outcome === "failed" ? "失敗" : "停掉了"}:${last?.error ?? last?.reason ?? "沒有說原因"}`,
          )
        : new StepError(
            "timeout",
            `Go Live 等了 ${Math.round(this.#config.golive_timeout_ms / 1000)} 秒還沒開始`,
          );
    }
    this.#goliveSeen = true;
    this.#changed();
    return note;
  }

  /** OBS's half of a broadcast; returns a note for the task, stops short when Go Live `ended`. */
  async #startObs(
    entry: Entry,
    guild: string,
    ended: () => string | null,
    signal: AbortSignal,
  ): Promise<string> {
    if (!this.#config.obs || !this.#port.has("stage.stream")) return "";
    if (!this.facts.stage.connected) return "沒有連上直播機,只有 Go Live";
    if (!this.facts.stage.obs) {
      await this.#rollbackGolive(entry, guild);
      throw new StepError("precondition", "OBS 沒開");
    }
    if (this.facts.stage.streaming) return "";
    const failed = () => ended() !== null;
    await this.#until(failed, this.#config.obs_start_delay_ms, signal);
    const pressed = await this.#pressObs(entry, failed, signal);
    if (pressed.streaming) return "";
    if (failed()) return "";
    await this.#rollbackGolive(entry, guild);
    throw obsFailure(pressed.error);
  }

  /**
   * OBS's half of a broadcast with `obs_hub`, before Go Live: OBS publishes to the hub, then
   * `obs_start_delay_ms` passes so the hub has the stream before the node's ffmpeg pulls it.
   * Nothing to roll back when it fails (Go Live has not started; OBS is the website's).
   */
  async #startObsFirst(entry: Entry, signal: AbortSignal): Promise<string> {
    if (!this.#config.obs || !this.#port.has("stage.stream")) return "";
    if (!this.facts.stage.connected) return "沒有連上直播機,只有 Go Live";
    if (!this.facts.stage.obs) throw new StepError("precondition", "OBS 沒開");
    if (this.facts.stage.streaming) return "";
    const pressed = await this.#pressObs(entry, () => false, signal);
    if (!pressed.streaming) throw obsFailure(pressed.error);
    await this.#until(() => false, this.#config.obs_start_delay_ms, signal);
    return "";
  }

  /**
   * Presses OBS "Start Streaming" up to `obs_attempts` times, until it streams or `failed()`;
   * `error`: the last attempt's (null when OBS answered but did not stream).
   */
  async #pressObs(
    entry: Entry,
    failed: () => boolean,
    signal: AbortSignal,
  ): Promise<{ streaming: boolean; error: unknown }> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.#config.obs_attempts && !failed(); attempt++) {
      try {
        const result = await this.#step(entry, "stage.stream", { action: "start" }, false, signal);
        const data = result.data;
        const streaming =
          (data !== null &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            data.streaming === true) ||
          this.facts.stage.streaming;
        if (streaming) {
          this.facts.stage = { ...this.facts.stage, streaming: true };
          return { streaming: true, error: null };
        }
        lastError = null;
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        if (failureCode(error) === "denied") break;
      }
      log.warn(
        { attempt, err: lastError === null ? null : errorMessage(lastError) },
        "OBS did not start streaming for Go Live",
      );
      if (attempt < this.#config.obs_attempts) {
        await this.#until(failed, Math.max(this.#config.obs_start_delay_ms, 1_000), signal);
      }
    }
    return { streaming: false, error: lastError };
  }

  /** Stops a half-started broadcast again, OBS first (best effort; OBS stays with `obs_hub`). */
  async #rollbackGolive(entry: Entry, guild: string): Promise<void> {
    const signal = new AbortController().signal;
    if (this.#obsEndsWithLive()) {
      try {
        await this.#step(entry, "stage.stream", { action: "stop" }, false, signal);
        this.facts.stage = { ...this.facts.stage, streaming: false };
      } catch (error) {
        log.warn({ err: errorMessage(error) }, "cannot stop OBS after the failed Go Live");
      }
    }
    if (!this.facts.golive.has(guild)) return;
    try {
      await this.#step(entry, "stream.stop", { guild }, false, signal);
    } catch (error) {
      log.warn({ guild, err: errorMessage(error) }, "cannot stop the half-started Go Live");
    }
  }

  /**
   * Curtain and OBS first, then Go Live (`primary`: the request was `stream.stop` itself). With
   * `obs_hub` OBS keeps streaming (to the website): only Go Live ends.
   */
  async #stopLive(entry: Entry, primary: boolean, signal: AbortSignal): Promise<string> {
    const guild = this.facts.liveGuild();
    this.#broadcastPhase = {
      value: { type: "stopping", guild: guild ?? "" },
      task: entry.record.id,
    };
    this.#changed();
    if (this.#obsEndsWithLive()) {
      try {
        // `stage.stream stop` shows the ending scene first (the curtain).
        await this.#step(entry, "stage.stream", { action: "stop" }, false, signal);
        this.facts.stage = { ...this.facts.stage, streaming: false };
      } catch (error) {
        if (signal.aborted) throw error;
        log.warn({ err: errorMessage(error) }, "could not stop OBS for the end of the broadcast");
      }
    }
    if (guild !== null) {
      await this.#step(entry, "stream.stop", { guild }, primary, signal);
      const stopped = await this.#until(
        () => !this.facts.golive.has(guild),
        this.#config.golive_timeout_ms,
        signal,
      );
      if (!stopped) throw new StepError("timeout", "Go Live 沒有確認結束");
    }
    this.#goliveSeen = false;
    this.#adopted = false;
    if (this.#broadcastPhase?.task === entry.record.id) this.#broadcastPhase = null;
    return "";
  }

  // ---- activity ---------------------------------------------------------------------------

  async #start(
    entry: Entry,
    request: Extract<ActivityRequest, { type: "start" }>,
    signal: AbortSignal,
  ): Promise<string> {
    if (request.activity === "chatting") {
      this.#endBrowse();
      this.#chatting = true;
      return "";
    }
    if (request.activity === "browse") {
      this.#browsing(request.target);
      return "";
    }
    this.#endBrowse();
    const target = request.target ?? "";
    if (this.facts.session?.game === target) {
      entry.name = this.facts.session.name;
      return "已經在玩了";
    }
    if (this.facts.session) {
      const old = this.facts.session;
      this.#activityPhase = {
        value: { type: "game", target: old.game, phase: "stopping" },
        task: entry.record.id,
      };
      this.#changed();
      await this.#step(entry, "game.stop", {}, false, signal);
      await this.#until(() => this.facts.session === null, CONFIRM_MS, signal);
    }
    this.#chatting = false;
    this.#activityPhase = {
      value: { type: "game", target, phase: "starting" },
      task: entry.record.id,
    };
    this.#gameOrigin = { context: entry.transition.context, turn: entry.transition.turn };
    this.#changed();
    // The launch may take minutes; it has its own deadline.
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new StepError("timeout", "遊戲開太久了")),
      this.#config.game_timeout_ms,
    );
    timer.unref?.();
    let result: ActionResult;
    try {
      result = await this.#step(
        entry,
        "game.start",
        { game: target, goal: request.goal },
        true,
        AbortSignal.any([signal, deadline.signal]),
      );
    } catch (error) {
      if (deadline.signal.aborted && !signal.aborted) throw deadline.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    // The step ended once the launch task ended `done` and the session started: its result
    // says which, so there is nothing to wait for (the session event confirms it again later).
    const started = startedSession(result.data);
    if (started !== null && started.game === target) {
      this.facts.session = started;
      this.facts.sessionEnd = null;
    }
    entry.name = this.facts.session?.name ?? null;
    entry.data = result.data;
    return result.text;
  }

  async #stop(
    entry: Entry,
    request: Extract<ActivityRequest, { type: "stop" }>,
    signal: AbortSignal,
  ): Promise<string> {
    if (request.activity === "chatting" || (request.activity === null && this.#chatting)) {
      this.#chatting = false;
      if (request.activity === "chatting") return "";
    }
    if (request.activity === "browse" || (request.activity === null && this.#browse !== null)) {
      this.#endBrowse();
      if (request.activity === "browse") return "";
    }
    const session = this.facts.session;
    if (session === null) return "本來就沒有在玩";
    entry.name = session.name;
    this.#activityPhase = {
      value: { type: "game", target: session.game, phase: "stopping" },
      task: entry.record.id,
    };
    this.#changed();
    const result = await this.#step(entry, "game.stop", {}, true, signal);
    await this.#until(() => this.facts.session === null, CONFIRM_MS, signal);
    return result.text;
  }

  // ---- scene override ---------------------------------------------------------------------

  #setOverride(
    request: Extract<ActivityRequest, { type: "scene_override" }> | null,
    by: Principal | null,
  ): void {
    if (this.#overrideTimer !== null) clearTimeout(this.#overrideTimer);
    this.#overrideTimer = null;
    if (request === null || by === null) {
      this.#override = null;
      this.#changed();
      return;
    }
    const duration = Math.max(request.duration_ms, 0);
    this.#override = {
      scene: request.scene,
      until: toTimestamp(this.#now() + duration),
      by: principalActor(by),
    };
    this.#overrideTimer = setTimeout(() => {
      this.#overrideTimer = null;
      this.#override = null;
      this.#changed();
    }, duration);
    this.#overrideTimer.unref?.();
    this.#changed();
  }

  // ---- the bus ----------------------------------------------------------------------------

  /** Feeds one bus event (the module subscribes to `FACT_TOPICS` and the task events). */
  observe(env: Envelope): void {
    if (this.#closed) return;
    if (env.event.type === "custom") {
      const task = parseTaskTopic(env.event.data.topic);
      if (task !== null) {
        const event = parseTaskEvent(env.event.data.payload);
        if (event !== null) this.#steering.observeTask(task.owner, event);
        return;
      }
    }
    if (env.event.type === "custom" && env.event.data.topic === GATE_DECISION_TOPIC) {
      this.#decision(env.event.data.payload);
      return;
    }
    if (!this.facts.apply(env)) return;
    const session = this.facts.session;
    if (session !== null && this.#restoring !== null) {
      this.#endRestore(session.game === this.#restoring.game.game ? "resumed" : "dropped");
    }
    this.#reconcile();
    this.#wake();
    this.#changed();
  }

  // ---- steer ------------------------------------------------------------------------------

  /**
   * Changes the goal of a running executor task and keeps its progress (v3 §10.6; see
   * `steer.ts`). Only the main line may call it.
   */
  steer(request: SteerRequest): Promise<SteerReceipt> {
    return this.#steering.steer(request);
  }

  /** The spec of a task an executor accepted, so a steer keeps its budget and start. */
  track(owner: string, spec: TaskSpec, at?: Timestamp): void {
    this.#steering.track(owner, spec, at);
  }

  /** Makes the tasks of `owner` steerable through `route` (singing). */
  registerRoute(owner: string, route: SteerRoute): () => void {
    return this.#steering.registerRoute(owner, route);
  }

  /** A task event of an executor (tests; the module feeds the bus through `observe`). */
  observeTask(owner: string, event: TaskEvent): void {
    this.#steering.observeTask(owner, event);
  }

  // ---- after a restart --------------------------------------------------------------------

  /**
   * The last run left this game open (v3 §5: a restart must not show it as idle). It shows as
   * `starting`, not `running`, until the game module reached the game and has its session back:
   * nothing has been seen of it in this run yet. If that does not happen within
   * `restore_grace_ms`, it was closed meanwhile and she is idle after all.
   */
  restore(game: RestoredGame): void {
    if (this.#closed || this.#restoring !== null || this.facts.session !== null) return;
    const restoring: Restoring = {
      game,
      until: this.#now() + this.#config.restore_grace_ms,
      controller: new AbortController(),
    };
    this.#restoring = restoring;
    this.#changed();
    void this.#resume(restoring);
  }

  async #resume(restoring: Restoring): Promise<void> {
    const { game, controller } = restoring;
    while (this.#restoring === restoring) {
      if (await this.#reached(restoring)) {
        // The session event follows; until it does this says the same, so nothing flickers.
        if (this.#restoring === restoring) {
          this.facts.session ??= { game: game.game, name: game.name, context: game.context };
          this.#endRestore("resumed");
        }
        return;
      }
      if (this.#restoring !== restoring) return;
      if (this.#now() >= restoring.until) {
        log.info({ game: game.game }, "the game of the last run did not come back");
        this.#endRestore("gone");
        return;
      }
      try {
        await sleep(this.#config.restore_poll_ms, controller.signal);
      } catch {
        return;
      }
    }
  }

  async #reached(restoring: Restoring): Promise<boolean> {
    const resume = this.#services?.get(GameResumeKey);
    if (!resume) return false;
    try {
      const status = await resume.resume(restoring.game, restoring.controller.signal);
      return status === "resumed";
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot resume the game of the last run");
      return false;
    }
  }

  #endRestore(outcome: ActivityRestore["outcome"]): void {
    const restoring = this.#restoring;
    if (restoring === null) return;
    this.#restoring = null;
    restoring.controller.abort();
    const payload: ActivityRestore = { game: restoring.game.game, outcome };
    this.#publish(customEvent(ACTIVITY_RESTORE_TOPIC, { ...payload }));
    this.#changed();
  }

  /** What the outside world did on its own: a game that ended, a Go Live without OBS. */
  #reconcile(): void {
    const end = this.facts.sessionEnd;
    if (end !== null) {
      this.facts.sessionEnd = null;
      const ours = this.#pending.some((e) => e.resources.includes("activity"));
      if (!ours && end.code !== null) this.#gameEnded(end.game, end.name, end.code, end.reason);
    }
    const busy = this.#pending.some((e) => e.resources.includes("broadcast"));
    const guild = this.facts.liveGuild();
    if (guild !== null) {
      this.#goliveSeen = true;
      // Go Live came up without a task (the node's own controls): OBS follows it. With
      // `obs_hub` OBS normally streams already (the node pulls from it): nothing to adopt.
      if (
        !busy &&
        !this.#adopted &&
        this.#obsWanted() &&
        this.facts.stage.obs &&
        !this.facts.stage.streaming
      ) {
        this.#adopted = true;
        const platform = this.facts.voice.get(guild)?.platform ?? "discord";
        this.submit(
          {
            request: { type: "ensure_live", platform, guild, source: null },
            principal: Principals.director(null),
            turn: null,
            context: null,
            why: "Go Live 開了,OBS 跟著開播",
          },
          null,
          null,
        );
      }
    } else if (this.#goliveSeen && !busy) {
      // Go Live ended without a task (failed, the node went away): OBS stops with it (not with
      // `obs_hub`: OBS keeps streaming to the website).
      this.#goliveSeen = false;
      this.#adopted = false;
      if (this.#obsEndsWithLive()) {
        this.submit(
          {
            request: { type: "stop_live" },
            principal: Principals.director(null),
            turn: null,
            context: null,
            why: "Go Live 結束了,OBS 也停止直播",
          },
          null,
          null,
        );
      }
      const last = [...this.facts.goliveLast.values()].at(-1);
      if (last?.state === "failed" && this.#liveOrigin !== null) {
        this.#notice({
          task: null,
          turn: this.#liveOrigin.turn,
          context: this.#liveOrigin.context,
          ok: false,
          code: "internal",
          text: `直播中斷了:${last.error ?? last.reason ?? "Go Live 失敗"}`,
        });
      }
    }
  }

  /** A game session that ended on its own (`disconnected`, the extension crashed). */
  #gameEnded(game: string, name: string, code: TaskFailureCode, reason: string | null): void {
    const now = this.#now();
    const origin = this.#gameOrigin;
    const detail = endedText(name, code, reason);
    const transition: ActivityTransition = {
      request: { type: "stop", activity: "game" },
      principal: Principals.director(origin?.context ?? null),
      turn: origin?.turn ?? null,
      context: origin?.context ?? null,
      why: reason ?? code,
    };
    const entry = this.#entry(transition, ["activity"], null);
    entry.name = name;
    entry.record.status = "running";
    this.#emitStarted(entry);
    const failure: ActivityFailure = { code, detail, at: toTimestamp(now) };
    this.#finish(entry, new StepError(code, detail));
    this.#hold({ type: "game", target: game, task: entry.record.id, failure });
    this.#changed();
  }

  // ---- events -----------------------------------------------------------------------------

  #emitStarted(entry: Entry): void {
    const r = entry.record;
    this.#publish(
      v2Event(ACTIVITY_STARTED_TOPIC, {
        type: "started",
        task: r.id,
        resource: r.resource,
        request: structuredClone(r.request),
        turn: r.turn,
        at: toTimestamp(this.#now()),
      }),
    );
    const arbiter = this.#services?.get(ArbiterKey);
    if (arbiter) {
      try {
        entry.ledger = arbiter.record({
          kind: "task",
          source: sourceOf(entry.transition.principal, r.turn),
          context: r.context,
          person: null,
          summary: what(r.request),
          outcome: "pending",
          detail: null,
          impulse: null,
          turn: r.turn,
          task: r.id,
        });
      } catch (error) {
        log.debug({ err: errorMessage(error) }, "cannot record the task in the ledger");
      }
    }
  }

  #emitEnded(entry: Entry): void {
    const r = entry.record;
    const at = toTimestamp(this.#now());
    const failed = r.failure;
    if (failed === null) {
      this.#publish(
        v2Event(ACTIVITY_DONE_TOPIC, {
          type: "done",
          task: r.id,
          resource: r.resource,
          request: structuredClone(r.request),
          turn: r.turn,
          detail: r.detail ?? "",
          data: entry.data,
          at,
        }),
      );
    } else {
      this.#publish(
        v2Event(ACTIVITY_FAILED_TOPIC, {
          type: "failed",
          task: r.id,
          resource: r.resource,
          request: structuredClone(r.request),
          turn: r.turn,
          code: failed.code,
          detail: failed.detail,
          at,
        }),
      );
    }
    const text =
      failed === null
        ? doneText(r.request, r.detail ?? "", entry.name)
        : r.request.type === "stop" &&
            entry.name !== null &&
            failed.code !== "superseded" &&
            failed.code !== "cancelled" &&
            failed.detail.startsWith(entry.name)
          ? failed.detail
          : failedText(r.request, failed.code, failed.detail, entry.name);
    if (entry.ledger !== null) {
      try {
        this.#services
          ?.get(ArbiterKey)
          ?.resolve(entry.ledger, failed === null ? "ok" : "failed", text);
      } catch (error) {
        log.debug({ err: errorMessage(error) }, "cannot resolve the ledger entry");
      }
    }
    // Who asked waits for it in a conversation; nobody needs to hear that a superseded or
    // cancelled task stopped.
    if (r.context === null) return;
    if (failed !== null && (failed.code === "superseded" || failed.code === "cancelled")) return;
    this.#notice({
      task: r.id,
      turn: r.turn,
      context: r.context,
      ok: failed === null,
      code: failed?.code ?? null,
      text,
    });
  }

  #notice(n: Omit<Notice, "id" | "at" | "source" | "expires_at">): void {
    const now = this.#now();
    this.#publish(
      v2Event(NOTICE_TOPIC, {
        id: newId(),
        at: toTimestamp(now),
        source: "activity",
        ...n,
        expires_at: toTimestamp(now + this.#config.notice_ttl_ms),
      }),
    );
  }

  // ---- the snapshot -----------------------------------------------------------------------

  #stable(key: string, identity: string): Timestamp {
    const k = `${key}:${identity}`;
    const known = this.#since.get(k);
    if (known !== undefined) return known;
    for (const old of [...this.#since.keys()])
      if (old.startsWith(`${key}:`)) this.#since.delete(old);
    const at = toTimestamp(this.#now());
    this.#since.set(k, at);
    return at;
  }

  #derive(): Omit<ActivitySnapshot, "version"> {
    const presence = this.#derivePresence();
    const broadcast = this.#deriveBroadcast();
    const activity = this.#deriveActivity();
    const override = this.#override ? { ...this.#override } : null;
    const at = toTimestamp(this.#now());
    let scene: string | null = override?.scene ?? null;
    const rule = this.#services?.get(SceneRuleKey);
    if (rule) {
      try {
        scene = rule.scene(
          { version: this.#snapshot?.version ?? 0, at, presence, broadcast, activity, override },
          this.#now(),
        );
      } catch (error) {
        log.debug({ err: errorMessage(error) }, "the scene rule failed");
      }
    }
    return { at, presence, broadcast, activity, override, scene };
  }

  #derivePresence(): HerPresence {
    const phase = this.#presencePhase;
    if (phase !== null) {
      const { type, channel } = phase.value;
      const since = this.#stable("presence", `${type}:${channel.scope}:${channel.channel}`);
      return { type, channel: { ...channel }, task: phase.task, since };
    }
    const channel = this.facts.voiceChannel();
    if (channel === null) return { type: "none" };
    const since = this.#stable("presence", `in:${channel.scope}:${channel.channel}`);
    return { type: "in", channel: { ...channel }, since };
  }

  #deriveBroadcast(): HerBroadcast {
    const phase = this.#broadcastPhase;
    const golive = (guild: string) => this.facts.golive.get(guild)?.state === "live";
    const obs = this.facts.stage.streaming;
    if (phase !== null) {
      const { type, guild } = phase.value;
      // Starting and live are one broadcast: `since` is when it began.
      const since = this.#stable(
        "broadcast",
        type === "stopping" ? `stopping:${guild}` : `on:${guild}`,
      );
      return { type, guild, golive: golive(guild), obs, task: phase.task, since };
    }
    const guild = this.facts.liveGuild();
    // With `obs_hub`, OBS streaming without Go Live is the website's, not her broadcast.
    if (guild === null && (!obs || this.#config.obs_hub)) return { type: "off" };
    const g = guild ?? this.facts.voiceChannel()?.scope ?? "";
    const type =
      guild !== null && this.facts.golive.get(guild)?.state === "starting" ? "starting" : "live";
    const since = this.#stable("broadcast", `on:${g}`);
    return { type, guild: g, golive: guild !== null && golive(guild), obs, task: null, since };
  }

  #deriveActivity(): HerActivity {
    const phase = this.#activityPhase;
    if (phase !== null) {
      const { type, target, phase: p } = phase.value;
      const since = this.#stable("activity", `${type}:${target}:${p}`);
      return { type, target, phase: p, task: phase.task, failure: null, since };
    }
    if (this.facts.song !== null) {
      const since = this.#stable("activity", `singing:${this.facts.song}`);
      return {
        type: "singing",
        target: this.facts.song,
        phase: "running",
        task: null,
        failure: null,
        since,
      };
    }
    const failure = this.#failure;
    if (failure !== null && failure.until > this.#now()) {
      const since = this.#stable("activity", `failed:${failure.type}:${failure.task}`);
      return {
        type: failure.type,
        target: failure.target,
        phase: "failed",
        task: failure.task,
        failure: { ...failure.failure },
        since,
      };
    }
    const session = this.facts.session;
    if (session !== null) {
      const since = this.#stable("activity", `game:${session.game}:running`);
      return {
        type: "game",
        target: session.game,
        phase: "running",
        task: null,
        failure: null,
        since,
      };
    }
    const restoring = this.#restoring;
    if (restoring !== null) {
      const target = restoring.game.game;
      const since = this.#stable("activity", `restoring:${target}`);
      return { type: "game", target, phase: "starting", task: null, failure: null, since };
    }
    const browse = this.#browse;
    if (browse !== null) {
      const since = this.#stable("activity", `browse:${browse.target ?? ""}`);
      return {
        type: "browse",
        target: browse.target,
        phase: "running",
        task: null,
        failure: null,
        since,
      };
    }
    if (this.#chatting) {
      const since = this.#stable("activity", "chatting");
      return { type: "chatting", target: null, phase: "running", task: null, failure: null, since };
    }
    return { type: "idle", since: this.#stable("activity", "idle") };
  }

  /** Re-derives the snapshot; publishes `activity.changed` when it changed. */
  #changed(): void {
    const next = this.#derive();
    const prev = this.#snapshot;
    const { at: _a, ...a } = next;
    const { at: _b, version: _v, ...b } = prev;
    if (same(a, b)) return;
    this.#snapshot = { ...next, version: prev.version + 1 };
    this.#publish(v2Event(ACTIVITY_CHANGED_TOPIC, structuredClone(this.#snapshot)));
  }

  // ---- the router -------------------------------------------------------------------------

  /** `ActivityRouter`: a capability call the gate allowed. */
  async route(call: RoutedCall): Promise<ActionResult> {
    const principal = call.request.principal;
    const accepted: { request: ActivityRequest; result: TransitionResult; entry: Entry | null }[] =
      [];
    for (const [i, request] of call.requests.entries()) {
      const { result, entry } = this.submit(
        {
          request,
          principal,
          turn: call.request.turn,
          // Who waits for the answer (commands, the panel, the mind) needs no notice.
          context: call.wait ? null : principal.context,
          why: call.request.why ?? "",
        },
        call.wait ? (call.signal ?? null) : null,
        i === 0 ? (run) => call.execute(run) : null,
      );
      accepted.push({ request, result, entry });
    }
    const first = accepted[0];
    if (!call.wait) {
      if (first?.result.status === "refused")
        throw new StepError(first.result.code, first.result.detail);
      return {
        text: accepted.map((a) => answerText(a.request, a.result)).join("\n"),
        data: accepted.map((a) => a.result) as unknown as JsonValue,
      };
    }
    const texts: string[] = [];
    for (const [i, a] of accepted.entries()) {
      if (a.result.status === "refused") {
        if (i === 0) throw new StepError(a.result.code, a.result.detail);
        texts.push(failedText(a.request, a.result.code, a.result.detail, null));
        continue;
      }
      const entry =
        a.entry ?? (a.result.task !== null ? (this.#find(a.result.task) ?? null) : null);
      if (entry === null) {
        texts.push(`${what(a.request)}:現在已經是這樣了。`);
        continue;
      }
      await (call.signal ? abortable(entry.ended, call.signal) : entry.ended);
      const r = entry.record;
      if (r.status === "failed") {
        if (i === 0) {
          throw entry.cause instanceof Error
            ? entry.cause
            : new StepError(r.failure?.code ?? "internal", r.failure?.detail ?? "failed");
        }
        texts.push(
          failedText(a.request, r.failure?.code ?? "internal", r.failure?.detail ?? "", entry.name),
        );
      } else if (i === 0 && entry.primary !== null && r.detail) {
        texts.push(r.detail);
      } else {
        texts.push(doneText(a.request, r.detail ?? "", entry.name));
      }
    }
    return {
      text: texts.join(""),
      data: accepted.map((a) => a.result) as unknown as JsonValue,
    };
  }

  /** Cancels everything (module stop). */
  close(): void {
    this.#closed = true;
    this.#restoring?.controller.abort();
    this.#restoring = null;
    for (const e of [...this.#pending]) e.controller.abort(new StepError("cancelled", "正在關閉"));
    if (this.#failureTimer !== null) clearTimeout(this.#failureTimer);
    if (this.#overrideTimer !== null) clearTimeout(this.#overrideTimer);
    if (this.#browseTimer !== null) clearTimeout(this.#browseTimer);
    this.#failureTimer = null;
    this.#overrideTimer = null;
    this.#browseTimer = null;
  }
}

/** The ledger source of who asked. */
function sourceOf(principal: Principal, turn: string | null) {
  switch (principal.kind) {
    case "command":
      return "command" as const;
    case "panel":
      return "panel" as const;
    case "director":
      return "game" as const;
    case "user":
      return "message" as const;
    case "self":
      return turn === null ? ("plan" as const) : ("message" as const);
  }
}
