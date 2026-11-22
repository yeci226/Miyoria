// The local stocks' codes against what the store keeps (docs/design/v5-profiles.md). Holdings,
// orders, fills and price history are keyed by a stock's code, so a profile that renames a code
// on a database with rows under the old one would leave them behind under a stock nobody can
// trade. That is refused at start; a profile with a new database (empty) may name its codes
// freely. A code that was listed but never traded or priced only goes out of the lists.

import { DEFAULT_LOCAL, type LocalCompany } from "./local.js";
import type { InstrumentRecord, RealStore } from "./store.js";

export interface LocalCodeCheck {
  /** Why the exchange must not start (`null`: it may). */
  error: string | null;
  /** Local codes the config no longer names that have nothing kept under them. */
  stale: string[];
}

const KEY = "[modules.exchange.local_companies]";

/** Checks the configured local stocks against the instruments and rows in the store. */
export function checkLocalCodes(
  store: Pick<RealStore, "instrumentList" | "rowsUnder">,
  companies: readonly LocalCompany[],
): LocalCodeCheck {
  const rows: InstrumentRecord[] = store.instrumentList();
  const byCode = new Map(rows.map((r) => [r.code, r]));
  for (const c of companies) {
    const row = byCode.get(c.code);
    if (row && row.market !== "local")
      return {
        error: `${KEY} ${c.role}.code = "${c.code}" is a ${row.market} ticker people already looked up here; give the ${c.role} stock another code.`,
        stale: [],
      };
  }
  const named = new Set(companies.map((c) => c.code));
  const gone = rows.filter((r) => r.market === "local" && !named.has(r.code));
  const kept = gone.filter((r) => store.rowsUnder(r.code) > 0);
  if (kept.length === 0) return { error: null, stale: gone.map((r) => r.code) };
  // Which role each old code was: the one it is the first character's code of, else the one role
  // whose code has no row yet.
  const fresh = companies.filter((c) => !byCode.has(c.code));
  const old = kept.map((r) => r.code);
  const roleOf = (code: string): LocalCompany | undefined =>
    companies.find((c) => DEFAULT_LOCAL[c.role].code === code && c.code !== code) ??
    (old.length === 1 && fresh.length === 1 ? fresh[0] : undefined);
  const pairs = old.map((code) => ({ code, now: roleOf(code) }));
  const which = pairs
    .map((p) =>
      p.now
        ? `${p.now.role}.code was "${p.code}" and is now "${p.now.code}"`
        : `"${p.code}" is no longer named`,
    )
    .join("; ");
  const back = pairs
    .map((p) => (p.now ? `put ${p.now.role}.code back to "${p.code}"` : `name "${p.code}" again`))
    .join(" and ");
  return {
    error: `${KEY}: ${which}, but the database keeps holdings, orders or price history under ${old.join(", ")}. A code is what those rows are kept under, so they would be left behind. Either ${back}, or use the new codes in a new profile (its database starts empty).`,
    stale: [],
  };
}
