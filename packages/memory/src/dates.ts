// Birthdays and other dates people tell her (`remember_date`), and the day she met them.
//
// The dates are kept in the settings store (`memory.dates`), one list per profile. On the day
// itself (in `[modules.memory.dates] utc_offset_minutes`), the first time the person says
// something, she gets a followup due right away ("today is Owen's birthday"): the Arbiter's
// followup producer brings it up while they are around, like any other followup, and a followup
// nobody brought up within `followup_max_age_hours` is dropped, so it never comes a day late.
// Each date is brought up once a year. The day she met someone (their person record's
// `created_at`) counts from the first anniversary on, when `met_anniversary` is on.

import { errorMessage, getLogger } from "@miyoria/kernel";
import type { PeopleStore, SettingsStore } from "@miyoria/store";
import type { Tool, ToolContext, ToolSpec } from "@miyoria/tools";
import {
  type AccountRef,
  type Clock,
  type ContextKey,
  isJsonObject,
  type JsonValue,
  newId,
  type PersonId,
  type ProfileId,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import type { DatesConfig } from "./config.js";
import type { MemoryEngine } from "./engine.js";
import { scopeForNew } from "./scope.js";

const log = getLogger("memory.dates");

/** Settings store key of the dates. */
export const DATES_KEY = "memory.dates";
export const REMEMBER_DATE = "remember_date";
export const FORGET_DATE = "forget_date";

/** Longest label (characters). */
const MAX_LABEL = 16;
/** Most dates one person may have. */
const MAX_PER_PERSON = 8;

/** One date of one person. */
export interface DateEntry {
  id: string;
  person: PersonId;
  /** Their name when it was told (for the followup's wording). */
  name: string;
  month: number;
  day: number;
  /** What the day is, e.g. `生日`. */
  label: string;
  added_at: string;
}

/** What is kept: the dates, and the year each occasion was last brought up. */
export interface DatesState {
  entries: DateEntry[];
  /** Occasion key (`date:<id>` / `met:<person>`) → year it was last brought up. */
  greeted: Record<string, number>;
}

/** A calendar day. */
export interface LocalDay {
  year: number;
  month: number;
  day: number;
}

/** The calendar day of `nowMs` at `offsetMinutes` from UTC. */
export function localDay(nowMs: number, offsetMinutes: number): LocalDay {
  const d = new Date(nowMs + offsetMinutes * 60_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Whether `month`/`day` falls on `today` (29 February is kept on the 28th in other years). */
export function fallsOn(month: number, day: number, today: LocalDay): boolean {
  if (month === 2 && day === 29 && !isLeap(today.year)) {
    return today.month === 2 && today.day === 28;
  }
  return month === today.month && day === today.day;
}

/** Whether `month`/`day` is a real day of the calendar (29 February included). */
export function validDay(month: number, day: number): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12) return false;
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
  return day >= 1 && day <= days;
}

/** Something to bring up today: its key (for once a year) and the followup's text. */
export interface Occasion {
  key: string;
  text: string;
}

/**
 * Today's occasions of `person`: their dates that fall on `today`, and the day she met them
 * (`metAt`, from the first anniversary on) when `met` is on.
 */
export function occasionsOf(
  state: DatesState,
  person: PersonId,
  name: string,
  metAt: string | null,
  today: LocalDay,
  options: { met: boolean; offsetMinutes: number },
): Occasion[] {
  const out: Occasion[] = [];
  const md = `${today.month}/${today.day}`;
  for (const e of state.entries) {
    if (e.person !== person || !fallsOn(e.month, e.day, today)) continue;
    const text =
      e.label === "生日"
        ? `今天(${md})是${name}的生日,找機會跟${name}說聲生日快樂`
        : `今天(${md})是${name}說過的「${e.label}」,可以跟${name}提一下`;
    out.push({ key: `date:${e.id}`, text });
  }
  if (options.met && metAt !== null) {
    const ms = Date.parse(metAt);
    if (Number.isFinite(ms)) {
      const met = localDay(ms, options.offsetMinutes);
      const years = today.year - met.year;
      if (years >= 1 && fallsOn(met.month, met.day, today)) {
        out.push({
          key: `met:${person}`,
          text: `今天(${md})是你和${name}認識滿 ${years} 年的日子,可以跟${name}提一下`,
        });
      }
    }
  }
  return out.filter((o) => state.greeted[o.key] !== today.year);
}

/** The dates of a profile in the settings store (read once, written on change). */
export class DateBook {
  #state: DatesState | null = null;

  constructor(
    private readonly settings: SettingsStore | null,
    private readonly profile: ProfileId,
  ) {}

  async state(): Promise<DatesState> {
    if (this.#state !== null) return this.#state;
    let raw: JsonValue | null = null;
    try {
      raw = (await this.settings?.get(this.profile, DATES_KEY)) ?? null;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot read dates");
    }
    this.#state = parseState(raw);
    return this.#state;
  }

  async #save(): Promise<void> {
    if (!this.settings || this.#state === null) return;
    await this.settings.set(this.profile, DATES_KEY, this.#state as unknown as JsonValue);
  }

  /** Adds (or replaces, by label) a date of `person`. */
  async add(entry: Omit<DateEntry, "id" | "added_at">, now: number): Promise<DateEntry> {
    const state = await this.state();
    const kept = state.entries.filter(
      (e) => !(e.person === entry.person && e.label === entry.label),
    );
    if (kept.filter((e) => e.person === entry.person).length >= MAX_PER_PERSON) {
      throw new Error("too many dates");
    }
    const added: DateEntry = { ...entry, id: newId(), added_at: toTimestamp(now) };
    state.entries = [...kept, added];
    await this.#save();
    return added;
  }

  /** Removes `person`'s date called `label`; whether there was one. */
  async remove(person: PersonId, label: string): Promise<boolean> {
    const state = await this.state();
    const kept = state.entries.filter((e) => !(e.person === person && e.label === label));
    if (kept.length === state.entries.length) return false;
    state.entries = kept;
    await this.#save();
    return true;
  }

  async greeted(key: string, year: number): Promise<void> {
    const state = await this.state();
    state.greeted[key] = year;
    await this.#save();
  }
}

function parseState(raw: JsonValue | null): DatesState {
  const state: DatesState = { entries: [], greeted: {} };
  if (!isJsonObject(raw)) return state;
  for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
    if (!isJsonObject(e)) continue;
    const { id, person, name, month, day, label, added_at } = e;
    if (typeof id !== "string" || typeof person !== "string" || typeof label !== "string") continue;
    if (typeof month !== "number" || typeof day !== "number" || !validDay(month, day)) continue;
    state.entries.push({
      id,
      person: person as PersonId,
      name: typeof name === "string" ? name : "",
      month,
      day,
      label,
      added_at: typeof added_at === "string" ? added_at : "",
    });
  }
  if (isJsonObject(raw.greeted)) {
    for (const [key, year] of Object.entries(raw.greeted)) {
      if (typeof year === "number") state.greeted[key] = year;
    }
  }
  return state;
}

/**
 * Turns today's occasions of whoever just spoke into followups due now. Each person is looked at
 * once a day per run.
 */
export class DateGreeter {
  readonly #checked = new Set<string>();

  constructor(
    private readonly book: DateBook,
    private readonly engine: MemoryEngine,
    private readonly people: PeopleStore | null,
    private readonly config: () => DatesConfig,
  ) {}

  async seen(account: AccountRef, context: ContextKey, nowMs: number): Promise<number> {
    const cfg = this.config();
    if (!cfg.enabled || !this.people) return 0;
    const today = localDay(nowMs, cfg.utc_offset_minutes);
    const person = await this.people.personByAccount(account);
    if (!person) return 0;
    const memo = `${person.id}:${today.year}-${today.month}-${today.day}`;
    if (this.#checked.has(memo)) return 0;
    this.#checked.add(memo);
    if (this.#checked.size > 10_000) this.#checked.clear();
    const name = (await this.engine.nameOfPerson(person.id)) ?? person.display_name;
    const occasions = occasionsOf(
      await this.book.state(),
      person.id,
      name,
      person.created_at,
      today,
      {
        met: cfg.met_anniversary,
        offsetMinutes: cfg.utc_offset_minutes,
      },
    );
    let made = 0;
    for (const o of occasions) {
      const stored = await this.engine.store(
        {
          kind: "followup",
          scope: scopeForNew(this.engine.config, context, account, "followup", null),
          subjects: [person.id],
          content: o.text,
          importance: 0.6,
          confidence: 1,
          source_context: context,
          due: toTimestamp(nowMs),
          origin: "experienced",
        },
        toTimestamp(nowMs),
      );
      if (stored.type === "refused") continue;
      await this.book.greeted(o.key, today.year);
      made++;
    }
    return made;
  }
}

function intArg(args: JsonValue, key: string): number | null {
  const v = isJsonObject(args) ? args[key] : undefined;
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function labelArg(args: JsonValue): string {
  const v = isJsonObject(args) ? args.label : undefined;
  const label = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return label === "" ? "生日" : [...label].slice(0, MAX_LABEL).join("");
}

/** `remember_date`: a date of the person she is talking with (their birthday by default). */
export class RememberDateTool implements Tool {
  readonly spec: ToolSpec = {
    name: REMEMBER_DATE,
    description:
      "正在跟你說話的人告訴你他的生日或某個對他重要的日子(例如紀念日)時記下來,那天他出現時你會想起來。只記對方自己說的,不記別人的。",
    parameters: {
      type: "object",
      properties: {
        month: { type: "integer", minimum: 1, maximum: 12 },
        day: { type: "integer", minimum: 1, maximum: 31 },
        label: { type: "string", description: "什麼日子,預設「生日」,例如「交往紀念日」" },
      },
      required: ["month", "day"],
    },
  };

  constructor(
    private readonly book: DateBook,
    private readonly engine: MemoryEngine,
    private readonly clock: Clock = systemClock,
  ) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const month = intArg(args, "month");
    const day = intArg(args, "day");
    if (month === null || day === null || !validDay(month, day)) return "沒有這一天,沒有記。";
    const person = await this.engine.personOf(ctx.account);
    if (person === null) return "我還不知道你是誰,沒辦法記。";
    const name = (await this.engine.nameOf(ctx.account)) ?? "";
    const label = labelArg(args);
    try {
      await this.book.add({ person, name, month, day, label }, this.clock.now());
    } catch {
      return "你的日子我記太多了,先忘掉一個再說。";
    }
    return `記住了:${month}/${day} 是你的${label}。`;
  }
}

/** `forget_date`: drops a date of the person she is talking with. */
export class ForgetDateTool implements Tool {
  readonly spec: ToolSpec = {
    name: FORGET_DATE,
    description: "正在跟你說話的人要你忘掉他的生日或某個日子時用。",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "什麼日子,預設「生日」" },
      },
    },
  };

  constructor(
    private readonly book: DateBook,
    private readonly engine: MemoryEngine,
  ) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const person = await this.engine.personOf(ctx.account);
    if (person === null) return "我沒有記你的日子。";
    const label = labelArg(args);
    return (await this.book.remove(person, label))
      ? `忘掉你的${label}了。`
      : `我沒有記你的${label}。`;
  }
}
