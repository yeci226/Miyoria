// The five local stocks tied to her (owner 2026-11-21: back as the beginners' recommendation), as
// one more quote provider, so they trade in the same order flow as everything else: market orders,
// the same fee and caps, the house as counterparty, shares, priced directly in fish coins.
//
// The price: one tick an hour from 12:00 to 23:00 Taipei, every day (12 ticks; the gap between the
// Taiwan close and the US open has something to trade). Each tick is a mean-reverting walk with the
// company's own temperament (the feeding and silence stocks calm, the model stock jumpy) towards
// its anchor (config `local_companies.<role>.anchor`, about 100 coins: owner 2026-11-21, cheap enough that a whole share is
// affordable), seeded and reproducible from the market's seed and the tick's time. A hard ±10%
// daily limit from the previous day's last tick. Soft bounds: outside 0.7×–1.4× of the anchor the
// pull back grows, and 0.5×–2× is a hard floor and ceiling, so a local stock never drifts to
// pennies or to thousands (the simulated year in `test/local.test.ts` shows the range).
//
// Her real things (feedings, songs finished, silent hours, game goals and deaths, her model API
// errors and slow calls: one role each, RICE WHLE NAPS CUBE DPSK by default) move it by at most
// ±3% a day:
// the signal is the LAST COMPLETED Taipei day's count against that company's own trailing
// baseline (`signals.ts`, counted from the event log by `sources.ts`), and the whole move lands as
// a gap at the day's first tick (12:00). Every order placed before then fills at a price that
// already has it, so nothing a member does today can be traded on at a known price today. The
// offline checks (`test/local.test.ts`, `test/signals.test.ts`) show that feeding her to push
// the feeding stock, buying and selling loses money once the feedings and the fee are counted, and that causing
// model errors never pays. No leverage on these, no treasury, no rounds, no news deck.

import { rngFor } from "../engine/rng.js";
import { DEFAULT_SESSIONS, isOpenAt, zonedParts } from "./instruments.js";
import type { QuoteProvider, RawQuote } from "./provider.js";

/**
 * The five local stocks by what moves them (docs/design/v5-profiles.md): the logic (signals,
 * directions, temperaments, sources) is keyed by role; each role's code, name, anchor and words are
 * the profile's (`[modules.exchange.local_companies.<role>]`), today's by default. In this order.
 */
export const LOCAL_ROLES = ["feeding", "songs", "silence", "game", "model"] as const;
export type LocalRole = (typeof LOCAL_ROLES)[number];

/** What a profile may name of a role's stock: the first character's companies by default. */
export interface LocalIdentity {
  /** The ticker people type: four capital letters. */
  code: string;
  /** Its zh-TW name. */
  name: string;
  /** Its first price and the level its walk returns to, in coins. */
  anchor: number;
}

/** Miyoria's five companies: every default of `[modules.exchange.local_companies]`. */
export const DEFAULT_LOCAL: Readonly<Record<LocalRole, LocalIdentity>> = {
  feeding: { code: "RICE", name: "白飯食品", anchor: 100 },
  songs: { code: "WHLE", name: "鯨落唱片", anchor: 108 },
  silence: { code: "NAPS", name: "打盹床業", anchor: 88 },
  game: { code: "CUBE", name: "方塊礦業", anchor: 116 },
  model: { code: "DPSK", name: "DipSick AI", anchor: 94 },
};

/** A role's stock as the running profile names it. */
export interface LocalCompany extends LocalIdentity {
  role: LocalRole;
  /** What moves it, in one plain sentence (the 新手推薦 section). */
  what_moves: string;
  /** One line for the old local market's company page. */
  blurb: string;
}

/** `name` then `rest`, with a space after a name that ends in a Latin letter or digit. */
const joined = (name: string, rest: string) =>
  `${name}${/[A-Za-z0-9]$/.test(name) ? " " : ""}${rest}`;

/** What moves a role's stock called `name`, about her (`pronoun`). */
export function whatMovesOf(role: LocalRole, name: string, pronoun = "她"): string {
  switch (role) {
    case "feeding":
      return `大家多餵${pronoun},${joined(name, "就容易漲")}`;
    case "songs":
      return `${pronoun}唱完的歌越多,${joined(name, "越好")}`;
    case "silence":
      return `${pronoun}安靜不說話的時間越長,${joined(name, "越好")}`;
    case "game":
      return `${pronoun}在遊戲裡達成目標就漲,死掉就跌`;
    case "model":
      return `${pronoun}的模型出錯變多,${joined(name, "就跌")}`;
  }
}

