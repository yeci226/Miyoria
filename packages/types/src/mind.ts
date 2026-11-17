// Her mind (docs/design/autonomy.md §5, docs/design/v5-heart.md §2.6): the `mind` module provides
// `MindKey`, her thought journal. Since phase 4 step 5 it records her `feel` applications and her
// reflections in a line each (`note`); older entries (Plan's thoughts and intents) keep their
// shape. Nothing here thinks on its own any more.

import type { ThoughtData } from "@miyoria/contracts/events";
import type { TurnId } from "./ids.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** The capability of an intent that only means "start talking there". */
export const CHAT_START = "chat.start";
/** The capability of an intent that means "DM this person and talk". */
export const CHAT_DM = "chat.dm";

/** Something she decided to do. */
export interface Intent {
  id: string;
  /** Capability to run (`chat.start` / `chat.dm` to just start talking). */
  capability: string;
  args: JsonObject;
  /** Her reason, in her own words. */
  why: string;
  /** Her idea of how to open (her words; may echo other people). */
  opening: string | null;
  /** Where she acts and talks; the gate's principal context. */
  context: ContextKey | null;
  /** Who it is about or directed at (consent and per-person limits apply to them). */
  about: AccountRef | null;
  created_at: Timestamp;
  /** It no longer makes sense after this; dropped unstarted. */
  expires_at: Timestamp;
}

/**
 * `pending`: not submitted yet; `started`: her turn is queued or running; `done`: the action
 * ran (and her turn, if any, finished); `denied`: the gate refused; `dropped`: expired, busy or
 * interrupted; `failed`: the action failed after the gate allowed it.
 */
export type IntentStatus = "pending" | "started" | "done" | "denied" | "dropped" | "failed";

export interface IntentOutcome {
  status: IntentStatus;
  /** Short detail: the gate's reason, the action's result, why it was dropped. */
  detail: string;
  /** The turn she opened (or that the action ran in), when there is one. */
  turn: TurnId | null;
}

// ---- journal --------------------------------------------------------------------------------

export type ThoughtTriggerKind =
  /** Her periodic heartbeat. */
  | "heartbeat"
  /** A `world.salient` event. */
  | "salient"
  /** A suggestion from another module (initiative). */
  | "suggestion"
  /** One of her turns ended. */
  | "turn"
  /** The voice channel she is in went quiet after a conversation. */
  | "voice_quiet"
  /** Asked for from the panel or a test. */
  | "manual";

export interface ThoughtTrigger {
  kind: ThoughtTriggerKind;
  /** Short neutral description (may contain untrusted names). */
  detail: string;
  context: ContextKey | null;
  at: Timestamp;
}

/** A gate decision made for one of her intents (pre-action or a tool call in her turn). */
export interface ThoughtDecision {
  at: Timestamp;
  capability: string;
  allowed: boolean;
  stage: string;
  reason: string;
}

export interface ThoughtIntent {
  id: string;
  capability: string;
  args: JsonValue;
  why: string;
  opening: string | null;
  context: ContextKey | null;
  about: AccountRef | null;
  expires_at: Timestamp;
  status: IntentStatus;
  detail: string | null;
  turn: TurnId | null;
  decisions: ThoughtDecision[];
  /** What she said in the turn she opened. */
  said: string | null;
  /** Every status it went through, oldest first (newer journals only). */
  history?: { at: Timestamp; status: IntentStatus; detail: string | null }[];
}

/**
 * What one thought saw, as the panel shows it: bounded copies of the prompt's data. Only the
 * newest thoughts of the journal keep it.
 */
export interface ThoughtInput {
  /** Her local time as she was told it. */
  time: string;
  night: boolean;
  self: {
    mood: { valence: number; arousal: number; energy: number } | null;
    boredom: number;
    drives: Record<string, number>;
    initiative: number;
    /** Her emotions (name: intensity) and what showed of them. */
    emotions?: Record<string, number>;
    shown?: string | null;
  } | null;
  suggestions: MindSuggestion[];
  world: string;
  places: { ref: string; label: string; note: string; here: boolean }[];
  people: {
    ref: string;
    name: string;
    person: string | null;
    relation: string | null;
    feeling: string | null;
    doing: string | null;
    heart?: string | null;
  }[];
  agenda: { ref: string; text: string; due: Timestamp | null; blocked: string | null }[];
  memories: string | null;
  documents: string | null;
  lessons: string[];
  recap: string | null;
  digest: string | null;
  unanswered: string[];
  blocked: { capability: string; reason: string }[];
  /** Thoughts in a row that did nothing, and since when (minutes). */
  idle: { thoughts: number; minutes: number } | null;
  /** Capabilities she was offered. */
  capabilities: string[];
  /** Her earlier thoughts she was shown. */
  recent: number;
}

