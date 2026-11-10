// Arbiter (docs/design/v2-architecture.md §3.3): the one place that decides "now or not" for
// everything that wants her to speak or act, and the Ledger that tells her what she did and
// which limits apply (so she plans with the rules in view instead of hitting them blind).
//
// Every source sends an `Impulse` (directly through `ArbiterKey`, or as an
// `ARBITER_IMPULSE_TOPIC` custom event for modules that only publish). The Arbiter applies the
// floors (budget, rate, quiet hours, consent, pause), orders / merges / preempts (addressed >
// ongoing conversation > her own wishes), records the result and publishes an
// `ArbiterDecision` (`ARBITER_DECISION_TOPIC`).
//
// Until the Arbiter lands, sources keep publishing `agent_initiative` as today; the Arbiter
// takes those over source by source (see docs/design/v2-implementation.md).

import type { Priority } from "./action.js";
import type { Handle } from "./handle.js";
import type { TurnId } from "./ids.js";
import type { JsonObject } from "./json.js";
import type { FloorClaimKind } from "./mainline.js";
import type { RaisedTopic } from "./mind.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { TaskId } from "./task.js";
import type { Timestamp } from "./time.js";

/**
 * Where an impulse comes from. Only `plan` and `agenda` are her own initiative (they count
 * toward "主動開話題" and the unanswered streak); songs, game commentary, followups and notices
 * never do.
 */
export const IMPULSE_SOURCES = [
  /** A message / utterance that addressed her or that she may join (the agent). */
  "message",
  /** Her Plan call decided it (was: mind intents). */
  "plan",
  /** A Goal's trigger fired. */
  "agenda",
  /** A memory followup came due, or a high-risk action's result came back. */
  "followup",
  /** An activity / task outcome she should hear about (`Notice`). */
  "notice",
  /** Game commentary (the game director). */
  "game",
  /** A song announcement or song request (sing). */
  "song",
  /** A greeting or reaction to a world change (someone came online / joined voice). */
  "world",
  /** A slash command. */
  "command",
  /** The admin panel / API. */
  "panel",
] as const;

export type ImpulseSource = (typeof IMPULSE_SOURCES)[number];

/** Sources that are her own initiative. */
export const SELF_INITIATED_SOURCES: readonly ImpulseSource[] = ["plan", "agenda"];

/** True when the source counts as her starting something on her own. */
export function isSelfInitiated(source: ImpulseSource): boolean {
  return SELF_INITIATED_SOURCES.includes(source);
}

/** `speak`: open a turn (talk); `act`: run a capability (through the gate / ActivityManager). */
export type ImpulseKind = "speak" | "act";

/**
 * What a line nobody asked for is about, so the Arbiter can stop her saying it twice (a stop-gap
 * for v3 §6 `attention_key` / `revision`). The key names the thing, not the words, so a rewording
 * has the same key. The source decides what a new revision is: `repeat_after_ms` after it was
 * said, a new occurrence counts as one.
 */
export interface ImpulseAttention {
  /** Stable content key, e.g. `game:craft:stone_pickaxe`. */
  key: string;
  repeat_after_ms: number;
  /** The revision of the thing (§6), when an observation says it. V2 goes by the time alone. */
  revision?: number;
}

/** Who / where an impulse is aimed at. */
export interface ImpulseTarget {
  /** Where she would speak or act (`null`: wherever fits, e.g. a DM is resolved from `person`). */
  context: ContextKey | null;
  /** The person it is directed at or about. */
  person: Handle | null;
  /** That person's account when known (consent and per-person limits apply to it). */
  account: AccountRef | null;
}

export interface Impulse {
  /** ULID. */
  id: string;
  source: ImpulseSource;
  kind: ImpulseKind;
  target: ImpulseTarget;
  /** `act`: the capability (`game.start`); `speak`: `null` (or `chat.start` / `chat.dm`). */
  capability: string | null;
  /** `act`: the capability arguments. */
  args: JsonObject;
  /** Reuses the scheduler's priority names: `direct` > `request` > `initiative` > `idle`. */
  priority: Priority;
  /** It no longer makes sense after this (dropped, recorded as `expired`). Mandatory. */
  expires_at: Timestamp;
  /** Why, in her words or the source's (shown in the ledger). */
  why: string;
  /** `speak`: what she might bring up (zh-TW; may quote others, so data). */
  hint: string | null;
  /** Accounts the hint is about. */
  about: AccountRef[];
  /** Impulses with the same key are merged (the newest wins). */
  coalesce_key: string | null;
  /** The Goal it executes, if any. */
  goal: string | null;
  created_at: Timestamp;
  /**
   * Set on narration only. A line someone waits for, or that cannot wait (a death, a result),
   * has none, and nothing limits it as narration.
   */
  attention?: ImpulseAttention | null;
  /** V3: which row of the claim order this is (§7.1). Default: from its source. */
  claim?: FloorClaimKind;
}

/** True once `impulse` is past `expires_at` (`now`: epoch ms). */
export function isImpulseExpired(impulse: Impulse, now: number): boolean {
  const at = Date.parse(impulse.expires_at);
  return Number.isNaN(at) || now >= at;
}

/**
 * `accepted`: it runs now (`turn` / `task` say what started); `merged`: folded into another
 * impulse (`merged_into`); `deferred`: kept, retried at `retry_at`; `rejected`: a floor said no;
 * `preempted`: something more urgent took its place; `expired`: dropped unstarted.
 */
export type ArbiterVerdict =
  | "accepted"
  | "merged"
  | "deferred"
  | "rejected"
  | "preempted"
  | "expired";