/** The old local market's line for a role's company. */
export function blurbOf(role: LocalRole, pronoun = "她"): string {
  switch (role) {
    case "feeding":
      return "穩,大家每天都要吃飯";
    case "songs":
      return "跟著新歌起伏";
    case "silence":
      return "最穩的一家";
    case "game":
      return "景氣循環,偶爾出事故";
    case "model":
      return `${pronoun}的老家。波動大,消息多`;
  }
}

/** The configured identity of one role (`code`, `name`, `anchor`, optional words). */
export interface LocalCompanyInput {
  code: string;
  name: string;
  anchor?: number | undefined;
  what_moves?: string | undefined;
  blurb?: string | undefined;
}

/**
 * The five stocks as the profile names them, in role order. `legacyAnchors` is the old
 * `local_anchors` table, keyed by the first character's codes: it gives a role's anchor when its
 * own `anchor` is not set.
 */
export function resolveLocal(
  companies: Readonly<Record<LocalRole, LocalCompanyInput>>,
  legacyAnchors: Readonly<Partial<Record<string, number>>> = {},
  pronoun = "她",
): LocalCompany[] {
  return LOCAL_ROLES.map((role) => {
    const c = companies[role];
    return {
      role,
      code: c.code,
      name: c.name,
      anchor: c.anchor ?? legacyAnchors[DEFAULT_LOCAL[role].code] ?? DEFAULT_LOCAL[role].anchor,
      what_moves: c.what_moves ?? whatMovesOf(role, c.name, pronoun),
      blurb: c.blurb ?? blurbOf(role, pronoun),
    };
  });
}

/** A role's stock: its role (the logic) and its code (the walk's seed, the rows in the store). */
export interface LocalStock {
  role: LocalRole;
  code: string;
}

/** A temperament: the walk's noise per tick and how fast it returns to its base. */
export const TEMPER: Readonly<Record<LocalRole, { sigma: number; reversion: number }>> = {
  feeding: { sigma: 0.004, reversion: 0.03 },
  silence: { sigma: 0.003, reversion: 0.03 },
  songs: { sigma: 0.007, reversion: 0.02 },
  game: { sigma: 0.008, reversion: 0.02 },
  model: { sigma: 0.012, reversion: 0.015 },
};

/** Outside this band around the anchor the pull back is stronger; the outer one is a hard stop. */
export const SOFT_BAND = { lo: 0.7, hi: 1.4 } as const;
export const HARD_BAND = { lo: 0.5, hi: 2 } as const;
/** The extra pull per tick, per unit of log distance outside the soft band. */
const SOFT_PULL = 0.15;

/** The most a day's signal moves a price. */
export const SIGNAL_MAX = 0.03;
export const DAILY_LIMIT = 0.1;

/**
 * A completed day's signal of a company: in [-1, 1], already in the company's direction (+1 is the
 * full +`SIGNAL_MAX` gap; more model errors give the model stock a negative one). `signals.ts` makes it from
 * the day's count and the company's own baseline.
 */
export interface LocalSignal {
  signal: number;
}

/** The signal of a company for the completed Taipei day `day` (`null`: none, a neutral open). */
export type LocalSignals = (role: LocalRole, day: number) => LocalSignal | null;

/** Where the local stocks' signals come from (`signals.ts`'s `LocalSignalBook`). */
export interface LocalSignalFeed {
  /** The signal of a completed day, at once (`null`: neutral). */
  signal(role: LocalRole, day: number): LocalSignal | null;
  /** Readies the signals of these completed Taipei days. */
  prepare(days: readonly number[], now: number): Promise<void>;
  /** The card's plain line: what moved today's open of `role`'s stock (`null`: nothing known yet). */
  line(role: LocalRole, now: number, pronoun?: string): string | null;
}

