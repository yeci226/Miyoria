// The karaoke room on the stream (docs/design/karaoke.md §7.1, 「做了什麼第五步」): what of it shows
// for a scene, and the words on it. Pure (no DOM); src/karaoke-view.ts draws it.
//
// - No room (or `show=` without `karaoke`): nothing; the overlay is as it always was.
// - `lobby`: one compact corner plate (the room code to join with, the song, who is in).
// - `countdown`, `singing`, `results`: the full scene (the song, the lyrics over the round's video,
//   the live board, then the final ranking), and the page's own pieces make room for it.

import type { WorkersKaraokeLyricsV2 } from "@miyoria/contracts/workers";
import type { KaraokeLine, KaraokeLyrics, KaraokeMember, KaraokeScene } from "./feed.js";

export type KaraokeMode = "none" | "lobby" | "stage";

/** What of the room shows: `on` is whether this page shows the karaoke section at all. */
export function karaokeMode(scene: KaraokeScene | null, on: boolean): KaraokeMode {
  if (!on || scene === null) return "none";
  return scene.state === "lobby" ? "lobby" : "stage";
}

/** Whole seconds left before the round starts (a song time below 0), or `null`. */
export function countdownLeft(positionMs: number | null): number | null {
  if (positionMs === null || positionMs >= 0) return null;
  return Math.ceil(-positionMs / 1000);
}

/** How far the song is, 0..1 (0 without a length or before it starts). */
export function songProgress(positionMs: number | null, durationMs: number | null): number {
  if (positionMs === null || durationMs === null || durationMs <= 0) return 0;
  return Math.min(Math.max(positionMs / durationMs, 0), 1);
}

/** `1:05` (a time below 0 is 0:00). */
export function clockText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A score with one decimal; `—` before there is one. */
export function scoreText(total: number | null): string {
  return total === null ? "—" : total.toFixed(1);
}

/** `+15 魚幣`. */
export function coinsText(coins: number, currency: string): string {
  return currency === "" ? `+${coins}` : `+${coins} ${currency}`;
}

/** What the stream plays of the round (this scene's own sound), or `null` when nothing. */
export function airText(air: Pick<KaraokeScene["air"], "backing" | "relay">): string | null {
  const parts = [air.backing ? "伴奏" : null, air.relay === null ? null : `${air.relay} 的歌聲`].filter(
    (p): p is string => p !== null,
  );
  return parts.length === 0 ? null : `直播播出:${parts.join("、")}`;
}

/**
 * A member's colour (0..7): the panel's five category colours in order, then the first three again
 * drawn hollow, so eight stay apart by shape as well as colour.
 */
export function memberSwatch(color: number): { slot: number; hollow: boolean } {
  const n = ((Math.trunc(color) % 8) + 8) % 8;
  return { slot: (n % 5) + 1, hollow: n >= 5 };
}

/** The lobby plate's people: the singers first, each group in the order they came. */
export function lobbyMembers(members: readonly KaraokeMember[]): KaraokeMember[] {
  return [...members.filter((m) => m.role === "singer"), ...members.filter((m) => m.role === "spectator")];
}

/** What a member's row says beside the name. */
export function memberTag(m: KaraokeMember): string {
  if (m.role === "spectator") return m.opener ? "房主 · 看" : "看";
  return m.opener ? "房主 · 唱" : "唱";
}

/** The lobby's one line about what it waits for. */
export function lobbyStatus(scene: Pick<KaraokeScene, "members" | "song">): string {
  const singers = scene.members.filter((m) => m.role === "singer");
  if (singers.length === 0) return "等人加入";
  if (scene.song === null) return "等開房的人選歌";
  const ready = singers.filter((m) => m.ready).length;
  if (ready === singers.length) return "都準備好了,等開房的人按開始";
  return `等大家準備好(${ready}/${singers.length})`;
}

/** How many more the room may sing. */
export function roundsLeftText(left: number): string {
  return left > 0 ? `還可以唱 ${left} 首` : "這間房的歌都唱完了";
}

/** The round's words, when they are this round's (they come once per round, on their own). */
export function lyricsFor(scene: KaraokeScene | null, lyrics: KaraokeLyrics | null): KaraokeLyrics | null {
  if (scene === null || lyrics === null) return null;
  return lyrics.room === scene.room && lyrics.round === scene.round ? lyrics : null;
}

/** Whether a round's lyrics are what the recogniser heard (shown as 「聽寫」). */
export function heard(lyrics: WorkersKaraokeLyricsV2 | null): boolean {
  return lyrics?.source === "heard";
}

/** A singer's key on the board: their colour and name (both stay the same through a round). */
export function lineKey(line: Pick<KaraokeLine, "name" | "color">): string {
  return `${line.color}\u0000${line.name}`;
}

/** One row of the board as drawn. */
export interface BoardRow {
  key: string;
  rank: number | null;
  name: string;
  color: number;
  score: string;
  /** The browser's estimate, not the official score: tagged 「預估」. */
  estimate: boolean;
  /** Since the last board (Core's word): an arrow beside the score. */
  move: "up" | "down" | "same";
  /** Its place changed since the board this page drew last: it slides there and its arrow flashes. */
  moved: boolean;
  winner: boolean;
  coins: number;
  finished: boolean;
  /** Their voice is the one the stream plays now: marked 「播出中」. */
  onAir: boolean;
}

/**
 * The board in rank order (unranked last, in the order they came) with what moved since the last
 * one this page drew (`previous`: key → rank).
 */
export function boardRows(lines: readonly KaraokeLine[], previous: ReadonlyMap<string, number | null>): BoardRow[] {
  const ranked = lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => (a.line.rank ?? Number.MAX_SAFE_INTEGER) - (b.line.rank ?? Number.MAX_SAFE_INTEGER) || a.i - b.i);
  return ranked.map(({ line }) => {
    const key = lineKey(line);
    const before = previous.get(key);
    return {
      key,
      rank: line.rank,
      name: line.name,
      color: line.color,
      score: scoreText(line.total),
      estimate: line.source === "estimate",
      move: line.move,
      moved: before !== undefined && before !== line.rank,
      winner: line.winner,
      coins: line.coins,
      finished: line.finished,
      onAir: line.onAir,
    };
  });
}

/** The ranks of a board, for the next `boardRows`. */
export function boardRanks(rows: readonly Pick<BoardRow, "key" | "rank">[]): Map<string, number | null> {
  return new Map(rows.map((r) => [r.key, r.rank]));
}

/** What a results row says at its end: the coins it won, 「沒唱完」, or nothing. */
export function resultTail(row: Pick<BoardRow, "coins" | "finished">, currency: string): string {
  if (row.coins > 0) return coinsText(row.coins, currency);
  return row.finished ? "" : "沒唱完";
}
