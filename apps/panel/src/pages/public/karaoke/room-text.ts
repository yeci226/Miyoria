// Words and small decisions of a room's screens (docs/design/karaoke.md 「做了什麼第四步」). No DOM.

import type {
  KaraokeBoardLine,
  KaraokeResult,
  KaraokeRoomEvent,
  KaraokeRoomMember,
  KaraokeRoomState,
} from "@miyoria/contracts/api";
import { decodeTrack, fromBase64, TRACK_HZ } from "@miyoria/play/karaoke/score";

export type TrendEvent = Extract<KaraokeRoomEvent, { type: "trend" }>;
export type BoardEvent = Extract<KaraokeRoomEvent, { type: "board" }>;

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

  /** Takes one board's lines; what is far behind the newest frame is forgotten. */
  take(lines: readonly KaraokeBoardLine[]): void {
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
