// A read-only look at the party games for the admin panel (docs/design/v4-plan.md §9.1).
//
// The `party` module provides it, so the panel can tell "the module is off" (no service) from
// "no games right now" (an empty snapshot) instead of guessing from the event log. It shows who
// plays and the scores, never what the game keeps hidden (an answer, the turtle-soup bottom), and
// the recent results are kept in memory only: a restart starts the list again.

import type { ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";

export interface PartyPlayerView {
  /** Their display name; her own entry is `你`. */
  name: string;
  her: boolean;
  score: number;
  /** In the voice channel now. */
  present: boolean;
  /** Made a move the game took. */
  active: boolean;
}

/** A game going on. */
export interface PartySessionView {
  id: string;
  /** `quiz`, `song`, `chain`, `soup`. */
  game: string;
  title: string;
  /** The voice channel it runs in. */
  context: ContextKey;
  /** `running`: the only state a listed game is in; one that ended moves to `recent`. */
  state: "running";
  /** ISO time it started. */
  started_at: string;
  /** Points become coins at the end. */
  scored: boolean;
  players: PartyPlayerView[];
}

/** A game that ended. */
export interface PartyResultView {
  id: string;
  game: string;
  title: string;
  context: ContextKey;
  /** Why it ended: `done`, `host`, `stop`, `idle`, `empty`, `left`, `away`. */
  reason: string;
  started_at: string;
  ended_at: string;
  scored: boolean;
  /** The final standings, best first. */
  players: PartyPlayerView[];
}

export interface PartySnapshot {
  sessions: PartySessionView[];
  /** Newest first, at most `PARTY_RECENT_MAX`. */
  recent: PartyResultView[];
}

/** Results kept. */
export const PARTY_RECENT_MAX = 20;

/** Provided by the `party` module. */
export interface PartyOverview {
  snapshot(): PartySnapshot;
}

export const PartyOverviewKey = serviceKey<PartyOverview>("PartyOverview");
