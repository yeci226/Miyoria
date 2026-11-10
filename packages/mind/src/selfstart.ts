// What she started on her own and what became of it. Pure; `now` is epoch ms.
//
// * Backoff: per place (a text channel, a voice channel, a DM partner) at least a base gap
//   between two self-started conversations (`self_start_gap_voice_secs` / `_text_secs`). Each
//   self-start nobody responded to (nobody addressed her there within the base gap) doubles it,
//   up to `self_start_max_backoff` times; a real exchange there (someone addresses her) resets it.
// * Raised topics: what she said when she started talking, with whether anyone engaged. Ignored
//   ones are listed to her ("你最近提過、沒人接的話題") for `stale_topic_mins`, and a new
//   self-start about the same thing is dropped.
// * Blocks: an action that failed (`game.start` while the game is not running) is not tried
//   again until the situation it depends on changes, or `blocked_retry_mins` passed.
//
// With the Arbiter running, its ledger is the floor and these are only her own record (the
// topics nobody picked up); without it they are the fallback floor Plan is shown as limits.

import { type ContextKey, contextKeyString, type RaisedTopic, toTimestamp } from "@miyoria/types";

const MINUTE_MS = 60_000;
/** Starts remembered per place. */
const MAX_STARTS = 8;
/** Places remembered (least recently used dropped). */
const MAX_PLACES = 200;
/** Topics listed per place. */
const MAX_LISTED = 5;
/** Characters of a remembered line or topic. */
const MAX_TEXT = 120;

export type PlaceKind = "voice" | "text" | "dm";

export interface SelfStartConfig {
  self_start_gap_voice_secs: number;
  self_start_gap_text_secs: number;
  self_start_max_backoff: number;
  stale_topic_mins: number;
}

interface Start {
  at: number;
  /** What she said. */
  said: string;
  /** What she meant to talk about (her intent's opening and reason). */
  about: string;
  status: RaisedTopic["status"];
}

interface Place {
  kind: PlaceKind;
  context: ContextKey | null;
  /** Ignored self-starts in a row (the gap doubles with each). */
  misses: number;
  last: number | null;
  starts: Start[];
  touched: number;
}

function cut(text: string, max = MAX_TEXT): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** The key of a place: the context, or `dm:<account>` for a DM partner. */
export function placeKey(context: ContextKey): string {
  return contextKeyString(context);
}

export function kindOf(context: ContextKey | null): PlaceKind {
  if (context === null || context.kind === "dm") return "dm";
  return context.kind === "voice" ? "voice" : "text";
}