/** What one thought changed, item by item (`changes` says it in words). */
export interface ThoughtEffects {
  drives: Record<string, number>;
  /** Emotion changes (name: change). */
  emotions?: Record<string, number>;
  talkativeness: { scope: string; level: number; minutes: number; why: string }[];
  initiative: { level: number; why: string } | null;
  feelings: { person: string; name: string; note: string | null; hint: "+" | "-" | null }[];
  agenda_added: { text: string; why: string }[];
  agenda_done: string[];
  agenda_dropped: string[];
  documents: { type: string; title: string | null; ok: boolean; error: string | null }[];
}

/**
 * The `body` of a `thought` line of the EventLog that the mind wrote (source `mind`): the
 * journal entry without what she saw (`ThoughtInput`).
 */
export interface MindThoughtBody {
  thought: string;
  changes: string[];
  intents: ThoughtIntent[];
  error: string | null;
}

/**
 * The `body` of a `thought` line of the game director (source `game.director`): one decision
 * about a goal, with what woke it. The `game.director.decision` event carries the same fields.
 */
export interface DirectorThoughtBody {
  game: string;
  /** What woke the director, one line each. */
  trigger: string[];
  goal: string | null;
  /** The action it picked, as the call reads. */
  action: string | null;
  /** `Step`, `Replace` or `Keep("...")`: what the anti-spam rule made of it. */
  verdict: string | null;
  commentary: string | null;
  busy: boolean | null;
}

/** What a `thought` line says; `source` tells which. */
export type ThoughtBody = MindThoughtBody | DirectorThoughtBody;

/** One entry of her thought journal (contract: `ThoughtSchema` in @miyoria/contracts/events). */
export type Thought = ThoughtData;

/** Older journal entries condensed into one record (the journal keeps a bounded number raw). */
export interface ThoughtDigest {
  id: string;
  /** First and last thought it covers. */
  from: Timestamp;
  to: Timestamp;
  /** Thoughts condensed. */
  count: number;
  /** What she was thinking about then (her voice, or a plain summary when no model ran). */
  summary: string;
  /** Intents of those thoughts by `capability:status`. */
  intents: Record<string, number>;
  /** `summarizer` or `rule` (no model available or allowed). */
  by: "summarizer" | "rule";
}

/** A reason to think, offered by another module. */
export interface MindSuggestion {
  /** Module, e.g. `initiative`. */
  source: string;
  /** `idle_channel`, `greeting`, `voice_join`, `followup`, ... */
  reason: string;
  context: ContextKey | null;
  /** What it is about (zh-TW; may quote other people). */
  hint: string;
  about: AccountRef[];
}

/** How her journal is going. */
export interface MindStats {
  /** Her newest journal entry. */
  last_at: Timestamp | null;
  /** Why the module is not looking at her goals right now, if it is not. */
  idle_reason: string | null;
}

/** A line of what went on inside her, for her journal (`Mind.note`). */
export interface MindNote {
  /** `feel`: her `feel` block applied; `reflect`: one of her reflections. */
  kind: "feel" | "reflect";
  /** What she felt or concluded, short (her words; may name people). */
  text: string;
  /** What changed, one line each. */
  changes?: string[];
  context?: ContextKey | null;
}

/**
 * Something she brought up on her own (a self-started line) and what became of it: `waiting`
 * for a response, `engaged` (someone addressed her within the window) or `ignored`.
 */
export interface RaisedTopic {
  /** What she said (her words, short). */
  text: string;
  context: ContextKey | null;
  at: Timestamp;
  status: "waiting" | "engaged" | "ignored";
}

/** Provided by the `mind` module. */
export interface Mind {
  /** Newest first. */
  thoughts(limit?: number): Thought[];
  /** One journal entry, with what it saw while it still keeps that. */
  thought?(id: string): Thought | null;
  /** Digests of older thoughts, newest first. */
  digests?(limit?: number): ThoughtDigest[];
  stats(): MindStats;
  /** Records a line of what went on inside her (optional so test doubles need not). */
  note?(entry: MindNote): void;
}

export const MindKey = serviceKey<Mind>("Mind");
