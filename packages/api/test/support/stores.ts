// In-memory store areas for the API tests (the Rust tests use `Store::memory()`).

import {
  type Account,
  type AuditEntry,
  type AuditLog,
  type AuthScope,
  type AuthStore,
  type DecisionLog,
  type DecisionRecord,
  type IdentityStore,
  type MemberCardRecord,
  type MemberCardStore,
  type MemoryFilter,
  type MemoryHit,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryRecordStore,
  MemorySettingsStore,
  type NodeOverride,
  type PeopleStore,
  type Person,
  type PersonaOverride,
  type PersonaOverrideStore,
  type PrunePolicy,
  type Relationship,
  type RelationshipDelta,
  type RelationshipStore,
  type RoleAssignment,
  type RoleDefinition,
  type RoleMapping,
} from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  contextKeyEquals,
  type JsonObject,
  newId,
  type PersonId,
  type PlatformId,
  type ProfileId,
  sameAccount,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";

const clone = <T>(v: T): T => structuredClone(v);
const ms = (t: Timestamp) => Date.parse(t);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class MemoryDecisionLog implements DecisionLog {
  readonly #records: DecisionRecord[] = [];
  async append(record: DecisionRecord): Promise<void> {
    this.#records.push(clone(record));
  }
  async recent(
    profile: ProfileId,
    context: ContextKey | null,
    limit: number,
  ): Promise<DecisionRecord[]> {
    return this.#records
      .filter((r) => r.profile === profile)
      .filter((r) => context === null || contextKeyEquals(r.trace.context, context))
      .sort((a, b) => ms(b.ts) - ms(a.ts))
      .slice(0, limit)
      .map(clone);
  }
}

export class MemoryPersonaOverrides implements PersonaOverrideStore {
  readonly #rows: PersonaOverride[] = [];
  async set(profile: ProfileId, key: string, body: string, editedBy: string): Promise<number> {
    const version = this.#rows.filter((r) => r.profile === profile && r.key === key).length + 1;
    this.#rows.push({
      profile,
      key,
      version,
      body,
      edited_by: editedBy,
      edited_at: toTimestamp(Date.now()),
    });
    return version;
  }
  async current(profile: ProfileId): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const r of this.#rows) if (r.profile === profile) out.set(r.key, r.body);
    return out;
  }
  async history(profile: ProfileId, key: string): Promise<PersonaOverride[]> {
    return this.#rows.filter((r) => r.profile === profile && r.key === key).map(clone);
  }
}

export class MemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];
  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(clone(entry));
  }
  async recent(limit: number, actor: string | null): Promise<AuditEntry[]> {
    return this.entries
      .filter((e) => actor === null || e.actor === actor)
      .reverse()
      .slice(0, limit)
      .map(clone);
  }
}

export class MemoryRecords implements MemoryRecordStore {
  readonly #rows = new Map<string, MemoryRecord>();
  async upsert(record: MemoryRecord): Promise<void> {
    this.#rows.set(record.id, clone(record));
  }
  async get(id: string): Promise<MemoryRecord | null> {
    const r = this.#rows.get(id);
    return r ? clone(r) : null;
  }
  async delete(id: string): Promise<boolean> {
    return this.#rows.delete(id);
  }
  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const hits: MemoryHit[] = [];
    for (const r of this.#rows.values()) {
      if (r.profile !== query.profile || r.superseded_by !== null) continue;
      if (!query.scopes.some((s) => same(s, r.scope))) continue;
      if (query.kinds && !query.kinds.includes(r.kind)) continue;
      const tokens = new Set(r.tokens.split(" "));
      const matched = query.tokens.filter((t) => tokens.has(t)).length;
      if (matched === 0) continue;
      hits.push({
        record: clone(r),
        text_score: matched / query.tokens.length,
        vector_score: null,
      });
    }
    return hits.slice(0, query.limit);
  }
  async list(profile: ProfileId, filter: MemoryFilter): Promise<MemoryRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.profile === profile)
      .filter((r) => filter.subject === null || r.subjects.includes(filter.subject))
      .filter((r) => filter.scope === null || same(filter.scope, r.scope))
      .filter((r) => filter.kind === null || r.kind === filter.kind)
      .filter((r) => filter.before === null || ms(r.created_at) < ms(filter.before))
      .filter((r) => filter.include_superseded || r.superseded_by === null)
      .sort((a, b) => ms(b.created_at) - ms(a.created_at))
      .slice(0, filter.limit)
      .map(clone);
  }
  async touch(): Promise<void> {}
  async expireFollowups(): Promise<number> {
    return 0;
  }
  async dueFollowups(): Promise<MemoryRecord[]> {
    return [];
  }
  async prune(_profile: ProfileId, _policy: PrunePolicy): Promise<number> {
    return 0;
  }
  async deleteBySubject(): Promise<number> {
    return 0;
  }
  async mergePerson(keep: PersonId, absorb: PersonId): Promise<number> {
    if (keep === absorb) return 0;
    let n = 0;
    for (const r of this.#rows.values()) {
      const scoped = r.scope.type === "person" && r.scope.person === absorb;
      if (!r.subjects.includes(absorb) && !scoped) continue;
      r.subjects = [...new Set(r.subjects.map((s) => (s === absorb ? keep : s)))];
      if (scoped) r.scope = { type: "person", person: keep };
      n += 1;
    }
    return n;
  }
}

