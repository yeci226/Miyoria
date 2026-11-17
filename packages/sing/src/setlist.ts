// Her set list: the songs requested, preparing on the worker, ready, playing and recently done.
// Kept in the settings store (`snapshot` / `restore`), so a Core restart picks up the songs it
// had: preparing ones re-attach to their worker jobs, ready ones are still ready.

import {
  type AccountRef,
  type ContextKey,
  type JsonValue,
  safeName,
  sameAccount,
  type Timestamp,
} from "@miyoria/types";
import { z } from "zod";
import { type SongMeta, SongMetaSchema } from "./client.js";

/** Short number used in commands and by her tools (`#3`). */
export type SongNo = number;

export type SongState = "preparing" | "ready" | "playing" | "done" | "failed" | "cancelled";

/**
 * What becomes of the song's own backing voices (harmonies, chorus): kept as recorded (default),
 * dropped, converted to her voice like the lead, or a cappella (her lead alone, no instrumental).
 */
export const BACKING_MODES = ["keep", "drop", "convert", "acapella"] as const;
export type BackingMode = (typeof BACKING_MODES)[number];

/** How each mode is said to people (list labels, command choices). */
export const BACKING_LABELS: Record<BackingMode, string> = {
  keep: "原曲伴唱",
  drop: "不要伴唱",
  convert: "伴唱也轉",
  acapella: "清唱",
};

export interface SongEntry {
  no: SongNo;
  /** What was asked for (a name, maybe with the artist, or a link). Untrusted. */
  query: string;
  key: number;
  /** What becomes of the song's own backing voices (`keep` unless asked). */
  backing: BackingMode;
  requester: AccountRef | null;
  requester_name: string;
  /** Where it was asked for. */
  context: ContextKey | null;
  /**
   * Sung as soon as she is free once ready (a command or the request queue asked; commands are
   * forced overrides). Otherwise she picks the moment.
   */
  forced: boolean;
  state: SongState;
  /** Worker stage while preparing (`download`, `separate`, `convert`, ...). */
  stage: string;
  progress: number;
  error: string | null;
  job: string | null;
  song: SongMeta | null;
  /** `[modules.queue]` item this song came from. */
  queue_item: number | null;
  created_at: Timestamp;
  ready_at: Timestamp | null;
  /** How often her mind was told it is ready. */
  reminders: number;
  last_reminder_ms: number | null;
  /** Ledger row of the ticket that let this song past the per-person limit; refunded once. */
  ticket_entry: string | null;
  /**
   * She prepared it for herself (v4 §8.1 練歌), nobody is waiting for it: it is never sung on its
   * own, her mind hears about it once, and she sings it when she wants and someone is there.
   */
  practice?: boolean;
  /** The paid dedication's words (already screened), or `null`. */
  dedication: string | null;
  /** Ledger row of the dedication; refunded once when the song is not sung. */
  dedication_entry: string | null;
}

export type NewSong = Pick<
  SongEntry,
  "query" | "key" | "requester" | "requester_name" | "context"
> &
  Partial<
    Pick<
      SongEntry,
      | "backing"
      | "forced"
      | "practice"
      | "queue_item"
      | "ticket_entry"
      | "dedication"
      | "dedication_entry"
    >
  >;

export class SetListError extends Error {
  override readonly name = "SetListError";
}

const OPEN: readonly SongState[] = ["preparing", "ready", "playing"];

/** ` 獻詞:「…」` for a paid dedication, else nothing (the words are short and screened). */
export function dedicationNote(e: SongEntry): string {
  return e.dedication ? `;獻詞:「${safeName(e.dedication, 60)}」` : "";
}

/** One line naming a song for her or for a card: `「title」- artist`, escaped and short. */
export function songLabel(e: SongEntry): string {
  const title = e.song?.title?.trim() || e.query;
  const artist = e.song?.artist?.trim();
  const mode =
    e.backing === "keep" || e.backing === undefined ? "" : `(${BACKING_LABELS[e.backing]})`;
  return `「${safeName(title, 60)}」${artist ? ` - ${safeName(artist, 40)}` : ""}${mode}`;
}

const AccountSchema = z.object({ platform: z.string(), id: z.string() });
const ContextSchema = z.object({
  platform: z.string(),
  scope: z.string().nullable(),
  channel: z.string(),
  kind: z.enum(["channel", "thread", "dm", "voice"]),
});

/** One stored entry; anything unreadable drops that entry, not the list. */
const StoredEntrySchema = z.object({
  no: z.number().int().positive(),
  query: z.string().min(1),
  key: z.number().int().catch(0),
  backing: z.enum(BACKING_MODES).catch("keep"),
  requester: AccountSchema.nullable().catch(null),
  requester_name: z.string().catch("觀眾"),
  context: ContextSchema.nullable().catch(null),
  forced: z.boolean().catch(false),
  practice: z.boolean().catch(false),
  state: z.enum(["preparing", "ready", "playing", "done", "failed", "cancelled"]),
  stage: z.string().catch(""),
  progress: z.number().catch(0),
  error: z.string().nullable().catch(null),
  job: z.string().nullable().catch(null),
  song: SongMetaSchema.nullable().catch(null),
  queue_item: z.number().int().nullable().catch(null),
  created_at: z.string(),
  ready_at: z.string().nullable().catch(null),
  reminders: z.number().int().nonnegative().catch(0),
  last_reminder_ms: z.number().nullable().catch(null),
  ticket_entry: z.string().nullable().catch(null),
  dedication: z.string().nullable().catch(null),
  dedication_entry: z.string().nullable().catch(null),
});

const StoredSetListSchema = z.object({
  version: z.literal(1),
  next: z.number().int().positive(),
  entries: z.array(z.unknown()),
});

