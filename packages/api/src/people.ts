// `/api/people*`: the one admin source for who she knows and how she feels about them, read from
// the heart's rows (`heart_person`; docs/design/v5-heart.md §2.11). A row of the list carries the
// bond, its ring, the eight values and how much she cares; the person page adds her words, the
// tier and its anchors, the newest changes, today's caps and the evidence. Everyone in the people
// store is listed; someone without a row yet is every number at where a newcomer starts
// (`has_row: false`). Every change goes to the row.

import type {
  AdjustPersonRequest,
  FieldLedger,
  HeartHistoryEntry,
  HeartHistoryPage,
  PersonAnchor,
  PersonEvidence,
  PersonPage,
  PersonProfile,
  PersonRow,
  SetAnchorRequest,
  UpdatePersonRequest,
} from "@miyoria/contracts/api";
import {
  ANCHORED_TIERS,
  BLOCKED_TAG,
  bondPlace,
  cares,
  dailyCap,
  HEART_FIELDS,
  type HeartPerson,
  type HeartStore,
  type HeartHistoryEntry as HistoryEntry,
  hasTag,
  heldTier,
  labelOf,
  newPerson,
  OWNER_TAG,
  type TierAnchor,
} from "@miyoria/heart/person";
import { MemoryEngineKey } from "@miyoria/memory/memory";
import {
  type IdentityStore,
  IdentityStoreKey,
  type MemoryFilter,
  MemoryRecordStoreKey,
  type PeopleStore,
  PeopleStoreKey,
  type Person,
  StoreError,
} from "@miyoria/store";
import {
  BOND_LADDER,
  isUlid,
  type PersonId,
  type ProfileId,
  type RelationshipLabel,
  toTimestamp,
} from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { heartRows } from "./heart-rows.js";
import { type ApiContext, type ApiState, actorOf, toJson } from "./state.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_HISTORY = 50;
const MAX_HISTORY = 500;
/** Newest evidence on the person page. */
const EVIDENCE_SHOWN = 30;
const MAX_TAGS = 32;
const MAX_TAG_CHARS = 32;
const MAX_TEXT_CHARS = 2000;
const MAX_CALL_NAME_CHARS = 64;
const MAX_PUBLIC_FEELING_CHARS = 500;
const MAX_ANCHOR_CHARS = 500;
const MAX_NOTE_REF_CHARS = 64;
/** The largest number an owner's adjustment may name (the bond's whole span, with room). */
const MAX_ADJUST = 1100;

function chars(s: string): number {
  return [...s].length;
}

function unknownPerson(id: string): ApiError {
  return ApiError.notFound(`unknown person \`${id}\``);
}

function parsePerson(id: string): PersonId {
  const upper = id.toUpperCase();
  if (!isUlid(upper)) throw unknownPerson(id);
  return upper;
}

function ms(ts: string | null): number {
  return ts === null ? Number.NEGATIVE_INFINITY : Date.parse(ts);
}

/** The tier of someone without a row yet. */
const NEUTRAL_TIER = labelOf(null);

/** The numbers of a person's row as the contract names them. */
function numbersOf(p: HeartPerson) {
  return {
    bond: p.bond,
    trust: p.trust,
    familiarity: p.familiarity,
    warmth: p.warmth,
    respect: p.respect,
    ease: p.ease,
    grudge: p.grudge,
    longing: p.longing,
    rapport: p.rapport,
  };
}

/** One list row: `row` is `null` for someone she has not met (a newcomer's numbers). */
export function rowOf(person: Person, row: HeartPerson | null): PersonRow {
  const p = row ?? newPerson(person.id, person.created_at);
  const place = bondPlace(p.bond);
  return {
    person,
    has_row: row !== null,
    blocked: hasTag(p, BLOCKED_TAG),
    owner: hasTag(p, OWNER_TAG),
    tier: row === null ? NEUTRAL_TIER : place.tier,
    stage: row === null ? null : place.stage,
    tier_label: row === null ? NEUTRAL_TIER : place.tier_label,
    ...numbersOf(p),
    ring: place.ring,
    cares: cares(p),
    stance: p.stance,
    impression: p.impression,
    public_feeling: p.public_feeling,
    call_name: p.call_name,
    tags: [...p.tags],
    interactions: p.interactions,
    last_interaction: p.last_interaction,
    last_seen: p.last_seen,
    last_together: p.last_together,
    updated_at: row === null ? null : p.updated_at,
  };
}

/** The services people routes read from. */
class PeopleCtx {
  readonly profile: ProfileId;
  readonly identity: IdentityStore;
  readonly people: PeopleStore | undefined;
  readonly heart: HeartStore;

