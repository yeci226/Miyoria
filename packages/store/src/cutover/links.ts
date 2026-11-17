// `miyoria db import-links`: who people are, carried over from the V4 database (docs/design/
// v5-data.md §4.3, decisions D3 and D4). Everything else stays behind: bonds, memories, coins,
// cards, messages, events, settings blobs.
//
// It reads the old file through `openReadOnly` (nothing next to it changes) and copies:
// - `people (id, display_name, created_at)` -> `persons` with the same id, `name`, `created_at`;
// - `accounts (platform, account_id, person_id, display_name, first_seen, last_seen)` ->
//   `accounts` with a new id, `linked_by = 'import'`;
// - `profile_settings` of `_global`, `handle:<platform>:<id>` -> `persons.handle`: a person takes
//   the oldest handle row of their accounts (or that names them), as V4's directory answered;
//   a handle taken ignoring case (V4 kept `Owen` and `owen` apart, V5 does not) gets the next
//   free suffix (`owen#2`), the older row keeping the bare one; a person with no row gets one
//   made from their name. Rows of accounts that were never a person are left: they get a handle
//   when they speak;
// - `profile_settings` of `_global`, `privacy:*` and `voice_consent:*` -> `persons.prefs`, as the
//   feature wrote them; when a person's accounts disagree, the latest choice wins. A choice of an
//   account that was never a person (someone who only listened in voice) is kept too: the import
//   makes the person to hold it, named by that account's handle row when there is one;
// - for the keepsake, `persons.legacy = {first_seen, old_tier, cards}`: the earliest `first_seen`
//   of their accounts, the name of the bond tier their `relationships` row gave at the archive
//   (V4's thresholds, frozen here), and how many `member_cards` she had given them (the card's
//   person, else its account's).
// One `identity.imported` event per person it makes.
//
// It skips a person whose id is already in the new database (so a second run changes nothing),
// and a person with no account left (V4 moved their accounts to someone else). It refuses, writing
// nothing, when an account of a person it would make already belongs to another person there:
// V5 met them first, so the import runs before V5 talks to anyone. All writes are one transaction.

