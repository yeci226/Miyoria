// The local companies (docs/design/exchange.md §2.1, owner 2026-11-21): the five tied to her, priced
// by the simulator and nudged by the real things they stand for. Every one is made up; nothing here
// is a real company's mark, logo or data. Real stocks and crypto are `real/` instruments instead. Their character is only in
// these numbers: how much they follow the market (`beta`), how much they move on their own each
// round (`sigma`), and how many coins of net buying move them about one percent (`depth`).

import { DEFAULT_LOCAL, type LocalCompany, type LocalRole, resolveLocal } from "../real/local.js";

export type Sector = "ai" | "staples" | "media" | "resources";

export interface CompanySpec {
  /** The ticker people type: four capital letters. */
  code: string;
  name: string;
  sector: Sector;
  /** One line for the company page. */
  blurb: string;
  /** How strongly the market factor moves it. */
  beta: number;
  /** Its own noise per round, as a log return's standard deviation. */
  sigma: number;
  /** Coins of net buying in one round that move it about `impact` (one percent by default). */
  depth: number;
  /** The first price, in cents (10000 = 100.00). */
  start: number;
}

export const SECTOR_LABEL: Readonly<Record<Sector, string>> = {
  ai: "AI",
  staples: "民生",
  media: "娛樂",
  resources: "資源",
};

/**
 * The old market's numbers of each role's company (its temperament); its code, name and line are
 * the profile's (`[modules.exchange.local_companies]`, docs/design/v5-profiles.md).
 */
const TRAITS: Readonly<Record<LocalRole, Omit<CompanySpec, "code" | "name" | "blurb">>> = {
  model: { sector: "ai", beta: 1.3, sigma: 0.006, depth: 1500, start: 10000 },
  feeding: { sector: "staples", beta: 0.6, sigma: 0.003, depth: 2000, start: 8000 },
  songs: { sector: "media", beta: 0.9, sigma: 0.005, depth: 1500, start: 6000 },
  game: { sector: "resources", beta: 1.1, sigma: 0.005, depth: 1500, start: 5000 },
  silence: { sector: "staples", beta: 0.5, sigma: 0.0025, depth: 2000, start: 7000 },
};

/** The old market's order of its companies (its simulation walks them in this order). */
const ENGINE_ORDER: readonly LocalRole[] = ["model", "feeding", "songs", "game", "silence"];

/** The old market's companies for the profile's five local stocks. */
export function companiesOf(locals: readonly LocalCompany[]): CompanySpec[] {
  return ENGINE_ORDER.flatMap((role) => {
    const l = locals.find((x) => x.role === role);
    return l ? [{ code: l.code, name: l.name, blurb: l.blurb, ...TRAITS[role] }] : [];
  });
}

/** The first character's companies (the defaults). */
export const COMPANIES: readonly CompanySpec[] = companiesOf(resolveLocal(DEFAULT_LOCAL));

export const COMPANY_CODES: readonly string[] = COMPANIES.map((c) => c.code);

/** The company of `code` among `companies` (default: the first character's). */
export function companyOf(
  code: string,
  companies: readonly CompanySpec[] = COMPANIES,
): CompanySpec | null {
  return companies.find((c) => c.code === code) ?? null;
}
