// Real instruments (owner 2026-11-21, v1: Taiwan and US stocks; an ETF is a ticker like any other):
// the price is a provider's quote, in the instrument's own currency (TWD or USD), turned into fish
// coins by two fixed rates in config (`rates.ts`). The list is config
// (`[[modules.exchange.instruments]]`): adding or removing a ticker needs no code. Each names its
// market (which hours it trades), its provider and the provider's symbol (Yahoo: `2330.TW`,
// `6488.TWO`, `AAPL`) and its display name. `crypto` stays a market kind for later; v1 lists none.

export type MarketKind = "us" | "tw" | "crypto" | "local";

export interface RealInstrument {
  /** What people type: 2 to 10 capital letters or digits (`AAPL`, `2330`, `BTC`). */
  code: string;
  name: string;
  market: MarketKind;
  /** The provider's id (`[modules.exchange.providers]`) and its symbol for this instrument. */
  provider: string;
  symbol: string;
  /** Off: no new order; holdings stay and can be sold. */
  enabled: boolean;
}

/** A market's trading hours: its time zone, the sessions of a weekday, its closed dates. */
export interface Session {
  /** An IANA zone (`America/New_York`). */
  zone: string;
  /** `HH:MM` local opening and closing; `24h`: always open. */
  open: string;
  close: string;
  /** Trading weekdays, Sunday 0 .. Saturday 6. */
  days: number[];
  /** Closed dates in the zone, `YYYY-MM-DD` (holidays). */
  holidays: string[];
  always: boolean;
}

export const DEFAULT_SESSIONS: Readonly<Record<MarketKind, Session>> = {
  us: {
    zone: "America/New_York",
    open: "09:30",
    close: "16:00",
    days: [1, 2, 3, 4, 5],
    holidays: [],
    always: false,
  },
  tw: {
    zone: "Asia/Taipei",
    open: "09:00",
    close: "13:30",
    days: [1, 2, 3, 4, 5],
    holidays: [],
    always: false,
  },
  // The five local stocks tied to her: one tick an hour from 12:00 to 23:00 Taipei, every day.
  local: {
    zone: "Asia/Taipei",
    open: "12:00",
    close: "23:01",
    days: [0, 1, 2, 3, 4, 5, 6],
    holidays: [],
    always: false,
  },
  crypto: {
    zone: "UTC",
    open: "00:00",
    close: "24:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    holidays: [],
    always: true,
  },
};

const parts = new Map<string, Intl.DateTimeFormat>();

/** The date, weekday and minutes after midnight of `ms` in `zone`. */
export function zonedParts(
  ms: number,
  zone: string,
): { date: string; weekday: number; minutes: number } {
  let f = parts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    parts.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "");
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

const minutesOf = (hhmm: string) => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
};

/** Whether the market of `session` is open at `ms`. */
export function isOpenAt(session: Session, ms: number): boolean {
  if (session.always) return true;
  const z = zonedParts(ms, session.zone);
  if (!session.days.includes(z.weekday) || session.holidays.includes(z.date)) return false;
  return z.minutes >= minutesOf(session.open) && z.minutes < minutesOf(session.close);
}

/** `YYYY-MM-DD` plus `n` calendar days (pure date arithmetic, no zone). */
function addDays(date: string, n: number): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The epoch ms of `minutes` after midnight of `date` on the wall clock of `zone` (daylight saving
 * from the zone itself): a first guess as if it were UTC, corrected by the zone's offset there.
 */
export function zonedTime(date: string, minutes: number, zone: string): number {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d) + minutes * 60_000;
  let t = want;
  for (let i = 0; i < 3; i++) {
    const z = zonedParts(t, zone);
    const [zy = 0, zm = 1, zd = 1] = z.date.split("-").map(Number);
    const seen = Date.UTC(zy, zm - 1, zd) + z.minutes * 60_000;
    if (seen === want) break;
    t += want - seen;
  }
  return t;
}

const tradesOn = (s: Session, date: string): boolean => {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return s.days.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay()) && !s.holidays.includes(date);
};

/**
 * When the market of `session` next opens after `ms` (epoch ms), in its own zone with daylight
 * saving and holidays; `null` for a market that never closes. While it is open this is the next
 * session's open, not the current one's.
 */
export function nextOpenAt(session: Session, ms: number): number | null {
  if (session.always) return null;
  const today = zonedParts(ms, session.zone).date;
  for (let i = 0; i <= 21; i++) {
    const date = addDays(today, i);
    if (!tradesOn(session, date)) continue;
    const open = zonedTime(date, minutesOf(session.open), session.zone);
    if (open > ms) return open;
  }
  return null;
}

/** When the market of `session` next closes after `ms` (epoch ms); `null`: never closes. */
export function nextCloseAt(session: Session, ms: number): number | null {
  if (session.always) return null;
  const today = zonedParts(ms, session.zone).date;
  for (let i = 0; i <= 21; i++) {
    const date = addDays(today, i);
    if (!tradesOn(session, date)) continue;
    const close = zonedTime(date, minutesOf(session.close), session.zone);
    if (close > ms) return close;
  }
  return null;
}

/** When the market of `session` last closed at or before `ms` (epoch ms); `null`: never closes. */
export function lastCloseAt(session: Session, ms: number): number | null {
  if (session.always) return null;
  const today = zonedParts(ms, session.zone).date;
  for (let i = 0; i <= 21; i++) {
    const date = addDays(today, -i);
    if (!tradesOn(session, date)) continue;
    const close = zonedTime(date, minutesOf(session.close), session.zone);
    if (close <= ms) return close;
  }
  return null;
}

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** `11/24(一)09:00` on Taipei's clock, the community's own (Taiwan has no daylight saving). */
export function taipeiWhen(ms: number): string {
  const z = zonedParts(ms, "Asia/Taipei");
  const [, m = 0, d = 0] = z.date.split("-").map(Number);
  const hh = String(Math.floor(z.minutes / 60)).padStart(2, "0");
  const mm = String(z.minutes % 60).padStart(2, "0");
  return `${m}/${d}(${WEEKDAY[z.weekday] ?? ""})${hh}:${mm}`;
}

/** `11/20` of a trading date `YYYY-MM-DD`. */
export function shortDate(date: string): string {
  const [, m = 0, d = 0] = date.split("-").map(Number);
  return `${m}/${d}`;
}

/** The trading date of `ms` in the session's zone (for the day's reference price). */
export function tradingDate(session: Session, ms: number): string {
  return zonedParts(ms, session.zone).date;
}

/** The currency a market quotes in. */
export function currencyOf(market: MarketKind): "TWD" | "USD" | "COIN" {
  return market === "tw" ? "TWD" : market === "local" ? "COIN" : "USD";
}

/** Fixed rates (owner 2026-11-21): never fetched, never floating. */
export interface Rates {
  /** NT dollars per fish coin. */
  twd_per_coin: number;
  /** NT dollars per US dollar. */
  twd_per_usd: number;
}

/** Coins as a price in the market's own currency (the inverse of `toCoins`). */
export function fromCoins(coins: number, market: MarketKind, r: Rates): number {
  if (market === "local") return coins;
  const twd = coins * r.twd_per_coin;
  return market === "tw" ? twd : twd / r.twd_per_usd;
}

/** A quoted price in coins: TWD ÷ twd_per_coin; USD × twd_per_usd ÷ twd_per_coin. */
export function toCoins(price: number, market: MarketKind, r: Rates): number {
  if (market === "local") return price;
  const twd = market === "tw" ? price : price * r.twd_per_usd;
  return twd / r.twd_per_coin;
}
