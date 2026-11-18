// The `heart` plugin's tables on the store's database (`schema.ts`): her numbers and words for each
// person (`HeartStore`, on `heart_person`) and her own state (`HeartSelfStore`, on `heart_self`).
//
// A number moves only through `apply` (and `applyDecay`, `adminSet`, `migrateLegacy`, which go the
// same way): the rules of `rules.ts` decide what is applied, and the row and its `heart.changed`
// event are written in one `Db.tx` (a savepoint inside a caller's), as the coin ledger writes
// `economy.posted`. `upsert` writes a row as it is given, for her words and tags; it records no
// change, so it is not the way to move a number.
//
// A bond that enters a tier never reached before (`tier_floor` goes up) is told to whoever listens
// (`onTierEntered`) once the write is committed: the cards plugin gives a milestone card for it
// (docs/design/v5-play.md §6.1). The migration's rows and a merge are no rise, and tell nothing.
//
// Core's store opens this plugin (`STORE_PLUGINS`); the module `heart` (`module.ts`) owns it.

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import {
  type CategoryData,
  type Db,
  type EventStore,
  HeartChanged,
  HeartEvidence,
  type HeartEvidenceData,
  type PersonForget,
  type PersonHookResult,
  type PersonMerge,
  persons,
  StoreError,
  type StorePlugin,
  tablePart,
} from "@miyoria/store";
import {
  BOND_LADDER,
  type BondTier,
  type Clock,
  HEART_TEXT_FIELDS,
  type HeartActivity,
  type HeartDay,
  type HeartLine,
  type HeartReflected,
  type HeartReflection,
  type JsonObject,
  type JsonValue,
  type PersonId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { type HeartPersonConfig, heartPersonConfig } from "./config.js";
import { type LegacyInput, type LegacyResult, migrateLegacy } from "./legacy.js";
import { changeWrite, evidenceWrite, HeartLog } from "./log.js";
import { heartSchema } from "./migrations.js";
import {
  BLOCKED_TAG,
  clampField,
  HEART_FIELDS,
  type HeartField,
  type HeartPerson,
  hasTag,
  isProposalField,
  newPerson,
  OWNER_TAG,
  type TierAnchor,
} from "./model.js";
import {
  ANCHORED_TIERS,
  applyChange,
  applyDecay,
  decayDay,
  emptyLedger,
  familiarityGain,
  type HeartChange,
  type HeartChangeRequest,
  heldTier,
  lineDepth,
  localDay,
  settle,
} from "./rules.js";
import { type HeartPersonRow, heartPerson, heartSelf } from "./schema.js";
import { recordOf } from "./view.js";

const P = heartPerson;

const log = getLogger("heart.store");

/** At most this many people per page of `list`. */
const MAX_PAGE = 200;

/** A bond that entered tiers she had never reached with someone (`tier_floor` went up). */
export interface TierEntered {
  person: PersonId;
  /** The tiers entered, lowest first: every `BOND_LADDER` tier above the old floor up to the new. */
  tiers: BondTier[];
  /** Why the bond moved (the last change of the write). */
  cause: HeartChange["cause"];
  at: Timestamp;
}

/** Told of every `TierEntered` once its write is committed; it must not throw. */
export type TierListener = (entered: TierEntered) => void;

/** Options of a write that moves a number. */
export interface HeartApplyOptions {
  /** Epoch ms; default: the store's clock. Decides her local day for the caps. */
  now?: number;
  /** The turn the change came from (a `feel` proposal's), on the event's envelope. */
  turn?: string | null;
  /**
   * An instant of the local day whose caps apply (default `now`): her nightly reflection counts
   * its corrections against the day she reviewed, not the day it runs on.
   */
  capsAt?: number;
}

/** What one change did. */
export interface HeartApplied {
  /** The row as written. */
  person: HeartPerson;
  /** The `heart.changed` payload as appended (`delta` 0 when the caps took all of it). */
  change: HeartChange;
  /** The event's id. */
  event_id: string;
  /** The tier a bond rise stopped under for want of an anchor (H4); `null`: none. */
  held: number | null;
  /** The person had no row: this change made it. */
  created: boolean;
}

/** One person as the panel's list shows them. */
export interface HeartListEntry {
  person: HeartPerson;
  /** Identity's name and handle for them; `null` when identity has no such person. */
  name: string | null;
  handle: string | null;
}

export interface HeartListOptions {
  /**
   * Part of their name, handle or call name (any case), or their exact person id. Empty: all.
   */
  search?: string;
  /** Rows to skip (the previous page's `next`). */
  offset?: number;
  /** Rows per page, 1..200; default 50. */
  limit?: number;
}

/** One page of `list`, closest first (bond, then person id). */
export interface HeartPersonPage {
  entries: HeartListEntry[];
  /** How many match in all. */
  total: number;
  /** The `offset` of the next page; `null`: this is the last. */
  next: number | null;
}

/** A row as `HeartPerson` (and back: the fields are the same), with copies of its lists. */
function personOf(row: HeartPersonRow | HeartPerson): HeartPerson {
  return {
    person_id: row.person_id,
    bond: row.bond,
    trust: row.trust,
    familiarity: row.familiarity,
    warmth: row.warmth,
    respect: row.respect,
    ease: row.ease,
    grudge: row.grudge,
    longing: row.longing,
    rapport: row.rapport,
    stance: row.stance,
    impression: row.impression,
    unfinished: row.unfinished,
    jokes: row.jokes,
    dislikes: row.dislikes,
    public_feeling: row.public_feeling,
    call_name: row.call_name,
    tags: [...row.tags],
    tier_floor: row.tier_floor,
    anchors: row.anchors.map((a) => ({ ...a })),
    interactions: row.interactions,
    last_interaction: row.last_interaction,
    last_seen: row.last_seen,
    last_together: row.last_together,
    decayed_on: row.decayed_on,
    legacy: row.legacy,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** `HeartPerson` as a row (the same fields; whole numbers where the column is an integer). */
function rowOf(p: HeartPerson): HeartPersonRow {
  return {
    ...personOf(p),
    tier_floor: Math.round(p.tier_floor),
    interactions: Math.max(0, Math.round(p.interactions)),
    decayed_on: p.decayed_on === null ? null : Math.round(p.decayed_on),
  };
}

/** `text` as a LIKE pattern matching it anywhere, with `%`, `_` and `\` taken literally. */
function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Her numbers and words for each person (`heart_person`), and the changes on the event log. */
export class HeartStore {
  readonly #db: Db;
  readonly #events: EventStore;
  readonly #clock: Clock;
  #rules: HeartPersonConfig;
  #log: HeartLog;
  readonly #tierListeners = new Set<TierListener>();

  constructor(
    db: Db,
    events: EventStore,
    options: { rules?: HeartPersonConfig; clock?: Clock } = {},
  ) {
    this.#db = db;
    this.#events = events;
    this.#clock = options.clock ?? db.clock;
    this.#rules = options.rules ?? heartPersonConfig();
    this.#log = new HeartLog(events, this.#rules);
  }

  /** The rules in force (the owning module's config section). */
  get rules(): HeartPersonConfig {
    return this.#rules;
  }

  /** Puts `rules` in force from now on (the module that owns the heart, on start and reload). */
  setRules(rules: HeartPersonConfig): void {
    this.#rules = rules;
    this.#log = new HeartLog(this.#events, rules);
  }

  /** The changes and evidence on the event log: a person's history, the day's ledger. */
  get log(): HeartLog {
    return this.#log;
  }

  /**
   * Tells `listener` of every bond that enters a tier never reached before, after the write is
   * committed (never for one that rolls back). The way to stop listening is the returned function.
   */
  onTierEntered(listener: TierListener): () => void {
    this.#tierListeners.add(listener);
    return () => {
      this.#tierListeners.delete(listener);
    };
  }

  /** Queues `entered` for the listeners, once the outermost transaction commits. */
  #tellTiers(entered: TierEntered): void {
    if (entered.tiers.length === 0 || this.#tierListeners.size === 0) return;
    this.#db.afterCommit(() => {
      for (const listener of this.#tierListeners) {
        try {
          listener(entered);
        } catch (error) {
          log.warn({ err: errorMessage(error), person: entered.person }, "a tier listener failed");
        }
      }
    });
  }

  #now(now: number | undefined): number {
    return now ?? this.#clock.now();
  }

  // ---- reading ------------------------------------------------------------------------------

  get(person: PersonId): HeartPerson | null {
    this.#db.ensureOpen();
    const row = this.#db.orm.select().from(P).where(eq(P.person_id, person)).get();
    return row === undefined ? null : personOf(row);
  }

  has(person: PersonId): boolean {
    this.#db.ensureOpen();
    return (
      this.#db.orm.select({ id: P.person_id }).from(P).where(eq(P.person_id, person)).get() !==
      undefined
    );
  }

  /** People closest first, a page at a time, optionally only those `search` finds. */
  list(options: HeartListOptions = {}): HeartPersonPage {
    this.#db.ensureOpen();
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), MAX_PAGE);
    const offset = Math.max(Math.floor(options.offset ?? 0), 0);
    const q = options.search?.trim() ?? "";
    let where: SQL | undefined;
    if (q !== "") {
      const pattern = contains(q);
      const like = (column: SQLWrapper) => sql`${column} LIKE ${pattern} ESCAPE '\\'`;
      where = or(eq(P.person_id, q), like(persons.name), like(persons.handle), like(P.call_name));
    }
    const orm = this.#db.orm;
    const total = orm
      .select({ n: count() })
      .from(P)
      .leftJoin(persons, eq(persons.id, P.person_id))
      .where(where)
      .get();
    const rows = orm
      .select({ row: P, name: persons.name, handle: persons.handle })
      .from(P)
      .leftJoin(persons, eq(persons.id, P.person_id))
      .where(where)
      .orderBy(desc(P.bond), asc(P.person_id))
      .limit(limit)
      .offset(offset)
      .all();
    const n = Number(total?.n ?? 0);
    return {
      entries: rows.map((r) => ({ person: personOf(r.row), name: r.name, handle: r.handle })),
      total: n,
      next: offset + rows.length < n ? offset + rows.length : null,
    };
  }

  /**
   * How many people have a row, and how many of them had a number change from `since` (epoch ms)
   * on, the daily pass and the migration left out: for the module's card on the panel. Two indexed
   * reads of the log: where `since` starts in commit order (`events_at_idx`, the index alone), then
   * the heart's changes from there (`events_type_idx`).
   */
  summary(since: number): { people: number; changed: number } {
    this.#db.ensureOpen();
    const people = this.#db.orm.select({ n: count() }).from(P).get();
    const from = since * 1000;
    const changed = this.#db.orm.all<{ n: number }>(sql`
      SELECT COUNT(DISTINCT e.person_id) AS n FROM events e
      WHERE e.type = ${HeartChanged.type}
        AND e.seq >= (SELECT MIN(seq) FROM events WHERE at >= ${from})
        AND e.at >= ${from}
        AND json_extract(e.data, '$.cause') NOT IN ('decay', 'migrate')
        AND e.person_id IN (SELECT ${P.person_id} FROM ${P})`);
    return { people: Number(people?.n ?? 0), changed: Number(changed[0]?.n ?? 0) };
  }

  /**
   * The people with a row, not blocked, who did anything with her from `since` until `until`
   * (epoch ms): a line said with her (`last_interaction` in the span), a `feel` change or
   * evidence. Most first (lines, changes and evidence together, then person id), at most `max`.
   */
  active(since: number, until: number, max: number): HeartActivity[] {
    this.#db.ensureOpen();
    const from = toTimestamp(since);
    const to = toTimestamp(until);
    const counts = this.#log.activity(from, to);
    const talked = this.#db.orm
      .select({ id: P.person_id })
      .from(P)
      .where(and(gte(P.last_interaction, from), lt(P.last_interaction, to)))
      .all()
      .map((r) => r.id);
    const candidates = new Set<PersonId>(talked);
    for (const [person, c] of counts) if (c.changes + c.evidence > 0) candidates.add(person);
    const out: HeartActivity[] = [];
    for (const person of candidates) {
      const row = this.get(person);
      if (row === null || hasTag(row, BLOCKED_TAG)) continue;
      const c = counts.get(person) ?? { lines: 0, changes: 0, evidence: 0 };
      out.push({ person, ...c });
    }
    const total = (a: HeartActivity) => a.lines + a.changes + a.evidence;
    out.sort((a, b) => total(b) - total(a) || (a.person < b.person ? -1 : 1));
    return out.slice(0, Math.max(0, max));
  }

  /**
   * What the nightly reflection on `person` is given for the span: the row, the changes (not the
   * daily pass's or the migration's), the evidence and the tier the bond is held under, if any.
   */
  day(person: PersonId, since: number, until: number): HeartDay | null {
    const row = this.get(person);
    if (row === null) return null;
    const from = toTimestamp(since);
    const to = toTimestamp(until);
    const changes = this.#log
      .changesBetween(person, from, to)
      .filter((e) => e.change.cause !== "decay" && e.change.cause !== "migrate")
      .map(({ at, change: c }) => ({
        at,
        field: c.field,
        delta: c.delta,
        proposed: c.proposed,
        quote: c.reason_quote,
        cause: c.cause,
      }));
    const evidence = this.#log.evidence(person, from, to).map(({ evidence: e }) => ({
      at: e.at,
      kind: e.kind,
      detail: e.detail,
      weight: e.weight,
    }));
    return { record: recordOf(row), changes, evidence, held: heldTier(row, this.#rules) };
  }

  /**
   * Applies her nightly reflection on `person` in one transaction: the anchor first (so a rise it
   * allows passes the tier), the texts, then the value corrections (cause `reflect`, one step each,
   * under the day's caps). Throws, changing nothing, for someone without a row or a bad anchor.
   */
  reflect(
    person: PersonId,
    reflection: HeartReflection,
    options: HeartApplyOptions = {},
  ): HeartReflected {
    const now = this.#now(options.now);
    const at = toTimestamp(now);
    return this.#write(() => {
      const current = this.get(person);
      if (current === null) throw new StoreError(`no heart row for person \`${person}\``);
      let anchored = false;
      if (reflection.anchor !== null) {
        const { tier, note_ref, quote } = reflection.anchor;
        this.setAnchor(person, { tier, note_ref, quote, at, by: "reflect" }, { now });
        anchored = true;
      }
      const texts = HEART_TEXT_FIELDS.filter((f) => reflection.texts[f] !== undefined);
      const feeling = reflection.public_feeling !== undefined;
      if (texts.length > 0 || feeling) {
        const next = { ...(this.get(person) as HeartPerson), updated_at: at };
        for (const f of texts) next[f] = reflection.texts[f] as string;
        if (feeling) next.public_feeling = reflection.public_feeling as string;
        this.upsert(next);
      }
      const requests: HeartChangeRequest[] = [];
      for (const p of reflection.proposals) {
        if (!isProposalField(p.field)) continue;
        requests.push({
          type: "propose",
          field: p.field,
          direction: p.direction,
          quote: p.quote,
          cause: "reflect",
        });
      }
      const changes = requests.length === 0 ? [] : this.applyAll(person, requests, options);
      return { changes: changes.length, texts, public_feeling: feeling, anchored };
    });
  }

  /** Everyone with a call name, and the name. */
  callNames(): { person: PersonId; call_name: string }[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select({ person: P.person_id, call_name: P.call_name })
      .from(P)
      .where(isNotNull(P.call_name))
      .orderBy(asc(P.person_id))
      .all()
      .flatMap((r) => (r.call_name === null ? [] : [{ person: r.person, call_name: r.call_name }]));
  }

  /** The people the daily pass has not run for on the local day of `now`. */
  decayDue(now?: number): PersonId[] {
    this.#db.ensureOpen();
    const today = localDay(this.#now(now), this.#rules);
    return this.#db.orm
      .select({ id: P.person_id })
      .from(P)
      .where(or(isNull(P.decayed_on), lt(P.decayed_on, today)))
      .orderBy(asc(P.person_id))
      .all()
      .map((r) => r.id);
  }

  // ---- writing ------------------------------------------------------------------------------

  /** Writes `person` as it is (a new row, or every field of the existing one). Records no change. */
  upsert(person: HeartPerson): void {
    const row = rowOf(person);
    const { person_id: _id, ...rest } = row;
    this.#db.ensureOpen();
    this.#db.orm.insert(P).values(row).onConflictDoUpdate({ target: P.person_id, set: rest }).run();
  }

  /**
   * Applies one change to `person` (a row is made for someone new) by the rules, and writes the
   * row and its `heart.changed` event in one transaction.
   */
  apply(
    person: PersonId,
    request: HeartChangeRequest,
    options: HeartApplyOptions = {},
  ): HeartApplied {
    return this.applyAll(person, [request], options)[0] as HeartApplied;
  }

  /** Applies `requests` to `person` in order, in one transaction, each seeing the ones before. */
  applyAll(
    person: PersonId,
    requests: readonly HeartChangeRequest[],
    options: HeartApplyOptions = {},
  ): HeartApplied[] {
    const now = this.#now(options.now);
    const at = toTimestamp(now);
    return this.#write(() => {
      const stored = this.get(person);
      let current = stored ?? newPerson(person, at, this.#rules.default_trust);
      let ledger = this.#log.dayLedger(person, options.capsAt ?? now);
      const out: HeartApplied[] = [];
      for (const request of requests) {
        const applied = applyChange(current, request, ledger, this.#rules, now);
        current = applied.person;
        ledger = applied.ledger;
        const event = this.#events.appendNow(changeWrite(applied.change, at, options.turn ?? null));
        out.push({
          person: current,
          change: applied.change,
          event_id: event.id,
          held: applied.held,
          created: stored === null,
        });
      }
      if (out.length > 0) this.upsert(current);
      const floor = stored?.tier_floor ?? 0;
      const last = out.at(-1);
      if (last !== undefined && current.tier_floor > floor && last.change.cause !== "migrate") {
        this.#tellTiers({
          person,
          tiers: BOND_LADDER.filter((t) => t.min > floor && t.min <= current.tier_floor),
          cause: last.change.cause,
          at,
        });
      }
      return out;
    });
  }

  /**
   * `person` said a line (a row is made for someone new): when she last saw them, and, for a line
   * said with her (to her, or in the voice channel she is in), an interaction and when they last
   * talked and were together; familiarity grows by the line's depth (`lineDepth`,
   * `familiarityGain`). Bookkeeping, not a change of hers: no `heart.changed` is written, as
   * `interactions` writes none. Someone tagged `blocked` is left as they are. The row as written.
   */
  seen(person: PersonId, line: HeartLine): HeartPerson {
    const at = toTimestamp(line.at);
    return this.#write(() => {
      const current = this.get(person) ?? newPerson(person, at, this.#rules.default_trust);
      if (hasTag(current, BLOCKED_TAG)) return current;
      const together = line.together || line.directed;
      const gain = familiarityGain(
        current.familiarity,
        lineDepth(line.text, line.directed),
        this.#rules,
      );
      const next: HeartPerson = {
        ...current,
        familiarity: clampField("familiarity", current.familiarity + gain),
        interactions: current.interactions + (together ? 1 : 0),
        last_seen: at,
        last_interaction: together ? at : current.last_interaction,
        last_together: together ? at : current.last_together,
        updated_at: at,
      };
      this.upsert(next);
      return next;
    });
  }

  /**
   * Writes her words and tags about `person` as given (a row is made for someone new): her call
   * name (`set_call_name`, `/me call`, the panel), her other words about them (the panel), the
   * member page's line (`null` when they ask her to forget it) and the tags. Records no change: these are
   * not numbers. The row as written.
   */
  edit(
    person: PersonId,
    patch: Partial<
      Pick<
        HeartPerson,
        | "call_name"
        | "impression"
        | "public_feeling"
        | "tags"
        | "stance"
        | "unfinished"
        | "jokes"
        | "dislikes"
      >
    >,
    options: { now?: number } = {},
  ): HeartPerson {
    const at = toTimestamp(this.#now(options.now));
    return this.#write(() => {
      const current = this.get(person) ?? newPerson(person, at, this.#rules.default_trust);
      const next: HeartPerson = { ...current, ...patch, updated_at: at };
      if (patch.tags !== undefined) next.tags = [...new Set(patch.tags)].sort();
      this.upsert(next);
      if (hasTag(next, OWNER_TAG) && !hasTag(current, OWNER_TAG)) {
        return this.#ownerFloors(person, options.now);
      }
      return next;
    });
  }

  /**
   * The owner's trust and bond floor (`owner_trust`, `owner_bond_floor`), applied at once when the
   * tag is added, each jump its own change (cause `admin`), rather than folded into whatever
   * change comes next. The row as written.
   */
  #ownerFloors(person: PersonId, now: number | undefined): HeartPerson {
    const quote = "標為擁有者";
    let row = this.get(person) as HeartPerson;
    const trust = clampField("trust", this.#rules.owner_trust);
    if (row.trust !== trust) row = this.adminSet(person, "trust", trust, { now, quote }).person;
    const floor = clampField("bond", this.#rules.owner_bond_floor);
    if (row.bond < floor) row = this.adminSet(person, "bond", floor, { now, quote }).person;
    return row;
  }

  /** Adds or removes `tag` of `person`; whether anything changed. */
  setTag(person: PersonId, tag: string, on: boolean, options: { now?: number } = {}): boolean {
    return this.#write(() => {
      const tags = this.get(person)?.tags ?? [];
      if (tags.includes(tag) === on) return false;
      this.edit(person, { tags: on ? [...tags, tag] : tags.filter((t) => t !== tag) }, options);
      return true;
    });
  }

  /**
   * The owner's reset of `person`: every number back to where someone new starts (cause `admin`)
   * and her words about them cleared; tags, the tier floor and the anchors stay.
   */
  reset(person: PersonId, options: HeartApplyOptions & { quote?: string } = {}): HeartPerson {
    const at = toTimestamp(this.#now(options.now));
    return this.#write(() => {
      const fresh = newPerson(person, at, this.#rules.default_trust);
      const before = this.get(person) ?? fresh;
      for (const field of HEART_FIELDS) {
        if (before[field] !== fresh[field]) this.adminSet(person, field, fresh[field], options);
      }
      const current = this.get(person) ?? fresh;
      this.upsert({
        ...current,
        stance: "",
        impression: "",
        unfinished: "",
        jokes: "",
        dislikes: "",
        public_feeling: null,
        call_name: null,
        updated_at: at,
      });
      return this.get(person) as HeartPerson;
    });
  }

  /**
   * The owner sets `field` of `person` to `value` (cause `admin`: no cap, no anchor; the range
   * and the owner's floor still hold).
   */
  adminSet(
    person: PersonId,
    field: HeartField,
    value: number,
    options: HeartApplyOptions & { quote?: string } = {},
  ): HeartApplied {
    if (!Number.isFinite(value)) throw new StoreError(`not a number for \`${field}\``);
    return this.#write(() => {
      const current =
        this.get(person) ??
        newPerson(person, toTimestamp(this.#now(options.now)), this.#rules.default_trust);
      return this.apply(
        person,
        {
          type: "adjust",
          field,
          delta: value - current[field],
          cause: "admin",
          quote: options.quote ?? "",
        },
        options,
      );
    });
  }

  /**
   * The daily pass for `person` on the local day of `now` (`decayDay`), written with one `decay`
   * change per field it moved. `null` for someone without a row. The day is recorded also when
   * nothing moved, so a second call that day writes nothing.
   */
  applyDecay(
    person: PersonId,
    options: { now?: number } = {},
  ): { person: HeartPerson; changes: HeartChange[] } | null {
    const now = this.#now(options.now);
    const at = toTimestamp(now);
    return this.#write(() => {
      const current = this.get(person);
      if (current === null) return null;
      const pass = decayDay(current, now, this.#rules);
      if (pass.changes.length === 0 && current.decayed_on === pass.day) {
        return { person: current, changes: [] };
      }
      // Decay is not capped, so the day's ledger does not matter to it.
      const result = applyDecay(current, pass, emptyLedger(pass.day), this.#rules, now);
      for (const change of result.changes) this.#events.appendNow(changeWrite(change, at));
      const next = { ...result.person, updated_at: at };
      this.upsert(next);
      return { person: next, changes: result.changes };
    });
  }

  /**
   * Sets the anchor of `anchor.tier` (one per tier; a new one replaces the old). The bond is not
   * moved: a bond held below the tier passes it with the next rise.
   */
  setAnchor(person: PersonId, anchor: TierAnchor, options: { now?: number } = {}): HeartPerson {
    if (!ANCHORED_TIERS.includes(anchor.tier)) {
      throw new StoreError(`tier \`${anchor.tier}\` takes no anchor`);
    }
    return this.#write(() => {
      const current = this.get(person);
      if (current === null) throw new StoreError(`no heart row for person \`${person}\``);
      const anchors = [...current.anchors.filter((a) => a.tier !== anchor.tier), { ...anchor }];
      anchors.sort((a, b) => a.tier - b.tier);
      const next = { ...current, anchors, updated_at: toTimestamp(this.#now(options.now)) };
      this.upsert(next);
      return next;
    });
  }

  /** Removes the anchor of `tier`; `null` when the person has no row. The bond stays. */
  removeAnchor(person: PersonId, tier: number, options: { now?: number } = {}): HeartPerson | null {
    return this.#write(() => {
      const current = this.get(person);
      if (current === null) return null;
      if (!current.anchors.some((a) => a.tier === tier)) return current;
      const anchors = current.anchors.filter((a) => a.tier !== tier);
      const next = { ...current, anchors, updated_at: toTimestamp(this.#now(options.now)) };
      this.upsert(next);
      return next;
    });
  }

  /** Appends a piece of evidence (`heart.evidence`); the session decides its scope. Its id. */
  appendEvidence(evidence: HeartEvidenceData, session: string | null = null): string {
    return this.#events.appendNow(evidenceWrite(evidence, session)).id;
  }

  /**
   * The migration from the old records (`legacy.ts`): a row and a `migrate` change for everyone
   * without a row yet, in one transaction. Running it again changes nothing.
   */
  migrateLegacy(input: LegacyInput, options: { now?: number } = {}): LegacyResult {
    const now = this.#now(options.now);
    const at = toTimestamp(now);
    return this.#write(() => {
      const result = migrateLegacy(input, (p) => this.has(p), this.#rules, now);
      for (const row of result.rows) this.upsert(row);
      for (const change of result.changes) this.#events.appendNow(changeWrite(change, at));
      return result;
    });
  }

  /**
   * "Forget me" for `ids` (the person and everyone merged into them): she takes them for someone
   * she has just met. What the two of them built goes: a bond above zero, trust above a
   * newcomer's, familiarity, warmth and respect above zero, ease, longing, rapport, the tier
   * floor, the anchors, what she calls them, the counters, her words about them and the old notes
   * the migration kept. What she holds against them stays, so asking to be forgotten is no way out
   * of it: a bond below zero, trust below a newcomer's, warmth and respect below zero, the grudge.
   * The tags stay too (`owner` and `blocked` are the owner's, not her memory; the owner's floors
   * still hold). Each number that moves is logged (cause `admin`, no words). On the event log the
   * quotes of their earlier `heart.changed` and the details of their `heart.evidence` are taken
   * out the way their chat lines are, keeping the rest (`EventStore.redactFields`), so the day's
   * caps still add up. Rows and events, by kind.
   */
  forgetPerson(
    ids: readonly PersonId[],
    reason: string,
    source: string,
    options: { now?: number } = {},
  ): { people: number; changes: number; evidence: number } {
    const at = toTimestamp(this.#now(options.now));
    return this.#write(() => {
      let people = 0;
      let changes = 0;
      let evidence = 0;
      for (const id of new Set(ids)) {
        const words = (type: string, field: string) =>
          this.#events.redactFields({ personId: id, types: [type] }, [field], reason, source)
            .length;
        changes += words(HeartChanged.type, "reason_quote");
        evidence += words(HeartEvidence.type, "detail");
        const row = this.get(id);
        if (row === null) continue;
        const fresh = newPerson(id, at, this.#rules.default_trust);
        const next = settle(
          {
            ...fresh,
            created_at: row.created_at,
            decayed_on: row.decayed_on,
            tags: row.tags,
            bond: Math.min(row.bond, fresh.bond),
            trust: Math.min(row.trust, fresh.trust),
            warmth: Math.min(row.warmth, fresh.warmth),
            respect: Math.min(row.respect, fresh.respect),
            grudge: row.grudge,
          },
          this.#rules,
        );
        this.upsert(next);
        for (const field of HEART_FIELDS) {
          if (next[field] === row[field]) continue;
          this.#events.appendNow(
            changeWrite(
              {
                person: id,
                field,
                delta: next[field] - row[field],
                value_after: next[field],
                proposed: null,
                reason_quote: "",
                cause: "admin",
              },
              at,
            ),
          );
        }
        people += 1;
      }
      return { people, changes, evidence };
    });
  }

  /**
   * `absorb` turned out to be `keep`: its row becomes `keep`'s when `keep` has none. When both have
   * one, they become one row of `keep`: the numbers, tier floor and words of the one with the
   * higher bond (words the other has where that one has none), the higher tier floor, every
   * anchor (that one's for a tier both have), all tags, the interactions added up and the latest
   * times. The events stay under the absorbed id (the log is append-only), so the kept person's
   * history and today's caps do not count what was logged under it.
   */
  merge(keep: PersonId, absorb: PersonId): PersonHookResult {
    return this.#write((): PersonHookResult => {
      const from = this.get(absorb);
      if (from === null) return { counts: { moved: 0 } };
      const into = this.get(keep);
      if (into === null) {
        this.#db.orm.update(P).set({ person_id: keep }).where(eq(P.person_id, absorb)).run();
        return { counts: { moved: 1 } };
      }
      this.upsert(mergedRow(keep, into, from));
      this.#db.orm.delete(P).where(eq(P.person_id, absorb)).run();
      return { counts: { merged: 1 } };
    });
  }

  #write<T>(fn: () => T): T {
    this.#db.ensureOpen();
    return this.#db.tx(fn);
  }
}

