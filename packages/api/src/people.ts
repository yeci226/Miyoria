// `/api/people*`: people the active profile knows and how she feels about them. Reads come from
// the stores (with the social engine's cached numbers when it runs); every change goes through
// the social engine. Everyone in the people store is listed; people she has no relationship with
// yet have `relationship: null` and the label of a neutral relationship.

import { MemoryEngineKey } from "@miyoria/memory";
import { attitude, BLOCKED_TAG, label, type Social, SocialKey } from "@miyoria/social";
import {
  type IdentityStore,
  IdentityStoreKey,
  type MemoryFilter,
  MemoryRecordStoreKey,
  type PeopleStore,
  PeopleStoreKey,
  type Person,
  type Relationship,
  type RelationshipDelta,
  type RelationshipStore,
  RelationshipStoreKey,
} from "@miyoria/store";
import { isUlid, type PersonId, type ProfileId, toTimestamp } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { readJson, readQuery, usizeParam } from "./extract.js";
import { json, param, type Route } from "./route.js";
import { type ApiContext, type ApiState, actorOf, toJson } from "./state.js";
import type { Page, PersonDetail, PersonSummary, UpdatePersonRequest } from "./types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_HISTORY = 500;
const MAX_TAGS = 32;
const MAX_TAG_CHARS = 32;
const MAX_NOTES_CHARS = 2000;
const MAX_CALL_NAME_CHARS = 64;

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

/** The label of someone she has no relationship with yet (all levels at zero: 陌生人). */
const NEUTRAL_LABEL = label({
  profile: "",
  person: "",
  affinity: 0,
  trust: 0,
  familiarity: 0,
  tags: [],
  notes: "",
  call_name: null,
  interactions: 0,
  last_interaction: null,
  updated_at: toTimestamp(0),
});

/** The services people routes read from. */
class PeopleCtx {
  readonly profile: ProfileId;
  readonly relationships: RelationshipStore;
  readonly identity: IdentityStore;
  readonly people: PeopleStore | undefined;
  readonly social: Social | undefined;

  constructor(state: ApiState) {
    this.social = state.optional(SocialKey);
    this.profile = this.social ? this.social.profile : state.profile();
    this.relationships = state.service(RelationshipStoreKey, "relationship store");
    this.identity = state.service(IdentityStoreKey, "identity store");
    this.people = state.optional(PeopleStoreKey);
  }