export class SetList {
  readonly #entries: SongEntry[] = [];
  #next = 1;

  /** The list as JSON for the settings store. */
  snapshot(): JsonValue {
    return { version: 1, next: this.#next, entries: this.#entries } as unknown as JsonValue;
  }

  /**
   * Replaces the list with a stored one; returns how many entries it read. A song that was
   * playing when Core stopped is ready again (it was cut off), and she decides about it.
   */
  restore(stored: JsonValue): number {
    const parsed = StoredSetListSchema.safeParse(stored);
    if (!parsed.success) return 0;
    const entries: SongEntry[] = [];
    for (const raw of parsed.data.entries) {
      const e = StoredEntrySchema.safeParse(raw);
      if (!e.success || entries.some((x) => x.no === e.data.no)) continue;
      const entry = e.data as SongEntry;
      if (entry.state === "playing") {
        entry.state = entry.song ? "ready" : "failed";
        entry.forced = false;
        entry.reminders = 0;
        entry.last_reminder_ms = null;
      }
      if (entry.state === "ready" && entry.song === null) entry.state = "failed";
      entries.push(entry);
    }
    this.#entries.splice(0, this.#entries.length, ...entries);
    this.#next = Math.max(parsed.data.next, ...entries.map((e) => e.no + 1), 1);
    return entries.length;
  }

  constructor(
    private readonly limits: { max_pending: number; max_pending_per_user: number; history: number },
  ) {}

  /** Every entry still in the list, oldest first. */
  all(): SongEntry[] {
    return [...this.#entries];
  }

  get(no: SongNo): SongEntry | null {
    return this.#entries.find((e) => e.no === no) ?? null;
  }

  byJob(job: string): SongEntry | null {
    return this.#entries.find((e) => e.job === job) ?? null;
  }

  open(): SongEntry[] {
    return this.#entries.filter((e) => OPEN.includes(e.state));
  }

  preparing(): SongEntry[] {
    return this.#entries.filter((e) => e.state === "preparing");
  }

  ready(): SongEntry[] {
    return this.#entries.filter((e) => e.state === "ready");
  }

  playing(): SongEntry | null {
    return this.#entries.find((e) => e.state === "playing") ?? null;
  }

  /** Songs she prepared for herself that are still open. */
  practicing(): SongEntry[] {
    return this.open().filter((e) => e.practice === true);
  }

  /** The same song (by query, key and backing mode) already open. */
  findOpen(query: string, key: number, backing: BackingMode = "keep"): SongEntry | null {
    const q = query.trim().toLowerCase();
    return (
      this.open().find(
        (e) => e.key === key && e.backing === backing && e.query.trim().toLowerCase() === q,
      ) ?? null
    );
  }

  /** Whether `who` already has as many open songs as one person may (a ticket adds one more). */
  atUserLimit(who: AccountRef): boolean {
    return this.#byUser(who) >= this.limits.max_pending_per_user;
  }

  #byUser(who: AccountRef): number {
    return this.open().filter((e) => e.requester !== null && sameAccount(e.requester, who)).length;
  }

  add(song: NewSong, now: Timestamp): SongEntry {
    const open = this.open();
    if (open.length >= this.limits.max_pending) {
      throw new SetListError(`the set list is full (${this.limits.max_pending} songs)`);
    }
    const requester = song.requester;
    if (
      requester !== null &&
      this.#byUser(requester) >=
        this.limits.max_pending_per_user + (song.ticket_entry != null ? 1 : 0)
    ) {
      throw new SetListError(
        `already ${this.limits.max_pending_per_user} songs requested by this person`,
      );
    }
    const entry: SongEntry = {
      no: this.#next++,
      query: song.query,
      key: song.key,
      backing: song.backing ?? "keep",
      requester,
      requester_name: song.requester_name,
      context: song.context,
      forced: song.forced ?? false,
      practice: song.practice ?? false,
      state: "preparing",
      stage: "queued",
      progress: 0,
      error: null,
      job: null,
      song: null,
      queue_item: song.queue_item ?? null,
      created_at: now,
      ready_at: null,
      reminders: 0,
      last_reminder_ms: null,
      ticket_entry: song.ticket_entry ?? null,
      dedication: song.dedication ?? null,
      dedication_entry: song.dedication_entry ?? null,
    };
    this.#entries.push(entry);
    return entry;
  }

  /**
   * Moves `e` so it stands `position`th (1 is next, clamped) among the songs still to sing
   * (preparing or ready, the playing one not counted); returns where it ended up.
   */
  move(e: SongEntry, position: number): number {
    const others = this.#entries.filter(
      (x) => x !== e && (x.state === "preparing" || x.state === "ready"),
    );
    const at = Math.min(Math.max(Math.trunc(position), 1), others.length + 1);
    const from = this.#entries.indexOf(e);
    if (from < 0) return at;
    this.#entries.splice(from, 1);
    const after = others[at - 1];
    // Before the song it now stands in front of, else behind the last one waiting.
    const to =
      after !== undefined
        ? this.#entries.indexOf(after)
        : others.length > 0
          ? this.#entries.indexOf(others[others.length - 1] as SongEntry) + 1
          : this.#entries.length;
    this.#entries.splice(to, 0, e);
    return at;
  }

  /** Moves `e` to a final state and trims the history. */
  finish(e: SongEntry, state: "done" | "failed" | "cancelled", error: string | null = null): void {
    e.state = state;
    e.error = error;
    const closed = this.#entries.filter((x) => !OPEN.includes(x.state));
    for (const old of closed.slice(0, Math.max(0, closed.length - this.limits.history))) {
      this.#entries.splice(this.#entries.indexOf(old), 1);
    }
  }
}
