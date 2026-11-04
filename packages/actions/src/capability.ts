// Capabilities: the actions she can take, each registered once with a risk tier, an argument
// schema and an executor. Every caller (her tools, slash commands, the panel, the game
// director) goes through `ActuatorRegistry.invoke`, which runs the gate first.

import type { ReplyFile } from "@miyoria/commands";
import type { ServiceLookup } from "@miyoria/kernel";
import type {
  AccountRef,
  JsonObject,
  JsonValue,
  LaneKey,
  Principal,
  Timestamp,
  TurnId,
} from "@miyoria/types";
import type { z } from "zod";
import type { Limit } from "./config.js";

/**
 * `low`: allowed once the hard rules pass. `medium`: rate limits and cooldowns. `high`: her own
 * separate review call decides (`allow` / `deny` / `uncertain` → ask the owners).
 */
export type Risk = "low" | "medium" | "high";

/** What a person can withdraw for actions directed at them (see `/me privacy`). */
export type ConsentKind = "dm";

/** How a capability is offered to the model as a tool (names: `[A-Za-z0-9_-]`). */
export interface CapabilityTool {
  name: string;
  /** What it does, in her terms (Traditional Chinese). The registry adds the request rule. */
  description: string;
  /** JSON Schema `properties` of the arguments (the registry adds `why` and `on_own`). */
  properties: JsonObject;
  required?: string[];
  /**
   * High risk only: the result matters to her (e.g. program output). The tool waits up to
   * `[modules.actions] inline_wait_ms` for the review and the run; when that is not enough it
   * answers "pending" and the outcome comes back later as a follow-up turn (`agent_initiative`,
   * reason `action_result`). Without it a high-risk tool only says the request is under review.
   */
  followup?: boolean;
}

/** What the owners' approval card shows instead of the raw arguments. */
export interface ApprovalDetail {
  /** Plain lines (escaped by the card). */
  lines: string[];
  /** Attachments, e.g. the program to approve. */
  files?: ReplyFile[];
}

/** What `Capability.denied` gets. */
export interface DeniedContext {
  principal: Principal;
  request: ActionRequest;
  decision: GateDecision;
  services: ServiceLookup;
}

/** What an executor gets besides its arguments. */
export interface ExecContext {
  principal: Principal;
  request: ActionRequest;
  /** The gate's decision that allowed this run (who reviewed it: `decision.reviewer`). */
  decision: GateDecision;
  services: ServiceLookup;
  signal: AbortSignal;
}

/** An executor's result: a short text (for her or the command) and optional details. */
export interface ActionResult {
  text: string;
  data: JsonValue;
}

/**
 * One capability. Function members use method syntax so a `Capability<Args>` can be stored as a
 * `Capability<unknown>`.
 */
export interface Capability<A = unknown> {
  /** Dotted name, e.g. `voice.join` (also the audit action `gate.<name>`). */
  readonly name: string;
  /** One line for reviews, audit and status (Traditional Chinese). */
  readonly summary: string;
  readonly risk: Risk;
  readonly args: z.ZodType<A>;
  /** Permission node a `user` principal (the person asking) needs. */
  readonly permission: string | null;
  /** Offered to the model in reactive turns when set. */
  readonly tool?: CapabilityTool | null;
  /** Consent the `target` can withdraw. */
  readonly consent?: ConsentKind | null;
  /**
   * High risk: what the self-review should know about this capability (what is safe, what to
   * refuse). Shown to the review next to `summary`.
   */
  readonly guidance?: string;
  /** How long a run queued from a turn may wait in its lane (ms). Default 60 000. */
  readonly ttlMs?: number;
  /**
   * Default rate limits (medium / high risk) when `[modules.actions.limits."<name>"]` does not
   * set them; unset fields fall back to the tier defaults.
   */
  readonly limits?: Partial<Limit> | null;
  /** Guild the action happens in, for the cross-guild prohibition. */
  scope?(args: A, principal: Principal): string | null;
  /** Person the action is directed at (consent, strangers). */
  target?(args: A, principal: Principal): AccountRef | null;
  /** Scheduler lane for runs requested from a turn; `null` runs directly. */
  lane?(args: A, principal: Principal): LaneKey | null;
  /** `false`: her mind is not offered this for now (it may also refuse in `check`). */
  available?(): boolean;
  /** Checks against live state after the schema (e.g. the scene exists); returns why not. */
  check?(args: A, principal: Principal): string | null;
  /** The owners' approval card shows this instead of the raw JSON arguments. */
  describe?(args: A): ApprovalDetail;
  execute(args: A, ctx: ExecContext): Promise<ActionResult | string>;
  /**
   * Called after the gate refused a request at the `review` or `escalation` stage (e.g. to keep
   * a proposal for the owners to look at later). Errors are logged, never returned.
   */
  denied?(args: A, ctx: DeniedContext): Promise<void>;
}

