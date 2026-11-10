// The main line of V3 (docs/design/v3-architecture.md §4, §7, §10): the one foreground decider.
//
// * `Pipeline`: which of the two brains runs (`[core] pipeline`). `v2` keeps every old path; one
//   setting rolls back.
// * `TurnOutput`: what one call of the main line produces. What she says and what she does are the
//   same decision (§10), so they come out of the same response.
// * `Floor` (§7): whether she may take the mic now, what her budget is, how hard a claim may
//   interrupt, and when the mic is free again. No model is involved.
// * `Commitment` (§10.2): something she said she would do. Overdue ones return to her context.
// * `Proposal` (§10.5): everything the background may do. It cannot speak or act; the main line
//   sees it the next time it has the floor and decides for itself.
// * `Mouth`: the one way a line reaches the scheduler, and how the scheduler tells a line of the
//   main line from one that went around it.

import type { ImpulseAttention } from "./arbiter.js";
import type { Handle } from "./handle.js";
import type { TurnId } from "./ids.js";
import type { JsonValue } from "./json.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { type ServiceKey, serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

// ---- the switch -----------------------------------------------------------------------------

export const PIPELINES = ["v3", "v2"] as const;

export type Pipeline = (typeof PIPELINES)[number];

/** What `[core] pipeline` means when the config says nothing. */
export const DEFAULT_PIPELINE: Pipeline = "v3";

export function isPipeline(value: unknown): value is Pipeline {
  return typeof value === "string" && (PIPELINES as readonly string[]).includes(value);
}

export const PipelineKey = serviceKey<{ pipeline: Pipeline }>("Pipeline");

/**
 * The pipeline in use. The core always provides it (`DEFAULT_PIPELINE` unless the config says
 * otherwise); only a module wired up by hand, as in a package's own tests, runs without one, and
 * that module then keeps its V2 behaviour.
 */
export function pipelineOf(services: { get<T>(key: ServiceKey<T>): T | undefined }): Pipeline {
  return services.get(PipelineKey)?.pipeline ?? "v2";
}

// ---- one turn of the main line ----------------------------------------------------------------

/** One piece of what she says, in order (§10). */
export interface SaySegment {
  /** The written line: subtitles, chat, history. */
  text: string;
  /** What she says out loud for it, when she is heard in another language. */
  voice: string | null;
  emotion: string | null;
}

/** One action of the output, as the model asked for it. */
export interface ActionCall {
  id: string;
  /** The tool that does it. */
  tool: string;
  /** Raw JSON arguments. */
  args: string;
}

/** A commitment as the model wrote it. */
export interface CommitmentDraft {
  what: string;
  /** The tool or capability that would keep it. */
  capability: string | null;
  /** Seconds from now; `null`: the configured default. */
  due_secs: number | null;
}

/** §10: what she says, does and promises, from one call. */
export interface TurnOutput {
  say: SaySegment[];
  actions: ActionCall[];
  commitments: CommitmentDraft[];
  silence: boolean;
}

/** The `body` of the `decision` event a main-line turn ends with. */
export interface TurnDecision {
  turn: TurnId;
  claim: FloorClaimKind;
  say: number;
  actions: string[];
  commitments: string[];
  silence: boolean;
  /** Why she stayed quiet, when she did (§1: every silence has a reason). */
  why_silent: string | null;
}

/** The `body` of an `action` event of the main line. */
export interface MainActionBody {
  turn: TurnId;
  call: string;
  tool: string;
  args: JsonValue;
}

/** `accepted` is a receipt only: nothing she may call done (§10.1). */
export type ActionState = "accepted" | "done" | "failed";

/** The `body` of a `result` event about an action of the main line. */
export interface MainResultBody {
  turn: TurnId;
  call: string;
  tool: string;
  state: ActionState;
  detail: string;
  /** The task it runs as, when it takes time. */
  task: string | null;
}

// ---- floor ------------------------------------------------------------------------------------

/** §7.1, most urgent first. The order of this list is the claim order. */
export const FLOOR_CLAIMS = [
  /** Someone called her name, @-mentioned her or replied to her. */
  "addressed",
  /** Someone answered what she just said. */
  "reply",
  /** A result someone waits for. */
  "result",
  /** About to die, disconnected: cannot wait. */
  "urgent",
  /** Something notable that was not delivered yet. */
  "notable",
  /** She wants to say something herself (a proposal). */
  "wish",
  /** People talking among themselves. */
  "ambient",
] as const;

export type FloorClaimKind = (typeof FLOOR_CLAIMS)[number];

/** The rank of a claim: 1 is the first row of §7.1. */
export function floorRank(kind: FloorClaimKind): number {
  return FLOOR_CLAIMS.indexOf(kind) + 1;
}

/** Claims that spend her budget. The rest she owes someone, or cannot hold back. */
export function spendsBudget(kind: FloorClaimKind): boolean {
  return kind === "notable" || kind === "wish" || kind === "ambient";
}

/**
 * §7.3. `queue`: waits for her to finish; `wrap_up`: the sentence playing is finished, the rest
 * dropped; `cut_short`: she fades out and answers; `interrupt`: she stops at once.
 */
export const INTERRUPT_LEVELS = ["queue", "wrap_up", "cut_short", "interrupt"] as const;

export type InterruptLevel = (typeof INTERRUPT_LEVELS)[number];

/** A turn that has the mic. */
export interface FloorHold {
  turn: TurnId;
  context: ContextKey;
  kind: FloorClaimKind;
  since: Timestamp;
  /** Generation is over; the hold now only waits for lines to settle. */
  ended: boolean;
  /** Lines not settled yet. */
  lines: number;
}

