// Browsing the market (owner 2026-11-21: browsing, not only typing a code). The lists a member
// picks from, on Discord and on the panel alike:
//
// - 新手推薦 · 這裡獨家: the five local stocks (first, and the default for someone with no positions);
// - 大家都在買: the tickers most held in the server, as counts of holders only, never who;
// - 今天漲跌最多: among tickers the server holds, watches or viewed lately (never a whole-market scan);
// - 熱門台股 / 熱門美股: the starter lists in config, as far as they validated;
// - 我的持股, 我最近看過, 我的觀察: their own.
//
// Plus the watch list (capped per member) and the ticker suggestions while typing: matches among
// tickers already known and the starter lists, cached and limited per person, never one provider
// call per keystroke (no name search at the provider was verified, so none is made).

import type { PersonId } from "@miyoria/types";
import type { ExchangeConfig } from "../config.js";
import type { ExchangeStore } from "../store.js";
import { candidates, type RealDesk, type RealLine } from "./desk.js";

export const LIST_KINDS = [
  "local",
  "popular",
  "movers",
  "tw",
  "us",
  "mine",
  "recent",
  "watch",
] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export const LIST_LABEL: Readonly<Record<ListKind, string>> = {
  local: "新手推薦 · 這裡獨家",
  popular: "大家都在買",
  movers: "今天漲跌最多",
  tw: "熱門台股",
  us: "熱門美股",
  mine: "我的持股",
  recent: "我最近看過",
  watch: "我的觀察",
};

/** One line of a list: the ticker's line, and for 大家都在買 how many hold it. */
export interface ListRow extends RealLine {
  /** People holding it (大家都在買 only; a count, never who). */
  holders: number | null;
}

/** Rows a page of a list shows (Discord's select takes 25 options). */
export const PAGE_SIZE = 25;
const DAY_MS = 86_400_000;
/** How long one typed prefix's suggestions are kept. */
const SUGGEST_CACHE_MS = 30_000;
const SUGGEST_MAX = 25;

export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
}

export function pageOf<T>(items: readonly T[], page: number, size = PAGE_SIZE): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, Math.trunc(page)), pages - 1);
  return { items: items.slice(p * size, (p + 1) * size), page: p, pages };
}

export type WatchResult =
  | { ok: true; watching: boolean; count: number }
  | { ok: false; code: string; message: string };

export class MarketLists {
  readonly #suggestCache = new Map<string, { at: number; out: { code: string; name: string }[] }>();
  readonly #suggestCount = new Map<string, { minute: number; n: number }>();

  constructor(
    private readonly desk: RealDesk,
    private readonly store: ExchangeStore,
    private readonly config: () => ExchangeConfig,
    private readonly now: () => number,
  ) {}

  /** The list someone sees first: their holdings when they have any, else the local stocks. */
  defaultList(person: PersonId | null): ListKind {
    if (person !== null && this.desk.portfolio(person).holdings.length > 0) return "mine";
    return "local";
  }