/** Letters and digits only, lower case (CJK kept). */
function letters(text: string): string {
  return [...text.toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");
}

function bigrams(text: string): Set<string> {
  const chars = [...letters(text)];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/**
 * Whether two short texts are about the same thing: at least 3 shared character bigrams that
 * cover at least 40% of the shorter one ("那個 bypass 別找了" ~ "你那個 bypass 找不到就先放著").
 */
export function similar(a: string, b: string): boolean {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared >= 3 && shared / Math.min(x.size, y.size) >= 0.4;
}

/**
 * Looser than `similar`: whether an agenda item is what a failed action was for (2 shared
 * bigrams covering 30% of the shorter text: "過來陪我玩麥塊" ~ "想去玩麥塊").
 */
export function related(a: string, b: string): boolean {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared >= 2 && shared / Math.min(x.size, y.size) >= 0.3;
}

export class SelfStarts {
  readonly #places = new Map<string, Place>();

  constructor(private readonly config: SelfStartConfig) {}

  #base(kind: PlaceKind): number {
    return (
      (kind === "voice"
        ? this.config.self_start_gap_voice_secs
        : this.config.self_start_gap_text_secs) * 1000
    );
  }

  #place(key: string, kind: PlaceKind, context: ContextKey | null, now: number): Place {
    let p = this.#places.get(key);
    if (!p) {
      p = { kind, context, misses: 0, last: null, starts: [], touched: now };
      this.#places.set(key, p);
      if (this.#places.size > MAX_PLACES) {
        const oldest = [...this.#places.entries()].sort((a, b) => a[1].touched - b[1].touched);
        for (const [k] of oldest.slice(0, this.#places.size - MAX_PLACES)) this.#places.delete(k);
      }
    }
    p.touched = now;
    return p;
  }

  /** She started talking at `key` on her own and said `said` (about `about`). */
  started(
    key: string,
    kind: PlaceKind,
    context: ContextKey | null,
    now: number,
    said: string,
    about: string,
  ): void {
    this.resolve(now);
    const p = this.#place(key, kind, context, now);
    p.last = now;
    p.starts = [
      ...p.starts,
      { at: now, said: cut(said), about: cut(about), status: "waiting" as const },
    ].slice(-MAX_STARTS);
  }

  /** Someone addressed her at `key`: a real exchange (what she raised there got a response). */
  engaged(key: string, now: number): void {
    const p = this.#places.get(key);
    if (!p) return;
    this.resolve(now);
    const window = this.#base(p.kind);
    for (const s of p.starts) {
      if (s.status === "waiting" && now >= s.at && now - s.at <= window) s.status = "engaged";
    }
    p.misses = 0;
  }

  /** Self-starts older than the window without a response count as ignored. */
  resolve(now: number): void {
    const max = Math.max(Math.floor(Math.log2(Math.max(this.config.self_start_max_backoff, 1))), 0);
    for (const p of this.#places.values()) {
      const window = this.#base(p.kind);
      for (const s of p.starts) {
        if (s.status !== "waiting" || now - s.at <= window) continue;
        s.status = "ignored";
        p.misses = Math.min(p.misses + 1, max);
      }
    }
  }

  /** The gap that applies at `key` now (base × 2^ignored, capped). */
  gapMs(key: string, kind: PlaceKind, now: number): number {
    this.resolve(now);
    const misses = this.#places.get(key)?.misses ?? 0;
    return this.#base(kind) * 2 ** misses;
  }

  /** How long until she may start talking at `key` again (0 = now), and how many were ignored. */
  wait(key: string, kind: PlaceKind, now: number): { ms: number; misses: number } {
    const gap = this.gapMs(key, kind, now);
    const p = this.#places.get(key);
    if (!p || p.last === null) return { ms: 0, misses: p?.misses ?? 0 };
    return { ms: Math.max(p.last + gap - now, 0), misses: p.misses };
  }

  /** Places where she has to wait before starting again (`ms` > 0), the longest first. */
  waits(now: number): { key: string; kind: PlaceKind; ms: number; misses: number }[] {
    this.resolve(now);
    const out: { key: string; kind: PlaceKind; ms: number; misses: number }[] = [];
    for (const [key, p] of this.#places) {
      const w = this.wait(key, p.kind, now);
      if (w.ms > 0) out.push({ key, kind: p.kind, ...w });
    }
    return out.sort((a, b) => b.ms - a.ms);
  }

  /** Self-starts since `since` (epoch ms), everywhere. */
  startsSince(since: number): number {
    let n = 0;
    for (const p of this.#places.values()) for (const s of p.starts) if (s.at >= since) n++;
    return n;
  }

  /** The most ignored self-starts in a row at any one place. */
  maxMisses(now: number): number {
    this.resolve(now);
    let max = 0;
    for (const p of this.#places.values()) max = Math.max(max, p.misses);
    return max;
  }

  /** What she raised at `key` (or anywhere, for `null`) recently that nobody picked up. */
  unanswered(key: string | null, now: number): RaisedTopic[] {
    this.resolve(now);
    const keep = this.config.stale_topic_mins * MINUTE_MS;
    const out: (RaisedTopic & { ms: number })[] = [];
    for (const [k, p] of this.#places) {
      if (key !== null && k !== key) continue;
      for (const s of p.starts) {
        if (s.status !== "ignored" || now - s.at > keep || s.said === "") continue;
        out.push({
          text: s.said,
          context: p.context,
          at: toTimestamp(s.at),
          status: s.status,
          ms: s.at,
        });
      }
    }
    return out
      .sort((a, b) => b.ms - a.ms)
      .slice(0, MAX_LISTED)
      .map(({ ms: _ms, ...t }) => t);
  }

  /**
   * A topic she raised at `key` recently, still waiting or ignored, that `text` is about again
   * (`null` if none).
   */
  repeats(key: string, text: string, now: number): string | null {
    this.resolve(now);
    if (letters(text) === "") return null;
    const keep = this.config.stale_topic_mins * MINUTE_MS;
    for (const s of [...(this.#places.get(key)?.starts ?? [])].reverse()) {
      if (s.status === "engaged" || now - s.at > keep) continue;
      if ((s.said !== "" && similar(text, s.said)) || (s.about !== "" && similar(text, s.about))) {
        return s.said === "" ? s.about : s.said;
      }
    }
    return null;
  }
}

/** A capability on hold after it failed. */
export interface Block {
  capability: string;
  reason: string;
  at: number;
  /** The situation it depended on when it failed (`conditionOf`). */
  condition: string;
}

/** What a capability's success depends on, as far as she can see it. */
export interface Situation {
  /** The game she is playing (`null`: none). */
  game: string | null;
  /** Last time she saw the game running (the activity snapshot), or `null`. */
  gameSeenAt: number | null;
  /** Her voice channel (`null`: none). */
  voice: string | null;
  /** Go Live / OBS state. */
  live: string;
  scene: string | null;
  /** Who streams in her voice channel, sorted (`watch.*` depends on it). */
  streamers: string;
}

/** The part of the situation `capability` depends on. */
export function conditionOf(capability: string, s: Situation): string {
  const area = capability.split(".")[0] ?? "";
  switch (area) {
    case "game":
      return `game:${s.game ?? ""}`;
    case "voice":
      return `voice:${s.voice ?? ""}`;
    case "watch":
      return `watch:${s.voice ?? ""}|${s.streamers}`;
    case "stream":
      return `live:${s.live}`;
    case "stage":
      return `stage:${s.scene ?? ""}|${s.live}`;
    default:
      return "";
  }
}

/** Whether a block is over: the situation changed, a game came up, or the retry time passed. */
export function blockLifted(b: Block, s: Situation, now: number, retryMs: number): boolean {
  if (now - b.at >= retryMs) return true;
  if (conditionOf(b.capability, s) !== b.condition) return true;
  // The game came up after it failed: it is available now.
  return b.capability.startsWith("game.") && s.gameSeenAt !== null && s.gameSeenAt > b.at;
}
