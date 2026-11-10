// ActivityManager (docs/design/v2-architecture.md §3.2): the one owner of "what she is doing
// now". Three small state machines (presence, broadcast, activity) replace the copies in the
// scene director, the game director, game chat, `LiveState`, world and mind.
//
// * Every caller (her tools, commands, the panel, directors) only *requests* transitions
//   (`ActivityManager.request`); requests are idempotent and serialized per resource.
// * Every accepted transition has a task id (`TaskId`, see task.ts) and ends with exactly one
//   `activity.done` / `activity.failed` (with a `TaskFailureCode`). The tool that asked returns
//   at once ("開始了,task 7"); the outcome reaches her conversation later as a `Notice`.
// * Cleanup is part of the machines: a game that disconnects goes to `failed`, and the scene,
//   the prompt and the planner all read that from the same snapshot.
// * The scene is a pure function of the snapshot plus her timed override.
//
// Bus topics (custom events): `ACTIVITY_CHANGED_TOPIC` (the whole `ActivitySnapshot`, on every
// change), `ACTIVITY_STARTED_TOPIC` / `ACTIVITY_DONE_TOPIC` / `ACTIVITY_FAILED_TOPIC`
// (`ActivityTaskEvent`), and `NOTICE_TOPIC` (`Notice`, for her conversation).

import type { Principal } from "./actuator.js";
import type { TurnId } from "./ids.js";
import type { JsonValue } from "./json.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { TaskFailureCode, TaskId } from "./task.js";
import type { Timestamp } from "./time.js";

/** The three resources; each has its own mutex. */
export type ActivityResource = "presence" | "broadcast" | "activity";

export const ACTIVITY_RESOURCES: readonly ActivityResource[] = [
  "presence",
  "broadcast",
  "activity",
];

// ---- states ---------------------------------------------------------------------------------

/**
 * Her presence in voice: `none` → `joining(ch)` → `in(ch)` → `leaving(ch)`. She has one voice
 * account and Discord lets an account be in one voice channel at a time, so there is one
 * presence (not one per guild). `channel` is a voice `ContextKey` (`kind: "voice"`).
 */
export type HerPresence =
  | { type: "none" }
  | { type: "joining"; channel: ContextKey; task: TaskId; since: Timestamp }
  | { type: "in"; channel: ContextKey; since: Timestamp }
  | { type: "leaving"; channel: ContextKey; task: TaskId; since: Timestamp };

/**
 * Her broadcast: `off` → `starting` → `live` → `stopping`. Discord Go Live and OBS streaming
 * are two sub-steps of the one broadcast, not two "streams".
 */
export type HerBroadcast =
  | { type: "off" }
  | {
      type: "starting" | "live" | "stopping";
      /** The guild whose voice channel she goes live in. */
      guild: string;
      /** Discord Go Live is up. */
      golive: boolean;
      /** OBS is streaming. */
      obs: boolean;
      /** The transition in flight (`null` while steadily `live`). */
      task: TaskId | null;
      since: Timestamp;
    };

/** What she is busy with. `idle` has no phase. */
export type ActivityType = "idle" | "chatting" | "singing" | "game" | "browse";

export const ACTIVITY_TYPES: readonly ActivityType[] = [
  "idle",
  "chatting",
  "singing",
  "game",
  "browse",
];

export type ActivityPhase = "starting" | "running" | "stopping" | "failed";

/** Why an activity (or another transition) failed. */
export interface ActivityFailure {
  code: TaskFailureCode;
  /** Short neutral detail (`"OBS 沒開"`); may be shown to her. */
  detail: string;
  at: Timestamp;
}

/**
 * `chatting` (no target), `singing(song)`, `game(minecraft)`, `browse(threads)`; each with a
 * phase. `failed` stays until the next request (or `failed_hold_ms`) so everything sees why.
 */
export type HerActivity =
  | { type: "idle"; since: Timestamp }
  | {
      type: Exclude<ActivityType, "idle">;
      /** The song id, game id (`minecraft`) or site (`threads`); `null` for `chatting`. */
      target: string | null;
      phase: ActivityPhase;
      /** The transition in flight, or the one that failed. */
      task: TaskId | null;
      /** Set in phase `failed`. */
      failure: ActivityFailure | null;
      since: Timestamp;
    };

/** Her timed scene override (`stage.scene` is an override with a duration, not a fight). */
export interface SceneOverride {
  scene: string;
  until: Timestamp;
  /** `principalActor` of who set it. */
  by: string;
}

