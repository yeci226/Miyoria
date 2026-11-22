// Her real things as the local stocks' daily signal (docs/design/exchange.md §9). A source
// (`sources.ts`) counts one company's thing for a completed Taipei day; this compares that count
// with the same company's own trailing baseline and gives the signal the simulator (`local.ts`)
// turns into the gap at the next day's 12:00 tick (at most ±3%, from YESTERDAY's count only).
//
// The mapping, per company (`[modules.exchange.local_signals]`):
// - the baseline is the previous `baseline_days` days the source has whole on record: their
//   median `m` and their spread `s` (the median absolute distance from `m`, ×1.4826, so a normal
//   day-to-day wobble has `s` about its standard deviation). Robust: one huge day in the window
//   moves neither, and days of zeros give `m = s = 0`;
// - the day's distance from the median over the scale, `(x − m) / max(spread·s, relative·m,
//   floor)`, held within [-1, 1]: a full signal needs the day far from usual in its own terms, by
//   a third of a usual day at least, and never by fewer than `floor`;
// - times the company's direction (the model stock: −1), held within the company's `up` / `down`.
//   The model stock's `up`
//   is always 0 (fewer errors than usual give nothing: the only way to move it up would be to cause
//   errors first) and its `down` stays under one round trip's fees, so causing errors, buying the
//   dip and waiting for the walk to bring it back cannot pay;
// - fewer than `min_history_days` days on record (a new instance, a module that just came on), no
//   record of the day, or a source that is missing: no signal, a neutral open.
//
// The plain line on a local stock's card (`line`) and her note (`herLine`) say the same numbers.
// Nothing here names a person: the sources count rows, never whose.

import { type ExchangeConfig, localMappingOf } from "../config.js";
import {
  LOCAL_ROLES,
  type LocalRole,
  type LocalSignal,
  type LocalSignalFeed,
  SIGNAL_MAX,
  signalMove,
  taipeiDay,
} from "./local.js";

/** One completed day's count of a company's thing. */
export interface DayCount {
  /** What the baseline compares (game: goals − deaths; model: failed + slow calls). */
  value: number;
  /** The numbers the plain line names (`feeds`, `songs`, `hours`, `goals`, `deaths`, `errors`, `slow`). */
  parts: Readonly<Record<string, number>>;
}

/** Counts one company's thing. */
export interface CountSource {
  /** What it counts and from where, for the start log. */
  readonly label: string;
  /** Why it cannot count now (its module is off, there is no event log); `null`: it can. */
  missing(): string | null;
  /** The count of Taipei day `day`; `null` when that day is not whole on record at `now`. */
  count(day: number, now: number): Promise<DayCount | null>;
}

export type LocalSources = Readonly<Partial<Record<LocalRole, CountSource>>>;

/** More of the thing is good (+1) or bad (−1) for the company. */
export const LOCAL_DIRECTION: Readonly<Record<LocalRole, 1 | -1>> = {
  feeding: 1,
  songs: 1,
  silence: 1,
  game: 1,
  model: -1,
};

/** The robust spread of a normal sample from its median absolute deviation. */
const MAD_TO_SD = 1.4826;