  constructor(state: ApiState) {
    this.profile = state.profile();
    this.identity = state.service(IdentityStoreKey, "identity store");
    this.people = state.optional(PeopleStoreKey);
    const heart = heartRows(state);
    if (heart === null) throw ApiError.unavailable("the heart's rows are not available");
    this.heart = heart;
  }

  row(person: PersonId): HeartPerson | null {
    return this.heart.get(person);
  }

  /** The person with their accounts; `null` when nobody has this id. */
  async person(id: PersonId): Promise<Person | null> {
    const accounts = await this.identity.accountsOf(id);
    const first = accounts[0];
    if (!first) return null;
    if (this.people) {
      const person = await this.people.personByAccount(first.account);
      if (person && person.id === id) return person;
    }
    let created = first.first_seen;
    for (const a of accounts) {
      if (Date.parse(a.first_seen) < Date.parse(created)) created = a.first_seen;
    }
    return { id, display_name: first.display_name, created_at: created, accounts };
  }

  async requireRow(id: PersonId): Promise<PersonRow> {
    const person = await this.person(id);
    if (!person) throw unknownPerson(id);
    return rowOf(person, this.row(id));
  }
}

/** When one of the person's accounts was last seen. */
function lastSeen(person: Person): number {
  let last = Number.NEGATIVE_INFINITY;
  for (const a of person.accounts) last = Math.max(last, Date.parse(a.last_seen));
  return last;
}

/**
 * Most recent interaction first, then the most recently changed row, then whoever was seen last
 * (people without a row sort after those with one of the same recency).
 */
function byRecency(a: PersonRow, b: PersonRow): number {
  return (
    ms(b.last_interaction) - ms(a.last_interaction) ||
    ms(b.updated_at) - ms(a.updated_at) ||
    lastSeen(b.person) - lastSeen(a.person) ||
    0
  );
}

function matches(row: PersonRow, needle: string): boolean {
  const has = (s: string) => s.toLowerCase().includes(needle);
  return (
    has(row.person.display_name) ||
    row.person.id.toLowerCase() === needle ||
    row.person.accounts.some((a) => has(a.display_name) || has(a.account.id)) ||
    (row.call_name !== null && has(row.call_name))
  );
}

/** Every heart row (the list is paged in the store). */
function allRows(heart: HeartStore): HeartPerson[] {
  const out: HeartPerson[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = heart.list({ offset, limit: 200 });
    for (const e of page.entries) out.push(e.person);
    offset = page.next;
  }
  return out;
}

/**
 * `GET /api/people?q=&limit=&cursor=`: every known person, most recent interaction first. Without
 * a people store only people with a row are known.
 */
async function list(
  state: ApiState,
  q: { q?: string | undefined; limit?: number | undefined; cursor?: string | undefined },
): Promise<PersonPage> {
  const ctx = new PeopleCtx(state);
  let offset = 0;
  const cursor = q.cursor?.trim() ?? "";
  if (cursor !== "") {
    if (!/^\+?\d+$/.test(cursor)) throw ApiError.badRequest(`invalid cursor \`${cursor}\``);
    offset = Number.parseInt(cursor, 10);
  }
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const needle = q.q?.trim().toLowerCase() || null;

  const rows = new Map<PersonId, HeartPerson>();
  for (const r of allRows(ctx.heart)) rows.set(r.person_id, r);
  const all: PersonRow[] = [];
  if (ctx.people) {
    for (const person of await ctx.people.all()) {
      all.push(rowOf(person, rows.get(person.id) ?? null));
    }
  } else {
    for (const r of rows.values()) {
      const person = await ctx.person(r.person_id);
      if (person) all.push(rowOf(person, r));
    }
  }
  const items = all.filter((row) => needle === null || matches(row, needle)).sort(byRecency);
  return {
    items: items.slice(offset, offset + limit),
    next_cursor: items.length > offset + limit ? String(offset + limit) : null,
  };
}

function historyEntry({ id, at, change }: HistoryEntry): HeartHistoryEntry {
  return {
    id,
    at,
    field: change.field,
    delta: change.delta,
    value_after: change.value_after,
    proposed: change.proposed,
    cause: change.cause,
    reason_quote: change.reason_quote,
  };
}

