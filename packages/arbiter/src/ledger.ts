// Her ledger (docs/design/v2-architecture.md §3.3): what she did or tried and what became of
// it, her own starts (daily counts, the gap per place with the unanswered backoff) and the
// topics she raised that nobody picked up. Pure bookkeeping; `now` is epoch ms. The Arbiter
// writes it, the ActivityManager and the agent add entries through `Arbiter.record`.

import {
  type AccountRef,
  type ContextKey,
  contextKeyString,
  type Handle,
  type LedgerEntry,
  type LedgerOutcome,
  type LedgerRecord,
  newId,
  type RaisedTopic,
  type Timestamp,
  type TurnId,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import type { ArbiterConfig } from "./config.js";
import { dayIndex } from "./time.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Starts remembered (two days are enough for every daily count). */
const START_KEEP_MS = 48 * HOUR_MS;
/** Places remembered (least recently used dropped). */
const MAX_PLACES = 200;
/** Raised topics remembered. */
const MAX_TOPICS = 100;
/** Topics listed to her. */
const MAX_LISTED = 5;
/** Characters of a remembered line. */
const MAX_TEXT = 120;

export type PlaceKind = "text" | "voice" | "dm";

/** Where she talks: a channel, a voice channel or a DM partner (`dm:<platform>:<id>`). */
export interface Place {
  key: string;
  kind: PlaceKind;
  context: ContextKey | null;
}

/** The place of a context (a DM channel without a known partner keys by its channel). */
export function placeOf(context: ContextKey | null, account: AccountRef | null): Place | null {
  if (context === null || context.kind === "dm") {
    if (account !== null) {
      return { key: `dm:${account.platform}:${account.id}`, kind: "dm", context };
    }
    return context === null ? null : { key: contextKeyString(context), kind: "dm", context };
  }
  return {
    key: contextKeyString(context),
    kind: context.kind === "voice" ? "voice" : "text",
    context,
  };
}

function cut(text: string, max = MAX_TEXT): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** One of her own starts (a self-initiated impulse that makes her talk). */
interface Start {
  at: number;
  place: string;
  /** Account or handle key of whom it was aimed at. */
  person: string | null;
  impulse: string;
}

interface PlaceState {
  kind: PlaceKind;
  context: ContextKey | null;
  /** Ignored starts in a row (each doubles the gap). */
  misses: number;
  /** When `misses` last changed (decay counts from here). */
  missesAt: number;
  /** Turns she started here since a person last spoke here (`max_unanswered`). */
  unanswered: number;
  touched: number;
}

/** A topic she raised on her own and whether anyone picked it up. */
interface Topic {
  entry: string;
  place: string;
  context: ContextKey | null;
  person: Handle | null;
  turn: TurnId | null;
  /** When she started, and when her words went out (the reply window counts from there). */
  at: number;
  spokeAt: number | null;
  said: string;
  status: RaisedTopic["status"];
}

/** A topic nobody picked up (what `settle` returns, for `topic_ignored`). */
export interface IgnoredTopic {
  entry: string;
  place: string;
  context: ContextKey | null;
  person: Handle | null;
  said: string;
}

// ---- persisted snapshot -----------------------------------------------------------------------

const ContextKeySchema = z.object({
  platform: z.string(),
  scope: z.string().nullable(),
  channel: z.string(),
  kind: z.enum(["channel", "thread", "dm", "voice"]),
});

export const LedgerSnapshotSchema = z.object({
  starts: z
    .array(
      z.object({
        at: z.number(),
        place: z.string(),
        person: z.string().nullable(),
        impulse: z.string(),
      }),
    )
    .default([]),
  places: z
    .array(
      z.object({
        key: z.string(),
        kind: z.enum(["text", "voice", "dm"]),
        context: ContextKeySchema.nullable(),
        misses: z.number(),
        misses_at: z.number(),
        unanswered: z.number().default(0),
      }),
    )
    .default([]),
  streak: z.number().default(0),
  said: z.array(z.object({ key: z.string(), until: z.number() })).default([]),
  topics: z
    .array(
      z.object({
        place: z.string(),
        context: ContextKeySchema.nullable(),
        person: z.string().nullable(),
        at: z.number(),
        said: z.string(),
        status: z.enum(["waiting", "engaged", "ignored"]),
      }),
    )
    .default([]),
});
export type LedgerSnapshot = z.output<typeof LedgerSnapshotSchema>;

export class Ledger {
  readonly #cfg: ArbiterConfig;
  /** Newest first. */
  #entries: LedgerEntry[] = [];
  #starts: Start[] = [];
  readonly #places = new Map<string, PlaceState>();
  #topics: Topic[] = [];
  /** Her own starts in a row, anywhere, that nobody picked up. */
  #streak = 0;
  /** What she said lately (`Impulse.attention`): key → when it may ask to be said again. */
  readonly #said = new Map<string, number>();
  #dirty = false;

  constructor(config: ArbiterConfig) {
    this.#cfg = config;
  }

  // ---- entries --------------------------------------------------------------------------------

  add(record: LedgerRecord, selfInitiated: boolean, now: number): LedgerEntry {
    const at = toTimestamp(now);
    const entry: LedgerEntry = {
      id: newId(),
      at,
      kind: record.kind,
      source: record.source,
      self_initiated: selfInitiated,
      context: record.context,
      person: record.person,
      summary: cut(record.summary, 80),
      outcome: record.outcome,
      detail: record.detail === null ? null : cut(record.detail, 200),
      impulse: record.impulse,
      turn: record.turn,
      task: record.task,
      updated_at: at,
    };
    this.#entries = [entry, ...this.#entries].slice(0, Math.max(this.#cfg.ledger_keep, 1));
    return entry;
  }

  get(id: string): LedgerEntry | null {
    return this.#entries.find((e) => e.id === id) ?? null;
  }

  byTurn(turn: TurnId): LedgerEntry | null {
    return this.#entries.find((e) => e.turn === turn) ?? null;
  }

  /** Updates an entry; returns it (`null`: unknown). */
  resolve(
    id: string,
    outcome: LedgerOutcome,
    detail: string | null,
    now: number,
  ): LedgerEntry | null {
    const entry = this.get(id);
    if (!entry) return null;
    entry.outcome = outcome;
    if (detail !== null) entry.detail = cut(detail, 200);
    entry.updated_at = toTimestamp(now);
    return entry;
  }

  setTurn(id: string, turn: TurnId | null, task: string | null): void {
    const entry = this.get(id);
    if (!entry) return;
    entry.turn = turn;
    entry.task = task;
    const topic = this.#topics.find((t) => t.entry === id);
    if (topic) topic.turn = turn;
  }

  /** Entries, those in `context` first (each part newest first). */
  entries(context: ContextKey | null): LedgerEntry[] {
    if (context === null) return this.#entries.map((e) => ({ ...e }));
    const key = contextKeyString(context);
    const here = this.#entries.filter((e) => e.context && contextKeyString(e.context) === key);
    const rest = this.#entries.filter((e) => !e.context || contextKeyString(e.context) !== key);
    return [...here, ...rest].map((e) => ({ ...e }));
  }

  // ---- her own starts -------------------------------------------------------------------------

  #place(place: Place, now: number): PlaceState {
    let p = this.#places.get(place.key);
    if (!p) {
      p = {
        kind: place.kind,
        context: place.context,
        misses: 0,
        missesAt: now,
        unanswered: 0,
        touched: now,
      };
      this.#places.set(place.key, p);
      if (this.#places.size > MAX_PLACES) {
        const oldest = [...this.#places.entries()].sort((a, b) => a[1].touched - b[1].touched);
        for (const [k] of oldest.slice(0, this.#places.size - MAX_PLACES)) this.#places.delete(k);
      }
    }
    p.touched = now;
    if (place.context !== null) p.context = place.context;
    return p;
  }

  /** Books one of her own starts (before it runs; `unbook` when it did not). */
  book(impulse: string, place: Place | null, person: string | null, now: number): void {
    this.#prune(now);
    if (place) this.#place(place, now);
    this.#starts.push({ at: now, place: place?.key ?? "", person, impulse });
    this.#dirty = true;
  }

  unbook(impulse: string): void {
    const before = this.#starts.length;
    this.#starts = this.#starts.filter((s) => s.impulse !== impulse);
    if (this.#starts.length !== before) this.#dirty = true;
  }

  #prune(now: number): void {
    this.#starts = this.#starts.filter((s) => now - s.at < START_KEEP_MS);
  }

  /** Her own starts today (all places, one place, one person). */
  startsToday(now: number, filter: { place?: string; person?: string } = {}): number {
    const day = dayIndex(now, this.#cfg);
    return this.#starts.filter(
      (s) =>
        dayIndex(s.at, this.#cfg) === day &&
        (filter.place === undefined || s.place === filter.place) &&
        (filter.person === undefined || s.person === filter.person),
    ).length;
  }

  /** Her last start (anywhere, or at `place`). */
  lastStart(place?: string): number | null {
    let last: number | null = null;
    for (const s of this.#starts) {
      if (place !== undefined && s.place !== place) continue;
      if (last === null || s.at > last) last = s.at;
    }
    return last;
  }

  /** Ignored starts in a row at `place`, after decay. */
  misses(place: string, now: number): number {
    const p = this.#places.get(place);
    if (!p || p.misses === 0) return 0;
    const forgotten = Math.floor((now - p.missesAt) / (this.#cfg.backoff_decay_hours * HOUR_MS));
    return Math.max(p.misses - Math.max(forgotten, 0), 0);
  }

  /** Ignored starts in a row, anywhere. */
  get streak(): number {
    return this.#streak;
  }

  /** Most doublings of the gap (`max_backoff` is the factor). */
  #maxMisses(): number {
    return Math.max(Math.floor(Math.log2(Math.max(this.#cfg.max_backoff, 1))), 0);
  }

  /** The base gap between two of her starts at a place of `kind`. */
  baseGapMs(kind: PlaceKind): number {
    return (kind === "voice" ? this.#cfg.gap_voice_secs : this.#cfg.gap_text_secs) * 1000;
  }

  /** The gap at `place` now: base × 2^misses. */
  gapMs(place: Place, now: number): number {
    return (
      this.baseGapMs(place.kind) * 2 ** Math.min(this.misses(place.key, now), this.#maxMisses())
    );
  }

  // ---- talking to nobody ----------------------------------------------------------------------

  /** Turns she started at `place` since a person last spoke there. */
  turnsUnanswered(place: string): number {
    return this.#places.get(place)?.unanswered ?? 0;
  }

  /** A turn she started went out at `place`. */
  startedTalking(place: Place, now: number): void {
    this.#place(place, now).unanswered += 1;
    this.#dirty = true;
  }

  /** A person spoke at `place` (see `humanResponse`), or a new stay in voice began. */
  heard(place: string): void {
    const p = this.#places.get(place);
    if (!p || p.unanswered === 0) return;
    p.unanswered = 0;
    this.#dirty = true;
  }

  // ---- what she already said ------------------------------------------------------------------

  /** Until when `key` may not ask to be said again (`null`: it may). */
  saidUntil(key: string, now: number): number | null {
    const until = this.#said.get(key);
    return until !== undefined && until > now ? until : null;
  }

  markSaid(key: string, until: number, now: number): void {
    for (const [k, at] of this.#said) if (at <= now) this.#said.delete(k);
    this.#said.set(key, until);
    this.#dirty = true;
  }

  /** The line did not go out: it was never said. */
  forgetSaid(key: string): void {
    if (this.#said.delete(key)) this.#dirty = true;
  }

  // ---- raised topics --------------------------------------------------------------------------

  /** She is about to raise something on her own (entry `entry`). */
  raise(
    entry: string,
    place: Place | null,
    person: Handle | null,
    about: string,
    now: number,
  ): void {
    this.#topics.push({
      entry,
      place: place?.key ?? "",
      context: place?.context ?? null,
      person,
      turn: null,
      at: now,
      spokeAt: null,
      said: cut(about),
      status: "waiting",
    });
    if (this.#topics.length > MAX_TOPICS) this.#topics = this.#topics.slice(-MAX_TOPICS);
    this.#dirty = true;
  }

  /** The topic of a turn she started herself, if any. */
  #topicOf(turn: TurnId): Topic | undefined {
    return this.#topics.find((t) => t.turn === turn && t.status === "waiting");
  }

  /** What she said in her own turn (empty: she said nothing; the topic is dropped). */
  spoke(turn: TurnId, text: string, now: number, context: ContextKey | null): Topic | null {
    const topic = this.#topicOf(turn);
    if (!topic) return null;
    if (text.trim() === "") {
      this.#topics = this.#topics.filter((t) => t !== topic);
      return null;
    }
    topic.said = cut(text);
    topic.spokeAt ??= now;
    if (context !== null && topic.context === null) topic.context = context;
    this.#dirty = true;
    return topic;
  }

  /** Her own turn did not go out (silence, cancelled, error): not a raised topic. */
  dropTopic(turn: TurnId): string | null {
    const topic = this.#topicOf(turn);
    if (!topic) return null;
    this.#topics = this.#topics.filter((t) => t !== topic);
    this.#dirty = true;
    return topic.entry;
  }

  #window(kind: PlaceKind): number {
    return (
      (kind === "voice" ? this.#cfg.reply_window_voice_secs : this.#cfg.reply_window_text_secs) *
      1000
    );
  }

  #kindOf(place: string): PlaceKind {
    return this.#places.get(place)?.kind ?? (place.startsWith("dm:") ? "dm" : "text");
  }

  /**
   * Someone addressed or answered her at `place`: what she raised there is picked up and the
   * backoff resets. Returns the entries that got their answer.
   */
  engaged(place: string, now: number): string[] {
    const out: string[] = [];
    for (const t of this.#topics) {
      if (t.place !== place || t.status !== "waiting" || t.spokeAt === null) continue;
      if (now < t.spokeAt || now - t.spokeAt > this.#window(this.#kindOf(place))) continue;
      t.status = "engaged";
      out.push(t.entry);
    }
    const p = this.#places.get(place);
    if (p && p.misses > 0) {
      p.misses = 0;
      p.missesAt = now;
      this.#dirty = true;
    }
    if (out.length > 0) {
      this.#streak = 0;
      this.#dirty = true;
    }
    return out;
  }

  /** Topics whose reply window passed without anyone picking them up become ignored. */
  settle(now: number): IgnoredTopic[] {
    const out: IgnoredTopic[] = [];
    for (const t of this.#topics) {
      if (t.status !== "waiting" || t.spokeAt === null) continue;
      if (now - t.spokeAt <= this.#window(this.#kindOf(t.place))) continue;
      t.status = "ignored";
      this.#streak += 1;
      const p = this.#places.get(t.place);
      if (p) {
        p.misses = Math.min(this.misses(t.place, now) + 1, this.#maxMisses());
        p.missesAt = now;
      }
      this.#dirty = true;
      out.push({
        entry: t.entry,
        place: t.place,
        context: t.context,
        person: t.person,
        said: t.said,
      });
    }
    // A start that never got its words out within a day is forgotten.
    this.#topics = this.#topics.filter((t) => t.spokeAt !== null || now - t.at < 24 * HOUR_MS);
    return out;
  }

  /** Ignored topics at `place` (or anywhere) within `stale_topic_mins`, newest first. */
  unanswered(place: string | null, now: number): RaisedTopic[] {
    const keep = this.#cfg.stale_topic_mins * MINUTE_MS;
    return this.#topics
      .filter(
        (t) =>
          t.status === "ignored" &&
          (place === null || t.place === place) &&
          now - (t.spokeAt ?? t.at) <= keep &&
          t.said !== "",
      )
      .sort((a, b) => (b.spokeAt ?? b.at) - (a.spokeAt ?? a.at))
      .slice(0, MAX_LISTED)
      .map((t) => ({
        text: t.said,
        context: t.context,
        at: toTimestamp(t.spokeAt ?? t.at),
        status: t.status,
      }));
  }

  // ---- persistence ----------------------------------------------------------------------------

  /** Something changed since the last `snapshot`. */
  get dirty(): boolean {
    return this.#dirty;
  }

  snapshot(now: number): LedgerSnapshot {
    this.#dirty = false;
    this.#prune(now);
    return {
      starts: this.#starts.map((s) => ({ ...s })),
      places: [...this.#places.entries()]
        .filter(([, p]) => p.misses > 0 || p.unanswered > 0)
        .map(([key, p]) => ({
          key,
          kind: p.kind,
          context: p.context,
          misses: p.misses,
          misses_at: p.missesAt,
          unanswered: p.unanswered,
        })),
      streak: this.#streak,
      said: [...this.#said.entries()]
        .filter(([, until]) => until > now)
        .map(([key, until]) => ({ key, until })),
      topics: this.#topics
        .filter((t) => t.spokeAt !== null && t.status !== "waiting")
        .map((t) => ({
          place: t.place,
          context: t.context,
          person: t.person,
          at: t.spokeAt ?? t.at,
          said: t.said,
          status: t.status,
        })),
    };
  }

  restore(snapshot: LedgerSnapshot, now: number): void {
    this.#starts = snapshot.starts.filter((s) => now - s.at < START_KEEP_MS);
    for (const p of snapshot.places) {
      this.#places.set(p.key, {
        kind: p.kind,
        context: p.context,
        misses: p.misses,
        missesAt: p.misses_at,
        unanswered: p.unanswered,
        touched: now,
      });
    }
    this.#streak = snapshot.streak;
    for (const s of snapshot.said) if (s.until > now) this.#said.set(s.key, s.until);
    this.#topics = snapshot.topics.map((t) => ({
      entry: "",
      place: t.place,
      context: t.context,
      person: t.person,
      turn: null,
      at: t.at,
      spokeAt: t.at,
      said: t.said,
      status: t.status,
    }));
  }
}

/** `Timestamp` of `ms`, or `null`. */
export function maybeTimestamp(ms: number | null): Timestamp | null {
  return ms === null ? null : toTimestamp(ms);
}