  /** The social engine's cached relationship, else the stored one. */
  async relationship(person: PersonId): Promise<Relationship | null> {
    const cached = this.social?.relationship(person) ?? null;
    if (cached) return cached;
    return this.relationships.get(this.profile, person);
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

  async summary(id: PersonId, relationship: Relationship | null): Promise<PersonSummary | null> {
    const person = await this.person(id);
    return person ? summarize(person, relationship) : null;
  }

  async requireSummary(id: PersonId): Promise<PersonSummary> {
    const relationship = await this.relationship(id);
    const summary = await this.summary(id, relationship);
    if (!summary) throw unknownPerson(id);
    return summary;
  }
}

function summarize(person: Person, relationship: Relationship | null): PersonSummary {
  const a = relationship ? attitude(relationship) : null;
  return { person, relationship, label: a?.label ?? NEUTRAL_LABEL, blocked: a?.blocked ?? false };
}

/** When one of the person's accounts was last seen. */
function lastSeen(person: Person): number {
  let last = Number.NEGATIVE_INFINITY;
  for (const a of person.accounts) last = Math.max(last, Date.parse(a.last_seen));
  return last;
}

/**
 * Most recent interaction first, then the most recently changed relationship, then whoever was
 * seen last (people without a relationship sort after those with one of the same recency).
 */
function byRecency(a: PersonSummary, b: PersonSummary): number {
  const ra = a.relationship;
  const rb = b.relationship;
  return (
    ms(rb?.last_interaction ?? null) - ms(ra?.last_interaction ?? null) ||
    ms(rb?.updated_at ?? null) - ms(ra?.updated_at ?? null) ||
    lastSeen(b.person) - lastSeen(a.person) ||
    0
  );
}

function matches(summary: PersonSummary, needle: string): boolean {
  const has = (s: string) => s.toLowerCase().includes(needle);
  return (
    has(summary.person.display_name) ||
    summary.person.id.toLowerCase() === needle ||
    summary.person.accounts.some((a) => has(a.display_name) || has(a.account.id)) ||
    (summary.relationship?.call_name != null && has(summary.relationship.call_name))
  );
}

const ListQuerySchema = z.object({
  q: z.string().optional(),
  limit: usizeParam.optional(),
  cursor: z.string().optional(),
});

/**
 * `GET /api/people?q=&limit=&cursor=`: every known person, most recent interaction first. Without
 * a people store only people with a relationship are known.
 */
async function list(state: ApiState, c: ApiContext): Promise<Response> {
  const q = readQuery(c, ListQuerySchema);
  const ctx = new PeopleCtx(state);
  let offset = 0;
  const cursor = q.cursor?.trim() ?? "";
  if (cursor !== "") {
    if (!/^\+?\d+$/.test(cursor)) throw ApiError.badRequest(`invalid cursor \`${cursor}\``);
    offset = Number.parseInt(cursor, 10);
  }
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const needle = q.q?.trim().toLowerCase() || null;

  const social = ctx.social;
  const rels = new Map<PersonId, Relationship>();
  for (const r of await ctx.relationships.list(ctx.profile)) {
    rels.set(r.person, social?.relationship(r.person) ?? r);
  }
  const all: PersonSummary[] = [];
  if (ctx.people) {
    for (const person of await ctx.people.all()) {
      // The engine may hold a relationship it has not written yet.
      const relationship = rels.get(person.id) ?? social?.relationship(person.id) ?? null;
      all.push(summarize(person, relationship));
    }
  } else {
    for (const r of rels.values()) {
      const summary = await ctx.summary(r.person, r);
      if (summary) all.push(summary);
    }
  }
  const items = all
    .filter((summary) => needle === null || matches(summary, needle))
    .sort(byRecency);
  const page: Page<PersonSummary> = {
    items: items.slice(offset, offset + limit),
    next_cursor: items.length > offset + limit ? String(offset + limit) : null,
  };
  return json(page);
}

/**
 * Turns stored deltas (oldest first) into the absolute levels after each one, walking back
 * from the current values.
 */
export function absoluteHistory(
  deltas: readonly RelationshipDelta[],
  current: Relationship | null,
): RelationshipDelta[] {
  let a = current?.affinity ?? 0;
  let t = current?.trust ?? 0;
  let f = current?.familiarity ?? 0;
  const out: RelationshipDelta[] = [];
  for (let i = deltas.length - 1; i >= 0; i--) {
    const d = deltas[i] as RelationshipDelta;
    out.push({ at: d.at, affinity: a, trust: t, familiarity: f, reason: d.reason });
    a -= d.affinity;
    t -= d.trust;
    f -= d.familiarity;
  }
  return out.reverse();
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

/** `GET /api/people/{id}`. */
async function detail(state: ApiState, c: ApiContext): Promise<Response> {
  const person = parsePerson(param(c, "id"));
  const ctx = new PeopleCtx(state);
  const summary = await ctx.requireSummary(person);
  let deltas = await ctx.relationships.deltasSince(ctx.profile, person, toTimestamp(0));
  if (deltas.length > MAX_HISTORY) deltas = deltas.slice(deltas.length - MAX_HISTORY);
  const body: PersonDetail = {
    ...summary,
    history: absoluteHistory(deltas, summary.relationship),
    memory_count: await memoryCount(state, ctx.profile, person),
  };
  return json(body);
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

function validate(request: UpdatePersonRequest): void {
  if (request.notes !== undefined && chars(request.notes) > MAX_NOTES_CHARS) {
    throw ApiError.badRequest(`notes are longer than ${MAX_NOTES_CHARS} characters`);
  }
  if (
    typeof request.call_name === "string" &&
    chars(request.call_name.trim()) > MAX_CALL_NAME_CHARS
  ) {
    throw ApiError.badRequest(`call_name is longer than ${MAX_CALL_NAME_CHARS} characters`);
  }
}

/** Tags to add and remove so the non-`blocked` tags become `wanted`. */
function tagChanges(current: readonly string[], wanted: readonly string[]) {
  return {
    add: wanted.filter((t) => !current.includes(t)),
    remove: current.filter((t) => t !== BLOCKED_TAG && !wanted.includes(t)),
  };
}

const UpdatePersonSchema = z
  .object({
    tags: z.array(z.string()).nullish(),
    notes: z.string().nullish(),
    call_name: z.string().nullable().optional(),
    blocked: z.boolean().nullish(),
  })
  .transform((r): UpdatePersonRequest => {
    const out: UpdatePersonRequest = {};
    if (r.tags != null) out.tags = r.tags;
    if (r.notes != null) out.notes = r.notes;
    if (r.call_name !== undefined) out.call_name = r.call_name;
    if (r.blocked != null) out.blocked = r.blocked;
    return out;
  });

async function applyUpdate(
  ctx: PeopleCtx,
  social: Social,
  person: PersonId,
  request: UpdatePersonRequest,
  tags: { add: string[]; remove: string[] } | null,
  actor: string,
  now: number,
): Promise<void> {
  if (tags) {
    for (const tag of tags.remove) await social.setTag(person, tag, false, actor, now);
    for (const tag of tags.add) await social.setTag(person, tag, true, actor, now);
  }
  if (request.blocked !== undefined) {
    await social.setTag(person, BLOCKED_TAG, request.blocked, actor, now);
  }
  if (request.call_name !== undefined) {
    const name = request.call_name?.trim() || null;
    await social.setCallName(person, name, now);
  }
  if (request.notes !== undefined) {
    // The engine has no notes setter: write the stored row and reload its cache (after flushing
    // its pending counters).
    await social.flush();
    const rel =
      (await ctx.relationships.get(ctx.profile, person)) ??
      (await social.adjust(person, 0, actor, now));
    await ctx.relationships.upsert({
      ...rel,
      notes: request.notes.trim(),
      updated_at: toTimestamp(now),
    });
    await social.load();
  }
}

/** `PATCH /api/people/{id}`. */
async function update(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, UpdatePersonSchema);
  const id = param(c, "id");
  const person = parsePerson(id);
  validate(request);
  const wanted = request.tags ? cleanTags(request.tags) : null;
  const social = state.service(SocialKey, "social module");
  const ctx = new PeopleCtx(state);
  if (!(await ctx.person(person))) throw unknownPerson(id);
  let tags: { add: string[]; remove: string[] } | null = null;
  if (wanted) {
    const current = (await ctx.relationship(person))?.tags ?? [];
    tags = tagChanges(current, wanted);
  }
  const actor = actorOf(c);
  let failure: unknown = null;
  try {
    await applyUpdate(ctx, social, person, request, tags, actor, state.now());
  } catch (error) {
    failure = error;
  }
  const detailJson = toJson(request) as Record<string, unknown>;
  if (failure !== null) detailJson.error = ApiError.internal(failure).message;
  await state.audit(c, "person.update", person, toJson(detailJson), failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  return json(await ctx.requireSummary(person));
}

const AdjustSchema = z.object({ affinity: z.number() });

/** `POST /api/people/{id}/adjust`: adds to the affinity, ignoring caps. */
async function adjust(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, AdjustSchema);
  const id = param(c, "id");
  const person = parsePerson(id);
  if (!Number.isFinite(request.affinity) || Math.abs(request.affinity) > 200) {
    throw ApiError.badRequest("`affinity` must be a number between -200 and 200");
  }
  const social = state.service(SocialKey, "social module");
  const ctx = new PeopleCtx(state);
  if (!(await ctx.person(person))) throw unknownPerson(id);
  let failure: unknown = null;
  try {
    await social.adjust(person, request.affinity, actorOf(c), state.now());
  } catch (error) {
    failure = error;
  }
  await state.audit(c, "person.adjust", person, { affinity: request.affinity }, failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  return json(await ctx.requireSummary(person));
}

export function peopleRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/people", handler: (c) => list(state, c) },
    { method: "GET", path: "/api/people/:id", handler: (c) => detail(state, c) },
    { method: "PATCH", path: "/api/people/:id", handler: (c) => update(state, c) },
    { method: "POST", path: "/api/people/:id/adjust", handler: (c) => adjust(state, c) },
  ];
}