/** The day's move from yesterday's signal: ±`SIGNAL_MAX` at most. */
export function signalMove(s: LocalSignal | null): number {
  if (!s || !Number.isFinite(s.signal)) return 0;
  return SIGNAL_MAX * Math.max(-1, Math.min(1, s.signal));
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The tick at or before `ms` (epoch ms of a whole Taipei hour from 12:00 to 23:00), or `null` outside. */
export function lastTick(ms: number): number | null {
  if (!isOpenAt(DEFAULT_SESSIONS.local, ms)) return null;
  return Math.floor(ms / HOUR) * HOUR;
}

/** The Taipei day number of `ms` (Taipei has no daylight saving): the local stocks' day. */
export const taipeiDay = (ms: number): number => Math.floor((ms + 8 * HOUR) / DAY);

/** The epoch ms window [start, end) of Taipei day `day`. */
export function taipeiDayWindow(day: number): { start: number; end: number } {
  const start = day * DAY - 8 * HOUR;
  return { start, end: start + DAY };
}

export interface LocalState {
  /** The last tick's price (coins) and time per company, and the previous day's close. */
  price: number;
  at: number;
  close: number;
}

/**
 * The price of `stock` at tick `t`, from the state at the tick before, around `anchor` (coins).
 * Pure: the same seed, stock, state, signal and anchor give the same price. The walk is seeded by
 * the code (a stock's price history is its code's), its temperament and signal are its role's.
 */
export function nextPrice(
  seed: string,
  stock: LocalStock,
  t: number,
  prev: LocalState,
  signals: LocalSignals,
  anchor: number,
): LocalState {
  const { role, code } = stock;
  const temper = TEMPER[role];
  const first = zonedParts(t, "Asia/Taipei").minutes === 12 * 60;
  const ref = first ? prev.price : prev.close;
  const rng = rngFor(seed, "local", code, t);
  const base = Math.log(anchor);
  let ln = Math.log(prev.price);
  ln +=
    temper.reversion * (base - ln) +
    temper.sigma * rng.normal() -
    (temper.sigma * temper.sigma) / 2;
  // Soft bounds: the farther outside the band, the harder it is pulled back.
  const lo = base + Math.log(SOFT_BAND.lo);
  const hi = base + Math.log(SOFT_BAND.hi);
  if (ln < lo) ln += SOFT_PULL * (lo - ln);
  if (ln > hi) ln -= SOFT_PULL * (ln - hi);
  if (first) ln += signalMove(signals(role, taipeiDay(t) - 1));
  const floor = Math.max(ref * (1 - DAILY_LIMIT), anchor * HARD_BAND.lo);
  const ceiling = Math.min(ref * (1 + DAILY_LIMIT), anchor * HARD_BAND.hi);
  const price = Math.round(Math.min(ceiling, Math.max(floor, Math.exp(ln))) * 100) / 100;
  return { price, at: t, close: ref };
}

/** The local stocks as a provider: the latest tick's price of each, computed from the last one known. */
export class LocalProvider implements QuoteProvider {
  readonly id = "local";
  readonly #state = new Map<string, LocalState>();

  constructor(
    private readonly seed: string,
    private readonly signals: LocalSignals,
    /** The five stocks as the profile names them, with their anchors in coins. */
    private readonly stocks: () => readonly (LocalStock & { anchor: number })[],
    /** The last stored price of a code (a restart continues from it). */
    private readonly stored: (
      code: string,
    ) => { price: number; at: number; prev_close: number | null } | null,
    /**
     * Readies the signals of these completed Taipei days before the ticks that read them are
     * priced (the counts come from the event log, which is asynchronous). Optional: without it a
     * signal is whatever `signals` already has.
     */
    private readonly prepare?: (days: readonly number[], now: number) => Promise<void>,
  ) {}

  async quotes(symbols: readonly string[], now: number): Promise<Map<string, RawQuote>> {
    const out = new Map<string, RawQuote>();
    const t = lastTick(now);
    if (t === null) return out;
    const stocks = this.stocks();
    for (const symbol of symbols) {
      const stock = stocks.find((s) => s.code === symbol);
      if (!stock) continue;
      const code = stock.code;
      let st = this.#state.get(code) ?? this.#fromStore(code, stock.anchor);
      if (st.at === 0) st = { ...st, at: t - HOUR };
      if (this.prepare && st.at < t) {
        // The first tick of each Taipei day from the one after the last priced tick to this one
        // reads the day before it.
        const days: number[] = [];
        for (let d = Math.max(taipeiDay(st.at) + 1, taipeiDay(t) - 14); d <= taipeiDay(t); d++)
          days.push(d - 1);
        try {
          if (days.length > 0) await this.prepare(days, now);
        } catch {
          // A source that cannot answer is a neutral open, never a failed quote.
        }
      }
      // Every tick missed since the last one, in order (they are reproducible from the seed).
      let guard = 0;
      while (st.at < t && guard++ < 24 * 14) {
        const next = nextTickAfter(st.at);
        if (next === null || next > t) break;
        st = nextPrice(this.seed, stock, next, st, this.signals, stock.anchor);
      }
      this.#state.set(code, st);
      out.set(symbol, { symbol, price: st.price, at: st.at, prev_close: st.close });
    }
    return out;
  }

  #fromStore(code: string, start: number): LocalState {
    const s = this.stored(code);
    return s
      ? { price: s.price, at: s.at, close: s.prev_close ?? s.price }
      : { price: start, at: 0, close: start };
  }
}

/** The tick after `ms` (skipping the night). */
export function nextTickAfter(ms: number): number | null {
  for (let t = Math.floor(ms / HOUR) * HOUR + HOUR, i = 0; i < 48; t += HOUR, i++) {
    if (isOpenAt(DEFAULT_SESSIONS.local, t)) return t;
  }
  return null;
}