export function defineCapability<A>(capability: Capability<A>): Capability<A> {
  return capability;
}

/** A request to run a capability. */
export interface ActionRequest {
  principal: Principal;
  capability: string;
  args: JsonValue;
  /** Why she (or whoever) wants it, for the audit and the review. */
  why: string | null;
  turn: TurnId | null;
  /**
   * Who an autonomous request is about when the capability itself names nobody (e.g. she joins
   * a voice channel because someone is there): their consent and per-person limits apply.
   */
  about?: AccountRef | null;
}

/** Where the gate decided. */
export type GateStage =
  | "unknown"
  | "args"
  | "pause"
  | "prohibition"
  | "consent"
  | "permission"
  | "budget"
  | "risk"
  | "rate"
  | "review"
  | "escalation";

/** One gate decision (audit `detail` and `gate.decision` payload). */
export interface GateDecision {
  id: string;
  at: Timestamp;
  capability: string;
  risk: Risk | null;
  principal: Principal;
  args: JsonValue;
  why: string | null;
  turn: TurnId | null;
  allowed: boolean;
  stage: GateStage;
  reason: string;
  /**
   * Who made the call at the `review` / `escalation` stage: `self` (her own review) or the
   * owner who answered (`discord:<id>`); `null` at other stages and when no owner answered.
   */
  reviewer: string | null;
}

export type ActionOutcome =
  | { status: "done"; decision: GateDecision; result: ActionResult }
  | { status: "denied"; decision: GateDecision }
  | { status: "failed"; decision: GateDecision; error: string; cause: unknown };

const DENIED_TEXT: Readonly<Record<GateStage, string>> = {
  unknown: "這個功能目前無法使用。",
  args: "參數不正確。",
  pause: "她的自主行動已暫停。",
  prohibition: "這個動作被設定禁止。",
  consent: "對方不希望她這樣做。",
  permission: "沒有權限。",
  budget: "今天的額度用完了。",
  risk: "這個動作的風險太高。",
  rate: "太頻繁了，請稍後再試。",
  review: "她審核後決定不這麼做。",
  escalation: "沒有得到擁有者的同意。",
};

/** User-facing (system text) line for a refusal at `stage`. */
export function deniedText(stage: GateStage): string {
  return DENIED_TEXT[stage];
}

/** The gate refused a request (tools turn it into a short answer for her). */
export class ActionDeniedError extends Error {
  override readonly name = "ActionDeniedError";

  constructor(readonly decision: GateDecision) {
    super(`not allowed: ${decision.reason}`);
  }
}

/** A queued run was dropped by the scheduler (expired, cancelled, ...). */
export class ActionDroppedError extends Error {
  override readonly name = "ActionDroppedError";
}

/** An executor's refusal with a user-facing message (e.g. "she is not in a voice channel"). */
export class CapabilityError extends Error {
  override readonly name: string = "CapabilityError";
}
