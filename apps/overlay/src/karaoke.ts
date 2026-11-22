// The karaoke room on the stream (docs/design/karaoke.md §7.1, 「做了什麼第五步」): what of it shows
// for a scene, and the words on it. Pure (no DOM); src/karaoke-view.ts draws it.
//
// - No room (or `show=` without `karaoke`): nothing; the overlay is as it always was.
// - `lobby`: one corner plate (the room code and the join link's QR code, the next songs, who is in).
// - `countdown`, `singing`: the full scene (the song, the pitch lanes and the lyrics over the
//   round's video, the live board), and the page's own pieces make room for it.
// - settling (`singing` with `settling`): 「結算中…」 and whom it waits for, the board still there.
// - `results`: the final ranking over the whole screen, the parts of every score, the QR code small.

import type { WorkersKaraokeLyricsV2 } from "@miyoria/contracts/workers";
import type {
  KaraokeCheer,
  KaraokeCheerKind,
  KaraokeLine,
  KaraokeLyrics,
  KaraokeMember,
  KaraokeParts,
  KaraokeQueueEntry,
  KaraokeScene,
  KaraokeSettling,
} from "./feed.js";

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
export function lobbyStatus(scene: Pick<KaraokeScene, "members" | "song" | "queue">): string {
  const singers = scene.members.filter((m) => m.role === "singer");
  if (singers.length === 0) return "等人加入";
  if (scene.song === null) return scene.queue.some((e) => e.state === "preparing") ? "等歌準備好" : "等大家點歌";
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
  /** The score as a number (it counts up to it on the page), `null` before there is one. */
  total: number | null;
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
      total: line.total,
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

// ---- the results ------------------------------------------------------------------------------

/** The four parts of a score, in the order the results show them, with the most each gives. */
export const PARTS = [
  { key: "pitch", label: "音程", max: 60 },
  { key: "stability", label: "安定", max: 15 },
  { key: "rhythm", label: "節奏", max: 15 },
  { key: "expression", label: "表現", max: 10 },
] as const;

/** One part of a results row: its number (one decimal, 「—」 when not given) and how full its bar is. */
export interface PartCell {
  label: string;
  max: number;
  text: string;
  share: number;
}

/** A row's four parts as the results show them; `null` without a result (nothing to show). */
export function partCells(parts: KaraokeParts | null): PartCell[] | null {
  if (parts === null) return null;
  return PARTS.map(({ key, label, max }) => {
    const v = parts[key];
    return {
      label,
      max,
      text: v === null ? "—" : v.toFixed(1),
      share: v === null ? 0 : Math.min(Math.max(v / max, 0), 1),
    };
  });
}

/** One row of the results: the board's row, its parts and what it says at its end. */
export interface ResultRow extends BoardRow {
  parts: PartCell[] | null;
  tail: string;
}

/** The final ranking in rank order, each row with its parts and its coins or 「沒唱完」. */
export function resultRows(lines: readonly KaraokeLine[], currency: string): ResultRow[] {
  const parts = new Map(lines.map((l) => [lineKey(l), l.parts]));
  return boardRows(lines, new Map()).map((row) => ({
    ...row,
    parts: partCells(parts.get(row.key) ?? null),
    tail: resultTail(row, currency),
  }));
}

/** How tall the results rows are: roomy for a few singers, compact for a crowd. */
export function resultsDensity(rows: number): "roomy" | "normal" | "compact" {
  return rows <= 4 ? "roomy" : rows <= 8 ? "normal" : "compact";
}

/** The results' heading: which round. */
export function resultsTitle(round: number): string {
  return round > 0 ? `第 ${round} 首結果` : "結果";
}

// ---- the phases and what shows in each ---------------------------------------------------------

/**
 * Where the room is, as the stream shows it: `settling` is the end of a sung round while its
 * results are worked out (Core still says `singing`).
 */
export type KaraokePhase = "lobby" | "countdown" | "singing" | "settling" | "results";

export function karaokePhase(scene: Pick<KaraokeScene, "state" | "settling">): KaraokePhase {
  if (scene.state === "singing" && scene.settling !== null) return "settling";
  return scene.state;
}

/** Where the join QR code shows: big in the lobby plate, small in a corner of the screen, or not at all. */
export type QrPlace = "lobby" | "corner" | null;

/**
 * The QR code of the room's join link: in the lobby next to the code; small in a corner with the
 * results; while the round counts down, is sung and settles only when `qrWhileSinging`. Without a
 * link there is none (the code stays as text).
 */
export function qrPlace(scene: Pick<KaraokeScene, "state" | "settling" | "joinUrl" | "qrWhileSinging">): QrPlace {
  if (scene.joinUrl === null) return null;
  const phase = karaokePhase(scene);
  if (phase === "lobby") return "lobby";
  if (phase === "results") return "corner";
  return scene.qrWhileSinging ? "corner" : null;
}

/** The pieces of the scene that show (`mode` from `karaokeMode`). */
export interface KaraokeBlocks {
  lobby: boolean;
  /** The song's plate, top left. */
  title: boolean;
  /** The lanes and the lyrics: while the round counts down and is sung. */
  lanes: boolean;
  lyrics: boolean;
  /** The live ranking, right. */
  board: boolean;
  /** 「結算中…」 in the middle of the screen. */
  settling: boolean;
  /** The final ranking over the whole screen. */
  results: boolean;
  qr: QrPlace;
}

/** What of the scene shows, phase by phase (`on`: this page shows the karaoke section). */
export function karaokeBlocks(scene: KaraokeScene | null, on: boolean): KaraokeBlocks {
  const none: KaraokeBlocks = {
    lobby: false,
    title: false,
    lanes: false,
    lyrics: false,
    board: false,
    settling: false,
    results: false,
    qr: null,
  };
  if (karaokeMode(scene, on) === "none" || scene === null) return none;
  const phase = karaokePhase(scene);
  const live = phase === "countdown" || phase === "singing";
  return {
    lobby: phase === "lobby",
    // The countdown's intro names the song itself; the plate comes in as it starts.
    title: phase === "singing" || phase === "settling",
    lanes: live,
    lyrics: live,
    board: live || phase === "settling",
    settling: phase === "settling",
    results: phase === "results",
    qr: qrPlace(scene),
  };
}

/** Names listed before 「等 N 人」. */
const SETTLING_NAMES = 4;

/** What 「結算中…」 says under it: whose result it still waits for, or that it is about done. */
export function settlingText(settling: KaraokeSettling): string {
  const names = settling.waiting;
  if (names.length === 0) return "馬上就好";
  if (names.length > SETTLING_NAMES) return `還在等 ${names.slice(0, SETTLING_NAMES).join("、")} 等 ${names.length} 人的分數`;
  return `還在等 ${names.join("、")} 的分數`;
}

// ---- the lobby's queue and the join code --------------------------------------------------------

/** One song in the lobby's 「下一首」 list. */
export interface QueueRow {
  title: string;
  artist: string | null;
  /** Who added it (`null`: not known, the chosen song). */
  by: string | null;
  /** A mark beside it: 「準備中」, 「失敗」, or none. */
  mark: string | null;
  state: KaraokeQueueEntry["state"];
}

/** The lobby's 「下一首」: the chosen song first, then the queue after it; empty when nobody has asked for one. */
export function queueRows(scene: Pick<KaraokeScene, "song" | "queue">): QueueRow[] {
  const rows: QueueRow[] = [];
  if (scene.song !== null) {
    rows.push({ title: scene.song.title, artist: scene.song.artist, by: null, mark: null, state: "ready" });
  }
  for (const e of scene.queue) {
    rows.push({
      title: e.title,
      artist: e.artist,
      by: e.by === "" ? null : e.by,
      mark: e.state === "preparing" ? "準備中" : e.state === "failed" ? "失敗" : null,
      state: e.state,
    });
  }
  return rows;
}

/**
 * The side of a QR code of `modules` (quiet zone included) in px: whole pixels per module, the
 * nearest to `target` px (so every module is the same size on the stream).
 */
export function qrPixels(modules: number, target: number): number {
  return Math.max(1, Math.round(target / modules)) * modules;
}

// ---- spectating: what happens, the line-up, the next song, numbers that count ---------------------

/** What a cheer says on the stream. */
export const CHEER_WORDS: Record<KaraokeCheerKind, string> = {
  cheer: "加油",
  nice: "好聽",
  wow: "太強了",
  encore: "安可",
};

/** How a judged note reads beside the now line. */
export const VERDICT_WORDS = { perfect: "完美", good: "不錯", miss: "沒中" } as const;

/** Notes hit in a row before the lane says so. */
export const COMBO_SHOWN = 3;

/** A lane's run of notes hit in a row, as it reads (`null`: too short to say). */
export function comboText(combo: number): string | null {
  return combo >= COMBO_SHOWN ? `連續 ${combo}` : null;
}

/** Song time before which a change of leader is not called (the first ranks are noise). */
export const LEAD_AFTER_MS = 8_000;

/** Something the stream says as it happens (a line in the scene's feed). */
export type KaraokeHappening =
  | { kind: "join"; name: string; color: number; role: KaraokeMember["role"] }
  | { kind: "leave"; name: string; color: number }
  | { kind: "lead"; name: string; color: number }
  | { kind: "phrase"; name: string; color: number };

/**
 * What changed between two frames of one room that the stream calls out: who came in, who left,
 * and, while a round is sung, who took the lead (after its first seconds, and only from someone
 * else who led). Nothing across rooms (a new room is not everyone arriving at once).
 */
export function happenings(before: KaraokeScene | null, after: KaraokeScene): KaraokeHappening[] {
  if (before === null || before.room !== after.room) return [];
  const out: KaraokeHappening[] = [];
  const was = new Map(before.members.map((m) => [lineKey(m), m]));
  const now = new Map(after.members.map((m) => [lineKey(m), m]));
  for (const [key, m] of now) {
    if (!was.has(key)) out.push({ kind: "join", name: m.name, color: m.color, role: m.role });
  }
  for (const [key, m] of was) if (!now.has(key)) out.push({ kind: "leave", name: m.name, color: m.color });
  const leader = (s: KaraokeScene) => s.board.find((l) => l.rank === 1 && l.total !== null) ?? null;
  const a = leader(before);
  const b = leader(after);
  if (
    before.state === "singing" &&
    after.state === "singing" &&
    before.round === after.round &&
    after.settling === null &&
    (after.positionMs ?? 0) >= LEAD_AFTER_MS &&
    a !== null &&
    b !== null &&
    lineKey(a) !== lineKey(b) &&
    // A tie at the top is not a new leader.
    (b.total ?? 0) > (after.board.find((l) => lineKey(l) === lineKey(a))?.total ?? 0)
  ) {
    out.push({ kind: "lead", name: b.name, color: b.color });
  }
  return out;
}

/** A happening's words (the name is shown beside them, as text). */
export function happeningText(h: KaraokeHappening): string {
  switch (h.kind) {
    case "join":
      return h.role === "singer" ? "加入了" : "進來看了";
    case "leave":
      return "離開了";
    case "lead":
      return "領先了";
    case "phrase":
      return "這一句唱得很完美";
  }
}

/** Several names in one line of the feed: 「Mia、小明 和 Kai」, or the first few and how many more. */
export function phraseNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length > 3) return `${names.slice(0, 2).join("、")} 等 ${names.length} 人`;
  return `${names.slice(0, -1).join("、")} 和 ${names.at(-1)}`;
}

