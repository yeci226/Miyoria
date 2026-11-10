// Building impulses, and the seam between the Arbiter and whoever opens her turns.
//
// * `newImpulse`: the one way sources build an `Impulse` (arbiter.ts). Speak impulses carry the
//   legacy initiative reason (`song_start`, `game`, `action_result`, ...) in `args.reason`, so
//   the turn she opens reads the same as an `agent_initiative` turn did.
// * `ImpulseHost` (provided by the agent): the Arbiter asks it for the conversation facts its
//   floors need (channel level, whether she is there, when she last spoke) and hands it every
//   accepted `speak` impulse (and her own `act` impulses, which may end in a turn). The host only
//   says whether the context can take the turn right now; every rule is the Arbiter's.

import type { Priority } from "./action.js";
import type {
  ArbiterReason,
  Impulse,
  ImpulseAttention,
  ImpulseKind,
  ImpulseSource,
} from "./arbiter.js";
import { isSelfInitiated } from "./arbiter.js";
import type { Handle } from "./handle.js";
import { newId, type TurnId } from "./ids.js";
import type { JsonObject } from "./json.js";
import type { FloorClaimKind } from "./mainline.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { TaskId } from "./task.js";
import { toTimestamp } from "./time.js";

/** What a source fills in; everything else gets a default. */
export interface ImpulseInput {
  source: ImpulseSource;
  /** Default `speak`. */
  kind?: ImpulseKind;
  context: ContextKey | null;
  person?: Handle | null;
  account?: AccountRef | null;
  capability?: string | null;
  args?: JsonObject;
  /**
   * Default: `request` for songs, notices, followups and game commentary (someone waits for
   * it or it belongs to what is going on), `initiative` for her own wishes and greetings.
   */
  priority?: Priority;
  /** How long it stays meaningful (ms from `now`). */
  ttlMs: number;
  why: string;
  hint?: string | null;
  about?: AccountRef[];
  coalesce_key?: string | null;
  goal?: string | null;
  /**
   * Speak impulses: the initiative reason the turn shows (`args.reason`; default: the source).
   */
  reason?: string;
  /** Narration: what the line is about (`Impulse.attention`). */
  attention?: ImpulseAttention | null;
  /** V3: the row of the claim order (`Impulse.claim`). */
  claim?: FloorClaimKind;
}

/** The default priority of a source. */
export function defaultImpulsePriority(source: ImpulseSource): Priority {
  switch (source) {
    case "message":
      return "direct";
    case "command":
    case "panel":
    case "notice":
    case "followup":
    case "song":
    case "game":
      return "request";
    case "plan":
    case "agenda":
    case "world":
      return "initiative";
  }
}

/** A new impulse created at `now` (epoch ms). */
export function newImpulse(input: ImpulseInput, now: number): Impulse {
  const kind = input.kind ?? "speak";
  const args: JsonObject = { ...(input.args ?? {}) };
  if (kind === "speak" && typeof args.reason !== "string")
    args.reason = input.reason ?? input.source;
  return {
    id: newId(),
    source: input.source,
    kind,
    target: {
      context: input.context,
      person: input.person ?? null,
      account: input.account ?? null,
    },
    capability: input.capability ?? null,
    args,
    priority: input.priority ?? defaultImpulsePriority(input.source),
    expires_at: toTimestamp(now + Math.max(input.ttlMs, 0)),
    why: input.why,
    hint: input.hint ?? null,
    about: [...(input.about ?? [])],
    coalesce_key: input.coalesce_key ?? null,
    goal: input.goal ?? null,
    created_at: toTimestamp(now),
    attention: input.attention ?? null,
    ...(input.claim === undefined ? {} : { claim: input.claim }),
  };
}

/** The initiative reason of a speak impulse (`args.reason`, else its source). */
export function impulseReason(impulse: Impulse): string {
  const reason = impulse.args.reason;
  return typeof reason === "string" && reason !== "" ? reason : impulse.source;
}

/** Which row of the claim order (§7.1) an impulse is. */
export function claimOf(impulse: Impulse): FloorClaimKind {
  if (impulse.claim !== undefined) return impulse.claim;
  switch (impulse.source) {
    case "message":
    case "command":
    case "panel":
      return "addressed";
    case "notice":
    case "song":
      return "result";
    case "followup":
      return impulseReason(impulse) === "followup" ? "wish" : "result";
    case "game":
      return (impulse.attention ?? null) === null ? "urgent" : "notable";
    case "world":
      return "notable";
    case "plan":
    case "agenda":
      return "wish";
  }
}

/**
 * Her own impulse to start talking (a self-initiated `speak`: `chat.start` / `chat.dm`). Only
 * these count toward "主動開話題" (daily caps, gaps, the unanswered backoff); her own `act`
 * impulses (join voice, sing a requested song, go live) respect quiet hours and the gate's
 * per-capability limits, as `chat.start` alone had the counters before.
 */
export function isSelfTalk(impulse: Impulse): boolean {
  return isSelfInitiated(impulse.source) && impulse.kind === "speak";
}

/** What the host knows about a context, for the Arbiter's floors. */
export interface ConversationFacts {
  /**
   * The owner's level of a text channel (`off`, `mention-only`, `quiet`, ...); `null` for voice
   * channels and DMs, which have none.
   */
  mode: string | null;
  /** The level's minimum gap between two conversations she starts there (0: none). */
  start_gap_ms: number;
  /** Voice: she is in that channel (always `true` for text channels and DMs). */
  present: boolean;
  /** When she last said something there (epoch ms), if she did. */
  last_spoke_at: number | null;
  /** Voice: the people in the channel besides her (`null`: not a voice channel, or unknown). */
  humans?: number | null;
}

/**
 * What hosting an accepted impulse did. `started`: her turn is opened or queued (`turn`), or
 * the action ran (`task` / `detail`); `busy`: the context cannot take it right now (a turn in
 * flight, messages waiting, her speech queued), try again later; `refused`: it cannot run
 * there at all (`reason`).
 */
export type ImpulseRun =
  | { status: "started"; turn: TurnId | null; task: TaskId | null; detail: string }
  | { status: "busy"; detail: string }
  | { status: "refused"; reason: ArbiterReason; detail: string };

/** Provided by the agent: opens the turns the Arbiter accepted. */
export interface ImpulseHost {
  /** Conversation facts for `context` (answers from memory). */
  facts(context: ContextKey): ConversationFacts;
  /** Runs an accepted impulse; resolves as soon as the turn is opened, queued or refused. */
  open(impulse: Impulse, signal?: AbortSignal): Promise<ImpulseRun>;
}

export const ImpulseHostKey = serviceKey<ImpulseHost>("ImpulseHost");
