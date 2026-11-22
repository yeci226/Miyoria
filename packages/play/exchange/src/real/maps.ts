// The two heat maps (owner 2026-11-21, after finviz's market map): each tile one ticker, its area
// its weight, its colour today's change (the product's one up/down convention), grouped by sector.
//
// - 伺服器持股圖 (`holdings`): the weight is the coins the whole server holds in the ticker at the
//   latest prices (every member summed, a 2× position at its equity). It never says who holds
//   what: a ticker held by fewer than `map_min_holders` people is merged into one 「其他」 tile with
//   no change shown, and that tile is left out too when fewer than that many people are in it, so
//   no single person's position can be read off the map. The local stocks are in it; a ticker no
//   starter list names is under the sector 其他.
// - 熱門台股圖 / 熱門美股圖 (`tw`, `us`): the starter lists as far as they validated, the weight and
//   sector from the list itself (Yahoo's keyless endpoint gives neither): static approximations by
//   size that the owner may edit, which the footnote says.
//
// No tile takes more than `map_max_share` of a map (2330 alone is two thirds of the Taiwan list's
// weights): a bigger one is cut to that share and the others keep their proportions. The weights
// here are the real ones; the cap is applied where the map is laid out, and the footnote says so.
//
// The layout is not here: the panel and the picture lay the same tiles out with the same code
// (`@miyoria/card-face`'s `market.ts`, `capShares`), so they agree.

import { DEFAULT_CURRENCY } from "@miyoria/types";
import { OTHER_SECTOR, type StarterEntry } from "../config.js";
import type { RealLine } from "./desk.js";

export const MAP_KINDS = ["holdings", "tw", "us"] as const;
export type MapKind = (typeof MAP_KINDS)[number];

export const MAP_TITLE: Readonly<Record<MapKind, string>> = {
  holdings: "伺服器持股圖",
  tw: "熱門台股圖",
  us: "熱門美股圖",
};

/** The local stocks' sector on the holdings map. */
export const LOCAL_SECTOR = "這裡獨家";
/** The code of the merged tile. */
export const OTHER_CODE = "其他";

export const isMapKind = (x: unknown): x is MapKind =>
  typeof x === "string" && (MAP_KINDS as readonly string[]).includes(x);

export interface MapTileData {
  code: string;
  name: string;
  sector: string;
  /** The tile's area (coins held, or the starter list's weight). */
  weight: number;
  /**
   * The move of its last session as a fraction: today's while its market trades, the last
   * session's while it is closed (`null`: none known, or the merged tile).
   */
  change: number | null;
  /** The last price in its own currency, and in coins. */
  price: number | null;
  currency: "TWD" | "USD" | "COIN" | null;
  coin_price: number | null;
  /** What the weight is, in words (the tooltip). */
  basis: string;
}

export interface MapData {
  kind: MapKind;
  title: string;
  tiles: MapTileData[];
  /** Under the map: what the size means (and what is left out). */
  footnote: string;
  /** Tickers left out of the holdings map because too few people are in 其他. */
  hidden: number;
  /** No tile is laid out bigger than this share of the map (`1`: no cap). */
  max_share: number;
}

/** The footnote's words for the cap (empty when there is none). */
export function capWords(maxShare: number): string {
  return maxShare < 1
    ? `;單一格最多占整張圖的 ${Math.round(maxShare * 100)}%,超過的縮到這個大小`
    : "";
}

const coinWord = (n: number) => Math.round(n).toLocaleString("en-US");

function tileOf(line: RealLine, sector: string, weight: number, basis: string): MapTileData {
  return {
    code: line.code,
    name: line.name,
    sector,
    weight,
    change: line.change,
    price: line.price,
    currency: line.currency,
    coin_price: line.coin_price,
    basis,
  };
}

/** One open position's share of the holdings map: who (for the count only) and its value in coins. */
export interface HeldValue {
  person: string;
  code: string;
  value: number;
}

/**
 * The 伺服器持股圖 from every open position's value in coins. `sectorOf` names a ticker's sector
 * (a starter list's, 這裡獨家, or 其他). Never carries a person: only totals and counts.
 */
export function holdingsMap(input: {
  held: readonly HeldValue[];
  lines: ReadonlyMap<string, RealLine>;
  sectorOf: (line: RealLine) => string;
  minHolders: number;
  /** `map_max_share` (default: none). */
  maxShare?: number;
  /** The coins' name (default 魚幣). */
  currency?: string;
}): MapData {
  const maxShare = input.maxShare ?? 1;
  const cur = input.currency ?? DEFAULT_CURRENCY;
  const by = new Map<string, { value: number; people: Set<string> }>();
  for (const h of input.held) {
    if (!(h.value > 0)) continue;
    const e = by.get(h.code) ?? { value: 0, people: new Set<string>() };
    e.value += h.value;
    e.people.add(h.person);
    by.set(h.code, e);
  }
  const tiles: MapTileData[] = [];
  const other = { value: 0, people: new Set<string>(), codes: 0 };
  for (const [code, e] of by) {
    const line = input.lines.get(code);
    if (!line || e.people.size < input.minHolders) {
      other.value += e.value;
      other.codes++;
      for (const p of e.people) other.people.add(p);
      continue;
    }
    tiles.push(
      tileOf(
        line,
        input.sectorOf(line),
        Math.round(e.value),
        `伺服器合計約 ${coinWord(e.value)} ${cur}・${e.people.size} 人持有`,
      ),
    );
  }
  let hidden = 0;
  if (other.codes > 0) {
    if (other.people.size >= input.minHolders && other.value > 0)
      tiles.push({
        code: OTHER_CODE,
        name: `少於 ${input.minHolders} 人持有的`,
        sector: OTHER_SECTOR,
        weight: Math.round(other.value),
        change: null,
        price: null,
        currency: null,
        coin_price: null,
        basis: `${other.codes} 檔合計約 ${coinWord(other.value)} ${cur}`,
      });
    else hidden = other.codes;
  }
  const left = hidden > 0 ? `;只有少數人持有的 ${hidden} 檔不列出` : "";
  return {
    kind: "holdings",
    title: MAP_TITLE.holdings,
    tiles: tiles.filter((t) => t.weight > 0),
    footnote: `格子大小為伺服器合計持有的市值(${cur},照最後的價格);少於 ${input.minHolders} 人持有的併入「其他」,不顯示是誰持有${left}${capWords(maxShare)}`,
    hidden,
    max_share: maxShare,
  };
}

/** A 熱門 map from a starter list's entries and the lines of those that validated. */
export function starterMap(
  market: "tw" | "us",
  entries: readonly { entry: StarterEntry; line: RealLine | null }[],
  maxShare = 1,
): MapData {
  const tiles = entries.flatMap(({ entry, line }) =>
    line ? [tileOf(line, entry.sector, entry.weight, `預設權重 ${entry.weight}`)] : [],
  );
  return {
    kind: market,
    title: MAP_TITLE[market],
    tiles,
    footnote: `格子大小為預設權重,非即時市值${capWords(maxShare)}`,
    hidden: 0,
    max_share: maxShare,
  };
}
