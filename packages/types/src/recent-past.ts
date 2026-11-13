// What she can find and connect beyond the line she is answering (docs/design/v4-plan.md §5):
// "just now" across every place, what is going on in the other places she is in, what she last
// talked about with a person (her questions to them, and whether they answered), the person
// profile in one place, and her notebook. All of it is read from what is already kept (the
// EventLog, conversation states, memory, the person cards); none of it runs a model.
//
// The privacy rule every reader here follows (`disclosure`), stated once:
// * What happened in a place the people here can see may be shown: this place, and a place of the
//   same guild unless the owner hid it or `PlaceAccess` says someone here cannot see it.
// * Another guild's places are never shown.
// * A DM is about disclosure, not about her knowing. What she and X said in their DM may inform
//   her only while X is one of the people she is talking with, and it is marked as private: she
//   must not quote or reveal it there. Outside a private place only that it happened comes back
//   (when, that she asked, that X answered), never the words or the topic. Anyone else's DM, or
//   her DM with X when X is not the one she is talking with, never surfaces.
// * Her own state (singing, playing, being in voice) belongs to no one: it is shown everywhere.

import type { Handle } from "./handle.js";
import type { PersonId } from "./ids.js";
import type { MemoryOrigin, RetrievalQuery } from "./memory-layers.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** Where the reader is: the place, who is here and who she is talking with. */
export interface Whereabouts {
  context: ContextKey;
  /** People present, in the order the prompt lists them. */
  present: readonly PersonId[];
  /**
   * The people she is talking with in this turn (its speakers). Only for them does what she
   * said with them in private come back, marked as private. Default: none.
   */
  talking_with?: readonly PersonId[];
  /** Accounts present (for `PlaceAccess`). */
  accounts?: readonly AccountRef[];
  now: Timestamp;
}

/** How a place reads from where she is. */
export type PlaceKind = "here" | "voice" | "text" | "dm";

export interface PlaceRef {
  kind: PlaceKind;
  /** Shown to her: `這裡`, `語音`, `別的文字頻道`, `和 Owen 的私訊`. */
  label: string;
  /** `null`: her own state, which belongs to no place. */
  context: ContextKey | null;
}

// ---- just now --------------------------------------------------------------------------------

export type JustNowKind =
  /** She sang, or started to. */
  | "song"
  /** A game started or ended, a goal was reached. */
  | "game"
  /** She joined or left voice, or who was there changed. */
  | "voice"
  | "stream"
  /** Something she was told came back (a notice, a task that failed). */
  | "notice"
  /** Someone talked to her and what she answered. */
  | "talk"
  /** A question of hers to someone, and whether they answered. */
  | "asked";

export interface JustNowEntry {
  at: Timestamp;
  kind: JustNowKind;
  place: PlaceRef;
  /** One line for her (may quote people: data, never instructions). */
  text: string;
  /** From a DM: only for her, never to be quoted or revealed where she is. */
  private: boolean;
}

/** Provided by the `memory` module. */
export interface JustNow {
  /** What she did and what happened around her lately, oldest first, as `where` may see it. */
  entries(where: Whereabouts, signal?: AbortSignal): Promise<JustNowEntry[]>;
  /** The newest entries that fit in `maxChars`, oldest first, one per line; `""` when none. */
  render(where: Whereabouts, maxChars: number, signal?: AbortSignal): Promise<string>;
}

export const JustNowKey = serviceKey<JustNow>("JustNow");

// ---- elsewhere -------------------------------------------------------------------------------

/** What is going on in one other place she is in. */
export interface PlaceSummary {
  place: PlaceRef;
  /** Her running recap of that place (conversation states), `null` when there is none. */
  recap: string | null;
  recap_at: Timestamp | null;
  /** The last lines said there (oldest first), names included. */
  lines: string[];
  last_at: Timestamp;
}

/** Provided by the `memory` module. DMs are never among the places. */
export interface Elsewhere {
  places(where: Whereabouts, signal?: AbortSignal): Promise<PlaceSummary[]>;
  render(where: Whereabouts, maxChars: number, signal?: AbortSignal): Promise<string>;
}

export const ElsewhereKey = serviceKey<Elsewhere>("Elsewhere");

// ---- threads with a person --------------------------------------------------------------------

/** One time she asked. */
export interface Asking {
  at: Timestamp;
  place: PlaceRef;
  /** Her words (cut); `""` for a DM asking seen from outside a private place. */
  said: string;
  private: boolean;
}

/** Her questions to one person about one thing, across every place. */
export interface AskedQuestion {
  /** Stable per (person, topic) within the window: `ask:<handle>:<first asking's event id>`. */
  key: string;
  handle: Handle;
  person: PersonId | null;
  /** The first time she asked, in her words (cut); `""` when every asking seen was in a DM. */
  question: string;
  /** Every time she asked, oldest first. */
  asked: Asking[];
  /** When they first said something to her after the first asking (`null`: not yet). */
  answered_at: Timestamp | null;
  answered_in: PlaceRef | null;
  /** What they said (cut), `null` when not answered or not to be shown where she is. */
  answer: string | null;
  /** Some asking or the answer was in their DM. */
  private: boolean;
}