import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  IdentityImported,
  type IdentityImportedData,
  IdentityImportedSchema,
} from "@miyoria/contracts/events";
import {
  type AccountRef,
  assignHandle,
  type Clock,
  type Handle,
  isValidHandle,
  type JsonValue,
  newId,
  type PersonId,
  systemClock,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { eq } from "drizzle-orm";
import { fromMicros } from "../common.js";
import { Db } from "../db.js";
import { EventStore } from "../events/log.js";
import { Identity } from "../identity/identity.js";
import { identitySchema } from "../identity/migrations.js";
import { accounts, type LegacySnapshot, type PersonPrefs, persons } from "../identity/schema.js";
import { migrate } from "../migrate.js";
import { CutoverError, fileFacts, openReadOnly, sameFile, tablesOf } from "./old-file.js";

/** The `source` of the events the import writes. */
export const LINK_IMPORT_SOURCE = "identity.import";

/** The V4 settings profile that held handles and a person's choices. */
const GLOBAL = "_global";
const HANDLE = "handle:";
const PREFS = { privacy: "privacy:", voice_consent: "voice_consent:" } as const;
export type PrefName = keyof typeof PREFS;
const PREF_NAMES = Object.keys(PREFS) as PrefName[];

/** Tables a V4 file has from its first migrations on. */
const V4_TABLES = ["schema_version", "people", "accounts", "profile_settings"];

// ---- V4's bond tiers, as V4 named them (main:packages/types/src/affect.ts) --------------------
// Kept as V4 had them on purpose: 家人般 is 宛若家人 in V5 (H10), but this reads V4's records.

const V4_BOND_TIERS: ReadonlyArray<readonly [number, string]> = [
  [1000, "永恆羈絆"],
  [870, "心之所歸"],
  [750, "無可取代"],
  [640, "命運相連"],
  [540, "生死之交"],
  [450, "家人般"],
  [370, "形影不離"],
  [300, "心有靈犀"],
  [240, "莫逆之交"],
  [190, "至交"],
  [150, "知己"],
  [120, "知心"],
];

/** The tier name V4 showed for a relationship (`relationshipLabel` there). */
export function v4TierName(affinity: number, familiarity: number): string {
  if (affinity <= -50) return "很討厭";
  if (affinity <= -15) return "討厭";
  if (affinity >= 75 && familiarity >= 30) {
    for (const [min, name] of V4_BOND_TIERS) if (affinity >= min) return name;
    return "摯友";
  }
  if (affinity >= 45 && familiarity >= 10) return "好朋友";
  if (affinity >= 15) return "朋友";
  if (familiarity < 3) return "陌生人";
  return "認識";
}

// ---- results --------------------------------------------------------------------------------

/** One account the import links. */
export interface PlannedAccount {
  platform: string;
  external_id: string;
  display_name: string;
  first_seen: Timestamp;
  last_seen: Timestamp;
  /** The row already in the new database without a person, which the import links; else new. */
  existing_id: string | null;
}

/** One person the import makes. */
export interface PlannedPerson {
  /** The V4 id, kept; a new id for a person made only to hold a choice. */
  id: PersonId;
  /** `person`: a V4 person. `choice`: made to hold the choice of an account that was none. */
  kind: "person" | "choice";
  name: string;
  handle: Handle;
  /** The V4 handle row it came from, `null` when there was none. */
  old_handle: Handle | null;
  created_at: Timestamp;
  accounts: PlannedAccount[];
  prefs: PersonPrefs;
  /** `null` for a `choice` person. */
  legacy: LegacySnapshot | null;
}

/** A choice of an account that already belongs to a person in the new database. */
export interface PlannedPref {
  person_id: PersonId;
  account: AccountRef;
  pref: PrefName;
  value: JsonValue;
}

/** An account of a person the import would make that belongs to someone else already. */
export interface LinkConflict {
  /** The V4 person. */
  person: PersonId;
  name: string;
  platform: string;
  external_id: string;
  /** The person it belongs to in the new database. */
  owner: PersonId;
}

export interface LinkImportResult {
  dry_run: boolean;
  /** The old file's name. */
  from: string;
  /** The character whose bonds and cards made the keepsakes (`null`: the file had none). */
  profile: string | null;
  persons: PlannedPerson[];
  /** Choices added to people already in the new database. */
  prefs_added: PlannedPref[];
  skipped: {
    /** V4 people whose id is already in the new database. */
    existing: PersonId[];
    /** V4 people with no account left. */
    no_accounts: Array<{ id: PersonId; name: string }>;
    /** Accounts whose person is not in `people`. */
    orphan_accounts: Array<{ platform: string; external_id: string; person_id: string }>;
    /** Handle rows no person took (accounts that were never a person, or a person's older names). */
    handles: number;
    /** Choices already made in the new database (left as they are). */
    prefs: number;
    /** Settings rows that are not readable JSON or not the shape their feature writes. */
    unreadable: string[];
  };
  /** Non-empty only in a dry run: a real run refuses instead. */
  conflicts: LinkConflict[];
  /** `identity.imported` events written (0 in a dry run). */
  events: number;
}

/** The numbers the CLI prints at the end. */
export interface LinkImportCounts {
  persons: number;
  choice_persons: number;
  accounts: number;
  handles_kept: number;
  handles_renamed: number;
  handles_made: number;
  privacy: number;
  voice_consent: number;
  with_tier: number;
  cards: number;
  events: number;
  skipped_existing: number;
  skipped_no_accounts: number;
  orphan_accounts: number;
  handles_left: number;
  conflicts: number;
}

export function linkImportCounts(result: LinkImportResult): LinkImportCounts {
  const people = result.persons.filter((p) => p.kind === "person");
  const prefCount = (name: PrefName) =>
    result.persons.filter((p) => p.prefs[name] !== undefined).length +
    result.prefs_added.filter((p) => p.pref === name).length;
  return {
    persons: people.length,
    choice_persons: result.persons.length - people.length,
    accounts: result.persons.reduce((n, p) => n + p.accounts.length, 0),
    handles_kept: result.persons.filter((p) => p.old_handle !== null && p.old_handle === p.handle)
      .length,
    handles_renamed: result.persons.filter(
      (p) => p.old_handle !== null && p.old_handle !== p.handle,
    ).length,
    handles_made: result.persons.filter((p) => p.old_handle === null).length,
    privacy: prefCount("privacy"),
    voice_consent: prefCount("voice_consent"),
    with_tier: people.filter((p) => p.legacy?.old_tier != null).length,
    cards: people.reduce((n, p) => n + (p.legacy?.cards ?? 0), 0),
    events: result.events,
    skipped_existing: result.skipped.existing.length,
    skipped_no_accounts: result.skipped.no_accounts.length,
    orphan_accounts: result.skipped.orphan_accounts.length,
    handles_left: result.skipped.handles,
    conflicts: result.conflicts.length,
  };
}

// ---- reading the V4 file ------------------------------------------------------------------------

type Row = Record<string, SQLOutputValue>;

function str(row: Row, column: string): string {
  const v = row[column];
  if (typeof v !== "string")
    throw new CutoverError("not_v4", `V4 column \`${column}\` is not text`);
  return v;
}

function optStr(row: Row, column: string): string | null {
  const v = row[column];
  return v === null || v === undefined ? null : str(row, column);
}

function num(row: Row, column: string): number {
  const v = row[column];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new CutoverError("not_v4", `V4 column \`${column}\` is not a number`);
}

interface V4Account {
  platform: string;
  external_id: string;
  person_id: string;
  display_name: string;
  first_seen: number;
  last_seen: number;
}

interface HandleRow {
  key: string;
  account: AccountRef;
  handle: Handle;
  person: string | null;
  display_name: string;
  /** Milliseconds; rows without a readable time sort last. */
  created_ms: number;
}

interface PrefRow {
  account: AccountRef;
  pref: PrefName;
  value: JsonValue;
  updated_at: number;
}

interface V4Data {
  people: Array<{ id: string; name: string; created_at: number }>;
  accounts: V4Account[];
  handles: HandleRow[];
  prefs: PrefRow[];
  unreadable: string[];
  /** `(profile, person) -> tier name`. */
  tiers: Array<{ profile: string; person: string; tier: string }>;
  cards: Array<{ profile: string; person: string | null; account: AccountRef }>;
}

const refKey = (ref: AccountRef) => `${ref.platform}:${ref.id}`;

/** `<prefix><platform>:<id>` -> the account, or `null`. */
function keyAccount(key: string, prefix: string): AccountRef | null {
  const rest = key.slice(prefix.length);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  return { platform: rest.slice(0, colon), id: rest.slice(colon + 1) };
}

function parseHandle(key: string, account: AccountRef, value: unknown): HandleRow | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.handle !== "string" || !isValidHandle(v.handle)) return null;
  const created = typeof v.created_at === "string" ? Date.parse(v.created_at) : Number.NaN;
  return {
    key,
    account,
    handle: v.handle,
    person: typeof v.person === "string" ? v.person : null,
    display_name: typeof v.display_name === "string" ? v.display_name : v.handle,
    created_ms: Number.isFinite(created) ? created : Number.POSITIVE_INFINITY,
  };
}