/** People, identities and relationships, sharing one account table like the SQL backend. */
export class MemoryPeople implements PeopleStore, IdentityStore {
  readonly #accounts: Array<Account & { person: PersonId }> = [];
  readonly #names = new Map<PersonId, string>();
  readonly #created = new Map<PersonId, Timestamp>();

  async upsertAccount(account: AccountRef, displayName: string): Promise<PersonId> {
    const now = toTimestamp(Date.now());
    const found = this.#accounts.find((a) => sameAccount(a.account, account));
    if (found) {
      found.display_name = displayName;
      found.last_seen = now;
      return found.person;
    }
    const person = newId();
    this.#names.set(person, displayName);
    this.#created.set(person, now);
    this.#accounts.push({
      account: clone(account),
      display_name: displayName,
      first_seen: now,
      last_seen: now,
      person,
    });
    return person;
  }
  async personByAccount(account: AccountRef): Promise<Person | null> {
    const found = this.#accounts.find((a) => sameAccount(a.account, account));
    if (!found) return null;
    const accounts = await this.accountsOf(found.person);
    return {
      id: found.person,
      display_name: this.#names.get(found.person) ?? found.display_name,
      created_at: accounts[0]?.first_seen ?? found.first_seen,
      accounts,
    };
  }
  async all(): Promise<Person[]> {
    const out: Person[] = [];
    for (const [id, name] of this.#names) {
      const accounts = await this.accountsOf(id);
      out.push({
        id,
        display_name: name,
        created_at: this.#created.get(id) ?? toTimestamp(0),
        accounts,
      });
    }
    return out;
  }
  async linkAccount(account: AccountRef, person: PersonId): Promise<void> {
    const found = this.#accounts.find((a) => sameAccount(a.account, account));
    if (found) found.person = person;
  }
  async mergePeople(keep: PersonId, absorb: PersonId): Promise<void> {
    for (const a of this.#accounts) if (a.person === absorb) a.person = keep;
    this.#names.delete(absorb);
  }
  async accountsOf(person: PersonId): Promise<Account[]> {
    return this.#accounts.filter((a) => a.person === person).map(({ person: _, ...a }) => clone(a));
  }
  async setPersonName(person: PersonId, displayName: string): Promise<void> {
    this.#names.set(person, displayName);
  }
  async createLinkCode(): Promise<void> {}
  async consumeLinkCode(): Promise<AccountRef | null> {
    return null;
  }
}

