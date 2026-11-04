// Pure dynamics of her inner state; `now` (epoch ms) is passed in.
//
// * Drives rise on their own toward 1 (`rise_per_hour` is the share of the remaining gap per
//   hour, so they saturate), `rest` follows tiredness (`1 - energy` of her mood), boredom rises
//   while nothing happens. Events subtract (satisfy). `longing` rises toward her crush's
//   romance while they are not with her and fades without a crush.
// * Her emotions (`EmotionEngine`) and feelings about people (`HeartBook`) live here too.
//   Drives unmet for a long time turn into emotions: wanting company (social, attention) into
//   寂寞, hunger and esteem into 不甘心, longing into 想念. Each builds as a "pressure" that
//   approaches its target slowly and holds the emotion at least that high, so the emotion does
//   not fade while the need lasts and fades at its own pace once it is met.
// * People she cares about who stay away build 想念 toward them (held, not faded, while away).
// * Policy and agenda are only stored here: she (phase C's mind loop, the activeness tool)
//   writes them; settings past `until` and agenda items past `expires_at` expire.

import {
  type AgendaInput,
  type AgendaItem,
  type ContextKey,
  DRIVE_NAMES,
  type Drives,
  type EffectiveTalkativeness,
  isJsonObject,
  type JsonValue,
  newId,
  type SelfPolicy,
  type Talkativeness,
  type TalkativenessInput,
  talkativenessScopes,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import type { SelfConfig } from "./config.js";
import { EmotionEngine, type Temperament, temperament } from "./emotions.js";
import { HeartBook } from "./heart.js";

const HOUR_MS = 3_600_000;
/** Longest agenda / reason text kept. */
const MAX_TEXT = 300;
const MAX_WHY = 200;
const DAY_MS = 24 * 60 * 60_000;

/** Characters that tell texts apart (no spaces or punctuation), lower case. */
function letters(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  const chars = [...text];
  for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/**
 * Two agenda texts say the same thing: equal or one inside the other once spaces and
 * punctuation are gone, or most of the shorter one's character pairs appear in the other.
 */
export function sameAgenda(a: string, b: string): boolean {
  const x = letters(a);
  const y = letters(b);
  if (x === "" || y === "") return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 4 && long.includes(short)) return true;
  const sa = bigrams(short);
  const sb = bigrams(long);
  if (sa.size === 0) return false;
  let shared = 0;
  for (const g of sa) if (sb.has(g)) shared++;
  return shared / sa.size >= 0.6;
}
/** Longest scope string. */
const MAX_SCOPE = 120;

/** How far above her tiredness (`1 - energy`) her own nudges may lift `rest`. */
export const REST_OVER_TIREDNESS = 0.1;

export class SelfError extends Error {
  override readonly name = "SelfError";
}

/** What the engine needs to know about the moment it advances to. */
export interface Circumstances {
  /** Her mood's energy (0..1), `null` when unknown. */
  energy: number | null;
  /** She is playing a game. */
  playing: boolean;
  /** She is live (OBS streaming or Discord Go Live). */
  streaming: boolean;
  /** Her crush is with her (in her voice channel). */
  crushTogether?: boolean;
  /** How much she cares about someone (0..1); unknown = only romance counts. */
  care?: (person: string) => number;
}

export const IDLE: Circumstances = { energy: null, playing: false, streaming: false };

/** Drives unmet for a while build these (0..1 each, see the header). */
interface Pressure {
  lonely: number;
  frustration: number;
  missing: number;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);

function cut(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

function validTimestamp(ts: string | null | undefined, what: string): string | null {
  if (ts === null || ts === undefined) return null;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new SelfError(`invalid ${what} \`${ts}\``);
  return toTimestamp(ms);
}

// ---- persisted shape ------------------------------------------------------------------------

const ContextSchema = z.object({
  platform: z.string(),
  scope: z.string().nullable(),
  channel: z.string(),
  kind: z.enum(["channel", "thread", "dm", "voice"]),
});

const AgendaSchema = z.object({
  id: z.string(),
  text: z.string(),
  why: z.string().catch(""),
  person: z.string().nullable().catch(null),
  context: ContextSchema.nullable().catch(null),
  created_at: z.string(),
  due: z.string().nullable().catch(null),
  expires_at: z.string().nullable().catch(null),
  status: z.enum(["open", "done", "expired", "dropped"]),
  closed_at: z.string().nullable().catch(null),
  blocked: z
    .object({ capability: z.string(), reason: z.string(), at: z.string() })
    .nullable()
    .catch(null)
    .default(null),
});

const TalkSchema = z.object({
  level: z.number(),
  until: z.string().nullable().catch(null),
  why: z.string().catch(""),
  set_at: z.string(),
});

const unitNum = z.number().transform(clamp01);
const pressure = unitNum.catch(0).default(0);

/** `self:state` as saved by `toJson`. */
export const SavedSchema = z.object({
  at: z.string(),
  boredom: unitNum,
  drives: z.object({
    social: unitNum.catch(0.3),
    play: unitNum.catch(0.3),
    attention: unitNum.catch(0.3),
    rest: unitNum.catch(0.3),
    curiosity: unitNum.catch(0.3),
    esteem: unitNum.catch(0.3),
    hunger: unitNum.catch(0.3),
    longing: unitNum.catch(0),
  }),
  policy: z.object({
    talkativeness: z.record(z.string(), TalkSchema).catch({}),
    initiative: unitNum.catch(0.5),
    initiative_why: z.string().catch(""),
  }),
  agenda: z.array(AgendaSchema).catch([]),
  /** Missing in records saved before emotions existed. */
  emotions: z.unknown().optional(),
  hearts: z.unknown().optional(),
  pressure: z
    .object({ lonely: pressure, frustration: pressure, missing: pressure })
    .catch({ lonely: 0, frustration: 0, missing: 0 })
    .optional(),
});

// ---- engine ---------------------------------------------------------------------------------

export class SelfEngine {
  #drives: Drives;
  #boredom: number;
  /** Her energy (mood) as of the last advance, `null` when unknown. */
  #energy: number | null = null;
  #policy: SelfPolicy;
  #agenda: AgendaItem[] = [];
  #pressure: Pressure = { lonely: 0, frustration: 0, missing: 0 };
  /** Agenda items for someone that expired since the last `takeExpired`. */
  #expired: AgendaItem[] = [];
  #at: number;
  readonly emotions: EmotionEngine;
  readonly hearts: HeartBook;

  constructor(
    private readonly config: SelfConfig,
    now: number,
    temper: Temperament = temperament().temperament,
  ) {
    const d = clamp01(config.initial_drive);
    this.#drives = Object.fromEntries(DRIVE_NAMES.map((n) => [n, d])) as Drives;
    this.#drives.longing = 0;
    this.emotions = new EmotionEngine(temper, config.emotions.floor, now);
    this.hearts = new HeartBook(
      config.heart,
      temper,
      config.utc_offset_minutes,
      config.emotions.missing_after_hours * HOUR_MS,
      now,
    );
    this.#boredom = clamp01(config.initial_boredom);
    this.#policy = {
      talkativeness: {},
      initiative: clamp01(config.initial_initiative),
      initiative_why: "",
    };
    this.#at = now;
  }

  drives(): Drives {
    return { ...this.#drives };
  }

  boredom(): number {
    return this.#boredom;
  }

  /** Drift from the last advance up to `now`; expires policy and agenda. */
  advance(now: number, c: Circumstances): void {
    const dt = now - this.#at;
    if (dt > 0) {
      const hours = dt / HOUR_MS;
      const rise = this.config.rise_per_hour;
      const toward1 = (v: number, r: number) => 1 - (1 - v) * Math.exp(-r * hours);
      const d = this.#drives;
      d.social = toward1(d.social, rise.social);
      d.play = toward1(d.play, rise.play);
      d.attention = toward1(d.attention, rise.attention);
      d.curiosity = toward1(d.curiosity, rise.curiosity);
      d.esteem = toward1(d.esteem, rise.esteem);
      d.hunger = toward1(d.hunger, rise.hunger);
      this.#boredom = toward1(this.#boredom, this.config.boredom_per_hour);
      // The crush as of the start of the interval.
      const crush = this.hearts.crush(this.#at);
      if (crush === null) {
        // Nobody to long for: it fades (half-life 6 hours).
        d.longing *= 0.5 ** (hours / 6);
      } else if (!c.crushTogether) {
        const target = clamp01(0.3 + crush.romance);
        if (target > d.longing) {
          d.longing += (target - d.longing) * (1 - Math.exp(-rise.longing * hours));
        }
      }
      this.#energy = c.energy;
      if (c.energy !== null) {
        const target = clamp01(1 - c.energy);
        const alpha = 1 - 0.5 ** (dt / (this.config.rest_half_life_mins * 60_000));
        d.rest += (target - d.rest) * alpha;
      }
      const s = this.config.satisfy;
      if (c.playing) {
        d.play -= s.playing_per_hour * hours;
        this.#boredom -= s.playing_per_hour * hours;
      }
      if (c.streaming) {
        d.attention -= s.streaming_per_hour * hours;
        d.rest += s.streaming_rest_per_hour * hours;
      }
      if (c.crushTogether) d.longing -= s.crush_together_per_hour * hours;
      for (const n of DRIVE_NAMES) d[n] = clamp01(d[n]);
      this.#boredom = clamp01(this.#boredom);
      this.emotions.advance(now);
      this.hearts.advance(now);
      this.#unmet(hours, now, c, crush?.person ?? null);
      this.#at = now;
    }
    this.#expire(now);
  }

  /** Emotions from drives unmet for a while and from people she cares about staying away. */
  #unmet(hours: number, now: number, c: Circumstances, crush: string | null): void {
    const e = this.config.emotions;
    const t = this.emotions.temperament.emotions;
    const d = this.#drives;
    const above = (v: number, level: number) => (v > level ? (v - level) / (1 - level) : 0);
    const build = (key: keyof Pressure, target: number, perHour: number) => {
      const p = this.#pressure[key];
      this.#pressure[key] =
        target > p ? p + (target - p) * (1 - Math.exp(-perHour * hours)) : clamp01(target);
    };
    // Long-unmet needs weigh, but not to the top: 寂寞 up to 0.8, the grumbling up to 0.6.
    build(
      "lonely",
      0.8 * above(Math.max(d.social, d.attention), e.lonely_social),
      e.lonely_per_hour * t.lonely.gain,
    );
    build(
      "frustration",
      0.6 * above(Math.max(d.hunger, d.esteem), e.unmet_level),
      e.unmet_per_hour * t.frustration.gain,
    );
    build(
      "missing",
      c.crushTogether ? 0 : above(d.longing, 0.4),
      (e.missing_per_day / 24) * t.missing.gain,
    );
    const lonelyCause = d.attention > d.social ? "很久沒人理我" : "很久沒人陪我聊天";
    this.emotions.atLeast("lonely", this.#pressure.lonely, lonelyCause, null, now);
    const grumble = d.hunger >= d.esteem ? "肚子餓,沒人給我白飯" : "都沒人認可我";
    this.emotions.atLeast("frustration", this.#pressure.frustration, grumble, null, now);

    // 想念 toward people she cares about who stay away; the strongest is also hers.
    let missing = crush === null ? 0 : this.#pressure.missing;
    let about: string | null = missing > 0 ? crush : null;
    const care = c.care;
    const after = e.missing_after_hours * HOUR_MS;
    for (const person of this.hearts.people()) {
      const seen = this.hearts.lastSeen(person);
      if (seen === null || now - seen < after) continue;
      const level = Math.max(care ? care(person) : 0, this.hearts.romanceOf(person));
      if (level <= 0) continue;
      const v = this.hearts.long(person, "missing", level, (e.missing_per_day / 24) * hours, now);
      if (v > missing) {
        missing = v;
        about = person;
      }
    }
    if (missing > 0) {
      this.emotions.atLeast("missing", missing, "想念某個人", about, now);
    }
  }

  /** Agenda items about someone that expired since the last call (she did not get to them). */
  takeExpired(): AgendaItem[] {
    return this.#expired.splice(0);
  }

  /**
   * Adds `delta` (negative = satisfied). `rest` follows her tiredness: nudges never lift it more
   * than `REST_OVER_TIREDNESS` above it, so wanting a break cannot outgrow how tired she is.
   */
  adjust(delta: Partial<Drives> & { boredom?: number }): void {
    for (const n of DRIVE_NAMES) {
      const v = delta[n];
      if (v === undefined || !Number.isFinite(v)) continue;
      let next = clamp01(this.#drives[n] + v);
      if (n === "rest" && v > 0 && this.#energy !== null) {
        next = Math.min(next, Math.max(this.#drives.rest, 1 - this.#energy + REST_OVER_TIREDNESS));
      }
      this.#drives[n] = next;
    }
    if (delta.boredom !== undefined && Number.isFinite(delta.boredom)) {
      this.#boredom = clamp01(this.#boredom + delta.boredom);
    }
  }

  // ---- policy -------------------------------------------------------------------------

  policy(now: number): SelfPolicy {
    this.#expire(now);
    return {
      talkativeness: Object.fromEntries(
        Object.entries(this.#policy.talkativeness).map(([k, v]) => [k, { ...v }]),
      ),
      initiative: this.#policy.initiative,
      initiative_why: this.#policy.initiative_why,
    };
  }

  talkativeness(context: ContextKey | null, now: number): EffectiveTalkativeness | null {
    this.#expire(now);
    for (const scope of talkativenessScopes(context)) {
      const t = this.#policy.talkativeness[scope];
      if (t) return { ...t, scope };
    }
    return null;
  }

  setTalkativeness(scope: string, input: TalkativenessInput, now: number): Talkativeness {
    const key = scope.trim();
    if (key === "" || key.length > MAX_SCOPE) throw new SelfError(`invalid scope \`${scope}\``);
    if (!Number.isFinite(input.level)) throw new SelfError("talkativeness level is not a number");
    const max = now + this.config.max_talkativeness_hours * HOUR_MS;
    let until: number | null = null;
    const absolute = validTimestamp(input.until, "until");
    if (absolute !== null) until = timestampMs(absolute);
    else if (input.forMs !== null && input.forMs !== undefined) until = now + input.forMs;
    if (until !== null && until <= now) throw new SelfError("`until` is in the past");
    // Open-ended settings are fine; only explicit expiries are capped.
    if (until !== null) until = Math.min(until, max);
    const t: Talkativeness = {
      level: clamp01(input.level),
      until: until === null ? null : toTimestamp(until),
      why: cut(input.why, MAX_WHY),
      set_at: toTimestamp(now),
    };
    this.#policy.talkativeness[key] = t;
    return { ...t };
  }

  clearTalkativeness(scope: string): boolean {
    const key = scope.trim();
    if (!(key in this.#policy.talkativeness)) return false;
    delete this.#policy.talkativeness[key];
    return true;
  }

  initiative(): number {
    return this.#policy.initiative;
  }

  setInitiative(level: number, why: string): void {
    if (!Number.isFinite(level)) throw new SelfError("initiative level is not a number");
    this.#policy.initiative = clamp01(level);
    this.#policy.initiative_why = cut(why, MAX_WHY);
  }

  // ---- agenda -------------------------------------------------------------------------

  /** Open items, soonest due first (no due date last), then by creation. */
  agenda(now: number): AgendaItem[] {
    this.#expire(now);
    return this.#agenda
      .filter((a) => a.status === "open")
      .sort(byDue)
      .map((a) => ({ ...a }));
  }

  /** Open items first, then closed ones, newest closed first. */
  allAgenda(now: number): AgendaItem[] {
    const open = this.agenda(now);
    const closed = this.#agenda
      .filter((a) => a.status !== "open")
      .sort((a, b) => Date.parse(b.closed_at ?? "") - Date.parse(a.closed_at ?? ""))
      .map((a) => ({ ...a }));
    return [...open, ...closed];
  }

  addAgenda(input: AgendaInput, now: number): AgendaItem {
    const text = cut(input.text, MAX_TEXT);
    if (text === "") throw new SelfError("agenda text is empty");
    const asked = validTimestamp(input.expiresAt, "expires_at");
    if (asked !== null && timestampMs(asked) <= now) {
      throw new SelfError("`expires_at` is in the past");
    }
    const latest = now + this.config.max_agenda_days * DAY_MS;
    const expires = asked !== null && timestampMs(asked) <= latest ? asked : toTimestamp(latest);
    // The same item again: the open one stays (its expiry moves out if this one lasts longer).
    const twin = this.#agenda.find((a) => a.status === "open" && sameAgenda(a.text, text));
    if (twin) {
      if (twin.expires_at === null || timestampMs(twin.expires_at) < timestampMs(expires)) {
        twin.expires_at = expires;
      }
      return { ...twin };
    }
    const item: AgendaItem = {
      id: newId(),
      text,
      why: cut(input.why ?? "", MAX_WHY),
      person: input.person ?? null,
      context: input.context ? { ...input.context } : null,
      created_at: toTimestamp(now),
      due: validTimestamp(input.due, "due"),
      expires_at: expires,
      status: "open",
      closed_at: null,
      blocked: null,
    };
    this.#agenda.push(item);
    const open = this.#agenda.filter((a) => a.status === "open");
    const excess = open.length - this.config.max_open_agenda;
    if (excess > 0) {
      // The oldest open items make room.
      const oldest = new Set(
        open
          .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
          .slice(0, excess)
          .map((a) => a.id),
      );
      for (const a of this.#agenda) if (oldest.has(a.id)) this.#close(a, "dropped", now);
    }
    this.#trimClosed();
    return { ...item };
  }

  completeAgenda(id: string, now: number): AgendaItem | null {
    return this.#finish(id, "done", now);
  }

  dropAgenda(id: string, now: number): AgendaItem | null {
    return this.#finish(id, "dropped", now);
  }

  /** Puts an open item on hold until `unblockAgenda`. */
  blockAgenda(
    id: string,
    block: { capability: string; reason: string },
    now: number,
  ): AgendaItem | null {
    this.#expire(now);
    const item = this.#agenda.find((a) => a.id === id && a.status === "open");
    if (!item) return null;
    item.blocked = {
      capability: cut(block.capability, 64),
      reason: cut(block.reason, MAX_WHY),
      at: toTimestamp(now),
    };
    return { ...item };
  }

  unblockAgenda(id: string, now: number): AgendaItem | null {
    this.#expire(now);
    const item = this.#agenda.find((a) => a.id === id && a.status === "open");
    if (!item?.blocked) return null;
    item.blocked = null;
    return { ...item };
  }

  #finish(id: string, status: "done" | "dropped", now: number): AgendaItem | null {
    this.#expire(now);
    const item = this.#agenda.find((a) => a.id === id && a.status === "open");
    if (!item) return null;
    this.#close(item, status, now);
    this.#trimClosed();
    return { ...item };
  }

  #close(item: AgendaItem, status: "done" | "dropped" | "expired", now: number): void {
    item.status = status;
    item.closed_at = toTimestamp(now);
  }

  #trimClosed(): void {
    const closed = this.#agenda
      .filter((a) => a.status !== "open")
      .sort((a, b) => Date.parse(b.closed_at ?? "") - Date.parse(a.closed_at ?? ""));
    const drop = new Set(closed.slice(this.config.keep_closed_agenda).map((a) => a.id));
    if (drop.size > 0) this.#agenda = this.#agenda.filter((a) => !drop.has(a.id));
  }

  #expire(now: number): void {
    for (const [scope, t] of Object.entries(this.#policy.talkativeness)) {
      if (t.until !== null && Date.parse(t.until) <= now) delete this.#policy.talkativeness[scope];
    }
    let closed = false;
    for (const a of this.#agenda) {
      if (a.status === "open" && a.expires_at !== null && Date.parse(a.expires_at) <= now) {
        a.status = "expired";
        a.closed_at = a.expires_at;
        closed = true;
        if (a.person !== null) this.#expired.push({ ...a });
      }
    }
    if (closed) this.#trimClosed();
  }

  // ---- persistence --------------------------------------------------------------------

  toJson(): JsonValue {
    return {
      at: toTimestamp(this.#at),
      boredom: this.#boredom,
      drives: { ...this.#drives },
      policy: this.policy(this.#at) as unknown as JsonValue,
      agenda: this.#agenda.map((a) => ({ ...a })) as unknown as JsonValue,
      emotions: this.emotions.toJson(),
      hearts: this.hearts.toJson(),
      pressure: { ...this.#pressure },
    };
  }

  /** Restores a `toJson` value; drift from its `at` to `now` is applied as idle time. */
  restore(value: JsonValue, now: number): boolean {
    if (!isJsonObject(value)) return false;
    const parsed = SavedSchema.safeParse(value);
    if (!parsed.success) return false;
    const saved = parsed.data;
    this.#drives = { ...saved.drives };
    this.#boredom = saved.boredom;
    this.#policy = {
      talkativeness: Object.fromEntries(
        Object.entries(saved.policy.talkativeness).map(([k, t]) => [
          k,
          { ...t, level: clamp01(t.level) },
        ]),
      ),
      initiative: saved.policy.initiative,
      initiative_why: saved.policy.initiative_why,
    };
    this.#agenda = saved.agenda.map((a) => ({ ...a }));
    const at = Date.parse(saved.at);
    this.#at = Number.isNaN(at) ? now : Math.min(at, now);
    this.#pressure = { ...(saved.pressure ?? { lonely: 0, frustration: 0, missing: 0 }) };
    this.emotions.restore(saved.emotions as JsonValue | undefined, this.#at);
    this.hearts.restore(saved.hearts as JsonValue | undefined, this.#at);
    this.advance(now, IDLE);
    // What expired while she was away is not news.
    this.#expired = [];
    return true;
  }
}

function byDue(a: AgendaItem, b: AgendaItem): number {
  const da = a.due === null ? Number.POSITIVE_INFINITY : Date.parse(a.due);
  const db = b.due === null ? Number.POSITIVE_INFINITY : Date.parse(b.due);
  if (da !== db) return da < db ? -1 : 1;
  return Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : 1);
}
