// What the panel reads or sends that the route table (`@miyoria/contracts/api`) does not own.
// Every shape a route answers with comes from the contract; pages import those from there. What
// is here: the panel's own query arguments (numbers and flags, which the calls turn into the
// wire's text), the bodies of EventLog lines (`LogEvent.body` is any JSON on the route), a few
// narrowings of contract shapes for what the panel reads, and the error body.

import type {
  DriveName as ContractDriveName,
  LogEvent as ContractLogEvent,
  Thought as ContractThought,
  VoiceE2eLatency as ContractVoiceE2eLatency,
  VoiceLatency as ContractVoiceLatency,
  VoiceSession as ContractVoiceSession,
  E2eSegmentName,
  LlmCallKind,
  LlmCallStatus,
  LogEventKind,
  MemoryKind,
  ThoughtIntent,
} from "@miyoria/contracts/api";
import type { ContextKey, PersonId, Timestamp, TurnId } from "@miyoria/contracts/wire";

/**
 * One line of the EventLog. The route says `body` is JSON (`JsonValue`); the panel reads it by
 * narrowing it itself, so it is `unknown` here.
 */
export type LogEvent = Omit<ContractLogEvent, "body"> & { body: unknown };

/**
 * One thought: the list (`GET /api/mind/thoughts`, newest first, without `input` and `reasoning`,
 * with `has_input` and `has_reasoning`) and `GET /api/mind/thoughts/{id}` (with them, for the
 * newest thoughts), in one type.
 */
export type Thought = ContractThought & { has_input?: boolean; has_reasoning?: boolean };

/** The five the state page and the trends show; the other three are on the affect page. */
export type DriveName = Exclude<ContractDriveName, "esteem" | "hunger" | "longing">;

export type ModuleAction = "enable" | "disable" | "restart";

/** Every error response. */
export interface ErrorBody {
  error: string;
}

export interface DecisionsQuery {
  /** Default 50, capped at 1000 by the server. */
  limit?: number;
  context?: ContextKey;
}

/** What a ledger line says earned coins: the first five are the Core's wallet's, the others economy 2.0 added. */
export type EarnReason = "checkin" | "talked" | "voice" | "song" | "her_gift" | "quest" | "play" | "achievement";

export interface PeopleQuery {
  q?: string;
  limit?: number;
  cursor?: string;
}

/** What the panel asks `GET /api/memory` with (numbers and flags; the call turns them into the wire's text). */
export interface MemoryQuery {
  /** Search text; omit to list newest first. */
  q?: string;
  kind?: MemoryKind;
  subject?: PersonId;
  /** Only records created before this time (pagination when listing). */
  before?: Timestamp;
  include_superseded?: boolean;
  limit?: number;
}

/**
 * One voice channel she is in. The server always sends `latency.e2e`; the panel still reads a
 * Core older than the six-segment measurement, which leaves it out.
 */
export type VoiceSession = Omit<ContractVoiceSession, "latency"> & {
  latency: Omit<ContractVoiceLatency, "e2e"> & { e2e?: ContractVoiceE2eLatency };
};

/** `GET /api/voice`. */
export interface VoiceState {
  sessions: VoiceSession[];
}

/**
 * One reply, measured: the payload of a `voice.latency` bus event with `stage: "e2e"`, or what a
 * `voice.latency` line of the EventLog keeps. The panel reads only these fields, so a Core that
 * sends fewer segments still shows.
 */
export interface E2eRecord {
  context: ContextKey;
  turn: TurnId | null;
  utterance: string;
  complete: boolean;
  reason: string | null;
  total_ms: number | null;
  segments: Record<E2eSegmentName, number | null>;
  unattributed_ms: number | null;
  prefetched: boolean;
  provider: string | null;
}

export interface LlmCallsQuery {
  purpose?: string;
  model?: string;
  module?: string;
  status?: LlmCallStatus;
  trouble?: boolean;
  thought?: string;
  turn?: string;
  since?: string;
  q?: string;
}

export interface LlmThinkingQuery {
  kind?: LlmCallKind;
  reasoned?: boolean;
  since?: string;
  q?: string;
}

// ---------------------------------------------------------------------------
// The fact layer (`GET /api/facts/*`): the bodies of its lines

/** `body` of a `steer` line: the request (`phase: "request"`) or how it went (`"outcome"`). */
export type SteerBody = SteerRequestBody | SteerOutcomeBody;

export interface SteerRequestBody {
  phase: "request";
  /** The executor's topic prefix. */
  owner: string;
  task: string;
  /** The goal arguments to change. */
  patch: Record<string, unknown>;
  /** Why she steers, in her words. */
  why: string;
  /** The kind of principal that asked (`self`: the main line). */
  by: string;
}

export type SteerOutcome = "applied" | "rejected" | "too_late";

export interface SteerOutcomeBody {
  phase: "outcome";
  task: string;
  steer: string;
  outcome: SteerOutcome;
  detail: string;
}

/** `body` of a `thought` line from the mind (source `mind`). */
export interface MindThoughtBody {
  thought: string;
  changes: string[];
  intents: ThoughtIntent[];
  error: string | null;
}

/** `body` of a `thought` line from the game director (source `game.director`). */
export interface DirectorThoughtBody {
  game: string;
  trigger: string[];
  goal: string | null;
  action: string | null;
  verdict: string | null;
  commentary: string | null;
  busy: boolean | null;
  /** What she saw when she decided (an older Core does not write it). */
  observation?: string;
  /** The goal's success condition: she holds at least `count` of `item`. */
  want?: { item: string; count: number } | null;
  /** Methods and goals on hold at the time, one line each: the ones that failed the same way twice. */
  held?: string[];
}

export type ThoughtBody = MindThoughtBody | DirectorThoughtBody;

/** `GET /api/facts/events` query. */
export interface FactEventsQuery {
  kind?: LogEventKind[];
  /** Comma list on the wire. */
  source?: string[];
  /** One turn's lines and what they caused (a Core before this ignores it). */
  turn?: string;
  since?: Timestamp;
  until?: Timestamp;
  /** Events older than this id (paging newest first). */
  before?: string;
  order?: "asc" | "desc";
  limit?: number;
}