export class MemoryRelationships implements RelationshipStore {
  readonly #rows = new Map<string, Relationship>();
  readonly #deltas = new Map<string, RelationshipDelta[]>();
  async get(profile: ProfileId, person: PersonId): Promise<Relationship | null> {
    const r = this.#rows.get(`${profile}/${person}`);
    return r ? clone(r) : null;
  }
  async upsert(relationship: Relationship): Promise<void> {
    this.#rows.set(`${relationship.profile}/${relationship.person}`, clone(relationship));
  }
  async list(profile: ProfileId): Promise<Relationship[]> {
    return [...this.#rows.values()].filter((r) => r.profile === profile).map(clone);
  }
  async delete(profile: ProfileId, person: PersonId): Promise<boolean> {
    return this.#rows.delete(`${profile}/${person}`);
  }
  async recordDelta(profile: ProfileId, person: PersonId, delta: RelationshipDelta): Promise<void> {
    const key = `${profile}/${person}`;
    const list = this.#deltas.get(key) ?? [];
    list.push(clone(delta));
    this.#deltas.set(key, list);
  }
  async deltasSince(
    profile: ProfileId,
    person: PersonId,
    since: Timestamp,
  ): Promise<RelationshipDelta[]> {
    return (this.#deltas.get(`${profile}/${person}`) ?? [])
      .filter((d) => ms(d.at) >= ms(since))
      .map(clone);
  }
}

export class MemoryAuthStore implements AuthStore {
  readonly #roles = new Map<string, RoleDefinition>();
  #assignments: RoleAssignment[] = [];
  #mappings: RoleMapping[] = [];
  #overrides: NodeOverride[] = [];

  async roles(): Promise<RoleDefinition[]> {
    return [...this.#roles.values()].map(clone);
  }
  async upsertRole(role: RoleDefinition): Promise<void> {
    this.#roles.set(role.name, clone(role));
  }
  async deleteRole(name: string): Promise<boolean> {
    return this.#roles.delete(name);
  }
  async assignmentsFor(account: AccountRef): Promise<RoleAssignment[]> {
    return this.#assignments.filter((a) => sameAccount(a.account, account)).map(clone);
  }
  async allAssignments(): Promise<RoleAssignment[]> {
    return this.#assignments.map(clone);
  }
  async assign(assignment: RoleAssignment): Promise<void> {
    this.#assignments = this.#assignments.filter(
      (a) =>
        !(
          sameAccount(a.account, assignment.account) &&
          a.role === assignment.role &&
          same(a.scope, assignment.scope)
        ),
    );
    this.#assignments.push(clone(assignment));
  }
  async revoke(account: AccountRef, role: string, scope: AuthScope): Promise<boolean> {
    const before = this.#assignments.length;
    this.#assignments = this.#assignments.filter(
      (a) => !(sameAccount(a.account, account) && a.role === role && same(a.scope, scope)),
    );
    return this.#assignments.length < before;
  }
  async mappings(platform: PlatformId, guild: string): Promise<RoleMapping[]> {
    return this.#mappings.filter((m) => m.platform === platform && m.guild === guild).map(clone);
  }
  async setMapping(mapping: RoleMapping): Promise<void> {
    await this.removeMapping(mapping.platform, mapping.guild, mapping.platform_role);
    this.#mappings.push(clone(mapping));
  }
  async removeMapping(platform: PlatformId, guild: string, platformRole: string): Promise<boolean> {
    const before = this.#mappings.length;
    this.#mappings = this.#mappings.filter(
      (m) => !(m.platform === platform && m.guild === guild && m.platform_role === platformRole),
    );
    return this.#mappings.length < before;
  }
  async overrides(): Promise<NodeOverride[]> {
    return this.#overrides.map(clone);
  }
  async setOverride(o: NodeOverride): Promise<void> {
    await this.removeOverride(o.scope, o.role, o.node);
    this.#overrides.push(clone(o));
  }
  async removeOverride(scope: AuthScope, role: string, node: string): Promise<boolean> {
    const before = this.#overrides.length;
    this.#overrides = this.#overrides.filter(
      (o) => !(same(o.scope, scope) && o.role === role && o.node === node),
    );
    return this.#overrides.length < before;
  }
}

export class MemoryMemberCards implements MemberCardStore {
  #cards: MemberCardRecord[] = [];
  #mine(profile: ProfileId, accounts: readonly AccountRef[]): MemberCardRecord[] {
    return this.#cards.filter(
      (c) => c.profile === profile && accounts.some((a) => sameAccount(a, c.account)),
    );
  }
  async issue(card: MemberCardRecord): Promise<void> {
    if (this.#cards.some((c) => c.serial === card.serial)) {
      throw new Error(`member card \`${card.serial}\` already exists`);
    }
    this.#cards.push(clone(card));
  }
  async bySerial(profile: ProfileId, serial: string): Promise<MemberCardRecord | null> {
    const found = this.#cards.find((c) => c.profile === profile && c.serial === serial);
    return found ? clone(found) : null;
  }
  async amend(profile: ProfileId, serial: string, snapshot: JsonObject): Promise<boolean> {
    const found = this.#cards.find((c) => c.profile === profile && c.serial === serial);
    if (!found) return false;
    found.snapshot = clone(snapshot);
    return true;
  }
  async listFor(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    limit: number,
  ): Promise<MemberCardRecord[]> {
    return this.#mine(profile, accounts).reverse().slice(0, limit).map(clone);
  }
  async countSince(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    since: Timestamp,
  ): Promise<number> {
    return this.#mine(profile, accounts).filter((c) => ms(c.issued_at) >= ms(since)).length;
  }
  async countFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    return this.#mine(profile, accounts).length;
  }
  async deleteFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number> {
    const gone = new Set(this.#mine(profile, accounts));
    this.#cards = this.#cards.filter((c) => !gone.has(c));
    return gone.size;
  }
}

/** Every area the tests use, like Rust's `Store::memory()`. */
export class TestStore {
  readonly decisions = new MemoryDecisionLog();
  readonly personaOverrides = new MemoryPersonaOverrides();
  readonly audit = new MemoryAuditLog();
  readonly memories = new MemoryRecords();
  readonly people = new MemoryPeople();
  readonly identity: IdentityStore = this.people;
  readonly relationships = new MemoryRelationships();
  readonly auth = new MemoryAuthStore();
  readonly settings = new MemorySettingsStore();
  readonly cards = new MemoryMemberCards();
}
