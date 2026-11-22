// Words and small decisions of a room's screens (docs/design/karaoke.md 「做了什麼第四步」). No DOM.

import type {
  KaraokeBoardLine,
  KaraokeResult,
  KaraokeRoomEvent,
  KaraokeRoomMember,
  KaraokeRoomState,
  KaraokeRoomView,
  KaraokeSession,
} from "@miyoria/contracts/api";
import { decodeTrack, fromBase64, TRACK_HZ } from "@miyoria/play/karaoke/score";

export type TrendEvent = Extract<KaraokeRoomEvent, { type: "trend" }>;
export type BoardEvent = Extract<KaraokeRoomEvent, { type: "board" }>;
export type LiveEvent = Extract<KaraokeRoomEvent, { type: "live" }>;
export type CheerEvent = Extract<KaraokeRoomEvent, { type: "cheer" }>;

/** What a cheer says (the same words as her stream). */
export const CHEER_WORDS: Record<CheerEvent["kind"], string> = {
  cheer: "加油",
  nice: "好聽",
  wow: "太強了",
  encore: "安可",
};

/** The kinds in the order the buttons show them. */
export const CHEER_ORDER: CheerEvent["kind"][] = ["cheer", "nice", "wow", "encore"];

/** Cheers kept on screen at once, and how long each stays (ms). */
export const CHEERS_SHOWN = 3;
export const CHEER_SHOW_MS = 4_000;

/** The latest cheers with the new one, oldest first, those older than `CHEER_SHOW_MS` gone. */
export function keepCheers<T extends { id: string; at: number }>(list: readonly T[], next: T, now: number): T[] {
  if (list.some((c) => c.id === next.id)) return [...list];
  return [...list.filter((c) => now - c.at < CHEER_SHOW_MS), next].slice(-CHEERS_SHOWN);
}

/** Who may be cheered: the round's singers on the board, else the members who sing. */
export function cheerTargets(
  board: readonly { member: string; name: string; color: number }[],
  members: readonly { id: string; name: string; color: number; role: "singer" | "spectator" }[],
): { member: string; name: string; color: number }[] {
  if (board.length > 0) return board.map((l) => ({ member: l.member, name: l.name, color: l.color }));
  return members.filter((m) => m.role === "singer").map((m) => ({ member: m.id, name: m.name, color: m.color }));
}

/** A room's code: six letters and digits people can read out (`KARAOKE_ROOM_CODE`). */
export const ROOM_CODE = /^[2-9A-HJKMNP-Z]{6}$/;

