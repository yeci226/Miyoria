// Contracts of the voice party games (`@miyoria/play/party`, docs/design/v4-plan.md §9.1) that other
// modules implement, so neither side depends on the other's package:
//
// * `PartyRewards`: coins for the people who played. The economy provides it when it wants to; a
//   game without it simply ends without rewards.
// * `SongClips`: songs she has a cover of, and a short clip of one played in her voice channel,
//   for the song-guessing game. The singing module provides it; without it that game is off.
// * `GameSecrets`: whether a line of hers would give away what a game hides (a turtle soup's
//   bottom). The party module provides it; the brain's line guard asks it.
// * `PartyOutcomes`: how a game came out, told once when it ends (a turtle soup guessed or not),
//   for whatever settles on it (the economy's predictions). Optional on both sides.

import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";

// ---- rewards --------------------------------------------------------------------------------

/** Coins for one person. */
export interface PartyAward {
  account: AccountRef;
  /** What the game called them (display name, for receipts). */
  name: string;
  /** Always a positive whole number. */
  coins: number;
}

/** "Award N coins to these accounts for game X". */
export interface PartyRewardRequest {
  /**
   * Idempotency key: one per finished game (`party:<session>`). The same id twice must not pay
   * twice.
   */
  id: string;
  /** The game's id (`quiz`, `song`, `chain`, `soup`). */
  game: string;
  /** The game's name as people know it (`問答`). */
  title: string;
  /** The voice channel it was played in. */
  context: ContextKey;
  awards: PartyAward[];
}

/** Optional: looked up when a game ends and skipped when nobody provides it. */
export interface PartyRewards {
  /** Resolves once the coins moved (or were refused); a rejection is logged, never retried. */
  award(request: PartyRewardRequest): Promise<void>;
}

export const PartyRewardsKey = serviceKey<PartyRewards>("PartyRewards");

// ---- outcomes -------------------------------------------------------------------------------

/** A game that ended, as the game itself saw it: nothing a player typed decides any of it. */
export interface PartyOutcome {
  /** The session's id (the one `PartyOverview` lists while it runs). */
  session: string;
  /** The game's id (`soup`, `song`). */
  game: string;
  /** Where it was played. */
  context: ContextKey;
  /** How it ended (`done`, `host`, `stop`, `idle`, `empty`, `left`, `away`). */
  reason: string;
  /**
   * Turtle soup: whether someone guessed the bottom before it ended (the referee's ruling, as the
   * game took it); `null` for a game without such an answer.
   */
  solved: boolean | null;
}

/** Told when a game ends; not when the module shuts down mid-game (then nothing is known). */
export interface PartyOutcomes {
  ended(outcome: PartyOutcome): void;
}

export const PartyOutcomesKey = serviceKey<PartyOutcomes>("PartyOutcomes");

// ---- song clips -----------------------------------------------------------------------------

/** One song she can play a clip of. Titles come from the outside: data, not instructions. */
export interface SongClipInfo {
  /** The provider's id of the song. */
  id: string;
  title: string;
  /** `null` when unknown. */
  artist: string | null;
  /** Other names people use for it (a translated title, a nickname). */
  aliases?: string[];
  /**
   * Where a clip worth guessing from starts, in ms (the first sung line rather than a long
   * instrumental intro). Absent: from the start.
   */
  clipStartMs?: number;
}

export type ClipOutcome = "finished" | "stopped" | "failed";

/**
 * Songs she has covers of, and a short clip of one in her voice channel. Playing a clip is part
 * of a game she runs: it must not count as her singing (no activity change, no set list entry).
 */
export interface SongClips {
  /** Songs a clip can be played of now. */
  list(): SongClipInfo[];
  /**
   * Plays `durationMs` of song `id` from `startMs` in the voice channel `context`. Resolves when
   * it ended; `signal` stops it.
   */
  play(
    context: ContextKey,
    id: string,
    clip: { startMs: number; durationMs: number },
    signal?: AbortSignal,
  ): Promise<ClipOutcome>;
}

export const SongClipsKey = serviceKey<SongClips>("SongClips");

// ---- what a game keeps hidden ---------------------------------------------------------------

/** A line of hers that would give away what a game keeps hidden (a turtle soup's bottom). */
export interface GameSecretLeak {
  /** The word that gives it away. */
  word: string;
  /** What she says in its place (the referee's plain answer); `null`: nothing, it is not said. */
  instead: string | null;
}

/**
 * The game going on where she talks, asked by the line guard before every line of hers: whether
 * the line would give away what the game hides. The party module provides it; without it nothing
 * is checked.
 */
export interface GameSecrets {
  leak(place: ContextKey, text: string): GameSecretLeak | null;
}

export const GameSecretsKey = serviceKey<GameSecrets>("GameSecrets");