function readV4(db: DatabaseSync, path: string): V4Data {
  const tables = tablesOf(db);
  const missing = V4_TABLES.filter((t) => !tables.has(t));
  if (missing.length > 0) {
    throw new CutoverError(
      "not_v4",
      `${path} is not a V4 database (no ${missing.map((t) => `\`${t}\``).join(", ")})`,
    );
  }
  const all = (sql: string) => db.prepare(sql).all() as Row[];
  const people = all("SELECT id, display_name, created_at FROM people ORDER BY created_at, id").map(
    (r) => ({ id: str(r, "id"), name: str(r, "display_name"), created_at: num(r, "created_at") }),
  );
  const accountRows = all(
    "SELECT platform, account_id, person_id, display_name, first_seen, last_seen FROM accounts " +
      "ORDER BY first_seen, platform, account_id",
  ).map((r) => ({
    platform: str(r, "platform"),
    external_id: str(r, "account_id"),
    person_id: str(r, "person_id"),
    display_name: str(r, "display_name"),
    first_seen: num(r, "first_seen"),
    last_seen: num(r, "last_seen"),
  }));

  const handles: HandleRow[] = [];
  const prefs: PrefRow[] = [];
  const unreadable: string[] = [];
  const settings = db
    .prepare(
      "SELECT key, value, updated_at FROM profile_settings WHERE profile_id = $profile AND " +
        "(substr(key, 1, 7) = 'handle:' OR substr(key, 1, 8) = 'privacy:' OR " +
        "substr(key, 1, 14) = 'voice_consent:') ORDER BY key",
    )
    .all({ profile: GLOBAL }) as Row[];
  for (const row of settings) {
    const key = str(row, "key");
    let value: JsonValue;
    try {
      value = JSON.parse(str(row, "value")) as JsonValue;
    } catch {
      unreadable.push(key);
      continue;
    }
    if (key.startsWith(HANDLE)) {
      const account = keyAccount(key, HANDLE);
      const parsed = account === null ? null : parseHandle(key, account, value);
      if (parsed === null) unreadable.push(key);
      else handles.push(parsed);
      continue;
    }
    const pref = PREF_NAMES.find((name) => key.startsWith(PREFS[name])) as PrefName;
    const account = keyAccount(key, PREFS[pref]);
    if (account === null) unreadable.push(key);
    else if (value !== null) {
      prefs.push({ account, pref, value, updated_at: num(row, "updated_at") });
    }
  }

  const tiers = tables.has("relationships")
    ? all("SELECT profile_id, person_id, affinity, familiarity FROM relationships").map((r) => ({
        profile: str(r, "profile_id"),
        person: str(r, "person_id"),
        tier: v4TierName(num(r, "affinity"), num(r, "familiarity")),
      }))
    : [];
  const cards = tables.has("member_cards")
    ? all("SELECT profile_id, author_platform, author_id, person_id FROM member_cards").map(
        (r) => ({
          profile: str(r, "profile_id"),
          person: optStr(r, "person_id"),
          account: { platform: str(r, "author_platform"), id: str(r, "author_id") },
        }),
      )
    : [];
  return { people, accounts: accountRows, handles, prefs, unreadable, tiers, cards };
}

// ---- the plan -------------------------------------------------------------------------------

/** What the import writes through: identity and the event log on the new database. */
export interface LinkTarget {
  db: Db;
  identity: Identity;
  /** `null` for a target opened only to look (a dry run). */
  events: EventStore | null;
}

export interface LinkImportOptions {
  /** Count and list, write nothing. */
  dryRun?: boolean;
  /**
   * The character whose bonds and cards make the keepsakes (`core.profile`). Needed when the file
   * holds several; refused when the file has bonds or cards but none of this one.
   */
  profile?: string | null;
}

function chooseProfile(data: V4Data, wanted: string | null, path: string): string | null {
  const found = [...new Set([...data.tiers, ...data.cards].map((r) => r.profile))]
    .filter((p) => p !== GLOBAL)
    .sort();
  if (wanted !== null) {
    if (found.length > 0 && !found.includes(wanted)) {
      throw new CutoverError(
        "profile",
        `${path} has no bonds or cards of \`${wanted}\` (it has ${found.map((p) => `\`${p}\``).join(", ")})`,
      );
    }
    return wanted;
  }
  if (found.length > 1) {
    throw new CutoverError(
      "profile",
      `${path} holds the bonds and cards of ${found.map((p) => `\`${p}\``).join(", ")}: name the character`,
    );
  }
  return found[0] ?? null;
}

const byAge = (a: HandleRow, b: HandleRow) =>
  a.created_ms - b.created_ms || (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0);

/** The latest value of each choice among `rows`. */
function latestPrefs(rows: readonly PrefRow[]): PersonPrefs {
  const prefs: PersonPrefs = {};
  const at: Partial<Record<PrefName, number>> = {};
  for (const row of rows) {
    if ((at[row.pref] ?? Number.NEGATIVE_INFINITY) > row.updated_at) continue;
    prefs[row.pref] = row.value;
    at[row.pref] = row.updated_at;
  }
  return prefs;
}

function plan(
  data: V4Data,
  target: LinkTarget,
  profile: string | null,
  now: Timestamp,
): Omit<LinkImportResult, "dry_run" | "from" | "profile" | "events"> {
  const { identity } = target;
  const peopleIds = new Set(data.people.map((p) => p.id));
  const accountsOf = new Map<string, V4Account[]>();
  const ownerOf = new Map<string, string>();
  const orphans: LinkImportResult["skipped"]["orphan_accounts"] = [];
  for (const a of data.accounts) {
    if (!peopleIds.has(a.person_id)) {
      orphans.push({ platform: a.platform, external_id: a.external_id, person_id: a.person_id });
      continue;
    }
    accountsOf.set(a.person_id, [...(accountsOf.get(a.person_id) ?? []), a]);
    ownerOf.set(refKey({ platform: a.platform, id: a.external_id }), a.person_id);
  }
  const orphanByKey = new Map(
    data.accounts
      .filter((a) => !peopleIds.has(a.person_id))
      .map((a) => [refKey({ platform: a.platform, id: a.external_id }), a] as const),
  );
  const handlesByAccount = new Map<string, HandleRow[]>();
  const handlesByPerson = new Map<string, HandleRow[]>();
  for (const h of data.handles) {
    const k = refKey(h.account);
    handlesByAccount.set(k, [...(handlesByAccount.get(k) ?? []), h]);
    if (h.person !== null)
      handlesByPerson.set(h.person, [...(handlesByPerson.get(h.person) ?? []), h]);
  }
  const prefsByAccount = new Map<string, PrefRow[]>();
  for (const p of data.prefs) {
    const k = refKey(p.account);
    prefsByAccount.set(k, [...(prefsByAccount.get(k) ?? []), p]);
  }
  const tierOf = new Map(
    data.tiers.filter((t) => t.profile === profile).map((t) => [t.person, t.tier] as const),
  );
  const cardsOf = new Map<string, number>();
  for (const card of data.cards) {
    if (card.profile !== profile) continue;
    const person =
      card.person !== null && peopleIds.has(card.person)
        ? card.person
        : ownerOf.get(refKey(card.account));
    if (person !== undefined) cardsOf.set(person, (cardsOf.get(person) ?? 0) + 1);
  }

  const used = new Set<string>();
  const existing: PersonId[] = [];
  const noAccounts: Array<{ id: PersonId; name: string }> = [];
  const conflicts: LinkConflict[] = [];
  const prefsAdded: PlannedPref[] = [];
  let prefsSkipped = 0;
  // Handles are given once everyone is known, oldest V4 row first (see the file comment).
  const drafts: Array<{ person: Omit<PlannedPerson, "handle">; row: HandleRow | null }> = [];

  const planAccount = (
    a: { platform: string; external_id: string },
    person: string,
    name: string,
  ) => {
    const found = identity.account({ platform: a.platform, id: a.external_id });
    if (found?.person_id != null && found.person_id !== person) {
      conflicts.push({
        person,
        name,
        platform: a.platform,
        external_id: a.external_id,
        owner: found.person_id,
      });
    }
    return found?.id ?? null;
  };

  for (const p of data.people) {
    if (identity.personRow(p.id) !== null) {
      existing.push(p.id);
      for (const a of accountsOf.get(p.id) ?? []) {
        for (const h of handlesByAccount.get(refKey({ platform: a.platform, id: a.external_id })) ??
          [])
          used.add(h.key);
      }
      for (const h of handlesByPerson.get(p.id) ?? []) used.add(h.key);
      continue;
    }
    const own = accountsOf.get(p.id) ?? [];
    if (own.length === 0) {
      noAccounts.push({ id: p.id, name: p.name });
      continue;
    }
    const refs = own.map((a) => refKey({ platform: a.platform, id: a.external_id }));
    const candidates = [
      ...refs.flatMap((k) => handlesByAccount.get(k) ?? []),
      ...(handlesByPerson.get(p.id) ?? []),
    ].sort(byAge);
    for (const h of candidates) used.add(h.key);
    drafts.push({
      person: {
        id: p.id,
        kind: "person",
        name: p.name,
        old_handle: candidates[0]?.handle ?? null,
        created_at: fromMicros(p.created_at),
        accounts: own.map((a) => ({
          platform: a.platform,
          external_id: a.external_id,
          display_name: a.display_name,
          first_seen: fromMicros(a.first_seen),
          last_seen: fromMicros(a.last_seen),
          existing_id: planAccount(a, p.id, p.name),
        })),
        prefs: latestPrefs(refs.flatMap((k) => prefsByAccount.get(k) ?? [])),
        legacy: {
          first_seen: fromMicros(Math.min(...own.map((a) => a.first_seen))),
          old_tier: tierOf.get(p.id) ?? null,
          cards: cardsOf.get(p.id) ?? 0,
        },
      },
      row: candidates[0] ?? null,
    });
  }

  // Choices of accounts that were never a person: kept on the person who has the account in the
  // new database, else on a person made for them.
  for (const [k, rows] of prefsByAccount) {
    if (ownerOf.has(k)) continue;
    const account = (rows[0] as PrefRow).account;
    const chosen = latestPrefs(rows);
    const found = identity.account(account);
    const owner = found?.person_id == null ? null : identity.person(found.person_id);
    if (owner !== null) {
      for (const name of PREF_NAMES) {
        const value = chosen[name];
        if (value === undefined) continue;
        if (owner.prefs[name] !== undefined) prefsSkipped++;
        else prefsAdded.push({ person_id: owner.id, account, pref: name, value });
      }
      continue;
    }
    const row = (handlesByAccount.get(k) ?? []).sort(byAge)[0] ?? null;
    if (row !== null) used.add(row.key);
    const orphan = orphanByKey.get(k);
    const name = orphan?.display_name ?? row?.display_name ?? account.id;
    const seen = orphan
      ? fromMicros(orphan.first_seen)
      : row !== null && Number.isFinite(row.created_ms)
        ? toTimestamp(row.created_ms)
        : now;
    drafts.push({
      person: {
        id: newId(),
        kind: "choice",
        name,
        old_handle: row?.handle ?? null,
        created_at: seen,
        accounts: [
          {
            platform: account.platform,
            external_id: account.id,
            display_name: name,
            first_seen: seen,
            last_seen: orphan ? fromMicros(orphan.last_seen) : seen,
            existing_id: found?.id ?? null,
          },
        ],
        prefs: chosen,
        legacy: null,
      },
      row,
    });
  }

  const taken = new Set<string>();
  const isTaken = (h: Handle) => taken.has(h.toLowerCase()) || identity.personByHandle(h) !== null;
  const order = drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => {
      if (a.d.row !== null && b.d.row !== null) return byAge(a.d.row, b.d.row) || a.i - b.i;
      return (a.d.row === null ? 1 : 0) - (b.d.row === null ? 1 : 0) || a.i - b.i;
    });
  const handles = new Map<number, Handle>();
  for (const { d, i } of order) {
    const wanted = d.row?.handle ?? d.person.name;
    const handle = d.row !== null && !isTaken(wanted) ? wanted : assignHandle(wanted, isTaken);
    taken.add(handle.toLowerCase());
    handles.set(i, handle);
  }
  const planned = drafts.map((d, i) => ({ ...d.person, handle: handles.get(i) as Handle }));

  return {
    persons: planned,
    prefs_added: prefsAdded,
    skipped: {
      existing,
      no_accounts: noAccounts,
      orphan_accounts: orphans,
      handles: data.handles.filter((h) => !used.has(h.key)).length,
      prefs: prefsSkipped,
      unreadable: data.unreadable,
    },
    conflicts,
  };
}

// ---- writing --------------------------------------------------------------------------------

function write(target: LinkTarget, result: LinkImportResult, now: Timestamp): number {
  const { db, identity, events } = target;
  if (events === null) throw new CutoverError("not_v5", "the import needs a writable database");
  let written = 0;
  db.tx(() => {
    const orm = db.orm;
    for (const p of result.persons) {
      orm
        .insert(persons)
        .values({
          id: p.id,
          name: p.name,
          handle: p.handle,
          prefs: p.prefs,
          created_at: p.created_at,
          legacy: p.legacy,
        })
        .run();
      for (const a of p.accounts) {
        const linked = { person_id: p.id, linked_at: now, linked_by: "import" as const };
        if (a.existing_id !== null) {
          orm
            .update(accounts)
            .set({ ...linked, display_name: a.display_name, first_seen: a.first_seen })
            .where(eq(accounts.id, a.existing_id))
            .run();
        } else {
          orm
            .insert(accounts)
            .values({
              id: newId(),
              platform: a.platform,
              external_id: a.external_id,
              display_name: a.display_name,
              first_seen: a.first_seen,
              last_seen: a.last_seen,
              ...linked,
            })
            .run();
        }
      }
      const data: IdentityImportedData = IdentityImportedSchema.parse({
        handle: p.handle,
        old_handle: p.old_handle,
        name: p.name,
        accounts: p.accounts.map((a) => ({ platform: a.platform, external_id: a.external_id })),
        prefs: PREF_NAMES.filter((name) => p.prefs[name] !== undefined),
        legacy: p.legacy,
        from: result.from,
      });
      events.appendNow({
        draft: {
          id: newId(),
          at: now,
          type: IdentityImported.type,
          v: IdentityImported.v,
          person_id: p.id,
          data,
        },
        source: LINK_IMPORT_SOURCE,
      });
      written++;
    }
    for (const p of result.prefs_added) {
      identity.setPref(p.account, p.pref, p.value as NonNullable<PersonPrefs[PrefName]>);
    }
  });
  return written;
}

/**
 * Imports the people of the V4 database open on `old` (its file name is `from`) into `target`, or,
 * with `dryRun`, only says what it would do. Throws a `CutoverError` for a file that is not V4, an
 * unclear profile, or (unless `dryRun`) accounts that already belong to someone else; then nothing
 * is written.
 */
export function importLinks(
  target: LinkTarget,
  old: DatabaseSync,
  from: string,
  options: LinkImportOptions = {},
): LinkImportResult {
  const data = readV4(old, from);
  const profile = chooseProfile(data, options.profile ?? null, from);
  const now = toTimestamp(target.db.clock.now());
  const planned = plan(data, target, profile, now);
  const result: LinkImportResult = {
    dry_run: options.dryRun === true,
    from,
    profile,
    ...planned,
    events: 0,
  };
  if (result.dry_run) return result;
  if (result.conflicts.length > 0) {
    const list = result.conflicts
      .slice(0, 5)
      .map((c) => `${c.platform}:${c.external_id} (${c.name})`)
      .join(", ");
    throw new CutoverError(
      "conflict",
      `${result.conflicts.length} account(s) of people in ${from} already belong to someone in ` +
        `the new database: ${list}. Run the import before V5 talks to anyone, on a new database`,
    );
  }
  result.events = write(target, result, now);
  return result;
}

// ---- files ----------------------------------------------------------------------------------

/** The new database, opened by the import. */
export interface OpenedLinkTarget extends LinkTarget {
  /** The file did not exist (or was empty) and the import made it. */
  readonly created: boolean;
  close(): void;
}

/** What is at `path` as far as the import is concerned, refusing anything but a V5 database. */
function targetState(path: string): "absent" | "blank" | "v5" {
  const facts = fileFacts(path);
  if (!facts.exists || facts.size === 0) return "absent";
  const ro = openReadOnly(path);
  let tables: Set<string>;
  try {
    tables = tablesOf(ro.db);
  } finally {
    ro.close();
  }
  if (tables.has("schema_version")) {
    throw new CutoverError(
      "not_v5",
      `${path} is a V4 database: the import writes into the new one (\`core.database_url\`, ` +
        "for example `sqlite:data/core.db`)",
    );
  }
  if (tables.size === 0) return "blank";
  if (!tables.has("_migrations") || !tables.has("persons")) {
    throw new CutoverError("not_v5", `${path} is not a Miyoria V5 database`);
  }
  return "v5";
}

