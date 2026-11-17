// Her schedules on the new runner (docs/design/v5-architecture.md §7.3 「排程」): a time she sets
// for herself to wake up later, once or every day, kept in the `initiative` plugin's table so a
// restart loses nothing. When one comes due, the initiative (`initiative.ts`) makes it an inbox
// item and an opportunity to wake her in its place.
//
// The same book serves `remind_me` while the new runner runs (`reminders`): the mind module keeps
// the tool, its name and its spec, and finds its timers here instead of in its own settings keys.
//
// Times are local at `offsetMinutes`. A relative time and a daily one are plain arithmetic here;
// `HH:MM` and `YYYY-MM-DD HH:MM` are read by the parser `remind_me` uses (`parseAt`, handed in by
// Core, which knows the mind package).

import { CapabilityError } from "@miyoria/gate/actions";
import {
  type AccountRef,
  type ContextKey,
  newId,
  type Reminder,
  repairHandleText,
  sameAccount,
} from "@miyoria/types";
import type { InitiativeStore, ScheduleRow, ScheduleSource } from "./initiative-store.js";
import { SCHEDULE_TOOL } from "./initiative-texts.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A one-off time that could not wake her for this long is dropped as missed (`remind_me`'s). */
export const MISSED_AFTER_MS = DAY_MS;
/** Characters of a note kept (`remind_me` keeps 120). */
const MAX_NOTE = 120;

/** `remind_me`'s parser of `HH:MM` and `YYYY-MM-DD HH:MM` (heart's `parseAt`). */
export type ParseAt = (at: string, now: number, offsetMinutes: number) => number | null;

export interface ScheduleLimits {
  /** Open schedules at most (both tools together). */
  max: number;
  /** Open `remind_me` timers one person may have asked for. */
  perPerson: number;
  /** How far ahead a time may be set (days). */
  maxDays: number;
}

/** What `when` means: a moment, or a daily clock time and its next moment. */
export type When = { due: number; daily: string | null };

export class ScheduleError extends Error {
  override readonly name = "ScheduleError";
}

const RELATIVE =
  /^(?:in\s*)?(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|分鐘?|h|hr|hrs|hours?|小時|個小時|d|days?|天)\s*(?:後|later)?$/i;
const DAILY = /^(?:daily|every\s*day|每天|每日)\s*(\d{1,2}):(\d{2})$/i;
const CLOCK = /^(\d{1,2}):(\d{2})$/;

function unitMs(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("m") || u.startsWith("分")) return MINUTE_MS;
  if (u.startsWith("h") || u.includes("小時")) return HOUR_MS;
  return DAY_MS;
}

/** The next moment local clock `hh:mm` shows after `now`. */
export function nextAt(hh: number, mm: number, now: number, offsetMinutes: number): number {
  const local = new Date(now + offsetMinutes * MINUTE_MS);
  let at =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh, mm) -
    offsetMinutes * MINUTE_MS;
  while (at <= now) at += DAY_MS;
  return at;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** What `when` means at `now`; `null`: it cannot be read. */
