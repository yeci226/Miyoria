// What economy 2.0 keeps besides the ledger: collection items, predictions and their bets,
// commissions and what the audience has funded of her room (docs/design/v4-plan.md §10). The
// types and the service key live in `@miyoria/store`, which implements them (one `economy_docs`
// table on SQLite and Postgres); the in-memory `MemoryDocs` here is what the tests run against and
// what the module falls back to (with a warning) when no store provides `EconomyDocsKey`.
//
// Coins never live here: every balance change is a ledger row. A document says what the coins were
// for and where the thing stands; if one is lost, the ledger still shows who paid what.

import {
  type DocFilter,
  type DocUpdate,
  type EconomyDoc,
  type EconomyDocStore,
  EconomyDocsKey,
} from "@miyoria/store";
import { type ProfileId, sameAccount } from "@miyoria/types";

export { type DocFilter, type DocUpdate, type EconomyDoc, type EconomyDocStore, EconomyDocsKey };

/** Newest first by creation; the id breaks a tie (ULIDs sort by time). */
export function newestFirst(a: EconomyDoc, b: EconomyDoc): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The in-memory store: same behaviour as the real one, gone on restart. */
export class MemoryDocs implements EconomyDocStore {
  readonly #docs = new Map<string, EconomyDoc>();

  #key(profile: ProfileId, kind: string, id: string): string {
    return `${profile}\u0000${kind}\u0000${id}`;
  }

  async create(doc: EconomyDoc): Promise<boolean> {
    const key = this.#key(doc.profile, doc.kind, doc.id);
    if (this.#docs.has(key)) return false;
    this.#docs.set(key, structuredClone(doc));
    return true;
  }

  async get(profile: ProfileId, kind: string, id: string): Promise<EconomyDoc | null> {
    const doc = this.#docs.get(this.#key(profile, kind, id));
    return doc ? structuredClone(doc) : null;
  }

  async update(
    profile: ProfileId,
    kind: string,
    id: string,
    expected: number,
    next: DocUpdate,
  ): Promise<boolean> {
    const key = this.#key(profile, kind, id);
    const doc = this.#docs.get(key);
    if (!doc || doc.version !== expected) return false;
    this.#docs.set(key, {
      ...doc,
      status: next.status,
      data: structuredClone(next.data),
      owner: next.owner === undefined ? doc.owner : next.owner,
      version: doc.version + 1,
      updated_at: next.at,
    });
    return true;
  }

  async list(profile: ProfileId, kind: string, filter: DocFilter): Promise<EconomyDoc[]> {
    const out: EconomyDoc[] = [];
    for (const doc of this.#docs.values()) {
      if (doc.profile !== profile || doc.kind !== kind) continue;
      if (filter.statuses && !filter.statuses.includes(doc.status)) continue;
      if (filter.owners) {
        const owner = doc.owner;
        if (owner === null || !filter.owners.some((a) => sameAccount(a, owner))) continue;
      }
      out.push(doc);
    }
    out.sort(newestFirst);
    return out.slice(0, Math.max(filter.limit, 0)).map((d) => structuredClone(d));
  }
}