/** The changes of `person` after `before`, newest first, `limit` at a time. */
function historyPage(
  heart: HeartStore,
  person: PersonId,
  before: string | undefined,
  limit: number | undefined,
): HeartHistoryPage {
  const size = Math.min(Math.max(limit ?? DEFAULT_HISTORY, 1), MAX_HISTORY);
  // One more than the page shows tells whether another page follows.
  const entries = heart.log.history(person, {
    limit: size + 1,
    ...(before === undefined ? {} : { before }),
  });
  const items = entries.slice(0, size).map(historyEntry);
  const more = entries.length > size;
  return { items, next_before: more ? (items[items.length - 1]?.id ?? null) : null };
}

/** The name of the tier that starts at `min` on the ladder. */
function tierName(min: number): string {
  return BOND_LADDER.find((t) => t.min === min)?.label ?? String(min);
}

function anchorOf(a: TierAnchor): PersonAnchor {
  return {
    tier: a.tier,
    tier_name: tierName(a.tier),
    note_ref: a.note_ref,
    quote: a.quote,
    at: a.at,
    by: a.by,
  };
}

/** How much of today's caps `person` has used, for each number that has caps. */
function ledgerOf(heart: HeartStore, p: HeartPerson, now: number): FieldLedger[] {
  const ledger = heart.log.dayLedger(p.person_id, now);
  const rules = heart.rules;
  const out: FieldLedger[] = [];
  for (const field of HEART_FIELDS) {
    const capUp = dailyCap(field, "up", rules, p.bond);
    const capDown = dailyCap(field, "down", rules, p.bond);
    if (!Number.isFinite(capUp) || !Number.isFinite(capDown)) continue;
    const l = ledger.fields[field];
    out.push({
      field,
      used_up: l.up,
      used_down: l.down,
      cap_up: capUp,
      cap_down: capDown,
      proposed_up: l.proposed_up,
      proposed_down: l.proposed_down,
    });
  }
  return out;
}

async function memoryCount(state: ApiState, profile: ProfileId, person: PersonId): Promise<number> {
  const records = state.optional(MemoryEngineKey)?.records ?? state.optional(MemoryRecordStoreKey);
  if (!records) return 0;
  const filter: MemoryFilter = {
    subject: person,
    scope: null,
    kind: null,
    before: null,
    include_superseded: false,
    limit: 100_000,
  };
  try {
    if (records.count) return await records.count(profile, filter);
    return (await records.list(profile, filter)).length;
  } catch {
    return 0;
  }
}

/** `GET /api/people/{id}?limit=`. */
async function detail(
  state: ApiState,
  id: string,
  q: { limit?: number | undefined },
): Promise<PersonProfile> {
  const person = parsePerson(id);
  const ctx = new PeopleCtx(state);
  const row = await ctx.requireRow(person);
  const stored = ctx.row(person);
  const p = stored ?? newPerson(person, row.person.created_at);
  const place = bondPlace(p.bond);
  const held = stored === null ? null : heldTier(stored, ctx.heart.rules);
  const evidence: PersonEvidence[] = ctx.heart.log
    .recentEvidence(person, EVIDENCE_SHOWN)
    .map(({ id: eid, evidence: e }) => ({
      id: eid,
      at: e.at,
      kind: e.kind,
      detail: e.detail,
      weight: e.weight,
    }));
  return {
    ...row,
    next_tier: place.next_tier,
    next_label: row.has_row ? place.next_label : null,
    tier_progress: place.tier_progress,
    tier_floor: p.tier_floor,
    held: held === null ? null : { tier: held.tier, label: held.label as RelationshipLabel },
    anchors: p.anchors.map(anchorOf),
    unfinished: p.unfinished,
    jokes: p.jokes,
    dislikes: p.dislikes,
    history: historyPage(ctx.heart, person, undefined, q.limit),
    ledger: ledgerOf(ctx.heart, p, state.now()),
    evidence,
    memory_count: await memoryCount(state, ctx.profile, person),
  };
}

/** `GET /api/people/{id}/history?before=&limit=`. */
async function history(
  state: ApiState,
  id: string,
  q: { before?: string | undefined; limit?: number | undefined },
): Promise<HeartHistoryPage> {
  const person = parsePerson(id);
  const ctx = new PeopleCtx(state);
  if (!(await ctx.person(person))) throw unknownPerson(id);
  return historyPage(ctx.heart, person, q.before?.trim() || undefined, q.limit);
}

function cleanTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "" || tag === BLOCKED_TAG) continue;
    if (chars(tag) > MAX_TAG_CHARS) {
      throw ApiError.badRequest(`tag \`${tag}\` is longer than ${MAX_TAG_CHARS} characters`);
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw ApiError.badRequest(`at most ${MAX_TAGS} tags are allowed`);
  return out;
}