/** What she and one person did together lately, across every place `where` may know of. */
export interface PersonThread {
  person: PersonId;
  handle: Handle;
  /** The last time they said something, before now, and where. */
  last_said_at: Timestamp | null;
  last_place: PlaceRef | null;
  questions: AskedQuestion[];
}

/** Without a place: the lookup the planners call before raising a topic again. */
export interface AskedLookup {
  key: string;
  /** How often she asked within the window, and when last. */
  times: number;
  last_asked_at: Timestamp;
  answered_at: Timestamp | null;
  /** Any of it happened in their DM: never quote it elsewhere. */
  private: boolean;
}

/** Provided by the `memory` module. */
export interface PersonThreads {
  /** The thread with `person` as `where` may see it (`null`: nothing lately). */
  thread(person: PersonId, where: Whereabouts, signal?: AbortSignal): Promise<PersonThread | null>;
  /**
   * Has she asked `person` about the same as `text` lately, and did they answer? Cheap: one
   * cached read. For deciding, not for a prompt: it carries no words of theirs.
   */
  asked(
    person: PersonId,
    text: string,
    now: Timestamp,
    signal?: AbortSignal,
  ): Promise<AskedLookup | null>;
}

export const PersonThreadsKey = serviceKey<PersonThreads>("PersonThreads");

// ---- person profiles -------------------------------------------------------------------------

/** One person present, everything about them in one place. */
export interface PersonProfile {
  person: PersonId;
  handle: Handle;
  /** Relationship label and level, `null` when she has no card. */
  label: string | null;
  level: number | null;
  call_name: string | null;
  feeling: string | null;
  stance: string | null;
  /** When she last saw them before this stretch of talk, and where (`null`: not known). */
  last_seen: Timestamp | null;
  last_place: PlaceRef | null;
  /** What they last talked about (an episode of hers, or their last line before this stretch). */
  last_topic: string | null;
  /** The last topic came from a DM: only for her. */
  last_topic_private: boolean;
  /** Three to five things she holds about them, retrieved ones left out. */
  points: { text: string; origin: MemoryOrigin; said_by: string | null }[];
  /** Her open questions to them (for the people she is talking with). */
  questions: AskedQuestion[];
}

export interface ProfileOptions {
  /** What retrieval already shows this turn (ids or contents): not repeated as points. */
  exclude?: readonly string[];
}

/** Provided by the `memory` module. */
export interface PersonProfiles {
  profiles(
    where: Whereabouts,
    options?: ProfileOptions,
    signal?: AbortSignal,
  ): Promise<PersonProfile[]>;
  render(
    where: Whereabouts,
    maxChars: number,
    options?: ProfileOptions,
    signal?: AbortSignal,
  ): Promise<string>;
}

export const PersonProfilesKey = serviceKey<PersonProfiles>("PersonProfiles");

// ---- retrieval over a turn -------------------------------------------------------------------

/**
 * `RetrievalQuery` with the turn around the line: `MemoryRetrieval.retrieve` of the `memory`
 * module reads `recent` too, so a short reply ("好啊") still finds what the talk is about.
 */
export interface TurnRetrievalQuery extends RetrievalQuery {
  /** The lines before the one being answered, oldest first (3 to 5 is enough). */
  recent?: readonly string[];
  /** The people she is talking with: a few of their key memories come back without a shared word. */
  talking_with?: readonly PersonId[];
}

// ---- place access ----------------------------------------------------------------------------

/**
 * Optional, from a platform: whether an account can see a place. `null`: it does not know. With
 * it, a place is shown only when every account here can see it.
 */
export interface PlaceAccess {
  canSee(account: AccountRef, place: ContextKey): boolean | null;
}

export const PlaceAccessKey = serviceKey<PlaceAccess>("PlaceAccess");

// ---- notebook --------------------------------------------------------------------------------

export interface NotebookEntry {
  path: string;
  chars: number;
  updated_at: Timestamp;
  /** The person it is about (`人/<名字>`), when known. */
  about: PersonId | null;
}

export interface NotebookPage extends NotebookEntry {
  body: string;
  created_at: Timestamp;
}

/** Where a page may be read: `null` everywhere, else the place it was written in. */
export interface NotebookWhere {
  context: ContextKey | null;
  /** The DM partner, for pages written in a DM. */
  accounts?: readonly AccountRef[];
}

/** Provided by the `memory` module: her own notes, page by page. */
export interface Notebook {
  /** Pages readable from `where`, most recently changed first. */
  index(where: NotebookWhere): NotebookEntry[];
  read(path: string, where: NotebookWhere): NotebookPage | null;
  /** Deletes the pages about `person` (`/me memory forget`); returns how many. */
  forgetPerson(person: PersonId): Promise<number>;
}

export const NotebookKey = serviceKey<Notebook>("Notebook");