/** The whole body state. `version` increases by one on every change. */
export interface ActivitySnapshot {
  version: number;
  at: Timestamp;
  presence: HerPresence;
  broadcast: HerBroadcast;
  activity: HerActivity;
  override: SceneOverride | null;
  /** The scene `f(presence, broadcast, activity, override)` picks; `null`: no OBS / no rule. */
  scene: string | null;
}

// ---- requests -------------------------------------------------------------------------------

/**
 * A transition request. `ensure_*` / `start` are idempotent: asking for the state she is
 * already in (or heading to) returns `already` with the task in flight.
 */
export type ActivityRequest =
  /** Be in voice in `guild`: `channel`, else the channel `follow` is in. */
  | {
      type: "ensure_voice";
      platform: string;
      guild: string;
      channel: string | null;
      follow: AccountRef | null;
    }
  /** Leave voice (stops the broadcast first). */
  | { type: "leave_voice" }
  /** Be live in `guild` (joins voice first when needed; Go Live, then OBS). */
  | { type: "ensure_live"; platform: string; guild: string; source: string | null }
  /** End the broadcast (curtain, OBS, then Go Live). */
  | { type: "stop_live" }
  /** Start an activity (stops the current one first). */
  | {
      type: "start";
      activity: Exclude<ActivityType, "idle">;
      target: string | null;
      /** First goal for game / browse activities (`null`: none). */
      goal: string | null;
    }
  /** Stop the current activity (`activity`: only if it is that one). */
  | { type: "stop"; activity: Exclude<ActivityType, "idle"> | null }
  /** Show `scene` for `duration_ms` regardless of the rule. */
  | { type: "scene_override"; scene: string; duration_ms: number }
  /** Drop her scene override. */
  | { type: "clear_override" };

export type ActivityRequestType = ActivityRequest["type"];

/** The resource a request locks. */
export function requestResource(request: ActivityRequest): ActivityResource {
  switch (request.type) {
    case "ensure_voice":
    case "leave_voice":
      return "presence";
    case "ensure_live":
    case "stop_live":
    case "scene_override":
    case "clear_override":
      return "broadcast";
    case "start":
    case "stop":
      return "activity";
  }
}

/** A request with who asks and where to report the outcome. */
export interface ActivityTransition {
  request: ActivityRequest;
  /** Who asks (gate principal: her, a user, a command, the panel, a director). */
  principal: Principal;
  /** Her turn that asked (the outcome comes back to it as a notice); `null`: none. */
  turn: TurnId | null;
  /** Where the notice goes (`null`: no notice, e.g. panel requests). */
  context: ContextKey | null;
  /** Why, in her words or the caller's (for the ledger). */
  why: string;
}

/**
 * What `request` answers at once. `started`: a new task runs, its outcome follows as events;
 * `already`: nothing to do (`task`: the one already heading there, if any); `queued`: waits
 * behind the resource's mutex; `refused`: not accepted (nothing will happen).
 */
export type TransitionResult =
  | { status: "started"; task: TaskId; resource: ActivityResource }
  | { status: "already"; task: TaskId | null; resource: ActivityResource }
  | { status: "queued"; task: TaskId; resource: ActivityResource }
  | {
      status: "refused";
      resource: ActivityResource;
      code: TaskFailureCode;
      detail: string;
    };

/** One transition task, as the manager tracks it. */
export interface ActivityTask {
  id: TaskId;
  resource: ActivityResource;
  request: ActivityRequest;
  /** `principalActor` of who asked. */
  by: string;
  turn: TurnId | null;
  context: ContextKey | null;
  status: "queued" | "running" | "done" | "failed";
  created_at: Timestamp;
  ended_at: Timestamp | null;
  /** Set when `failed`. */
  failure: ActivityFailure | null;
  /** Short neutral result when `done`. */
  detail: string | null;
}

// ---- events ---------------------------------------------------------------------------------

/** Payload: the whole `ActivitySnapshot`, published on every change. */
export const ACTIVITY_CHANGED_TOPIC = "activity.changed";
/** Payload: `ActivityTaskEvent` (`type: "started"`). */
export const ACTIVITY_STARTED_TOPIC = "activity.started";
/** Payload: `ActivityTaskEvent` (`type: "done"`). */
export const ACTIVITY_DONE_TOPIC = "activity.done";
/** Payload: `ActivityTaskEvent` (`type: "failed"`). */
export const ACTIVITY_FAILED_TOPIC = "activity.failed";

