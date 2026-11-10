// Contracts of the voice party games (`@miyoria/party`, docs/design/v4-plan.md §9.1) that other
// modules implement, so neither side depends on the other's package:
//
// * `PartyRewards`: coins for the people who played. The economy provides it when it wants to; a
//   game without it simply ends without rewards.
// * `SongClips`: songs she has a cover of, and a short clip of one played in her voice channel,
//   for the song-guessing game. The singing module provides it; without it that game is off.

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
