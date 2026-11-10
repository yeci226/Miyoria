// In-memory store for the tests, mirroring the legacy Rust `MemoryStore` (message log, people,
// settings and memory records).

import type {
  Account,
  AuthoredEntry,
  LogEntry,
  MemoryFilter,
  MemoryHit,
  MemoryQuery,
  MemoryRecord,
  MemoryRecordStore,
  MessageLog,
  PeopleStore,
  Person,
  PrunePolicy,
} from "@miyoria/store";
import { MemorySettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  newId,
  type PersonId,
  type ProfileId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { cosine, scopeEquals } from "../src/index.js";

const ms = (ts: Timestamp) => Date.parse(ts);
const accountKey = (a: AccountRef) => `${a.platform}\u0000${a.id}`;
const contextKey = (c: ContextKey) =>
  `${c.platform}\u0000${c.scope}\u0000${c.channel}\u0000${c.kind}`;

function newestFirst(a: MemoryRecord, b: MemoryRecord): number {
  return ms(b.created_at) - ms(a.created_at) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);
}

export class FakeStore implements MessageLog, PeopleStore, MemoryRecordStore {
  readonly settings = new MemorySettingsStore();
  readonly #messages = new Map<string, LogEntry[]>();
  readonly #messageIds = new Set<string>();
  readonly #people = new Map<PersonId, { display_name: string; created_at: Timestamp }>();
  readonly #accounts = new Map<string, [PersonId, Account]>();
  readonly #memories = new Map<string, MemoryRecord>();

  // ---- MessageLog ------------------------------------------------------------------------

