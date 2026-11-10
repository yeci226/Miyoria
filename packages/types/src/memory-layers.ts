// The three memory layers of V3 (docs/design/v3-architecture.md §11) as the main line sees them.
//
// * Pinned: persona, rules, open commitments and one line per person present. Always in the
//   prompt, capped, never found by retrieval. `PinnedMemory.pinned` is the reader.
// * Log: the EventLog is the evidence (`log-event.ts`).
// * Derived memory: person facts, experiences and topics, tidied in the background. Each says
//   whether she lived it or was told it (`MemoryOrigin`), carries the events it came from and
//   fades with time. `MemoryRetrieval.retrieve` is the reader.
//
// Neither reader runs an LLM or follows links: both are one pass over indexed rows.

import type { PersonId } from "./ids.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

export const MEMORY_ORIGINS = [
  /** She was there: it happened in front of her, or it is her own words and promises. */
  "experienced",
  /** Someone said so. Read back as what they said, never as something she knows. */
  "told",
  /** Written before origins were recorded. Kept and usable, but not claimed to be either. */
  "unknown",
] as const;

export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

export function isMemoryOrigin(value: unknown): value is MemoryOrigin {
  return typeof value === "string" && (MEMORY_ORIGINS as readonly string[]).includes(value);
}

// ---- pinned ---------------------------------------------------------------------------------

/** Where the reader is: who is here and what the turn is about. */
export interface PinnedContext {
  context: ContextKey;
  /** People present, in the order the prompt lists them. */
  present: readonly PersonId[];
  /** Accounts present (a DM's memories are only shown for the accounts in it). */
  accounts?: readonly AccountRef[];
  now: Timestamp;
}

/** The kinds of pinned section, in the order they are placed. */
export const PINNED_KEYS = ["persona", "rules", "commitments", "people"] as const;

export type PinnedKey = (typeof PINNED_KEYS)[number];

export interface PinnedSection {
  key: PinnedKey;
  /** Heading for the prompt. */
  title: string;
  /** One entry per line, already trimmed to the section's cap. */
  lines: string[];
  /** Something was cut to stay within the cap. */
  truncated: boolean;
}

export interface Pinned {
  /** Only the sections that have lines. */
  sections: PinnedSection[];
  /** Characters over every line. Never more than the configured cap. */
  chars: number;
  /** The total cap was hit and the least important lines were left out. */
  truncated: boolean;
}

/**
 * Whoever owns persona or rules plugs it in here (the memory module cannot read them). The
 * lines are cut to the section's cap by the reader, so a source need not count characters.
 */
export interface PinnedSource {
  /** `persona` or `rules`: the sections memory does not write itself. */
  key: Extract<PinnedKey, "persona" | "rules">;
  lines(context: PinnedContext): readonly string[] | Promise<readonly string[]>;
}

/** Provided by the `memory` module. */
export interface PinnedMemory {
  /** Never throws and never waits for an LLM: a failing store gives the sources' lines only. */
  pinned(context: PinnedContext): Promise<Pinned>;
  /** Replaces the source of that key. Returns the function that removes it. */
  addSource(source: PinnedSource): () => void;
}

export const PinnedMemoryKey = serviceKey<PinnedMemory>("PinnedMemory");

// ---- retrieval ------------------------------------------------------------------------------

export type RetrievedKind = "episode" | "fact" | "self_note";

export interface RetrievalQuery {
  context: ContextKey;
  present: readonly PersonId[];
  accounts?: readonly AccountRef[];
  /** What is being talked about. */
  text: string;
  /** Default: the configured `recall_limit`. */
  limit?: number;
  now: Timestamp;
}

/** One memory as the prompt should read it. */
export interface RetrievedMemory {
  id: string;
  kind: RetrievedKind;
  origin: MemoryOrigin;
  content: string;
  /** Who told her (`origin: "told"`). */
  said_by: string | null;
  /** EventLog ids the memory came from. Empty for origin `unknown`. */
  source_events: string[];
  created_at: Timestamp;
  /** Final score, decay included. */
  score: number;
  /** `confidence` after decay and the origin's weight, 0..1. */
  confidence: number;
}

/** Provided by the `memory` module. */
export interface MemoryRetrieval {
  /** Hybrid score of one pass over the visible scopes. Records returned are touched. */
  retrieve(query: RetrievalQuery, signal?: AbortSignal): Promise<RetrievedMemory[]>;
  /** The memories as prompt lines: what she lived plainly, what she was told as what was said. */
  format(memories: readonly RetrievedMemory[], now: Timestamp): string;
}

export const MemoryRetrievalKey = serviceKey<MemoryRetrieval>("MemoryRetrieval");

// ---- notes about a person -------------------------------------------------------------------

/**
 * Provided by the `memory` module: something she lived with one person, kept like any episode
 * (recalled when they are present, faded and merged by the usual upkeep).
 */
export interface PersonNoteWriter {
  /** `false` when nothing was stored (no store, or the note was refused). */
  note(
    person: PersonId,
    content: string,
    options: { importance: number; at: Timestamp },
  ): Promise<boolean>;
}

export const PersonNoteWriterKey = serviceKey<PersonNoteWriter>("PersonNoteWriter");
