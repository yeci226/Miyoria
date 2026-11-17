// Who people are, for the heart (phase 4 step 5, docs/design/v5-heart.md §2.10): which person an
// account belongs to, their name, her own accounts and names, the owner tag for the accounts the
// authorizer treats as owners, and `/me link` (two accounts, one person). It used to be the
// `social` module's; its numbers are gone, so what is left lives with the rows it is about.
//
// It is also `SocialSignalsKey`: every reader of how she feels about someone by account
// (the queue's weighting, the gate's stranger and blocked checks, world salience, the economy's
// member check, ...) gets an `Attitude` made from the person's `heart_person` row. It answers
// from memory and SQLite, never awaiting: the account map is filled at start (every person with
// a row) and as accounts are seen.

import { getLogger, sleep } from "@miyoria/runtime/kernel";
import { hookCounts, type IdentityStore, type PeopleStore } from "@miyoria/store";
import {
  type AccountRef,
  type Attitude,
  type Authorizer,
  accountRefString,
  type Clock,
  newId,
  type PersonId,
  type ProfileId,
  relationshipLabel,
  type SocialSignals,
  type Subject,
  sameAccount,
  serviceKey,
  toTimestamp,
} from "@miyoria/types";
import { BLOCKED_TAG, type HeartPerson, hasTag, OWNER_TAG } from "./model.js";
import type { HeartStore } from "./store.js";

const log = getLogger("heart.people");

const LINK_CODE_MINUTES = 10;
const LINK_MAX_FAILURES = 5;
const MINUTE_MS = 60_000;
/** Rows read per page when the account map is filled at start. */
const LOAD_PAGE = 200;

/** Result of `/me link <code>`. */
export type LinkOutcome =
  | { type: "linked"; keep: PersonId; absorbed: PersonId }
  | { type: "already_linked" }
  | { type: "same_account" }
  | { type: "invalid_code" }
  | { type: "too_many_attempts" }
  /** No identity store is configured. */
  | { type: "unavailable" };

export interface DirectoryStores {
  people: PeopleStore;
  /** For `/me link` and the accounts of the people with a row; `null`: neither. */
  identity: IdentityStore | null;
  heart: HeartStore;
}

/** How she feels about `p`, as the readers by account see it. */
export function attitudeOf(p: HeartPerson, displayName: string | null): Attitude {
  return {
    person: p.person_id,
    affinity: p.bond,
    trust: p.trust,
    familiarity: p.familiarity,
    blocked: hasTag(p, BLOCKED_TAG),
    label: relationshipLabel({ affinity: p.bond, met: p.interactions > 0 || p.bond !== 0 }),
    call_name: p.call_name,
    owner: hasTag(p, OWNER_TAG),
    display_name: displayName,
    interactions: p.interactions,
    last_interaction: p.last_interaction,
  };
}

/** Who people are (`PeopleDirectoryKey`), and `SocialSignalsKey`. */
export class PeopleDirectory implements SocialSignals {
  readonly profile: ProfileId;
  readonly herName: string;
  readonly clock: Clock;
  /** Lower-cased names that address her. */
  readonly #names: string[];
  readonly #stores: DirectoryStores;
  readonly #autoOwner: boolean;
  #authorizer: Authorizer | null = null;
  readonly #personNames = new Map<PersonId, string>();
  readonly #accounts = new Map<string, PersonId>();
  readonly #selfAccounts = new Map<string, AccountRef>();
  readonly #linkFailures = new Map<string, { since: number; count: number }>();
  /** Accounts the platform says are bots. */
  readonly #bots = new Set<string>();

  constructor(
    profile: ProfileId,
    herName: string,
    names: readonly string[],
    stores: DirectoryStores,
    clock: Clock,
    options: { autoOwnerTag?: boolean } = {},
  ) {
    this.profile = profile;
    this.herName = herName;
    const lowered = [...names, herName].map((n) => n.trim().toLowerCase()).filter(Boolean);
    this.#names = [...new Set(lowered)].sort();
    this.#stores = stores;
    this.clock = clock;
    this.#autoOwner = options.autoOwnerTag ?? true;
  }