export interface Baseline {
  median: number;
  spread: number;
  days: number;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** The median and robust spread of the days on record. */
export function baselineOf(history: readonly number[]): Baseline {
  const m = median(history);
  return {
    median: m,
    spread: median(history.map((h) => Math.abs(h - m))) * MAD_TO_SD,
    days: history.length,
  };
}

/** The numbers of one company's mapping. */
export interface Mapping {
  min_history_days: number;
  spread: number;
  relative: number;
  floor: number;
  up: number;
  down: number;
  direction: 1 | -1;
}

/** The mapping of `role` from the config (the model stock's up is 0, its down under a round trip's fees). */
export function mappingOf(config: ExchangeConfig, role: LocalRole): Mapping {
  const c = config.local_signals;
  const m = localMappingOf(config, role);
  const dpsk = role === "model";
  return {
    min_history_days: Math.min(c.min_history_days, c.baseline_days),
    spread: c.spread,
    relative: c.relative,
    floor: m.floor,
    up: dpsk ? 0 : m.up,
    // Its fall stays under 90% of a round trip's fees in price terms.
    down: dpsk ? Math.min(m.down, (0.9 * 2 * config.fee) / SIGNAL_MAX) : m.down,
    direction: LOCAL_DIRECTION[role],
  };
}

/** How a day read against its baseline. */
export interface Reading {
  /** `(x − median) / scale`, held within [-1, 1], before the direction. */
  raw: number;
  /** The signal: in the company's direction, within its `up` / `down`. */
  signal: number;
  scale: number;
  baseline: Baseline;
}

/** The signal of a day's count `x` against the days on record; `null` without enough of them. */
export function readSignal(x: number, history: readonly number[], m: Mapping): Reading | null {
  if (!Number.isFinite(x) || history.length < Math.max(1, m.min_history_days)) return null;
  const baseline = baselineOf(history);
  const scale = Math.max(m.spread * baseline.spread, m.relative * baseline.median, m.floor, 1e-9);
  const raw = Math.max(-1, Math.min(1, (x - baseline.median) / scale));
  const signal = Math.max(-m.down, Math.min(m.up, m.direction * raw));
  // `+ 0` turns −0 into 0.
  return { raw, signal: signal + 0, scale, baseline };
}

/** A company's day as the card and her note tell it. */
export interface SignalFact {
  role: LocalRole;
  /** The completed day the signal is from (the open it moves is the next day's). */
  day: number;
  /** `null`: the source is missing or did not have the day. */
  count: DayCount | null;
  /** `null`: not enough days on record to know what is usual. */
  reading: Reading | null;
  /** The gap it puts into the open, as a fraction (0 without a reading). */
  move: number;
  /** Days on record before it. */
  history: number;
}

const key = (role: LocalRole, day: number) => `${role}:${day}`;
/** Days of counts and facts kept in memory. */
const KEEP_DAYS = 90;

export interface SignalBookDeps {
  sources: LocalSources;
  config: () => ExchangeConfig;
  /**
   * Told once, at the first signal computation, which companies have no source then (their opens
   * stay neutral). Not at start: the modules a source reads may start after this one.
   */
  onMissing?: (missing: Partial<Record<LocalRole, string>>) => void;
}

/**
 * The local stocks' signals, ready before the ticks that read them: `prepare` counts the days
 * (through the sources, asynchronously), `signal` answers the simulator at once. A completed
 * day's count is kept; a day a source could not count is asked again next time.
 */
export class LocalSignalBook implements LocalSignalFeed {
  readonly #d: SignalBookDeps;
  readonly #counts = new Map<string, DayCount>();
  readonly #facts = new Map<string, SignalFact>();
  /** What the simulator was given for a day, so the card says what the open really had. */
  readonly #applied = new Map<string, number>();

  /** Whether the sources were looked at once (the first computation). */
  #checked = false;

  constructor(deps: SignalBookDeps) {
    this.#d = deps;
  }

  /** The companies whose source is missing now, with why. */
  missingNow(): Partial<Record<LocalRole, string>> {
    const out: Partial<Record<LocalRole, string>> = {};
    for (const role of LOCAL_ROLES) {
      const why = this.missing(role);
      if (why !== null) out[role] = why;
    }
    return out;
  }

  /** Readies the signals of the completed Taipei days `days` for every company. */
  async prepare(days: readonly number[], now: number): Promise<void> {
    if (!this.#checked) {
      this.#checked = true;
      const missing = this.missingNow();
      if (Object.keys(missing).length > 0) this.#d.onMissing?.(missing);
    }
    for (const day of days) {
      if (day >= taipeiDay(now)) continue;
      for (const role of LOCAL_ROLES) {
        const k = key(role, day);
        const known = this.#facts.get(k);
        if (known?.reading) continue;
        this.#facts.set(k, await this.#fact(role, day, now));
      }
    }
    this.#trim(taipeiDay(now));
  }

  /** Why the source of `role` cannot count now (`null`: it can). */
  missing(role: LocalRole): string | null {
    const source = this.#d.sources[role];
    return source ? source.missing() : "沒有來源";
  }

  /** The simulator's question: the signal of `role` for completed day `day` (`null`: neutral). */
  signal(role: LocalRole, day: number): LocalSignal | null {
    const f = this.#facts.get(key(role, day));
    const s = f?.reading ? { signal: f.reading.signal } : null;
    this.#applied.set(key(role, day), s?.signal ?? 0);
    return s;
  }