/** The later of two times. */
function later(a: Timestamp | null, b: Timestamp | null): Timestamp | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Two rows of one person as one (`HeartStore.merge`): the closer one leads. */
function mergedRow(keep: PersonId, a: HeartPerson, b: HeartPerson): HeartPerson {
  const [lead, other] = b.bond > a.bond ? [b, a] : [a, b];
  const words = (f: "stance" | "impression" | "unfinished" | "jokes" | "dislikes") =>
    lead[f] !== "" ? lead[f] : other[f];
  const anchors = [
    ...lead.anchors,
    ...other.anchors.filter((x) => !lead.anchors.some((y) => y.tier === x.tier)),
  ].sort((x, y) => x.tier - y.tier);
  return {
    ...lead,
    person_id: keep,
    stance: words("stance"),
    impression: words("impression"),
    unfinished: words("unfinished"),
    jokes: words("jokes"),
    dislikes: words("dislikes"),
    public_feeling: lead.public_feeling ?? other.public_feeling,
    call_name: lead.call_name ?? other.call_name,
    tags: [...new Set([...lead.tags, ...other.tags])].sort(),
    tier_floor: Math.max(lead.tier_floor, other.tier_floor),
    anchors,
    interactions: lead.interactions + other.interactions,
    last_interaction: later(lead.last_interaction, other.last_interaction),
    last_seen: later(lead.last_seen, other.last_seen),
    last_together: later(lead.last_together, other.last_together),
    legacy: { ...other.legacy, ...lead.legacy },
    created_at:
      Date.parse(other.created_at) < Date.parse(lead.created_at)
        ? other.created_at
        : lead.created_at,
  };
}