  /** The heart's rows. */
  get heart(): HeartStore {
    return this.#stores.heart;
  }

  /** Used to tag owners and for owner-only commands; may be replaced at runtime. */
  setAuthorizer(authorizer: Authorizer | null): void {
    this.#authorizer = authorizer;
  }

  get authorizer(): Authorizer | null {
    return this.#authorizer;
  }

  /** Which accounts belong to the people with a row, when an identity store is there. */
  async load(): Promise<void> {
    const identity = this.#stores.identity;
    if (!identity) return;
    let offset: number | null = 0;
    let people = 0;
    while (offset !== null) {
      const page = this.#stores.heart.list({ offset, limit: LOAD_PAGE });
      for (const { person } of page.entries) {
        try {
          for (const a of await identity.accountsOf(person.person_id)) {
            this.#personNames.set(person.person_id, a.display_name);
            this.#accounts.set(accountRefString(a.account), person.person_id);
          }
          people += 1;
        } catch (error) {
          log.warn({ person: person.person_id, err: error }, "cannot load accounts");
        }
      }
      offset = page.next;
      // A page at a time: the rest of the process runs between pages.
      if (offset !== null) await sleep(0);
    }
    log.info({ profile: this.profile, people }, "people loaded");
  }

  /** One of her own accounts; whether it was new. */
  addSelfAccount(account: AccountRef): boolean {
    const key = accountRefString(account);
    if (this.#selfAccounts.has(key)) return false;
    this.#selfAccounts.set(key, { platform: account.platform, id: account.id });
    return true;
  }

  /** Her own accounts as known so far (the module keeps them across restarts). */
  selfAccounts(): AccountRef[] {
    return [...this.#selfAccounts.values()];
  }

  isSelf(account: AccountRef): boolean {
    return this.#selfAccounts.has(accountRefString(account));
  }

  /** What the platform says of `account`: a bot or not. */
  noteBot(account: AccountRef, isBot: boolean): void {
    const key = accountRefString(account);
    if (isBot) this.#bots.add(key);
    else this.#bots.delete(key);
  }

  isBot(account: AccountRef): boolean {
    return this.#bots.has(accountRefString(account));
  }

  /** Whether one of the accounts of `person` is a bot. */
  isBotPerson(person: PersonId): boolean {
    for (const [key, p] of this.#accounts) if (p === person && this.#bots.has(key)) return true;
    return false;
  }

  /** Whether `text` names her (one of her names, any case). */
  mentionsHer(text: string): boolean {
    const lower = text.toLowerCase();
    return this.#names.some((n) => lower.includes(n));
  }

  personOf(account: AccountRef): PersonId | null {
    return this.#accounts.get(accountRefString(account)) ?? null;
  }

  displayName(person: PersonId): string | null {
    return this.#personNames.get(person) ?? null;
  }

  /** People whose known display name equals `name` (any case). */
  peopleNamed(name: string): PersonId[] {
    const wanted = name.trim().toLowerCase();
    const out: PersonId[] = [];
    for (const [p, n] of this.#personNames) if (n.toLowerCase() === wanted) out.push(p);
    return out.sort();
  }

  /** Owner check for commands; `fallback` is used when no authorizer is set. */
  subjectIsOwner(subject: Subject, fallback: boolean): boolean {
    const a = this.#authorizer;
    return a ? a.allowsSubject(subject, "owner.person.adjust") : fallback;
  }

  /**
   * Account → person, from the map or the people store. With a display name the account is
   * recorded (a person is made on first sight); without one, an unknown account is `null`. An
   * account the authorizer treats as an owner gets the `owner` tag on the person's row.
   */
  async resolve(
    account: AccountRef,
    displayName: string | null,
    now: number,
  ): Promise<PersonId | null> {
    let person = this.personOf(account);
    if (person === null) {
      let name: string;
      if (displayName !== null) {
        person = await this.#stores.people.upsertAccount(account, displayName);
        name = displayName;
      } else {
        const p = await this.#stores.people.personByAccount(account);
        if (!p) return null;
        person = p.id;
        name =
          p.accounts.find((a) => sameAccount(a.account, account))?.display_name ?? p.display_name;
      }
      this.#accounts.set(accountRefString(account), person);
      if (!this.#personNames.has(person)) this.#personNames.set(person, name);
    }
    if (displayName !== null) this.#personNames.set(person, displayName);
    if (this.#autoOwner && this.#authorizer?.allows(account, "owner.social")) {
      const row = this.#stores.heart.get(person);
      if (row === null || !hasTag(row, OWNER_TAG)) {
        this.#stores.heart.setTag(person, OWNER_TAG, true, { now });
      }
    }
    return person;
  }

  attitude(account: AccountRef): Attitude | null {
    const person = this.personOf(account);
    return person === null ? null : this.attitudeOf(person);
  }

  attitudeOf(person: PersonId): Attitude | null {
    const row = this.#stores.heart.get(person);
    return row === null ? null : attitudeOf(row, this.displayName(person));
  }

  /** Issues a one-time `/me link` code for `account` (valid 10 minutes); `null` without identity. */
  async issueLinkCode(
    account: AccountRef,
    displayName: string,
    now: number,
  ): Promise<string | null> {
    const identity = this.#stores.identity;
    if (!identity) return null;
    await this.resolve(account, displayName, now);
    const code = newId().slice(-8);
    await identity.createLinkCode(code, account, toTimestamp(now + LINK_CODE_MINUTES * MINUTE_MS));
    return code;
  }

  /**
   * Redeems a code from another account: the invoker's person is merged into the issuer's. The
   * identity store's merge moves what every schema keeps about them in one transaction (the
   * heart's rows become one, `HeartStore.merge`).
   */
  async redeemLinkCode(
    account: AccountRef,
    displayName: string,
    code: string,
    now: number,
  ): Promise<LinkOutcome> {
    const identity = this.#stores.identity;
    if (!identity) return { type: "unavailable" };
    const window = LINK_CODE_MINUTES * MINUTE_MS;
    const key = accountRefString(account);
    const failures = this.#linkFailures.get(key);
    if (failures) {
      if (now - failures.since > window) this.#linkFailures.delete(key);
      else if (failures.count >= LINK_MAX_FAILURES) return { type: "too_many_attempts" };
    }
    const issuer = await identity.consumeLinkCode(code.trim().toUpperCase(), toTimestamp(now));
    if (!issuer) {
      const f = this.#linkFailures.get(key) ?? { since: now, count: 0 };
      f.count += 1;
      this.#linkFailures.set(key, f);
      return { type: "invalid_code" };
    }
    if (sameAccount(issuer, account)) return { type: "same_account" };
    const keep = await this.resolve(issuer, null, now);
    if (keep === null) return { type: "invalid_code" };
    const absorb = await this.resolve(account, displayName, now);
    if (absorb === null) return { type: "invalid_code" };
    if (keep === absorb) return { type: "already_linked" };
    await identity.linkAccount(account, keep);
    const merged = await identity.mergePeople(keep, absorb);
    const moved = merged === null ? undefined : hookCounts(merged, "memory").records;
    for (const [k, p] of this.#accounts) if (p === absorb) this.#accounts.set(k, keep);
    this.#personNames.delete(absorb);
    if (moved === undefined) log.info({ keep, absorb }, "accounts linked; memories are not merged");
    else log.info({ keep, absorb, memories: moved }, "accounts linked");
    return { type: "linked", keep, absorbed: absorb };
  }
}

/** The people directory itself (the account map, names, linking). */
export const PeopleDirectoryKey = serviceKey<PeopleDirectory>("PeopleDirectory");