  /** The rows of a list, for `person` (their own lists are empty without one). */
  rows(kind: ListKind, person: PersonId | null): ListRow[] {
    const lines = this.desk.view().instruments;
    const byCode = new Map(lines.map((l) => [l.code, l]));
    const pick = (codes: Iterable<string>, holders?: Map<string, number>): ListRow[] => {
      const out: ListRow[] = [];
      const seen = new Set<string>();
      for (const code of codes) {
        const l = byCode.get(code);
        if (!l || seen.has(code)) continue;
        seen.add(code);
        out.push({ ...l, holders: holders?.get(code) ?? null });
      }
      return out;
    };
    switch (kind) {
      case "local":
        return pick(this.desk.localCompanies().map((l) => l.code));
      case "popular": {
        const counts = this.desk.holderCounts();
        const codes = [...counts]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([c]) => c);
        return pick(codes, counts);
      }
      case "movers": {
        const now = this.now();
        const pool = new Set<string>([
          ...this.desk.holderCounts().keys(),
          ...this.store.real.viewedSince(now - DAY_MS),
          ...this.store.real.watchedByActive(now - this.config().watch_active_days * DAY_MS),
        ]);
        return pick(pool)
          .filter((r) => r.change !== null)
          .sort(
            (a, b) =>
              Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0) || a.code.localeCompare(b.code),
          );
      }
      case "tw":
      case "us":
        return pick(this.desk.starters(kind));
      case "mine":
        return person === null ? [] : pick(this.desk.portfolio(person).holdings.map((h) => h.code));
      case "recent":
        return person === null
          ? []
          : pick(this.store.real.marks(person, "view", 20).map((m) => m.code));
      case "watch":
        return person === null
          ? []
          : pick(
              this.store.real.marks(person, "watch", this.config().watch_max).map((m) => m.code),
            );
    }
  }

  /** Whether `person` watches `code`. */
  watching(person: PersonId, code: string): boolean {
    return this.store.real.marks(person, "watch", 100).some((m) => m.code === code);
  }

  /** Adds `code` to (or takes it off) `person`'s watch list, within `watch_max`. */
  setWatch(person: PersonId, code: string, on: boolean): WatchResult {
    const list = this.store.real.marks(person, "watch", 100);
    if (!on) {
      this.store.real.unmark(person, "watch", code);
      return { ok: true, watching: false, count: list.filter((m) => m.code !== code).length };
    }
    if (list.some((m) => m.code === code)) return { ok: true, watching: true, count: list.length };
    const max = this.config().watch_max;
    if (list.length >= max)
      return { ok: false, code: "watch_full", message: `觀察清單最多 ${max} 檔,先拿掉一些` };
    if (!this.desk.view().instruments.some((l) => l.code === code))
      return { ok: false, code: "instrument", message: "沒有這個標的(先查詢代號)" };
    this.store.real.mark(person, "watch", code, this.now());
    return { ok: true, watching: true, count: list.length + 1 };
  }

  /**
   * Suggestions while someone types a code or part of a name: tickers already known, then the
   * starter lists' codes not yet validated, then what the typed text would be looked up as. No
   * provider call: the lookup happens when they pick one. Cached per typed text; past
   * `suggest_per_minute` a person gets the cached answer or nothing.
   */
  suggest(person: string, typed: string): { code: string; name: string }[] {
    const now = this.now();
    const key = typed.trim().toUpperCase().slice(0, 24);
    const cached = this.#suggestCache.get(key);
    const minute = Math.floor(now / 60_000);
    const used = this.#suggestCount.get(person);
    const n = used && used.minute === minute ? used.n : 0;
    if (n >= this.config().suggest_per_minute) return cached?.out ?? [];
    this.#suggestCount.set(person, { minute, n: n + 1 });
    if (cached && now - cached.at < SUGGEST_CACHE_MS) return cached.out;
    const out = this.#suggestFresh(key);
    this.#suggestCache.set(key, { at: now, out });
    if (this.#suggestCache.size > 500) {
      for (const [k, v] of this.#suggestCache)
        if (now - v.at >= SUGGEST_CACHE_MS) this.#suggestCache.delete(k);
    }
    return out;
  }

  #suggestFresh(key: string): { code: string; name: string }[] {
    const lines = this.desk.view().instruments;
    const starters = [...this.desk.starters("tw"), ...this.desk.starters("us")];
    const known = new Set(lines.map((l) => l.code));
    const score = (code: string, name: string): number => {
      if (key === "") return starters.includes(code) || this.desk.localOf(code) !== null ? 1 : 0;
      const bare = code.replace(/\.TWO?$/, "");
      if (bare === key || code === key) return 4;
      if (bare.startsWith(key)) return 3;
      if (name.toUpperCase().includes(key)) return 2;
      if (code.includes(key)) return 1;
      return 0;
    };
    const ranked = lines
      .map((l) => ({
        code: l.code,
        name: l.name,
        s: score(l.code, l.name),
        local: l.local !== null,
      }))
      .filter((x) => x.s > 0)
      .sort(
        (a, b) => b.s - a.s || Number(b.local) - Number(a.local) || a.code.localeCompare(b.code),
      )
      .map(({ code, name }) => ({ code, name }));
    // Starter codes not validated yet, as typed.
    const starterCodes = [...this.desk.starterConfig("tw"), ...this.desk.starterConfig("us")];
    for (const { code: typed, name } of starterCodes) {
      if (ranked.length >= SUGGEST_MAX) break;
      const up = typed.toUpperCase();
      if (key !== "" && !up.startsWith(key) && !(name ?? "").toUpperCase().includes(key)) continue;
      if (candidates(typed).some((x) => known.has(x))) continue;
      if (!ranked.some((r) => r.code === up))
        ranked.push({ code: up, name: name === null ? "熱門清單" : `${name}・熱門清單` });
    }
    // What they typed, to look up when picked.
    if (key !== "" && ranked.length < SUGGEST_MAX && !ranked.some((r) => r.code === key)) {
      if (candidates(key).length > 0) ranked.push({ code: key, name: "查詢這個代號" });
    }
    return ranked.slice(0, SUGGEST_MAX);
  }
}