/** JSON text with every object's keys sorted: the same state gives the same text. */
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k] as JsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Her own emotions and drives (`heart_self`): one JSON row, written only when it changed. */
export class HeartSelfStore {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, options: { clock?: Clock } = {}) {
    this.#db = db;
    this.#clock = options.clock ?? db.clock;
  }

  /** The state as last saved; `null` before the first save. */
  get(): JsonObject | null {
    this.#db.ensureOpen();
    const row = this.#db.orm.select().from(heartSelf).where(eq(heartSelf.id, 1)).get();
    return row?.state ?? null;
  }

  /**
   * Saves `state` when it differs from what is stored (key order aside). Whether it wrote.
   */
  save(state: JsonObject, options: { now?: number } = {}): boolean {
    this.#db.ensureOpen();
    return this.#db.tx(() => {
      const stored = this.get();
      if (stored !== null && canonical(stored) === canonical(state)) return false;
      const updated_at = toTimestamp(options.now ?? this.#clock.now());
      this.#db.orm
        .insert(heartSelf)
        .values({ id: 1, state, updated_at })
        .onConflictDoUpdate({ target: heartSelf.id, set: { state, updated_at } })
        .run();
      return true;
    });
  }
}

/** What the plugin gives its owner. */
export interface HeartTables {
  people: HeartStore;
  self: HeartSelfStore;
}