  async append(entry: LogEntry): Promise<void> {
    if (this.#messageIds.has(entry.id)) throw new Error(`log entry \`${entry.id}\` already exists`);
    this.#messageIds.add(entry.id);
    const key = `${entry.profile}\u0001${contextKey(entry.context)}`;
    let list = this.#messages.get(key);
    if (!list) {
      list = [];
      this.#messages.set(key, list);
    }
    const at = list.findIndex((e) => ms(e.ts) > ms(entry.ts));
    list.splice(at < 0 ? list.length : at, 0, structuredClone(entry));
  }

  async recent(profile: ProfileId, context: ContextKey, limit: number): Promise<LogEntry[]> {
    const list = this.#messages.get(`${profile}\u0001${contextKey(context)}`) ?? [];
    return structuredClone(list.slice(Math.max(0, list.length - limit)));
  }

  async authoredSince(
    profile: ProfileId,
    authors: readonly AccountRef[],
    since: Timestamp,
    limit: number,
  ): Promise<AuthoredEntry[]> {
    const from = Date.parse(since);
    const all = [...this.#messages.values()]
      .flat()
      .filter(
        (e) =>
          e.profile === profile &&
          !e.is_self &&
          Date.parse(e.ts) >= from &&
          authors.some((a) => a.platform === e.author.platform && a.id === e.author.id),
      )
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    return all
      .slice(Math.max(all.length - limit, 0))
      .map((e) => ({ ts: e.ts, kind: e.context.kind }));
  }

  async purge(profile: ProfileId): Promise<number> {
    let n = 0;
    for (const [key, list] of [...this.#messages]) {
      if (key.startsWith(`${profile}\u0001`)) {
        n += list.length;
        this.#messages.delete(key);
      }
    }
    return n;
  }

  // ---- PeopleStore -----------------------------------------------------------------------

  async upsertAccount(account: AccountRef, displayName: string): Promise<PersonId> {
    const now = toTimestamp(Date.now());
    const existing = this.#accounts.get(accountKey(account));
    if (existing) {
      existing[1].display_name = displayName;
      existing[1].last_seen = now;
      return existing[0];
    }
    const person = newId();
    this.#people.set(person, { display_name: displayName, created_at: now });
    this.#accounts.set(accountKey(account), [
      person,
      { account, display_name: displayName, first_seen: now, last_seen: now },
    ]);
    return person;
  }

  async personByAccount(account: AccountRef): Promise<Person | null> {
    const found = this.#accounts.get(accountKey(account));
    if (!found) return null;
    const [id] = found;
    const record = this.#people.get(id);
    if (!record) return null;
    const accounts = [...this.#accounts.values()]
      .filter(([p]) => p === id)
      .map(([, a]) => structuredClone(a))
      .sort((a, b) => ms(a.first_seen) - ms(b.first_seen));
    return { id, display_name: record.display_name, created_at: record.created_at, accounts };
  }

  async all(): Promise<Person[]> {
    const out: Person[] = [];
    for (const [id, record] of this.#people) {
      const accounts = [...this.#accounts.values()]
        .filter(([p]) => p === id)
        .map(([, a]) => structuredClone(a))
        .sort((a, b) => ms(a.first_seen) - ms(b.first_seen));
      out.push({ id, display_name: record.display_name, created_at: record.created_at, accounts });
    }
    return out.sort((a, b) => ms(a.created_at) - ms(b.created_at) || (a.id < b.id ? -1 : 1));
  }

  // ---- MemoryRecordStore -----------------------------------------------------------------

  async upsert(record: MemoryRecord): Promise<void> {
    this.#memories.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const r = this.#memories.get(id);
    return r ? structuredClone(r) : null;
  }

  async delete(id: string): Promise<boolean> {
    return this.#memories.delete(id);
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    if (query.limit === 0) return [];
    const candidates = [...this.#memories.values()]
      .filter(
        (r) =>
          r.profile === query.profile &&
          r.superseded_by === null &&
          query.scopes.some((s) => scopeEquals(s, r.scope)) &&
          (query.kinds === null || query.kinds.includes(r.kind)),
      )
      .sort(newestFirst);

    // Text: fraction of the query tokens that the record contains.
    const wanted = [
      ...new Set(query.tokens.map((t) => t.trim().toLowerCase()).filter((t) => t !== "")),
    ];
    let text: [number, MemoryRecord][] = [];
    if (wanted.length > 0) {
      for (const record of candidates) {
        const have = new Set(
          record.tokens
            .split(/\s+/)
            .filter((t) => t !== "")
            .map((t) => t.toLowerCase()),
        );
        const matched = wanted.filter((t) => have.has(t)).length;
        if (matched > 0) text.push([matched / wanted.length, record]);
      }
      text.sort((a, b) => b[0] - a[0]);
      text = text.slice(0, query.limit);
    }
    const hits: MemoryHit[] = text.map(([score, record]) => ({
      record: structuredClone(record),
      text_score: score,
      vector_score: null,
    }));

    // Vector: brute-force cosine among records of the same dimension.
    const embedding = query.embedding;
    if (embedding !== null) {
      const nearest = candidates
        .filter((r) => r.embedding !== null && r.embedding.length === embedding.length)
        .map((r): [number, MemoryRecord] => [cosine(r.embedding as number[], embedding), r])
        .sort((a, b) => b[0] - a[0])
        .slice(0, query.limit);
      for (const [score, record] of nearest) {
        const hit = hits.find((h) => h.record.id === record.id);
        if (hit) hit.vector_score = score;
        else hits.push({ record: structuredClone(record), text_score: 0, vector_score: score });
      }
    }
    return hits;
  }

  async list(profile: ProfileId, filter: MemoryFilter): Promise<MemoryRecord[]> {
    return [...this.#memories.values()]
      .filter(
        (r) =>
          r.profile === profile &&
          (filter.subject === null || r.subjects.includes(filter.subject)) &&
          (filter.scope === null || scopeEquals(r.scope, filter.scope)) &&
          (filter.kind === null || r.kind === filter.kind) &&
          (filter.before === null || ms(r.created_at) < ms(filter.before)) &&
          (filter.include_superseded || r.superseded_by === null),
      )
      .sort(newestFirst)
      .slice(0, filter.limit)
      .map((r) => structuredClone(r));
  }

  async touch(ids: readonly string[], at: Timestamp): Promise<void> {
    for (const id of new Set(ids)) {
      const r = this.#memories.get(id);
      if (r) {
        r.access_count += 1;
        r.last_accessed = at;
      }
    }
  }

  async dueFollowups(
    profile: ProfileId,
    now: Timestamp,
    maxAgeMs: number | null = null,
  ): Promise<MemoryRecord[]> {
    return [...this.#memories.values()]
      .filter(
        (r) =>
          r.profile === profile &&
          r.kind === "followup" &&
          !r.done &&
          r.superseded_by === null &&
          r.due !== null &&
          ms(r.due) <= ms(now) &&
          (maxAgeMs === null || ms(r.due) >= ms(now) - maxAgeMs),
      )
      .sort((a, b) => ms(b.due as string) - ms(a.due as string) || (a.id < b.id ? 1 : -1))
      .map((r) => structuredClone(r));
  }

  async expireFollowups(profile: ProfileId, dueBefore: Timestamp): Promise<number> {
    let n = 0;
    for (const r of this.#memories.values()) {
      if (
        r.profile === profile &&
        r.kind === "followup" &&
        !r.done &&
        r.due !== null &&
        ms(r.due) < ms(dueBefore)
      ) {
        r.done = true;
        n += 1;
      }
    }
    return n;
  }

  async prune(profile: ProfileId, policy: PrunePolicy): Promise<number> {
    let n = 0;
    for (const [id, r] of this.#memories) {
      if (
        r.profile === profile &&
        r.kind === "episode" &&
        ms(r.created_at) < ms(policy.created_before) &&
        r.importance <= policy.max_importance &&
        (r.last_accessed === null || ms(r.last_accessed) < ms(policy.not_accessed_since))
      ) {
        this.#memories.delete(id);
        n += 1;
      }
    }
    return n;
  }

  async deleteBySubject(profile: ProfileId, person: PersonId): Promise<number> {
    let n = 0;
    for (const [id, r] of this.#memories) {
      const about =
        r.subjects.includes(person) || (r.scope.type === "person" && r.scope.person === person);
      if (r.profile === profile && about) {
        this.#memories.delete(id);
        n += 1;
      }
    }
    return n;
  }

  async mergePerson(keep: PersonId, absorb: PersonId): Promise<number> {
    if (keep === absorb) return 0;
    let n = 0;
    for (const r of this.#memories.values()) {
      const scoped = r.scope.type === "person" && r.scope.person === absorb;
      if (!r.subjects.includes(absorb) && !scoped) continue;
      r.subjects = [...new Set(r.subjects.map((s) => (s === absorb ? keep : s)))];
      if (scoped) r.scope = { type: "person", person: keep };
      n += 1;
    }
    return n;
  }
}