/** Lifecycle of one transition task (the `TaskEvent` shape plus what it was about). */
export type ActivityTaskEvent =
  | {
      type: "started";
      task: TaskId;
      resource: ActivityResource;
      request: ActivityRequest;
      turn: TurnId | null;
      at: Timestamp;
    }
  | {
      type: "done";
      task: TaskId;
      resource: ActivityResource;
      request: ActivityRequest;
      turn: TurnId | null;
      detail: string;
      data: JsonValue;
      at: Timestamp;
    }
  | {
      type: "failed";
      task: TaskId;
      resource: ActivityResource;
      request: ActivityRequest;
      turn: TurnId | null;
      code: TaskFailureCode;
      detail: string;
      at: Timestamp;
    };

// ---- notices --------------------------------------------------------------------------------

/** Payload: `Notice`. The agent consumes it; the ledger records it. */
export const NOTICE_TOPIC = "agent.notice";

/**
 * Something that happened that she should know about in a conversation, which is *not*
 * something someone said (AIRI's `notice`): "Minecraft 開好了", "開台失敗:OBS 沒開". The agent
 * shows it in her trusted self-state (it is her own state), never as a user message, and may
 * start a turn for it (through the Arbiter once it exists, `ImpulseSource` `notice`).
 */
export interface Notice {
  id: string;
  at: Timestamp;
  /** The module that reports it (`activity`, `actions`, `game`). */
  source: string;
  /** The task it reports on, if any. */
  task: TaskId | null;
  /** Her turn that asked for it (`null`: nobody waits for it). */
  turn: TurnId | null;
  /** Where to tell her (`null`: wherever she is talking next). */
  context: ContextKey | null;
  ok: boolean;
  /** Set when `ok` is false. */
  code: TaskFailureCode | null;
  /** What happened, short zh-TW for her (may contain untrusted names). */
  text: string;
  /** It no longer matters after this (dropped unshown). */
  expires_at: Timestamp;
}

// ---- service --------------------------------------------------------------------------------

/** Provided by the `activity` module. Reads answer from memory. */
export interface ActivityManager {
  snapshot(): ActivitySnapshot;
  /**
   * Requests a transition. Resolves as soon as it is accepted or refused (never waits for the
   * work); `signal` aborts the request while it is still queued, and the task if it runs.
   */
  request(transition: ActivityTransition, signal?: AbortSignal): Promise<TransitionResult>;
  /** Cancels a queued or running task (`failed` / `cancelled` follows); `false`: unknown or over. */
  cancel(task: TaskId, reason: string): boolean;
  /** A task still remembered (running or recently ended). */
  task(id: TaskId): ActivityTask | null;
  /** Recent tasks, newest first. */
  tasks(limit?: number): ActivityTask[];
}

export const ActivityManagerKey = serviceKey<ActivityManager>("ActivityManager");

// ---- after a restart ------------------------------------------------------------------------

/** A game session the last run left open, as far as the log can tell. */
export interface RestoredGame {
  game: string;
  /** Display name. */
  name: string;
  context: ContextKey | null;
  /** When the session started. */
  since: Timestamp;
}

/** Provided by the `facts` module: what the last run left behind (v3 §5). */
export interface ActivityRecovery {
  /** The session to pick up, read once when the core starts; `null`: nothing was running. */
  game(): RestoredGame | null;
}

export const ActivityRecoveryKey = serviceKey<ActivityRecovery>("ActivityRecovery");

/**
 * Provided by the `game` module: picks a session back up without starting anything. `waiting`:
 * the game cannot be reached (yet); `resumed`: a session runs now, whether it is this call's or
 * not.
 */
export interface GameResume {
  resume(restored: RestoredGame, signal?: AbortSignal): Promise<"resumed" | "waiting">;
}

export const GameResumeKey = serviceKey<GameResume>("GameResume");

/** Payload: `ActivityRestore`, once a session the last run left open is settled. */
export const ACTIVITY_RESTORE_TOPIC = "activity.restore";

/**
 * `resumed`: it was still there and runs again. `gone`: it did not come back in time. `dropped`:
 * something else was asked for meanwhile.
 */
export interface ActivityRestore {
  game: string;
  outcome: "resumed" | "gone" | "dropped";
}

/** She is in a voice channel (not joining or leaving). */
export function inVoice(snapshot: ActivitySnapshot): ContextKey | null {
  return snapshot.presence.type === "in" ? snapshot.presence.channel : null;
}

/** She is live or getting there (what the old `LiveState.live()` answered). */
export function isLive(snapshot: ActivitySnapshot): boolean {
  return snapshot.broadcast.type === "starting" || snapshot.broadcast.type === "live";
}

/** The activity running now (`running` phase), else `null`. */
export function runningActivity(
  snapshot: ActivitySnapshot,
): { type: Exclude<ActivityType, "idle">; target: string | null } | null {
  const a = snapshot.activity;
  if (a.type === "idle" || a.phase !== "running") return null;
  return { type: a.type, target: a.target };
}