/**
 * The heart's parts of the data categories: the rows about people go with `relationships` (with
 * every change and piece of evidence recorded about them, which the event log keeps otherwise),
 * what she calls them with `call_names` (cleared, the row stays), her own state with `inner`.
 */
const heartData: readonly CategoryData[] = [
  {
    category: "relationships",
    parts: [
      tablePart("heart_person", "heart_person", "node", "updated_at", "person_id", {
        person_id: "text",
        bond: "num",
        trust: "num",
        familiarity: "num",
        warmth: "num",
        respect: "num",
        ease: "num",
        grudge: "num",
        longing: "num",
        rapport: "num",
        stance: "text",
        impression: "text",
        unfinished: "text",
        jokes: "text",
        dislikes: "text",
        public_feeling: "text",
        call_name: "text",
        tags: "json",
        tier_floor: "num",
        anchors: "json",
        interactions: "num",
        last_interaction: "ts",
        last_seen: "ts",
        last_together: "ts",
        decayed_on: "num",
        legacy: "json",
        created_at: "ts",
        updated_at: "ts",
      }),
    ],
    keptEvents: "type IN ('heart.changed', 'heart.evidence')",
  },
  {
    category: "call_names",
    parts: [{ kind: "call_names", id: "heart_call_names", table: "heart_person", rows: "node" }],
  },
  {
    category: "inner",
    parts: [
      tablePart("heart_self", "heart_self", "node", "updated_at", "id", {
        state: "json",
        updated_at: "ts",
      }),
    ],
  },
];

/** The `heart` plugin's tables and code (`StorePlugin`). */
export const heartTables: StorePlugin<HeartTables> = {
  schema: heartSchema,
  open: ({ db, events }) => ({ people: new HeartStore(db, events), self: new HeartSelfStore(db) }),
  data: heartData,
  forgetPerson: (opened, request: PersonForget) => ({
    counts: opened.people.forgetPerson(request.ids, request.reason, request.source),
  }),
  mergePerson: (opened, { keep, absorb }: PersonMerge) => opened.people.merge(keep, absorb),
};