export function parseWhen(
  when: string,
  now: number,
  offsetMinutes: number,
  parseAt: ParseAt | null,
): When | null {
  const s = when.trim().replace(/\s+/g, " ");
  const rel = RELATIVE.exec(s);
  if (rel) {
    const amount = Number(rel[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return { due: now + Math.round(amount * unitMs(String(rel[2]))), daily: null };
  }
  const daily = DAILY.exec(s);
  if (daily) {
    const hh = Number(daily[1]);
    const mm = Number(daily[2]);
    if (hh > 23 || mm > 59) return null;
    return { due: nextAt(hh, mm, now, offsetMinutes), daily: `${pad(hh)}:${pad(mm)}` };
  }
  if (parseAt !== null) {
    const due = parseAt(s, now, offsetMinutes);
    return due === null ? null : { due, daily: null };
  }
  const clock = CLOCK.exec(s);
  if (!clock) return null;
  const hh = Number(clock[1]);
  const mm = Number(clock[2]);
  if (hh > 23 || mm > 59) return null;
  return { due: nextAt(hh, mm, now, offsetMinutes), daily: null };
}

/** `MM/DD HH:MM` local. */
export function localWhen(at: number, offsetMinutes: number): string {
  const d = new Date(at + offsetMinutes * MINUTE_MS);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** The short key she and the panel use: `S…` for hers, `R…` for `remind_me`'s, stable for its life. */
export function scheduleKey(row: Pick<ScheduleRow, "id" | "source">): string {
  const tail = row.id
    .replace(/[^0-9A-Za-z]/g, "")
    .slice(-5)
    .toUpperCase();
  return `${row.source === "remind_me" ? "R" : "S"}${tail}`;
}

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** What `remind_me` reads of a timer (`@miyoria/types` `Reminder`). */
export function asReminder(row: ScheduleRow): Reminder {
  return {
    id: row.id,
    key: scheduleKey(row),
    what: row.note,
    due: row.due,
    daily: row.daily !== null,
    context: row.context,
    person: row.person,
    for_account: row.for_account,
    fired: row.fired,
    created_at: row.created_at,
  };
}

/** What `remind_me`'s `set` hands over (heart's `ReminderInput`). */
export interface ReminderInput {
  what: string;
  due: number;
  daily: boolean;
  context: ContextKey | null;
  person: string | null;
  for_account: AccountRef | null;
}

/** The book `remind_me` uses while the new runner runs (heart's `ReminderBackend`). */
export interface ReminderBackend {
  readonly offsetMinutes: number;
  now(): number;
  list(): Reminder[];
  of(account: AccountRef): Reminder[];
  get(idOrKey: string): Reminder | null;
  cancel(idOrKey: string): boolean;
  set(input: ReminderInput): Reminder;
}

export interface ScheduleBookOptions {
  store: InitiativeStore;
  now(): number;
  offsetMinutes: number;
  limits: ScheduleLimits;
  parseAt?: ParseAt | null;
  /** Every timer set, ended or cancelled (the panel's `mind.reminder`). */
  publish?: (reminder: Reminder, state: "set" | "fired" | "done" | "cancelled") => void;
}

export class ScheduleBook {
  readonly #o: ScheduleBookOptions;
  /** `remind_me`'s view of this book. */
  readonly reminders: ReminderBackend;

  constructor(options: ScheduleBookOptions) {
    this.#o = options;
    const book = this;
    this.reminders = {
      get offsetMinutes() {
        return book.offsetMinutes;
      },
      now: () => book.now(),
      list: () => book.open().map(asReminder),
      of: (account) =>
        book
          .open()
          .filter((r) => r.for_account !== null && sameAccount(r.for_account, account))
          .map(asReminder),
      get: (idOrKey) => {
        const row = book.find(idOrKey);
        return row === null ? null : asReminder(row);
      },
      cancel: (idOrKey) => book.cancel(idOrKey) !== null,
      set: (input) => {
        try {
          return asReminder(book.#remind(input));
        } catch (error) {
          if (error instanceof ScheduleError) throw new CapabilityError(error.message);
          throw error;
        }
      },
    };
  }

  get offsetMinutes(): number {
    return this.#o.offsetMinutes;
  }

  now(): number {
    return this.#o.now();
  }

  /** What `when` means now; `null`: unreadable. */
  when(when: string): When | null {
    return parseWhen(when, this.now(), this.offsetMinutes, this.#o.parseAt ?? null);
  }

  /** The schedules still waiting, soonest first. */
  open(): ScheduleRow[] {
    return this.#o.store.openSchedules();
  }

  /** An open schedule by id or key. */
  find(idOrKey: string): ScheduleRow | null {
    const k = idOrKey.trim();
    if (k === "") return null;
    return (
      this.open().find((r) => r.id === k || scheduleKey(r).toUpperCase() === k.toUpperCase()) ??
      null
    );
  }

  /** Sets a time she chose (`schedule`); throws `ScheduleError` in her words. */
  set(input: { when: When; note: string; context: ContextKey | null }): ScheduleRow {
    return this.#add({
      note: input.note,
      due: input.when.due,
      daily: input.when.daily,
      context: input.context,
      person: null,
      for_account: null,
      source: "schedule",
    });
  }

  #remind(input: ReminderInput): ScheduleRow {
    const { perPerson } = this.#o.limits;
    if (input.for_account !== null && this.reminders.of(input.for_account).length >= perPerson) {
      throw new ScheduleError(SCHEDULE_TOOL.perPerson(perPerson));
    }
    const d = new Date(input.due + this.offsetMinutes * MINUTE_MS);
    return this.#add({
      note: input.what,
      due: input.due,
      daily: input.daily ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : null,
      context: input.context,
      person: input.person,
      for_account: input.for_account,
      source: "remind_me",
    });
  }

  #add(s: {
    note: string;
    due: number;
    daily: string | null;
    context: ContextKey | null;
    person: string | null;
    for_account: AccountRef | null;
    source: ScheduleSource;
  }): ScheduleRow {
    const now = this.now();
    const { max, maxDays } = this.#o.limits;
    const note = repairHandleText(cut(s.note, MAX_NOTE * 2));
    if (note === null || note.trim() === "") throw new ScheduleError(SCHEDULE_TOOL.empty);
    if (!Number.isFinite(s.due) || s.due <= now) throw new ScheduleError(SCHEDULE_TOOL.past);
    if (s.due - now > maxDays * DAY_MS) throw new ScheduleError(SCHEDULE_TOOL.tooFar(maxDays));
    const open = this.open().length;
    if (open >= max) throw new ScheduleError(SCHEDULE_TOOL.tooMany(open, max));
    const person = s.person?.trim() ? s.person.trim() : null;
    const row = this.#o.store.addSchedule({
      id: newId(),
      note: cut(note, MAX_NOTE),
      due: s.due,
      daily: s.daily,
      context: s.context,
      person,
      for_account: s.for_account,
      source: s.source,
      at: now,
    });
    this.#o.publish?.(asReminder(row), "set");
    return row;
  }

  /** Cancels an open schedule by id or key; the row, or `null` when there was none. */
  cancel(idOrKey: string): ScheduleRow | null {
    const row = this.find(idOrKey);
    if (row === null) return null;
    if (!this.#o.store.endSchedule(row.id, "cancelled", row.fired, this.now())) return null;
    this.#o.publish?.(asReminder(row), "cancelled");
    return row;
  }

  /**
   * The schedules due at `now`, each moved on as it is handed out: a daily one to its next time,
   * a one-off one ended as fired. A one-off one overdue by more than `MISSED_AFTER_MS` (the
   * process was down) ends as missed and is not handed out; a daily one goes on with its next day.
   */
  takeDue(now = this.now()): ScheduleRow[] {
    const out: ScheduleRow[] = [];
    for (const row of this.open()) {
      const due = Date.parse(row.due);
      if (due > now) break;
      const fired = row.fired + 1;
      if (row.daily === null) {
        if (now - due > MISSED_AFTER_MS) {
          this.#o.store.endSchedule(row.id, "missed", row.fired, now);
          this.#o.publish?.(asReminder(row), "done");
          continue;
        }
        this.#o.store.endSchedule(row.id, "fired", fired, now);
      } else {
        const [hh, mm] = row.daily.split(":").map(Number) as [number, number];
        this.#o.store.reschedule(row.id, nextAt(hh, mm, now, this.offsetMinutes), fired, now);
      }
      const handed = { ...row, fired };
      this.#o.publish?.(asReminder(handed), "fired");
      out.push(handed);
    }
    return out;
  }

  /** When the next open schedule is due (epoch ms), or `null`. */
  nextDue(): number | null {
    const first = this.open()[0];
    return first === undefined ? null : Date.parse(first.due);
  }
}

/** A line of `schedule_list`. */
export function scheduleLine(row: ScheduleRow, offsetMinutes: number, where: string): string {
  const when =
    row.daily === null ? localWhen(Date.parse(row.due), offsetMinutes) : `每天 ${row.daily}`;
  return `${scheduleKey(row)} ${when} ${where}:${row.note}`;
}