/** Her words a `PATCH` may set. */
const TEXT_FIELDS = ["impression", "stance", "unfinished", "jokes", "dislikes"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

/** What a `PATCH` changes: the fields it sent, a `null` meaning "not sent" (except two). */
interface PersonChange {
  tags?: string[];
  texts: Partial<Record<TextField, string>>;
  public_feeling?: string | null;
  call_name?: string | null;
  blocked?: boolean;
}

function changeOf(r: UpdatePersonRequest): PersonChange {
  const out: PersonChange = { texts: {} };
  if (r.tags != null) out.tags = r.tags;
  for (const field of TEXT_FIELDS) {
    const value = r[field];
    if (value != null) out.texts[field] = value;
  }
  if (r.public_feeling !== undefined) out.public_feeling = r.public_feeling;
  if (r.call_name !== undefined) out.call_name = r.call_name;
  if (r.blocked != null) out.blocked = r.blocked;
  return out;
}

function validate(request: PersonChange): void {
  for (const field of TEXT_FIELDS) {
    const text = request.texts[field];
    if (text !== undefined && chars(text) > MAX_TEXT_CHARS) {
      throw ApiError.badRequest(`${field} is longer than ${MAX_TEXT_CHARS} characters`);
    }
  }
  if (
    typeof request.public_feeling === "string" &&
    chars(request.public_feeling.trim()) > MAX_PUBLIC_FEELING_CHARS
  ) {
    throw ApiError.badRequest(
      `public_feeling is longer than ${MAX_PUBLIC_FEELING_CHARS} characters`,
    );
  }
  if (
    typeof request.call_name === "string" &&
    chars(request.call_name.trim()) > MAX_CALL_NAME_CHARS
  ) {
    throw ApiError.badRequest(`call_name is longer than ${MAX_CALL_NAME_CHARS} characters`);
  }
}

function applyUpdate(
  ctx: PeopleCtx,
  person: PersonId,
  request: PersonChange,
  wanted: string[] | null,
  now: number,
): void {
  const heart = ctx.heart;
  if (wanted !== null) {
    const current = heart.get(person)?.tags ?? [];
    const kept = current.filter((t) => t === BLOCKED_TAG);
    heart.edit(person, { tags: [...kept, ...wanted] }, { now });
  }
  if (request.blocked !== undefined) heart.setTag(person, BLOCKED_TAG, request.blocked, { now });
  if (request.call_name !== undefined) {
    heart.edit(person, { call_name: request.call_name?.trim() || null }, { now });
  }
  if (request.public_feeling !== undefined) {
    heart.edit(person, { public_feeling: request.public_feeling?.trim() || null }, { now });
  }
  const texts: Partial<Record<TextField, string>> = {};
  for (const field of TEXT_FIELDS) {
    const text = request.texts[field];
    if (text !== undefined) texts[field] = text.trim();
  }
  if (Object.keys(texts).length > 0) heart.edit(person, texts, { now });
}

/** `PATCH /api/people/{id}`. */
async function update(
  state: ApiState,
  c: ApiContext,
  id: string,
  body: UpdatePersonRequest,
): Promise<PersonRow> {
  const request = changeOf(body);
  const person = parsePerson(id);
  validate(request);
  const wanted = request.tags ? cleanTags(request.tags) : null;
  const ctx = new PeopleCtx(state);
  if (!(await ctx.person(person))) throw unknownPerson(id);
  let failure: unknown = null;
  try {
    applyUpdate(ctx, person, request, wanted, state.now());
  } catch (error) {
    failure = error;
  }
  const detailJson = toJson(body) as Record<string, unknown>;
  if (failure !== null) detailJson.error = ApiError.internal(failure).message;
  await state.audit(c, "person.update", person, toJson(detailJson), failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  return ctx.requireRow(person);
}

/** `POST /api/people/{id}/adjust`: sets or moves any number, ignoring caps (cause `admin`). */
async function adjust(
  state: ApiState,
  c: ApiContext,
  id: string,
  request: AdjustPersonRequest,
): Promise<PersonRow> {
  const person = parsePerson(id);
  const { field, value, delta } = request;
  if ((value === undefined) === (delta === undefined)) {
    throw ApiError.badRequest("send exactly one of `value` and `delta`");
  }
  const asked = value ?? delta ?? 0;
  if (!Number.isFinite(asked) || Math.abs(asked) > MAX_ADJUST) {
    throw ApiError.badRequest(
      `\`${value === undefined ? "delta" : "value"}\` must be a number between -${MAX_ADJUST} and ${MAX_ADJUST}`,
    );
  }
  const ctx = new PeopleCtx(state);
  if (!(await ctx.person(person))) throw unknownPerson(id);
  let failure: unknown = null;
  try {
    const base = ctx.row(person) ?? newPerson(person, toTimestamp(state.now()));
    ctx.heart.adminSet(person, field, value ?? base[field] + (delta ?? 0), {
      now: state.now(),
      quote: `adjust by ${actorOf(c)}`,
    });
  } catch (error) {
    failure = error;
  }
  await state.audit(
    c,
    "person.adjust",
    person,
    value === undefined ? { field, delta: asked } : { field, value: asked },
    failure === null,
  );
  if (failure !== null) throw ApiError.internal(failure);
  return ctx.requireRow(person);
}

/** The tier of an anchor route's path: a lowest bond of a tier that takes an anchor. */
function anchoredTier(tier: number): number {
  if (!ANCHORED_TIERS.includes(tier)) {
    throw ApiError.badRequest(
      `tier \`${tier}\` takes no anchor (one of ${ANCHORED_TIERS.join(", ")})`,
    );
  }
  return tier;
}

/** `PUT /api/people/{id}/anchors/{tier}`: the shared memory a tier rests on (`by: admin`). */
async function setAnchor(
  state: ApiState,
  c: ApiContext,
  id: string,
  tierValue: number,
  body: SetAnchorRequest,
): Promise<PersonAnchor[]> {
  const person = parsePerson(id);
  const tier = anchoredTier(tierValue);
  const quote = body.quote.trim();
  if (quote === "" || chars(quote) > MAX_ANCHOR_CHARS) {
    throw ApiError.badRequest(`\`quote\` must be 1 to ${MAX_ANCHOR_CHARS} characters`);
  }
  const noteRef = body.note_ref?.trim() || null;
  if (noteRef !== null && chars(noteRef) > MAX_NOTE_REF_CHARS) {
    throw ApiError.badRequest(`\`note_ref\` is longer than ${MAX_NOTE_REF_CHARS} characters`);
  }
  const ctx = new PeopleCtx(state);
  if (!(await ctx.person(person))) throw unknownPerson(id);
  if (ctx.row(person) === null) throw ApiError.notFound("she has no row for this person yet");
  const now = state.now();
  let failure: unknown = null;
  let anchors: TierAnchor[] = [];
  try {
    anchors = ctx.heart.setAnchor(
      person,
      { tier, note_ref: noteRef, quote, at: toTimestamp(now), by: "admin" },
      { now },
    ).anchors;
  } catch (error) {
    failure = error;
  }
  await state.audit(c, "person.anchor.set", person, { tier }, failure === null);
  if (failure !== null) {
    throw failure instanceof StoreError
      ? ApiError.badRequest(failure.message)
      : ApiError.internal(failure);
  }
  return anchors.map(anchorOf);
}

/** `DELETE /api/people/{id}/anchors/{tier}`: the bond stays where it is. */
async function removeAnchor(
  state: ApiState,
  c: ApiContext,
  id: string,
  tierValue: number,
): Promise<PersonAnchor[]> {
  const person = parsePerson(id);
  const tier = anchoredTier(tierValue);
  const ctx = new PeopleCtx(state);
  if (!(await ctx.person(person))) throw unknownPerson(id);
  let failure: unknown = null;
  let left: TierAnchor[] = [];
  try {
    left = ctx.heart.removeAnchor(person, tier, { now: state.now() })?.anchors ?? [];
  } catch (error) {
    failure = error;
  }
  await state.audit(c, "person.anchor.remove", person, { tier }, failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  return left.map(anchorOf);
}

/** The people routes on the route table (`@miyoria/contracts/api`). */
export const peopleRpc = {
  list: os.people.list.handler(({ input, context }) => list(context.state, input.query)),
  get: os.people.get.handler(({ input, context }) =>
    detail(context.state, input.params.id, input.query),
  ),
  history: os.people.history.handler(({ input, context }) =>
    history(context.state, input.params.id, input.query),
  ),
  update: os.people.update.handler(({ input, context }) =>
    update(context.state, context.c, input.params.id, input.body),
  ),
  adjust: os.people.adjust.handler(({ input, context }) =>
    adjust(context.state, context.c, input.params.id, input.body),
  ),
  setAnchor: os.people.setAnchor.handler(({ input, context }) =>
    setAnchor(context.state, context.c, input.params.id, input.params.tier, input.body),
  ),
  removeAnchor: os.people.removeAnchor.handler(({ input, context }) =>
    removeAnchor(context.state, context.c, input.params.id, input.params.tier),
  ),
};