  /**
   * The card's line for `role`'s stock: what moved today's open, in numbers, about her
   * (`pronoun`) (`null`: not known yet).
   */
  line(role: LocalRole, now: number, pronoun = "她"): string | null {
    return cardLine(this.fact(role, now), this.#d.config().local_signals.min_history_days, pronoun);
  }

  /** Her own companies' opens today, as facts (`null`: none known yet); `named`: each role's stock. */
  herNote(named: (role: LocalRole) => { code: string; name: string }, now: number): string | null {
    const min = this.#d.config().local_signals.min_history_days;
    const parts = LOCAL_ROLES.flatMap((role) => {
      const f = this.fact(role, now);
      return f ? [herLine(f, named(role), min)] : [];
    });
    return parts.length === 0 ? null : parts.join(";");
  }

  /** What today's open of `role`'s stock had from yesterday, as known now (`null`: not prepared). */
  fact(role: LocalRole, now: number): SignalFact | null {
    const day = taipeiDay(now) - 1;
    const f = this.#facts.get(key(role, day));
    if (!f) return null;
    const applied = this.#applied.get(key(role, day));
    if (applied === undefined || (f.reading?.signal ?? 0) === applied) return f;
    // The open was priced before the day could be read (a source came back later): it had this.
    return { ...f, reading: null, move: signalMove({ signal: applied }) };
  }

  async #fact(role: LocalRole, day: number, now: number): Promise<SignalFact> {
    const source = this.#d.sources[role];
    const empty: SignalFact = { role, day, count: null, reading: null, move: 0, history: 0 };
    if (!source || source.missing() !== null) return empty;
    const count = await this.#count(source, role, day, now);
    if (count === null) return empty;
    const config = this.#d.config();
    const history: number[] = [];
    for (let d = day - config.local_signals.baseline_days; d < day; d++) {
      const c = await this.#count(source, role, d, now);
      if (c !== null) history.push(c.value);
    }
    const reading = readSignal(count.value, history, mappingOf(config, role));
    return {
      role,
      day,
      count,
      reading,
      move: signalMove(reading ? { signal: reading.signal } : null),
      history: history.length,
    };
  }

  async #count(source: CountSource, role: LocalRole, day: number, now: number) {
    const k = key(role, day);
    const kept = this.#counts.get(k);
    if (kept) return kept;
    let c: DayCount | null = null;
    try {
      c = await source.count(day, now);
    } catch {
      c = null;
    }
    if (c !== null) this.#counts.set(k, c);
    return c;
  }

  #trim(today: number): void {
    for (const map of [this.#counts, this.#facts, this.#applied] as Map<string, unknown>[])
      for (const k of map.keys()) if (Number(k.split(":")[1]) < today - KEEP_DAYS) map.delete(k);
  }
}

// ---- the plain words ---------------------------------------------------------------------------

/** `+1.8%`, `-0.9%`, `+0.0%`. */
export function pct(move: number): string {
  const v = Math.round(move * 1000) / 10;
  return `${v < 0 ? "-" : "+"}${Math.abs(v).toFixed(1)}%`;
}

function compared(r: Reading): string {
  if (r.raw > 0.05) return "比平常多";
  if (r.raw < -0.05) return "比平常少";
  return "跟平常差不多";
}

/** What the day was, in numbers, with `who` as its subject (她 on the card, 你 in her note). */
function what(role: LocalRole, c: DayCount, who: string): string {
  const n = (k: string) => c.parts[k] ?? 0;
  switch (role) {
    case "feeding":
      return `昨天${who}被餵了 ${n("feeds")} 次`;
    case "songs":
      return `昨天${who}唱完 ${n("songs")} 首歌`;
    case "silence":
      return `昨天${who}有 ${n("hours")} 個小時沒說話`;
    case "game":
      return `昨天${who}在遊戲裡達成 ${n("goals")} 個目標、死了 ${n("deaths")} 次`;
    case "model":
      return `昨天${who}的模型出錯 ${n("errors")} 次、太慢 ${n("slow")} 次`;
  }
}

function sentence(f: SignalFact, who: string, minDays: number): string {
  const open = `今天開盤 ${pct(f.move)}`;
  if (f.count === null) return `昨天沒有${who}的紀錄 → ${open}`;
  const day = what(f.role, f.count, who);
  if (f.reading === null)
    return f.history < minDays
      ? `${day},${who}平常的樣子還不到 ${minDays} 天的紀錄 → ${open}`
      : `${day} → ${open}`;
  return `${day},${compared(f.reading)} → ${open}`;
}

/** The card's line: what moved today's open, in numbers, about her (`pronoun`) (`null`: nothing known yet). */
export function cardLine(f: SignalFact | null, minDays: number, pronoun = "她"): string | null {
  return f ? sentence(f, pronoun, minDays) : null;
}

/** One of her own companies' open today, as a fact for her note. */
export function herLine(
  f: SignalFact,
  stock: { code: string; name: string },
  minDays: number,
): string {
  return `${stock.name}(${stock.code}):${sentence(f, "你", minDays)}`;
}