/** A code as typed (any case, spaces, a pasted link), or `null` when it is not one. */
export function readRoomCode(text: string): string | null {
  const t = text.trim();
  const fromLink = /\/karaoke\/room\/([^/?#\s]+)/i.exec(t)?.[1] ?? /[?&]room=([^&#\s]+)/i.exec(t)?.[1];
  const code = (fromLink ?? t).replace(/[\s-]/g, "").toUpperCase();
  return ROOM_CODE.test(code) ? code : null;
}

// ---- the singer's trend plate ------------------------------------------------------------------

export interface TrendView {
  /** 上升中 / 下降中 / 保持 */
  word: string;
  /** ↑ ↓ — */
  mark: string;
  /** Where the live score comes from: 正式 (the stream) or 預估 (the browser). */
  source: string;
}

const TREND_WORDS: Record<TrendEvent["trend"], { word: string; mark: string }> = {
  rising: { word: "上升中", mark: "↑" },
  dropping: { word: "下降中", mark: "↓" },
  holding: { word: "保持", mark: "—" },
};

export const SOURCE_WORDS: Record<"voice" | "estimate", string> = { voice: "正式", estimate: "預估" };

/** What the singer's plate says; `null` before the first `trend`. */
export function trendView(e: Pick<TrendEvent, "trend" | "source"> | null): TrendView | null {
  if (e === null) return null;
  return { ...TREND_WORDS[e.trend], source: SOURCE_WORDS[e.source] };
}

/** The singer's own running number on their stage: Core's, labelled by where it comes from. */
export interface StageScore {
  total: number;
  source: "voice" | "estimate";
}

/**
 * The number a room's singer sees: their own running total from the latest `trend` (正式 from the
 * stream, 預估 from the browser), or `null` while there is none (the stage shows the browser's own
 * number as 預估). Their own only: a trend never carries anyone else's.
 */
export function stageScore(e: Pick<TrendEvent, "source" | "total"> | null): StageScore | null {
  if (e === null || e.total === null || !Number.isFinite(e.total)) return null;
  return { total: e.total, source: e.source };
}

// ---- a singer's stage ------------------------------------------------------------------------

/** A singer's stage of one round: its session and start, as the room gave them. */
export interface HeldStage {
  round: number;
  session: KaraokeSession;
  startAt: number;
}

/**
 * The stage this person sings on now, or `null`: the room's own word while it gives one (a round
 * running, they sing it, its session and start), else the one held from it for the same round while
 * that round is still on, so a later view (the song over, 結算中) cannot end the stage before the
 * take is sent. The results, a closed room or the next round let it go.
 */
export function stageOf(room: KaraokeRoomView, held: { current: HeldStage | null }): HeldStage | null {
  const running = room.state === "countdown" || room.state === "singing";
  const me = room.me;
  if (running && me?.singing && me.session !== null && room.start_at_ms !== null) {
    const now = held.current;
    if (now === null || now.round !== room.round || now.session.session !== me.session.session || now.startAt !== room.start_at_ms) {
      held.current = { round: room.round, session: me.session, startAt: room.start_at_ms };
    }
    return held.current;
  }
  return running && held.current?.round === room.round ? held.current : null;
}

// ---- 結算中 -------------------------------------------------------------------------------------

/** The room's `settling`. */
export type Settling = KaraokeRoomView["settling"];

/** 「結算中…」 and whom it waits for: `等 海苔、Akari 的分數`, or 馬上就好 when no one. */
export function settlingView(s: NonNullable<Settling>): { title: string; detail: string } {
  const names = s.waiting.filter((n) => n.trim() !== "");
  return {
    title: "結算中…",
    detail: names.length === 0 ? "馬上就好" : `等 ${names.join("、")} 的分數`,
  };
}

// ---- the queue (「第四步之後的修改:先開房再點歌」) ---------------------------------------------------

type QueueRoom = Pick<KaraokeRoomView, "state" | "queue" | "next" | "queue_limits" | "rounds_left" | "members">;

/** Entries waiting (a failed one is skipped and counts for nothing): all of them, and this person's. */
export function queueCounts(room: Pick<KaraokeRoomView, "queue">): { waiting: number; mine: number } {
  const live = room.queue.filter((e) => e.song.state !== "failed");
  return { waiting: live.length, mine: live.filter((e) => e.mine).length };
}

/** Songs are queued in the lobby and after a round, while the room has rounds left. */
export function canQueue(room: Pick<KaraokeRoomView, "state" | "rounds_left">): boolean {
  return (room.state === "lobby" || room.state === "results") && room.rounds_left > 0;
}

/**
 * Why this person cannot add a song now, in Core's own sentences (`null`: they can). Core checks
 * the same and says the same; this only spares a refusal.
 */
export function queueBlocked(room: QueueRoom): string | null {
  if (room.rounds_left <= 0) return "這間房的輪數用完了";
  const { waiting, mine } = queueCounts(room);
  const { per_person, max } = room.queue_limits;
  if (mine >= per_person) return `你已經點了 ${per_person} 首在等,唱完再點`;
  if (waiting >= max) return "點歌的清單滿了,等唱完幾首再點";
  return null;
}

/** Why the opener cannot start the next round now (`null`: they can). */
export function startBlocked(room: QueueRoom): string | null {
  if (room.state !== "lobby" && room.state !== "results") return null;
  if (room.rounds_left <= 0) return "這間房的輪數用完了";
  if (room.next === null) {
    return room.queue.some((e) => e.song.state === "preparing") ? "清單裡的歌還在準備" : "清單裡還沒有準備好的歌,先點一首";
  }
  if (!room.members.some((m) => m.role === "singer" && m.ready)) return "還沒有人準備好唱";
  return null;
}

/** Where an entry's song is: `null` ready, else its preparation in words (failed ones are skipped). */
export function entryState(
  song: Pick<KaraokeRoomView["queue"][number]["song"], "state" | "stage" | "progress">,
  stageWord: (stage: string | null) => string,
): { word: string; failed: boolean; progress: number | null } | null {
  if (song.state === "ready") return null;
  if (song.state === "failed") return { word: "準備失敗,輪到時會跳過", failed: true, progress: null };
  const p = Math.max(0, Math.min(1, song.progress));
  return { word: `${stageWord(song.stage)} ${Math.round(p * 100)}%`, failed: false, progress: p };
}

// ---- colours -----------------------------------------------------------------------------------

/**
 * A member's colour (0..7): the five chart colours in their fixed order, then the first three
 * again with a dashed line and a hollow mark, so eight stay apart by shape as well as colour.
 */
export function memberColor(i: number): { color: string; css: string; dashed: boolean } {
  const n = ((Math.trunc(i) % 8) + 8) % 8;
  const slot = (n % 5) + 1;
  return { color: `--chart-${slot}`, css: `var(--chart-${slot})`, dashed: n >= 5 };
}

// ---- the room's words --------------------------------------------------------------------------

export const STATE_WORDS: Record<KaraokeRoomState, string> = {
  lobby: "等人",
  countdown: "倒數",
  singing: "唱歌中",
  results: "結果",
  closed: "已關閉",
};

export function roleWord(m: Pick<KaraokeRoomMember, "role" | "opener">): string {
  if (m.opener) return m.role === "singer" ? "房主 · 唱" : "房主 · 看";
  return m.role === "singer" ? "唱" : "看";
}

/** `20 魚幣` */
export function coins(n: number, currency: string): string {
  return `${n} ${currency}`;
}

/** Whether a balance covers the price; `null` (the wallet cannot be read) leaves it to Core. */
export function canPay(balance: number | null, price: number): boolean {
  return balance === null || balance >= price;
}

/** The board's movement mark. */
export const MOVE_MARK: Record<KaraokeBoardLine["move"], string> = { up: "↑", down: "↓", same: "" };
export const MOVE_WORD: Record<KaraokeBoardLine["move"], string> = { up: "上升", down: "下降", same: "" };

// ---- the official score: whether this browser sends its recording ------------------------------

/**
 * Whether Core wants the recording now (`voice.upload`). A singer alone: whenever it waits for one.
 * A room's singer whose stream held: never (the stream gives the official score). A Core from
 * before rooms says nothing of it: then it is whenever it waits.
 */
export function wantsUpload(voice: Pick<KaraokeResult["voice"], "state"> & { upload?: boolean }): boolean {
  if (typeof voice.upload === "boolean") return voice.upload;
  return voice.state === "waiting";
}

// ---- the spectators' pitch lines ---------------------------------------------------------------

/** Seconds of each singer's line kept behind the now line. */
const LINE_KEEP_S = 12;

/** A point of a singer's line on the spectators' lane. */
export interface LinePoint {
  t: number;
  midi: number | null;
}

/** `midi` moved by whole octaves to sit nearest `ref` (singers sing an octave off). */
export function foldOctave(midi: number, ref: number | null): number {
  if (ref === null) return midi;
  return midi + 12 * Math.round((ref - midi) / 12);
}

/**
 * Each singer's line from the boards: a board carries their pitch lately from a frame `from` on,
 * which replaces what earlier boards said from there.
 */
export class BoardLines {
  readonly #frames = new Map<string, (number | null)[]>();

  /** Takes one board's (or `live`'s) lines; what is far behind the newest frame is forgotten. */
  take(lines: readonly Pick<KaraokeBoardLine, "member" | "pitch">[]): void {
    const keep = LINE_KEEP_S * TRACK_HZ;
    for (const l of lines) {
      if (!l.pitch) continue;
      const bytes = fromBase64(l.pitch.track);
      if (bytes === null) continue;
      const frames = this.#frames.get(l.member) ?? [];
      const midi = decodeTrack(bytes);
      const from = Math.max(0, l.pitch.from);
      while (frames.length < from) frames.push(null);
      frames.length = from;
      for (const m of midi) frames.push(m);
      for (let i = Math.max(0, frames.length - keep - TRACK_HZ * 2); i < frames.length - keep; i++) frames[i] = null;
      this.#frames.set(l.member, frames);
    }
  }

  /** A singer's line from `from` to `to` seconds, each point moved into the reference's octave. */
  line(member: string, from: number, to: number, ref: (t: number) => number | null): LinePoint[] {
    const frames = this.#frames.get(member);
    if (!frames) return [];
    const out: LinePoint[] = [];
    const a = Math.max(0, Math.floor(from * TRACK_HZ));
    const b = Math.min(frames.length, Math.ceil(to * TRACK_HZ) + 1);
    for (let i = a; i < b; i++) {
      const t = i / TRACK_HZ;
      const m = frames[i];
      out.push({ t, midi: m === null || m === undefined ? null : foldOctave(m, ref(t)) });
    }
    return out;
  }

  /** A new round. */
  clear(): void {
    this.#frames.clear();
  }
}