/** The floor or rule behind a verdict that is not `accepted`. */
export type ArbiterReason =
  /** LLM budget exhausted. */
  | "budget"
  /** Rate limit (per day / per person / per channel). */
  | "rate"
  /** Gap since her last start here not reached. */
  | "cooldown"
  | "quiet_hours"
  /** The person did not consent (DMs, voice, presence). */
  | "consent"
  /** Autonomy paused by the owner. */
  | "paused"
  /** The channel's level (`off` / `mention-only`). */
  | "ceiling"
  /** Something is already happening there (a turn, her speech, someone talking). */
  | "busy"
  /** Her recent starts went unanswered (backoff, or `max_unanswered`: until someone speaks). */
  | "unanswered"
  /** She already said this and nothing new happened (`Impulse.attention`). */
  | "repeat"
  /** Nobody is there to hear it (it may still work out before it expires). */
  | "nobody"
  /** A more urgent impulse. */
  | "superseded"
  | "expired"
  /** The gate refused the capability. */
  | "denied";

export interface ArbiterDecision {
  impulse: string;
  source: ImpulseSource;
  verdict: ArbiterVerdict;
  /** `null` for `accepted` / `merged`. */
  reason: ArbiterReason | null;
  /** Short zh-TW explanation she can read (`"今天主動開了 5 次,下次 21:40 之後"`). */
  detail: string;
  /** `deferred` (or a rate-limited `rejected`): when it may work. */
  retry_at: Timestamp | null;
  merged_into: string | null;
  /** The turn it opened, if any. */
  turn: TurnId | null;
  /** The task it started, if any. */
  task: TaskId | null;
  at: Timestamp;
}

// ---- ledger ---------------------------------------------------------------------------------

/** What a ledger entry records. */
export type LedgerKind = "impulse" | "turn" | "task" | "notice";

/**
 * `pending`: running / waiting for a reaction; `ok`: done (or someone engaged); `ignored`:
 * nobody picked it up; `failed`: it went wrong; `denied`: refused before it ran.
 */
export type LedgerOutcome = "pending" | "ok" | "ignored" | "failed" | "denied";

/** One thing she did or tried. Written by the Arbiter, the ActivityManager and the agent. */
export interface LedgerEntry {
  id: string;
  at: Timestamp;
  kind: LedgerKind;
  source: ImpulseSource;
  /** Counted as her own initiative (`isSelfInitiated(source)` at the time). */
  self_initiated: boolean;
  context: ContextKey | null;
  person: Handle | null;
  /** What it was, short zh-TW (`"開台"`, `"找 Owen 聊報告"`). */
  summary: string;
  outcome: LedgerOutcome;
  /** Why (the verdict's detail, the task's failure, ...). */
  detail: string | null;
  impulse: string | null;
  turn: TurnId | null;
  task: TaskId | null;
  updated_at: Timestamp;
}

/** The limits that apply to her right now, for her prompts (and the panel). */
export interface LedgerLimits {
  /** Self-initiated starts today (local day) and the daily cap (`null`: no cap). */
  initiatives_today: number;
  initiative_cap: number | null;
  /** Her self-initiated starts in a row that nobody picked up. */
  unanswered_streak: number;
  /** When she may start something on her own again (`null`: now). */
  next_initiative_at: Timestamp | null;
  /** Quiet hours (local hours, start inclusive, end exclusive) and whether they apply now. */
  quiet_hours: { start_hour: number; end_hour: number; active: boolean } | null;
  /** Autonomy paused by the owner. */
  paused: boolean;
  /** Capabilities on hold and why (`game.start`: "Minecraft 沒開"), with when it may work. */
  blocked: { capability: string; reason: string; until: Timestamp | null }[];
  /** `max_unanswered` reached here: she starts nothing until a person speaks. */
  waiting_for_response?: boolean;
}

/** What `Arbiter.ledger` returns. */
export interface LedgerView {
  at: Timestamp;
  /** Newest first, bounded. */
  entries: LedgerEntry[];
  limits: LedgerLimits;
  /** Topics she raised on her own that nobody picked up, newest first. */
  unanswered: RaisedTopic[];
}

/** What other writers (ActivityManager, agent) add to the ledger. */
export interface LedgerRecord {
  kind: LedgerKind;
  source: ImpulseSource;
  context: ContextKey | null;
  person: Handle | null;
  summary: string;
  outcome: LedgerOutcome;
  detail: string | null;
  impulse: string | null;
  turn: TurnId | null;
  task: TaskId | null;
}

// ---- service and topics ---------------------------------------------------------------------

/** Payload: `Impulse`. For sources that only publish; the Arbiter subscribes. */
export const ARBITER_IMPULSE_TOPIC = "arbiter.impulse";
/** Payload: `ArbiterDecision`, for every impulse. */
export const ARBITER_DECISION_TOPIC = "arbiter.decision";
/** Payload: `LedgerEntry`, for every new or updated entry. */
export const LEDGER_TOPIC = "arbiter.ledger";

/** Provided by the `arbiter` module. Reads answer from memory. */
export interface Arbiter {
  /** Decides on `impulse` (and runs it when accepted). */
  submit(impulse: Impulse, signal?: AbortSignal): Promise<ArbiterDecision>;
  /** The ledger as she sees it (`context`: entries there first; `null`: everywhere). */
  ledger(context?: ContextKey | null): LedgerView;
  /** Adds an entry (ActivityManager task outcomes, agent turn outcomes). Returns its id. */
  record(entry: LedgerRecord): string;
  /** Updates the outcome of an entry (a task finished, someone engaged); `false`: unknown id. */
  resolve(id: string, outcome: LedgerOutcome, detail: string | null): boolean;
  /** Why she may not do `capability` on her own right now (`null`: she may). */
  held?(capability: string): string | null;
}

export const ArbiterKey = serviceKey<Arbiter>("Arbiter");
