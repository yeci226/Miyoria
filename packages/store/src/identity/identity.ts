// The `identity` plugin's operations (docs/design/v5-data.md §4): persons and their accounts,
// handles, a person's own choices, link codes, merges, and the resolver from a `ContextKey` to a
// space, a room and a session. Every call is synchronous (`node:sqlite`) and runs in one
// transaction, joining the caller's when there is one (`Db.tx`).

import { createHash } from "node:crypto";
import {
  type AccountRef,
  assignHandle,
  type ContextKey,
  type ContextKind,
  type Handle,
  newId,
  type PersonId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { StoreError, toMicros } from "../common.js";
import type { Db } from "../db.js";
import {
  type AccountRow,
  accounts,
  type Lane,
  type LinkedBy,
  linkCodes,
  type PersonPrefs,
  type PersonRow,
  persons,
  type RoomKind,
  type RoomRow,
  rooms,
  sessions,
  spaceMembers,
  spaces,
} from "./schema.js";

/** Where a message happened, as rows: what `Identity.resolve` returns. */
export interface Place {
  /** `null` for DMs. */
  space_id: string | null;
  room_id: string;
  /** The session key (§4.1): `discord:<guild>:<channel>`, `discord:dm:<person>`, `home`, ... */
  session: string;
  lane: Lane;
  /** The author's person, when an author was given (always set for a DM). */
  person_id: PersonId | null;
}

/** Who wrote in a place: the account and the name it showed. */
export interface PlaceAuthor {
  account: AccountRef;
  display_name: string;
}

export interface ResolveOptions {
  /** A thread's channel (platform id), from the platform's thread event. */
  parent?: string | null;
  /** Names to record, when the platform gave them. */
  space_name?: string | null;
  room_name?: string | null;
}

/** The session key of her own space (§4.1). */
export const HOME_SESSION = "home";

/** `memberSeen` writes a current membership again only after this long (milliseconds). */
export const MEMBER_SEEN_MS = 60_000;

const ROOM_KIND: Readonly<Record<ContextKind, RoomKind>> = {
  channel: "text",
  thread: "thread",
  voice: "voice",
  dm: "dm",
};

/**
 * The session key of a place (§4.1): a DM's is its person's (`dmPerson`, required for a DM), a
 * voice room's has the `voice:` infix, a thread whose channel is known (`parent`, its platform id)
 * names it.
 */
function sessionKey(ctx: ContextKey, dmPerson: PersonId | null, parent: string | null): string {
  if (ctx.scope === null) {
    return `${ctx.platform}:dm:${ctx.kind === "voice" ? "voice:" : ""}${dmPerson}`;
  }
  if (ctx.kind === "voice") return `${ctx.platform}:${ctx.scope}:voice:${ctx.channel}`;
  if (ctx.kind === "thread" && parent !== null) {
    return `${ctx.platform}:${ctx.scope}:${parent}:${ctx.channel}`;
  }
  return `${ctx.platform}:${ctx.scope}:${ctx.channel}`;
}

/** A Space or a room row that appeared or changed (a Space's name, left, back). */
export interface PlaceRowChange {
  kind: "space" | "room";
  space_id: string | null;
  room_id: string | null;
}

// Listeners by database, so every `Identity` on one connection reports to every reader of it.
const placeListeners = new WeakMap<Db, Set<(change: PlaceRowChange) => void>>();

/** Calls `listener` after a space or room row of `db` is created or changed; returns the unsubscribe. */
export function onPlaceRows(db: Db, listener: (change: PlaceRowChange) => void): () => void {
  let set = placeListeners.get(db);
  if (set === undefined) {
    set = new Set();
    placeListeners.set(db, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

function placeChanged(db: Db, change: PlaceRowChange): void {
  for (const listener of placeListeners.get(db) ?? []) {
    try {
      listener(change);
    } catch {
      // A reader's cache must not break a write.
    }
  }
}

/** sha256 (hex) of a link code: codes are never stored as typed. */
export function linkCodeHash(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Persons, accounts and places on one database. */
export class Identity {
  readonly #db: Db;
  // The hottest lookups, prepared once.
  readonly #accountByRef;
  readonly #personById;
  readonly #personByHandle;

  constructor(db: Db) {
    this.#db = db;
    const orm = db.orm;
    const platform = sql.placeholder("platform");
    const id = sql.placeholder("id");
    this.#accountByRef = orm
      .select()
      .from(accounts)
      .where(and(eq(accounts.platform, platform), eq(accounts.external_id, id)))
      .prepare();
    this.#personById = orm.select().from(persons).where(eq(persons.id, id)).prepare();
    this.#personByHandle = orm
      .select()
      .from(persons)
      .where(sql`${persons.handle} = ${sql.placeholder("handle")} COLLATE NOCASE`)
      .prepare();
  }

  #now(): Timestamp {
    return toTimestamp(this.#db.clock.now());
  }

  // ---- reads ---------------------------------------------------------------------------

  account(ref: AccountRef): AccountRow | null {
    return this.#accountByRef.get({ platform: ref.platform, id: ref.id }) ?? null;
  }

  /** The row of `id` as it is (a merged person too). */
  personRow(id: PersonId): PersonRow | null {
    return this.#personById.get({ id }) ?? null;
  }

  /** The person `id` is now: itself, or the person that absorbed it. `null` if unknown. */
  person(id: PersonId): PersonRow | null {
    let row = this.personRow(id);
    for (let hops = 0; row?.merged_into != null && hops < 16; hops++) {
      row = this.personRow(row.merged_into);
    }
    return row?.merged_into == null ? row : null;
  }

  /** The person an account belongs to, `null` if it is unknown or no person yet. */
  personOf(ref: AccountRef): PersonRow | null {
    const person = this.account(ref)?.person_id;
    return person == null ? null : this.person(person);
  }

  /** The persons merged into `person` (a merge points every one it absorbed at the keeper). */
  absorbedInto(person: PersonId): PersonId[] {
    return this.#db.orm
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.merged_into, person))
      .orderBy(asc(persons.id))
      .all()
      .map((r) => r.id as PersonId);
  }

  /** A person's accounts, by first sight. */
  accountsOf(person: PersonId): AccountRow[] {
    return this.#db.orm
      .select()
      .from(accounts)
      .where(eq(accounts.person_id, person))
      .orderBy(asc(accounts.first_seen), asc(accounts.platform), asc(accounts.external_id))
      .all();
  }

  /** Every person not merged into another, oldest first. */
  persons(): PersonRow[] {
    return this.#db.orm
      .select()
      .from(persons)
      .where(isNull(persons.merged_into))
      .orderBy(asc(persons.created_at), asc(persons.id))
      .all();
  }

  /** Every account that belongs to a person, by first sight. */
  personAccounts(): AccountRow[] {
    return this.#db.orm
      .select()
      .from(accounts)
      .where(sql`${accounts.person_id} IS NOT NULL`)
      .orderBy(asc(accounts.first_seen), asc(accounts.platform), asc(accounts.external_id))
      .all();
  }

  /** The person whose handle is `handle`, ignoring case (callers compare exactly). */
  personByHandle(handle: Handle): PersonRow | null {
    return this.#personByHandle.get({ handle }) ?? null;
  }

  // ---- accounts and persons ------------------------------------------------------------

  #taken = (handle: Handle): boolean => this.personByHandle(handle) !== null;

  #newPerson(name: string, at: Timestamp): PersonRow {
    const row = {
      id: newId(),
      name,
      handle: assignHandle(name, this.#taken),
      created_at: at,
    };
    return this.#db.orm.insert(persons).values(row).returning().get();
  }

  /**
   * The account row of `ref`, created without a person when it is new (a link code can name an
   * account that never spoke). Its name is its id until it is seen.
   */
  ensureAccount(ref: AccountRef): AccountRow {
    return this.#db.tx(() => {
      const found = this.account(ref);
      if (found) return found;
      const at = this.#now();
      return this.#db.orm
        .insert(accounts)
        .values({
          id: newId(),
          platform: ref.platform,
          external_id: ref.id,
          display_name: ref.id,
          first_seen: at,
          last_seen: at,
        })
        .returning()
        .get();
    });
  }

  /**
   * Records that `ref` was seen as `displayName` and returns its person, made on first sight
   * (`linked_by = 'first_sight'`) with a handle from the name. A person that was only known by an
   * unseen account's id (someone set a choice before speaking) takes the real name now.
   */
  see(ref: AccountRef, displayName: string): PersonRow {
    return this.#db.tx(() => {
      const at = this.#now();
      const found = this.account(ref);
      const unseen = found !== null && found.display_name === found.external_id;
      if (found?.person_id != null) {
        this.#db.orm
          .update(accounts)
          .set({ display_name: displayName, last_seen: at })
          .where(eq(accounts.id, found.id))
          .run();
        const person = this.person(found.person_id);
        if (person === null) throw new StoreError(`account ${found.id} has a dangling person`);
        if (unseen && person.name === found.external_id && displayName !== found.external_id) {
          return this.#rename(person, displayName);
        }
        return person;
      }
      const person = this.#newPerson(displayName, at);
      const linked = { person_id: person.id, linked_at: at, linked_by: "first_sight" as const };
      if (found) {
        this.#db.orm
          .update(accounts)
          .set({ ...linked, display_name: displayName, last_seen: at })
          .where(eq(accounts.id, found.id))
          .run();
      } else {
        this.#db.orm
          .insert(accounts)
          .values({
            id: newId(),
            platform: ref.platform,
            external_id: ref.id,
            display_name: displayName,
            first_seen: at,
            last_seen: at,
            ...linked,
          })
          .run();
      }
      return person;
    });
  }

  /** A person known only by an account id gets a real name and a handle made from it. */
  #rename(person: PersonRow, name: string): PersonRow {
    if (this.accountsOf(person.id).length !== 1) return person;
    const taken = (h: Handle) => {
      const other = this.personByHandle(h);
      return other !== null && other.id !== person.id;
    };
    const row = { ...person, name, handle: assignHandle(name, taken) };
    this.#db.orm
      .update(persons)
      .set({ name: row.name, handle: row.handle })
      .where(eq(persons.id, person.id))
      .run();
    return row;
  }

  #live(id: PersonId): PersonRow {
    const row = this.personRow(id);
    if (row === null || row.merged_into !== null) throw new StoreError(`unknown person \`${id}\``);
    return row;
  }

  /** Moves `ref` to `person` (creating the account row if needed). */
  link(ref: AccountRef, person: PersonId, by: LinkedBy): void {
    this.#db.tx(() => {
      this.#live(person);
      const account = this.ensureAccount(ref);
      if (account.person_id === person) return;
      this.#db.orm
        .update(accounts)
        .set({ person_id: person, linked_at: this.#now(), linked_by: by })
        .where(eq(accounts.id, account.id))
        .run();
    });
  }

  /**
   * `absorb` becomes part of `keep`: its accounts, DM rooms and choices (where `keep` made none)
   * move over, and its row stays with `merged_into` set so its id still resolves.
   */
  merge(keep: PersonId, absorb: PersonId): void {
    this.#db.tx(() => {
      const kept = this.#live(keep);
      const absorbed = this.#live(absorb);
      if (keep === absorb) return;
      const orm = this.#db.orm;
      orm.update(accounts).set({ person_id: keep }).where(eq(accounts.person_id, absorb)).run();
      orm.update(rooms).set({ dm_person: keep }).where(eq(rooms.dm_person, absorb)).run();
      orm
        .update(persons)
        .set({ merged_into: keep })
        .where(sql`${persons.id} = ${absorb} OR ${persons.merged_into} = ${absorb}`)
        .run();
      const prefs: PersonPrefs = { ...absorbed.prefs, ...kept.prefs };
      orm.update(persons).set({ prefs }).where(eq(persons.id, keep)).run();
    });
  }

  rename(person: PersonId, name: string): void {
    this.#db.tx(() => {
      this.#live(person);
      this.#db.orm.update(persons).set({ name }).where(eq(persons.id, person)).run();
    });
  }

  // ---- a person's choices --------------------------------------------------------------

  /** One of a person's choices, by one of their accounts; `null` when never made. */
  pref<K extends keyof PersonPrefs>(ref: AccountRef, key: K): PersonPrefs[K] | null {
    return this.personOf(ref)?.prefs[key] ?? null;
  }

  /**
   * Sets (or, with `null`, clears) one of a person's choices by one of their accounts. Making a
   * choice before ever speaking makes the person, named by the account id until seen.
   */
  setPref<K extends keyof PersonPrefs>(
    ref: AccountRef,
    key: K,
    value: NonNullable<PersonPrefs[K]> | null,
  ): void {
    this.#db.tx(() => {
      let person = this.personOf(ref);
      if (person === null) {
        if (value === null) return;
        person = this.see(ref, this.account(ref)?.display_name ?? ref.id);
      }
      const prefs: PersonPrefs = { ...person.prefs };
      if (value === null) delete prefs[key];
      else prefs[key] = value;
      this.#db.orm.update(persons).set({ prefs }).where(eq(persons.id, person.id)).run();
    });
  }

  /** Every account whose person made choice `key`, with it, by account. */
  prefsByAccount<K extends keyof PersonPrefs>(
    key: K,
  ): Array<{ account: AccountRow; value: NonNullable<PersonPrefs[K]> }> {
    const out: Array<{ account: AccountRow; value: NonNullable<PersonPrefs[K]> }> = [];
    const live = new Map(this.persons().map((p) => [p.id, p] as const));
    for (const account of this.personAccounts()) {
      const value = live.get(account.person_id ?? "")?.prefs[key];
      if (value !== undefined && value !== null) out.push({ account, value });
    }
    return out;
  }

  // ---- link codes ----------------------------------------------------------------------

  /** Stores a one-time code (hashed) issued to `ref`; the same code issued again replaces it. */
  createLinkCode(code: string, ref: AccountRef, expiresAt: Timestamp): void {
    this.#db.tx(() => {
      const account = this.ensureAccount(ref);
      const row = { code_hash: linkCodeHash(code), account_id: account.id, expires_at: expiresAt };
      this.#db.orm
        .insert(linkCodes)
        .values(row)
        .onConflictDoUpdate({
          target: linkCodes.code_hash,
          set: { account_id: row.account_id, expires_at: row.expires_at },
        })
        .run();
    });
  }

  /** The account that issued `code`, if it is still valid at `now`. The code is used up. */
  consumeLinkCode(code: string, now: Timestamp): AccountRef | null {
    return this.#db.tx(() => {
      const used = this.#db.orm
        .delete(linkCodes)
        .where(eq(linkCodes.code_hash, linkCodeHash(code)))
        .returning()
        .get();
      if (!used || toMicros(used.expires_at) <= toMicros(now)) return null;
      const account = this.#db.orm
        .select({ platform: accounts.platform, id: accounts.external_id })
        .from(accounts)
        .where(eq(accounts.id, used.account_id))
        .get();
      return account ?? null;
    });
  }

  // ---- places --------------------------------------------------------------------------

  /**
   * The id of the space `(platform, externalId)`: created on first sight (the first one ever is
   * primary), renamed when `name` is new, and no longer left (something happened there, so she is
   * in it).
   */
  #space(platform: string, externalId: string, name: string | null, at: Timestamp): string {
    const found = this.#db.orm
      .select({ id: spaces.id, name: spaces.name, left_at: spaces.left_at })
      .from(spaces)
      .where(and(eq(spaces.platform, platform), eq(spaces.external_id, externalId)))
      .get();
    if (found) {
      const change: { name?: string; left_at?: null } = {};
      if (name !== null && name !== found.name) change.name = name;
      if (found.left_at !== null) change.left_at = null;
      if (Object.keys(change).length > 0) {
        this.#db.orm.update(spaces).set(change).where(eq(spaces.id, found.id)).run();
        placeChanged(this.#db, { kind: "space", space_id: found.id, room_id: null });
      }
      return found.id;
    }
    const id = newId();
    const primary = this.#db.orm
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.is_primary, true))
      .get();
    this.#db.orm
      .insert(spaces)
      .values({
        id,
        platform,
        external_id: externalId,
        name: name ?? externalId,
        joined_at: at,
        is_primary: primary === undefined,
        // The first Space of a fresh install is the original one; a later one starts quiet.
        established: primary === undefined,
      })
      .run();
    placeChanged(this.#db, { kind: "space", space_id: id, room_id: null });
    return id;
  }

  #room(
    platform: string,
    externalId: string,
    fields: {
      kind: RoomKind;
      space_id: string | null;
      parent_id: string | null;
      dm_person: PersonId | null;
      name: string | null;
    },
    at: Timestamp,
  ): RoomRow {
    const found = this.#db.orm
      .select()
      .from(rooms)
      .where(and(eq(rooms.platform, platform), eq(rooms.external_id, externalId)))
      .get();
    if (!found) {
      const row = this.#db.orm
        .insert(rooms)
        .values({ id: newId(), platform, external_id: externalId, created_at: at, ...fields })
        .returning()
        .get();
      placeChanged(this.#db, { kind: "room", space_id: row.space_id, room_id: row.id });
      return row;
    }
    // A voice channel's text chat has the voice channel's id: seeing it as voice once makes it a
    // voice room, and text never turns it back.
    const change: Partial<RoomRow> = {};
    if (fields.kind === "voice" && found.kind === "text") change.kind = "voice";
    if (found.parent_id === null && fields.parent_id !== null) change.parent_id = fields.parent_id;
    if (found.dm_person === null && fields.dm_person !== null) change.dm_person = fields.dm_person;
    if (fields.name !== null && fields.name !== found.name) change.name = fields.name;
    if (Object.keys(change).length === 0) return found;
    this.#db.orm.update(rooms).set(change).where(eq(rooms.id, found.id)).run();
    if (change.parent_id !== undefined) {
      placeChanged(this.#db, { kind: "room", space_id: found.space_id, room_id: found.id });
    }
    return { ...found, ...change };
  }

  /** The id of the space `(platform, externalId)`, created on first sight (named by its id). */
  ensureSpace(platform: string, externalId: string): string {
    return this.#db.tx(() => this.#space(platform, externalId, null, this.#now()));
  }

  /**
   * She is in the space `(platform, externalId)` (the platform says so: she joined, or it is in
   * her list on connecting): created on first sight, renamed, no longer left. Returns its id.
   */
  seenSpace(platform: string, externalId: string, name: string | null): string {
    return this.#db.tx(() => this.#space(platform, externalId, name, this.#now()));
  }

  /** She left the space `(platform, externalId)`: it is marked left; an unknown one is ignored. */
  leftSpace(platform: string, externalId: string): void {
    this.#db.tx(() => {
      const left = this.#db.orm
        .update(spaces)
        .set({ left_at: this.#now() })
        .where(
          and(
            eq(spaces.platform, platform),
            eq(spaces.external_id, externalId),
            isNull(spaces.left_at),
          ),
        )
        .returning({ id: spaces.id })
        .get();
      if (left) placeChanged(this.#db, { kind: "space", space_id: left.id, room_id: null });
    });
  }

  /**
   * `account` is a member of `spaceId` from `at`: the row is made, or its `last_seen` moves and a
   * `left` mark goes (acting there means they are there). The one write behind every way of
   * becoming a member: a message (`resolve`) and `memberSeen`.
   */
  #member(spaceId: string, accountId: string, at: Timestamp): void {
    this.#db.orm
      .insert(spaceMembers)
      .values({ space_id: spaceId, account_id: accountId, last_seen: at })
      .onConflictDoUpdate({
        target: [spaceMembers.space_id, spaceMembers.account_id],
        set: { last_seen: at, left_at: null },
      })
      .run();
  }

  /**
   * `ref` acted in the space `spaceId` without writing there (a command, a control, a modal, being
   * in one of its voice channels): seen like an author (`see`, with `name` when the platform gave
   * one) and made a member, or a member again, as a message would. Called on every interaction, so
   * it writes nothing when the membership is current: not left, seen under `MEMBER_SEEN_MS` ago,
   * the account already a person's and the name unchanged. An unknown space is ignored.
   */
  memberSeen(spaceId: string, ref: AccountRef, name: string | null = null): void {
    if (typeof spaceId !== "string" || spaceId === "") return;
    this.#db.tx(() => {
      const at = this.#now();
      const found = this.account(ref);
      const nameKnown = name === null || name === "" || name === found?.display_name;
      if (found?.person_id != null && nameKnown) {
        const row = this.#db.orm
          .select({ left_at: spaceMembers.left_at, last_seen: spaceMembers.last_seen })
          .from(spaceMembers)
          .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.account_id, found.id)))
          .get();
        if (
          row !== undefined &&
          row.left_at === null &&
          toMicros(at) - toMicros(row.last_seen) < MEMBER_SEEN_MS * 1000
        ) {
          return;
        }
      }
      const space = this.#db.orm
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .get();
      if (space === undefined) return;
      const shown = name !== null && name !== "" ? name : (found?.display_name ?? ref.id);
      this.see(ref, shown);
      const account = this.account(ref);
      if (account !== null) this.#member(spaceId, account.id, at);
    });
  }

  /** `account` left the space `spaceId`: its membership is marked left (the next message clears it). */
  memberLeft(spaceId: string, account: AccountRef): void {
    this.#db.tx(() => {
      const row = this.account(account);
      if (row === null) return;
      this.#db.orm
        .update(spaceMembers)
        .set({ left_at: this.#now() })
        .where(
          and(
            eq(spaceMembers.space_id, spaceId),
            eq(spaceMembers.account_id, row.id),
            isNull(spaceMembers.left_at),
          ),
        )
        .run();
    });
  }

  /**
   * The room `(platform, externalId)` of a space, created with the space on first sight (named
   * by nothing yet): for a setting given before anyone spoke there, such as the config import's.
   */
  ensureRoom(
    platform: string,
    spaceExternalId: string,
    externalId: string,
    kind: "text" | "voice",
  ): RoomRow {
    return this.#db.tx(() => {
      const at = this.#now();
      const spaceId = this.#space(platform, spaceExternalId, null, at);
      const fields = { kind, space_id: spaceId, parent_id: null, dm_person: null, name: null };
      return this.#room(platform, externalId, fields, at);
    });
  }

  #roomExternalId(id: string): string | null {
    const row = this.#db.orm
      .select({ external_id: rooms.external_id })
      .from(rooms)
      .where(eq(rooms.id, id))
      .get();
    return row?.external_id ?? null;
  }

  #session(key: string, place: Omit<Place, "session">, at: Timestamp): void {
    this.#db.orm
      .insert(sessions)
      .values({
        key,
        space_id: place.space_id,
        room_id: place.room_id,
        person_id: place.space_id === null ? place.person_id : null,
        lane: place.lane,
        created_at: at,
        last_at: at,
      })
      .onConflictDoUpdate({
        target: sessions.key,
        set: { last_at: at, room_id: place.room_id },
      })
      .run();
  }

  /**
   * The space, room and session of `ctx`, created on first sight (§4.2). With an author, their
   * person is made or updated too (`see`) and, in a space, their membership. A DM's session is
   * the person's, not the channel's: two accounts of one person share it, and it remembers the
   * room last used, to reply through.
   */
  resolve(ctx: ContextKey, author: PlaceAuthor | null = null, options: ResolveOptions = {}): Place {
    return this.#db.tx(() => {
      const at = this.#now();
      const person = author === null ? null : this.see(author.account, author.display_name);
      const spaceId =
        ctx.scope === null
          ? null
          : this.#space(ctx.platform, ctx.scope, options.space_name ?? null, at);
      const dm = ctx.scope === null;
      let parentId: string | null = null;
      if (ctx.kind === "thread" && options.parent != null) {
        parentId = this.#room(
          ctx.platform,
          options.parent,
          { kind: "text", space_id: spaceId, parent_id: null, dm_person: null, name: null },
          at,
        ).id;
      }
      const room = this.#room(
        ctx.platform,
        ctx.channel,
        {
          kind: dm ? "dm" : ROOM_KIND[ctx.kind],
          space_id: spaceId,
          parent_id: parentId,
          dm_person: dm ? (person?.id ?? null) : null,
          name: options.room_name ?? null,
        },
        at,
      );
      const lane: Lane = ctx.kind === "voice" ? "voice" : "text";
      let personId = person?.id ?? null;
      if (dm) {
        personId ??= room.dm_person === null ? null : (this.person(room.dm_person)?.id ?? null);
        if (personId === null) {
          throw new StoreError(
            `a DM (${ctx.platform}:${ctx.channel}) resolves only with its author`,
          );
        }
      }
      const parent =
        ctx.kind === "thread"
          ? (options.parent ??
            (room.parent_id === null ? null : this.#roomExternalId(room.parent_id)))
          : null;
      const key = sessionKey(ctx, personId, parent);
      const place = { space_id: spaceId, room_id: room.id, lane, person_id: personId };
      this.#session(key, place, at);
      if (spaceId !== null && author !== null) {
        // Writing there means they are there: a left membership comes back.
        const account = this.account(author.account);
        if (account !== null) this.#member(spaceId, account.id, at);
      }
      return { ...place, session: key };
    });
  }

  /**
   * The session key `resolve` would give `ctx`, without writing anything: `null` when its room
   * is unknown, or when it is a DM whose person is unknown.
   */
  sessionOf(ctx: ContextKey): string | null {
    const room = this.#db.orm
      .select({ parent_id: rooms.parent_id, dm_person: rooms.dm_person })
      .from(rooms)
      .where(and(eq(rooms.platform, ctx.platform), eq(rooms.external_id, ctx.channel)))
      .get();
    if (!room) return null;
    let personId: PersonId | null = null;
    if (ctx.scope === null) {
      personId = room.dm_person === null ? null : (this.person(room.dm_person)?.id ?? null);
      if (personId === null) return null;
    }
    const parent =
      ctx.kind === "thread" && room.parent_id !== null
        ? this.#roomExternalId(room.parent_id)
        : null;
    return sessionKey(ctx, personId, parent);
  }

  /** Her own space's session (`home`), created on first use. */
  home(): string {
    const at = this.#now();
    this.#db.orm
      .insert(sessions)
      .values({ key: HOME_SESSION, lane: "home", created_at: at, last_at: at })
      .onConflictDoNothing()
      .run();
    return HOME_SESSION;
  }
}