/** Her talk budget in one place (§7.2), for the prompt and the panel. */
export interface FloorBudget {
  window_mins: number;
  /** Lines of her own that really reached someone inside the window. */
  used: number;
  /** What she may have used inside the window right now. */
  allowed: number;
  human_lines: number;
  /** Turns of her own in a row with no person speaking since. */
  unanswered: number;
  /** `max_unanswered` reached: quiet until someone speaks. */
  waiting_for_response: boolean;
  performing: boolean;
}

/** Provided by the `arbiter` module under `pipeline = "v3"`. Answers from memory. */
export interface Floor {
  /** Takes the mic for `turn`. A context may have more than one: an old line can still be playing. */
  hold(turn: TurnId, context: ContextKey, kind: FloorClaimKind): void;
  /** Generation of `turn` is over. The mic is freed once its lines settled too. */
  turnEnded(turn: TurnId): void;
  /** Frees the mic whatever is still in flight (she left, or the turn was thrown away). */
  release(turn: TurnId, why: string): void;
  /** Every hold on `context` goes (she left the channel). */
  releaseContext(context: ContextKey, why: string): void;
  /** The most urgent hold on `context`. */
  holder(context: ContextKey): FloorHold | null;
  /** How hard a claim of `incoming` may cut into `holder` (`overHer`: a person talks over her). */
  interruptLevel(
    incoming: FloorClaimKind,
    holder: FloorClaimKind,
    overHer?: boolean,
  ): InterruptLevel;
  /** Why a claim may not take the mic in `context` now (`null`: it may). */
  refuses(kind: FloorClaimKind, context: ContextKey, hint?: string | null): string | null;
  budget(context: ContextKey): FloorBudget;
}

export const FloorKey = serviceKey<Floor>("Floor");

// ---- commitments ------------------------------------------------------------------------------

export type CommitmentStatus = "open" | "kept" | "broken";

/** §10.2. */
export interface Commitment {
  id: string;
  what: string;
  /** The tool or capability that keeps it. */
  capability: string | null;
  due: Timestamp;
  status: CommitmentStatus;
  context: ContextKey;
  turn: TurnId | null;
  made_at: Timestamp;
  /** She was reminded of it after it came due. */
  reminded: boolean;
}

/** The `body` of the `decision` event of a new or changed commitment. */
export interface CommitmentBody {
  commitment: Commitment;
}

// ---- proposals --------------------------------------------------------------------------------

/** §10.5, and where it belongs. */
export interface Proposal {
  id: string;
  /** What she wants, in her words. */
  what: string;
  why: string;
  /** What would do it (`chat.start` / `chat.dm` mean talking). */
  capability?: string;
  args?: JsonValue;
  expires: Timestamp;
  /** The background job that wrote it: `plan`, `agenda`, `memory`, `reflect`, `appraise`, ... */
  source: string;
  context: ContextKey | null;
  about: AccountRef | null;
  person: Handle | null;
  /** The goal it serves. */
  goal: string | null;
  /** What it is about, when that has a key: said once, it is not proposed again. */
  attention?: ImpulseAttention | null;
}

/** What a writer fills in. */
export type NewProposal = Omit<Proposal, "id"> & { id?: string };

export type ProposalState = "open" | "taken" | "declined" | "dropped" | "expired";

/** What became of a proposal so far. */
export interface ProposalOutcome {
  id: string;
  state: ProposalState;
  detail: string;
  /** The turn that handled it. */
  turn: TurnId | null;
}

/** The `body` of the `proposal` event a writer leaves. */
export interface ProposalBody {
  proposal: Proposal;
}

/** The `body` of the `result` event that ends a proposal. */
export interface ProposalResultBody {
  proposal: string;
  state: Exclude<ProposalState, "open">;
  detail: string;
  turn: TurnId | null;
}

/** Provided by the agent under `pipeline = "v3"`: the only door the background has. */
export interface ProposalBoard {
  /**
   * Writes `proposal` to the log and asks for the floor for it. Resolves when the Floor said
   * whether the main line takes it up now; it stays on the board until it expires either way.
   */
  propose(proposal: NewProposal, signal?: AbortSignal): Promise<ProposalOutcome>;
  /** What is waiting (`context`: there, or anywhere). */
  open(context?: ContextKey | null): Proposal[];
}

export const ProposalBoardKey = serviceKey<ProposalBoard>("ProposalBoard");

// ---- the mouth --------------------------------------------------------------------------------

/** A line that needs no model: what the owner typed in the panel, a reply she already wrote. */
export interface FixedLine {
  context: ContextKey;
  text: string;
  emotion?: string | null;
  turn?: TurnId | null;
  /** Who it comes from, for the log (`panel`, `game.chat`). */
  source: string;
  /** `text` is the filtered line already (`safeOutgoing`'s `blocked`). */
  blocked?: string | null;
}

/** Provided by the agent under `pipeline = "v3"`. */
export interface Mouth {
  /** Whether `turn` is one of the main line's: what the scheduler checks before it sends a line. */
  owns(turn: TurnId | null): boolean;
  /** Says `line` as the main line. Returns once it is queued. */
  say(line: FixedLine): Promise<void>;
}

export const MouthKey = serviceKey<Mouth>("Mouth");

/** The error of a line the scheduler refused for going around the main line. */
export const NOT_MAIN_LINE = "not the main line";

/** Bus topic: one `MainResultBody`, for whoever follows actions without reading the log. */
export const MAIN_RESULT_TOPIC = "mainline.result";