/** An empty new database in memory, to see what an import would bring without a target. */
export function emptyLinkTarget(clock: Clock = systemClock): OpenedLinkTarget {
  const db = new Db(new DatabaseSync(":memory:", { enableForeignKeyConstraints: true }), clock);
  migrate(db, [identitySchema], { location: ":memory:" });
  const identity = new Identity(db);
  return { db, identity, events: null, created: true, close: () => db.close() };
}

/**
 * Opens the new database to import into: a missing or empty file is made and migrated (`core`
 * and `identity`; Core migrates the rest at its first start). With `look`, nothing is written: an
 * existing file is read through `openReadOnly`, a missing one is stood in for by an empty database
 * in memory.
 */
export function openLinkTarget(
  path: string,
  options: { look?: boolean; clock?: Clock } = {},
): OpenedLinkTarget {
  const clock = options.clock ?? systemClock;
  const state = targetState(path);
  if (options.look) {
    if (state !== "v5") return emptyLinkTarget(clock);
    const ro = openReadOnly(path);
    const db = new Db(ro.db, clock);
    return {
      db,
      identity: new Identity(db),
      events: null,
      created: false,
      close: () => ro.close(),
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new Db(new DatabaseSync(path, { enableForeignKeyConstraints: true }), clock);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, [identitySchema], { location: path });
  } catch (error) {
    db.close();
    throw error;
  }
  const identity = new Identity(db);
  return {
    db,
    identity,
    events: new EventStore(db, { identity }),
    created: state !== "v5",
    close: () => db.close(),
  };
}

export interface LinkFileImportResult extends LinkImportResult {
  /** The new database's path, and whether the import made it (never in a dry run). */
  target: string;
  created: boolean;
}

/**
 * `importLinks` from the V4 file `from` into the V5 file `to`. The old file is only read (see
 * `openReadOnly`); a dry run does not touch the new one either.
 */
export function importLinksFromFile(
  from: string,
  to: string,
  options: LinkImportOptions & { clock?: Clock } = {},
): LinkFileImportResult {
  if (sameFile(from, to)) {
    throw new CutoverError("same_file", `${from} is both the old and the new database`);
  }
  const old = openReadOnly(from);
  try {
    // Refuse a file that is not V4, or an unclear profile, before the new database is made.
    chooseProfile(readV4(old.db, basename(from)), options.profile ?? null, basename(from));
    const target = openLinkTarget(to, {
      look: options.dryRun === true,
      ...(options.clock ? { clock: options.clock } : {}),
    });
    try {
      const result = importLinks(target, old.db, basename(from), options);
      return { ...result, target: to, created: !result.dry_run && target.created };
    } finally {
      target.close();
    }
  } finally {
    old.close();
  }
}