/** The cheers of a frame not shown yet (by id), oldest first; `seen` learns them. */
export function freshCheers(seen: Set<string>, cheers: readonly KaraokeCheer[]): KaraokeCheer[] {
  const out = cheers.filter((c) => !seen.has(c.id));
  for (const c of out) seen.add(c.id);
  return out;
}

/** Who sings the round, for its intro: the round's board (everyone in it), else the members who sing. */
export function lineup(scene: Pick<KaraokeScene, "board" | "members">): { name: string; color: number }[] {
  const from = scene.board.length > 0 ? scene.board : scene.members.filter((m) => m.role === "singer");
  return from.map((l) => ({ name: l.name, color: l.color }));
}

/** 「下一首」 while a round is on (the first song queued after it), else `null`. */
export function nextUp(scene: Pick<KaraokeScene, "state" | "queue">): { title: string; by: string | null } | null {
  if (scene.state !== "countdown" && scene.state !== "singing") return null;
  const next = scene.queue.find((e) => e.state !== "failed");
  return next === undefined ? null : { title: next.title, by: next.by === "" ? null : next.by };
}

/** A number on its way from `from` to `to` at `t` (0..1 of the way), eased out. */
export function countUp(from: number, to: number, t: number): number {
  const k = Math.min(Math.max(t, 0), 1);
  return from + (to - from) * (1 - (1 - k) ** 3);
}

/** The letter of a singer's mark: the name's first character (a whole one), Latin in capitals. */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  let first = "";
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    first = seg.segment(trimmed)[Symbol.iterator]().next().value?.segment ?? "";
  } else {
    first = Array.from(trimmed)[0] ?? "";
  }
  return first.toLocaleUpperCase();
}
