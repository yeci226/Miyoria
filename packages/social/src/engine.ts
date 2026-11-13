// The social engine: an in-memory cache of the active profile's relationships, kept in sync
// with the store, plus appraisal and notes.
//
// Callers pass `now` (epoch ms) explicitly so everything is testable without a clock.

import { getLogger, SerialQueue } from "@miyoria/kernel";
import { type LlmRouter, sessionId, withLlmTag } from "@miyoria/llm";
import type {
  IdentityStore,
  MemoryRecordStore,
  PeopleStore,
  Relationship,
  RelationshipDelta,
  RelationshipStore,
} from "@miyoria/store";
import {
  type AccountRef,
  type Attitude,
  type Authorizer,
  accountRefString,
  type Clock,
  type ContextKey,
  customEvent,
  type Event,
  newId,
  type PersonId,
  type ProfileId,
  type RelationshipEffects,
  type RelationshipGain,
  SOCIAL_APPRAISAL_TOPIC,
  SOCIAL_EVENT_TOPIC,
  type SocialAppraisal,
  type SocialSignals,
  type Subject,
  sameAccount,
  serviceKey,
  systemClock,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import {
  appraisalRequest,
  type Line,
  notesRequest,
  parseAppraisal,
  parseHeartAppraisal,
  parseNotes,
} from "./appraisal.js";
import type { SocialConfig } from "./config.js";
import {
  apply,
  baseChange,
  DayLedger,
  dayStart,
  diff,
  type EventKind,
  eventKindOrder,
  familiarityChange,
  flirtWeight,
  hasTag,
  isBlocked,
  isOwner,
  isPositiveKind,
  label,
  lineDepth,
  localDay,
  normalize,
  OWNER_TAG,
  parseEventKind,
  type Source,
} from "./rel.js";
import { classify } from "./rules.js";

const log = getLogger("social");

/** Bus topic of every relationship change. */
export const TOPIC = "social.relationship";

/** Publishes events on the bus (the module wires it to the `EventBus`). */
export type Publisher = (event: Event) => void;

/** The stores the engine works with. Backends are provided by the app. */
export interface SocialStores {
  people: PeopleStore;
  relationships: RelationshipStore;
  /** Needed for `/me link` and to know people's accounts right after start. */
  identity: IdentityStore | null;
  /** When set, `/me link` moves the absorbed person's memories to the surviving person. */
  memories?: MemoryRecordStore | null;
}

/** One line someone said, as seen by the engine. */
export interface Observed {
  context: ContextKey;
  account: AccountRef;
  display_name: string;
  text: string;
  /** Explicitly addressed to her (mention, reply, DM). */
  directed: boolean;
  /** Epoch ms. */
  ts: number;
}

/** Result of `/me link <code>`. */
export type LinkOutcome =
  | { type: "linked"; keep: PersonId; absorbed: PersonId }
  | { type: "already_linked" }
  | { type: "same_account" }
  | { type: "invalid_code" }
  | { type: "too_many_attempts" }
  /** No identity store is configured. */
  | { type: "unavailable" };

/** One capped change: where it came from, what it was and its scale (warm / cold). */
export type CappedEvent = readonly [Source, EventKind, number];

const LINK_CODE_MINUTES = 10;
const LINK_MAX_FAILURES = 5;
const ACTIVITY_LINES = 30;
const CONTEXT_LINES_KEPT = 6;
const TONE_THRESHOLD = 0.15;
const MINUTE_MS = 60_000;
/** Smallest familiarity change that is recorded as a delta row. */
const FAMILIARITY_STEP = 0.5;

interface BufLine {
  person: PersonId | null;
  speaker: string;
  text: string;
  fresh: boolean;
}

interface ContextBuffer {
  key: ContextKey;
  lines: BufLine[];
  /** Lines from people since the last appraisal. */
  pending: number;
  /** Kinds the rules already counted per person since the last appraisal. */
  ruleKinds: Map<PersonId, Set<EventKind>>;
  lastActivity: number;
  herLastSpoke: number | null;
  inFlight: boolean;
}

function newBuffer(key: ContextKey, now: number): ContextBuffer {
  return {
    key,
    lines: [],
    pending: 0,
    ruleKinds: new Map(),
    lastActivity: now,
    herLastSpoke: null,
    inFlight: false,
  };
}

function pushLine(buf: ContextBuffer, line: BufLine, max: number): void {
  buf.lines.push(line);
  while (buf.lines.length > max) buf.lines.shift();
}

interface Activity {
  lines: string[];
  sinceNotes: number;
  lastNotes: number | null;
  inFlight: boolean;
}

function newActivity(): Activity {
  return { lines: [], sinceNotes: 0, lastNotes: null, inFlight: false };
}

function pushActivity(a: Activity, line: string): void {
  a.lines.push(line);
  while (a.lines.length > ACTIVITY_LINES) a.lines.shift();
}

interface Snapshot {
  lines: Line[];
  /** Label shown to the model → person, for people with new lines. */
  people: Array<[string, PersonId]>;
  ruleKinds: Map<PersonId, Set<EventKind>>;
}

function contextMapKey(key: ContextKey): string {
  return JSON.stringify([key.platform, key.scope, key.channel, key.kind]);
}

function getOrInsert<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function clone(r: Relationship): Relationship {
  return structuredClone(r);
}

function row(
  at: number,
  affinity: number,
  trust: number,
  familiarity: number,
  reason: string,
): RelationshipDelta {
  return { at: toTimestamp(at), affinity, trust, familiarity, reason };
}

function nonzero(v: number): boolean {
  return Math.abs(v) > 1e-6;
}

/** Drops `<emo:...>` style markup from her replies. */
export function stripTags(text: string): string {
  let out = "";
  let depth = 0;
  for (const c of text) {
    if (c === "<") depth++;
    else if (c === ">" && depth > 0) depth--;
    else if (depth === 0) out += c;
  }
  return out.split(/\s+/u).filter(Boolean).join(" ");
}

/** Relationships of one profile. Provided as `SocialKey` and as `SocialSignalsKey`. */
export class Social implements SocialSignals, RelationshipEffects {
  readonly profile: ProfileId;
  readonly herName: string;
  /** Lower-cased names that address her. */
  readonly #names: string[];
  readonly config: SocialConfig;
  readonly clock: Clock;
  readonly #stores: SocialStores;
  readonly #publish: Publisher;
  #authorizer: Authorizer | null = null;

  readonly #rels = new Map<PersonId, Relationship>();
  readonly #personNames = new Map<PersonId, string>();
  readonly #accounts = new Map<string, PersonId>();
  readonly #ledgers = new Map<PersonId, DayLedger>();
  readonly #contexts = new Map<string, ContextBuffer>();
  readonly #activity = new Map<PersonId, Activity>();
  readonly #selfAccounts = new Set<string>();
  /** Interaction counters changed but not yet written. */
  readonly #dirty = new Set<PersonId>();
  readonly #linkFailures = new Map<string, { since: number; count: number }>();
  /** Familiarity gained since the last recorded step, per person. */
  readonly #famPending = new Map<PersonId, number>();
  /** Serializes read-modify-write cycles so store writes stay in order. */
  readonly #gate = new SerialQueue();
  /**
   * What she cares about, for the appraisal to read her feelings (who she likes, her secret
   * crush, what she wants); `null` = the appraisal does not read her feelings.
   */
  #concerns: (() => string | null) | null = null;

  constructor(
    profile: ProfileId,
    herName: string,
    names: readonly string[],
    config: SocialConfig,
    stores: SocialStores,
    publish: Publisher,
    clock: Clock = systemClock,
  ) {
    this.profile = profile;
    this.herName = herName;
    const lowered = [...names, herName].map((n) => n.trim().toLowerCase()).filter(Boolean);
    this.#names = [...new Set(lowered)].sort();
    this.config = config;
    this.#stores = stores;
    this.#publish = publish;
    this.clock = clock;
  }

  /** Used to auto-tag owners and for owner-only commands. */
  setAuthorizer(authorizer: Authorizer | null): void {
    this.#authorizer = authorizer;
  }

  /**
   * Lets the appraisal also read her feelings (`social.appraisal`): `concerns` describes what
   * she cares about (names inside are untrusted; it goes into the request's data); it returns
   * `null` while her feelings are not tracked (no `self` module).
   */
  setConcerns(concerns: (() => string | null) | null): void {
    this.#concerns = concerns;
  }

  get authorizer(): Authorizer | null {
    return this.#authorizer;
  }

  /**
   * Loads every relationship of the profile and, when an identity store is available, which
   * accounts belong to whom.
   */
  async load(): Promise<void> {
    const rels = await this.#stores.relationships.list(this.profile);
    const accounts: Array<[PersonId, Awaited<ReturnType<IdentityStore["accountsOf"]>>]> = [];
    const identity = this.#stores.identity;
    if (identity) {
      for (const r of rels) {
        try {
          accounts.push([r.person, await identity.accountsOf(r.person)]);
        } catch (error) {
          log.warn({ person: r.person, err: error }, "cannot load accounts");
        }
      }
    }
    for (const r of rels) {
      const copy = clone(r);
      normalize(copy, this.config);
      this.#rels.set(copy.person, copy);
    }
    for (const [person, list] of accounts) {
      for (const a of list) {
        this.#personNames.set(person, a.display_name);
        this.#accounts.set(accountRefString(a.account), person);
      }
    }
    log.info({ profile: this.profile, relationships: rels.length }, "relationships loaded");
  }

  /** One of her own accounts; never appraised. */
  addSelfAccount(account: AccountRef): void {
    this.#selfAccounts.add(accountRefString(account));
  }

  isSelf(account: AccountRef): boolean {
    return this.#selfAccounts.has(accountRefString(account));
  }

  relationship(person: PersonId): Relationship | null {
    const r = this.#rels.get(person);
    return r ? clone(r) : null;
  }

  personOf(account: AccountRef): PersonId | null {
    return this.#accounts.get(accountRefString(account)) ?? null;
  }

  displayName(person: PersonId): string | null {
    return this.#personNames.get(person) ?? null;
  }

  /** Today's appraisal budget use of a person, if any was tracked. */
  today(person: PersonId, now: number): DayLedger | null {
    const day = localDay(now, this.config);
    const ledger = this.#ledgers.get(person);
    return ledger && ledger.day === day ? ledger : null;
  }

  /** People whose cached display name equals `name` (case-insensitive). */
  peopleNamed(name: string): PersonId[] {
    const wanted = name.trim().toLowerCase();
    const out: PersonId[] = [];
    for (const [p, n] of this.#personNames) if (n.toLowerCase() === wanted) out.push(p);
    return out.sort();
  }

  #newRel(person: PersonId, now: number): Relationship {
    const r: Relationship = {
      profile: this.profile,
      person,
      affinity: 0,
      trust: this.config.default_trust,
      familiarity: 0,
      tags: [],
      notes: "",
      call_name: null,
      interactions: 0,
      last_interaction: null,
      updated_at: toTimestamp(now),
    };
    normalize(r, this.config);
    return r;
  }

  #accountIsOwner(account: AccountRef): boolean {
    return this.#authorizer?.allows(account, "owner.social") ?? false;
  }

  /** Owner check for commands; `fallback` is used when no authorizer is set. */
  subjectIsOwner(subject: Subject, fallback: boolean): boolean {
    const a = this.#authorizer;
    return a ? a.allowsSubject(subject, "owner.person.adjust") : fallback;
  }

  /**
   * Account → person, from the cache or the people store. With a display name the account is
   * recorded (creating a person on first sight); without one, unknown accounts resolve to
   * `null`.
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
      const known = this.#rels.has(person);
      const stored = known ? undefined : await this.#stores.relationships.get(this.profile, person);
      this.#accounts.set(accountRefString(account), person);
      if (!this.#personNames.has(person)) this.#personNames.set(person, name);
      if (stored !== undefined && !this.#rels.has(person)) {
        let r: Relationship;
        if (stored === null) {
          r = this.#newRel(person, now);
        } else {
          r = clone(stored);
          normalize(r, this.config);
        }
        this.#rels.set(person, r);
      }
    }
    if (displayName !== null) this.#personNames.set(person, displayName);
    const rel = this.#rels.get(person);
    const tagged = rel !== undefined && isOwner(rel);
    if (this.config.auto_owner_tag && !tagged && this.#accountIsOwner(account)) {
      await this.modify(person, "system: owner", now, (r) => {
        r.tags.push(OWNER_TAG);
      });
    }
    return person;
  }

  #mentionsHer(text: string): boolean {
    const lower = text.toLowerCase();
    return this.#names.some((n) => lower.includes(n));
  }

  #spokeRecently(context: ContextKey, now: number): boolean {
    const t = this.#contexts.get(contextMapKey(context))?.herLastSpoke ?? null;
    return t !== null && now - t <= this.config.direct_window_secs * 1000;
  }

  /**
   * Handles one line from a person: interaction count, familiarity, rule deltas (only for
   * lines said to her) and buffering for appraisal. Returns `true` when the context is due
   * for an LLM appraisal.
   */
  async observe(line: Observed): Promise<boolean> {
    const now = line.ts;
    const person = await this.resolve(line.account, line.display_name, now);
    if (person === null) return false;
    const rel = this.#rels.get(person);
    if (rel && isBlocked(rel)) return false;
    const directed =
      line.directed || this.#mentionsHer(line.text) || this.#spokeRecently(line.context, now);
    const kinds = directed ? classify(line.text) : [];
    const events: CappedEvent[] = kinds.map((k) => ["rule", k, 1] as const);
    await this.applyEvents(person, events, now, line.context, now, lineDepth(line.text, directed));

    const speaker = this.#personNames.get(person) ?? line.display_name;
    const text = line.text.trim();
    const buf = getOrInsert(this.#contexts, contextMapKey(line.context), () =>
      newBuffer(line.context, now),
    );
    pushLine(
      buf,
      { person, speaker, text, fresh: true },
      Math.max(this.config.appraisal_max_lines, 1),
    );
    buf.pending += 1;
    buf.lastActivity = now;
    const counted = getOrInsert(buf.ruleKinds, person, () => new Set());
    for (const k of kinds) counted.add(k);
    const due = !buf.inFlight && buf.pending >= Math.max(this.config.appraisal_every_lines, 1);
    const activity = getOrInsert(this.#activity, person, newActivity);
    pushActivity(activity, `${speaker}: ${text}`);
    activity.sinceNotes += 1;
    return due;
  }

  /**
   * Records her own reply in a context (context for appraisal and notes; lines right after
   * it count as said to her).
   */
  observeSelf(context: ContextKey, text: string, now: number): void {
    const clean = stripTags(text);
    if (clean === "") return;
    const buf = getOrInsert(this.#contexts, contextMapKey(context), () => newBuffer(context, now));
    buf.herLastSpoke = now;
    buf.lastActivity = now;
    const recent = new Set<PersonId>();
    for (const l of buf.lines.slice(-CONTEXT_LINES_KEPT))
      if (l.person !== null) recent.add(l.person);
    pushLine(
      buf,
      { person: null, speaker: this.herName, text: clean, fresh: true },
      Math.max(this.config.appraisal_max_lines, 1),
    );
    for (const person of recent) {
      pushActivity(getOrInsert(this.#activity, person, newActivity), `${this.herName}: ${clean}`);
    }
  }

  /** Contexts with unappraised lines that have been quiet long enough. */
  dueAppraisals(now: number): ContextKey[] {
    const idle = this.config.appraisal_idle_secs * 1000;
    const out: ContextKey[] = [];
    for (const b of this.#contexts.values()) {
      if (!b.inFlight && b.pending > 0 && now - b.lastActivity >= idle) out.push(b.key);
    }
    return out;
  }

  /**
   * Asks the LLM about the unappraised lines of `context` and applies the result. Returns how
   * many people were appraised.
   */
  async appraise(
    router: LlmRouter,
    context: ContextKey,
    now: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const snapshot = this.#takeSnapshot(context);
    if (!snapshot) return 0;
    try {
      return await this.#runAppraisal(router, snapshot, context, now, signal);
    } finally {
      const buf = this.#contexts.get(contextMapKey(context));
      if (buf) buf.inFlight = false;
    }
  }

  #takeSnapshot(context: ContextKey): Snapshot | null {
    const buf = this.#contexts.get(contextMapKey(context));
    if (!buf || buf.pending === 0 || buf.inFlight) return null;
    buf.inFlight = true;
    buf.pending = 0;
    const ruleKinds = buf.ruleKinds;
    buf.ruleKinds = new Map();

    // Unique speaker labels per person.
    const labels = new Map<PersonId, string>();
    const used = new Set<string>([this.herName]);
    for (const line of buf.lines) {
      const p = line.person;
      if (p === null || labels.has(p)) continue;
      let name = line.speaker;
      let n = 2;
      while (used.has(name)) {
        name = `${line.speaker}#${n}`;
        n++;
      }
      used.add(name);
      labels.set(p, name);
    }
    const freshPeople: PersonId[] = [];
    const lines: Line[] = buf.lines.map((l) => {
      if (l.fresh && l.person !== null && !freshPeople.includes(l.person)) {
        freshPeople.push(l.person);
      }
      return {
        speaker: (l.person !== null ? labels.get(l.person) : undefined) ?? l.speaker,
        text: l.text,
        old: !l.fresh,
      };
    });
    for (const l of buf.lines) l.fresh = false;
    // Keep a little context for the next round.
    while (buf.lines.length > CONTEXT_LINES_KEPT) buf.lines.shift();
    const people: Array<[string, PersonId]> = [];
    for (const p of freshPeople) {
      const l = labels.get(p);
      if (l !== undefined) people.push([l, p]);
    }
    return { lines, people, ruleKinds };
  }

  /** Session id of the appraisal / notes requests (one per profile). */
  #llmSession(): string {
    return sessionId(this.profile, "social");
  }

  async #runAppraisal(
    router: LlmRouter,
    snapshot: Snapshot,
    context: ContextKey,
    now: number,
    signal?: AbortSignal,
  ): Promise<number> {
    if (snapshot.people.length === 0) return 0;
    const names = snapshot.people.map(([n]) => n);
    const concerns = this.#concerns?.() ?? null;
    const request = {
      ...appraisalRequest(this.herName, snapshot.lines, names, concerns),
      session: this.#llmSession(),
    };
    const response = await withLlmTag({ module: "social", label: "appraisal" }, () =>
      router.complete(this.config.llm_purpose, request, signal),
    );
    const results = parseAppraisal(response.text);
    if (concerns !== null) this.#announceHeart(response.text, snapshot, context);
    let applied = 0;
    for (const result of results) {
      const wanted = asciiLower(result.person_name.trim());
      let person = snapshot.people.find(([n]) => asciiLower(n.trim()) === wanted)?.[1];
      if (person === undefined && snapshot.people.length === 1 && results.length === 1) {
        person = snapshot.people[0]?.[1];
      }
      if (person === undefined) {
        log.debug({ name: result.person_name }, "appraisal names an unknown person");
        continue;
      }
      const counted = snapshot.ruleKinds.get(person);
      const kinds = new Set<EventKind>();
      for (const e of result.events) {
        const k = parseEventKind(e);
        if (k === null || k === "warm" || k === "cold") continue;
        if (counted?.has(k)) continue;
        kinds.add(k);
      }
      const events: CappedEvent[] = [...kinds]
        .sort((a, b) => eventKindOrder(a) - eventKindOrder(b))
        .map((k) => ["appraisal", k, 1] as const);
      const tone = result.toward_her;
      if (tone >= TONE_THRESHOLD) events.push(["appraisal", "warm", tone]);
      else if (tone <= -TONE_THRESHOLD) events.push(["appraisal", "cold", tone]);
      await this.applyEvents(person, events, null, context, now);
      applied++;
    }
    return applied;
  }

  /** Publishes what the appraisal read about her feelings (`social.appraisal`). */
  #announceHeart(text: string, snapshot: Snapshot, context: ContextKey): void {
    let heart: ReturnType<typeof parseHeartAppraisal>;
    try {
      heart = parseHeartAppraisal(text);
    } catch {
      return;
    }
    const people: SocialAppraisal["people"] = [];
    for (const [label, person] of snapshot.people) {
      const p = heart.people.get(asciiLower(label.trim()));
      if (!p) continue;
      people.push({ person, name: this.displayName(person), ...p });
    }
    if (people.length === 0 && Object.keys(heart.her).length === 0) return;
    const payload: SocialAppraisal = { context: { ...context }, her: heart.her, people };
    this.#publish(customEvent(SOCIAL_APPRAISAL_TOPIC, JSON.parse(JSON.stringify(payload))));
  }

  /** People whose notes are due for a refresh. */
  dueNotes(now: number): PersonId[] {
    const interval = this.config.notes_min_interval_hours * 3_600_000;
    const out: PersonId[] = [];
    for (const [p, a] of this.#activity) {
      const rel = this.#rels.get(p);
      if (
        !a.inFlight &&
        a.sinceNotes >= Math.max(this.config.notes_every_lines, 1) &&
        (a.lastNotes === null || now - a.lastNotes >= interval) &&
        !(rel && isBlocked(rel))
      ) {
        out.push(p);
      }
    }
    return out;
  }

  /** Rewrites her impression notes of `person` from recent lines. Returns whether they changed. */
  async refreshNotes(
    router: LlmRouter,
    person: PersonId,
    now: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const old = this.#rels.get(person)?.notes ?? "";
    const name = this.#personNames.get(person) ?? "";
    const a = this.#activity.get(person);
    if (!a || a.inFlight || a.lines.length === 0) return false;
    a.inFlight = true;
    a.sinceNotes = 0;
    a.lastNotes = now;
    const lines = [...a.lines];
    try {
      const request = {
        ...notesRequest(this.herName, name, old, lines),
        session: this.#llmSession(),
      };
      const response = await withLlmTag({ module: "social", label: "notes" }, () =>
        router.complete(this.config.llm_purpose, request, signal),
      );
      const notes = parseNotes(response.text);
      if (notes === null || notes === old) return false;
      await this.#modifyInner(person, "notes: refresh", now, false, (r) => {
        r.notes = notes;
      });
      return true;
    } finally {
      const current = this.#activity.get(person);
      if (current) current.inFlight = false;
    }
  }

  /** Writes interaction counters that changed without a numeric change. */
  flush(): Promise<void> {
    return this.#gate.run(async () => {
      const rels: Relationship[] = [];
      for (const p of this.#dirty) {
        const r = this.#rels.get(p);
        if (r) rels.push(clone(r));
      }
      this.#dirty.clear();
      for (const r of rels) await this.#stores.relationships.upsert(r);
    });
  }

  async #ensureLedger(person: PersonId, now: number): Promise<void> {
    const today = localDay(now, this.config);
    const existing = this.#ledgers.get(person);
    if (existing) {
      if (existing.day !== today) this.#ledgers.set(person, new DayLedger(today));
      return;
    }
    const since = toTimestamp(dayStart(today, this.config));
    const deltas = await this.#stores.relationships.deltasSince(this.profile, person, since);
    this.#ledgers.set(person, DayLedger.fromDeltas(today, deltas));
  }

  /**
   * Applies capped events and, with `touch` (epoch ms), one interaction of `depth` (see
   * `lineDepth`; it sets how much it adds to familiarity).
   */
  applyEvents(
    person: PersonId,
    events: readonly CappedEvent[],
    touch: number | null,
    context: ContextKey | null,
    now: number,
    depth = 1,
  ): Promise<void> {
    if (events.length === 0 && touch === null) return Promise.resolve();
    return this.#gate.run(async () => {
      if (events.length > 0) await this.#ensureLedger(person, now);
      const r = getOrInsert(this.#rels, person, () => this.#newRel(person, now));
      if (isBlocked(r)) return;
      const rows: Array<[RelationshipDelta, EventKind | null]> = [];
      if (touch !== null) {
        const change = familiarityChange(
          r.last_interaction,
          touch,
          this.config,
          r.familiarity,
          depth,
        );
        r.interactions += 1;
        r.last_interaction = toTimestamp(touch);
        const [, , df] = apply(r, 0, 0, change, this.config);
        // A line moves it a hair: rows (and `social.relationship` events) come in steps of at
        // least half a point; the counters are flushed by the tick.
        const pending = (this.#famPending.get(person) ?? 0) + df;
        if (Math.abs(pending) >= FAMILIARITY_STEP) {
          this.#famPending.delete(person);
          rows.push([row(now, 0, 0, pending, "familiarity: lines"), null]);
        } else {
          this.#famPending.set(person, pending);
        }
      }
      // Her emotions react to everything, whether or not the caps let the numbers move.
      for (const [source, kind, scale] of events) {
        this.#publish(
          customEvent(SOCIAL_EVENT_TOPIC, {
            person,
            name: this.displayName(person),
            kind,
            source,
            scale: Math.abs(scale),
            context: context === null ? null : { ...context },
          }),
        );
      }
      const ledger = this.#ledgers.get(person);
      if (ledger) {
        for (const [source, kind, scale] of events) {
          let base = baseChange(kind, scale);
          if (kind === "flirt_too_far") {
            const w = flirtWeight(r.affinity);
            base = [base[0] * w, base[1] * w];
          }
          const [a, t] = ledger.take(kind, base, this.config);
          const [da, dt] = apply(r, a, t, 0, this.config);
          if (nonzero(da) || nonzero(dt)) {
            rows.push([row(now, da, dt, 0, `${source}: ${kind}`), kind]);
          }
        }
      }
      r.updated_at = toTimestamp(now);
      if (rows.length === 0) {
        this.#dirty.add(person);
        return;
      }
      this.#dirty.delete(person);
      await this.#persist(clone(r), rows, context);
    });
  }

  /**
   * A small gain from the economy (a paid gift, a deal paid): worth less for each earlier one of
   * its kind today (`repeat_decay`), within the kind's own daily cap and the overall ones. It
   * publishes no `social.event`: the economy already told her emotions.
   */
  gain(
    person: PersonId,
    gain: RelationshipGain,
    now: number,
  ): Promise<{ affinity: number; trust: number }> {
    return this.#gate.run(async () => {
      await this.#ensureLedger(person, now);
      const r = getOrInsert(this.#rels, person, () => this.#newRel(person, now));
      const none = { affinity: 0, trust: 0 };
      const ledger = this.#ledgers.get(person);
      if (!ledger || isBlocked(r)) return none;
      const cap =
        gain.kind_cap === null ? null : ([gain.kind_cap.affinity, gain.kind_cap.trust] as const);
      const [a, t] = ledger.take(gain.kind, [gain.affinity, gain.trust], this.config, cap);
      const [da, dt] = apply(r, a, t, 0, this.config);
      r.updated_at = toTimestamp(now);
      if (!nonzero(da) && !nonzero(dt)) {
        this.#dirty.add(person);
        return none;
      }
      this.#dirty.delete(person);
      await this.#persist(clone(r), [[row(now, da, dt, 0, `economy: ${gain.kind}`), null]], null);
      return { affinity: da, trust: dt };
    });
  }

  /** A loss outside the daily caps, recorded as one delta with `reason`. */
  async penalty(
    person: PersonId,
    loss: { affinity: number; trust: number; reason: string },
    now: number,
  ): Promise<{ affinity: number; trust: number }> {
    let before = { affinity: 0, trust: 0 };
    const after = await this.modify(person, loss.reason, now, (r) => {
      before = { affinity: r.affinity, trust: r.trust };
      r.affinity -= Math.abs(loss.affinity);
      r.trust -= Math.abs(loss.trust);
    });
    return { affinity: after.affinity - before.affinity, trust: after.trust - before.trust };
  }

  async #persist(
    r: Relationship,
    rows: ReadonlyArray<[RelationshipDelta, EventKind | null]>,
    context: ContextKey | null,
  ): Promise<void> {
    await this.#stores.relationships.upsert(r);
    for (const [delta, kind] of rows) {
      await this.#stores.relationships.recordDelta(this.profile, r.person, delta);
      this.#announce(r, delta, kind, context);
    }
  }

  #announce(
    r: Relationship,
    delta: RelationshipDelta,
    kind: EventKind | null,
    context: ContextKey | null,
  ): void {
    this.#publish(
      customEvent(TOPIC, {
        profile: this.profile,
        person: r.person,
        name: this.displayName(r.person),
        reason: delta.reason,
        kind,
        positive: kind === null ? null : isPositiveKind(kind),
        affinity: delta.affinity,
        trust: delta.trust,
        familiarity: delta.familiarity,
        label: label(r),
        context: context === null ? null : { ...context },
      }),
    );
  }

  /**
   * Changes a relationship outside the caps (admin, linking, settings), recording the
   * difference as one delta.
   */
  modify(
    person: PersonId,
    reason: string,
    now: number,
    f: (r: Relationship) => void,
  ): Promise<Relationship> {
    return this.#modifyInner(person, reason, now, true, f);
  }

  #modifyInner(
    person: PersonId,
    reason: string,
    now: number,
    record: boolean,
    f: (r: Relationship) => void,
  ): Promise<Relationship> {
    return this.#gate.run(async () => {
      const r = getOrInsert(this.#rels, person, () => this.#newRel(person, now));
      const before = clone(r);
      f(r);
      r.tags = [...new Set(r.tags)].sort();
      normalize(r, this.config);
      r.updated_at = toTimestamp(now);
      this.#dirty.delete(person);
      const after = clone(r);
      const delta = diff(before, after, reason, now);
      await this.#stores.relationships.upsert(after);
      if (record) await this.#stores.relationships.recordDelta(this.profile, person, delta);
      this.#announce(after, delta, null, null);
      return clone(after);
    });
  }

  /** Resets numbers, notes and call name; tags stay. */
  reset(person: PersonId, by: string, now: number): Promise<Relationship> {
    const fresh = this.#newRel(person, now);
    return this.modify(person, `admin: reset by ${by}`, now, (r) => {
      const tags = r.tags;
      Object.assign(r, fresh, { tags });
    });
  }

  /** Adds `affinity` directly (owner only; ignores caps). */
  adjust(person: PersonId, affinity: number, by: string, now: number): Promise<Relationship> {
    return this.modify(person, `admin: adjust by ${by}`, now, (r) => {
      r.affinity += affinity;
    });
  }

  /** Adds or removes a tag. Returns whether anything changed. */
  async setTag(
    person: PersonId,
    tag: string,
    on: boolean,
    by: string,
    now: number,
  ): Promise<boolean> {
    const rel = this.#rels.get(person);
    const has = rel !== undefined && hasTag(rel, tag);
    if (has === on) return false;
    const verb = on ? "tag" : "untag";
    await this.modify(person, `admin: ${verb} ${tag} by ${by}`, now, (r) => {
      if (on) r.tags.push(tag);
      else r.tags = r.tags.filter((t) => t !== tag);
    });
    return true;
  }

  /** `by` is who set it, for the relationship's delta log: `me` (the person), `her` (a tool). */
  setCallName(
    person: PersonId,
    callName: string | null,
    now: number,
    by = "me",
  ): Promise<Relationship> {
    return this.modify(person, `${by}: call_name`, now, (r) => {
      r.call_name = callName;
    });
  }

  /**
   * Issues a one-time `/me link` code for `account` (valid 10 minutes). `null` when no identity
   * store is configured.
   */
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
   * Redeems a code from another account: the invoker's person is merged into the issuer's.
   * Relationships keep the higher-affinity side; memories about the absorbed person (subjects
   * and `person` scopes, every profile) move to the kept one when a memory store is set. Both
   * happen before the people are merged, so a failure leaves the absorbed person in place.
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
    const normalized = code.trim().toUpperCase();
    const issuer = await identity.consumeLinkCode(normalized, toTimestamp(now));
    if (!issuer) {
      getOrInsert(this.#linkFailures, key, () => ({ since: now, count: 0 })).count += 1;
      return { type: "invalid_code" };
    }
    if (sameAccount(issuer, account)) return { type: "same_account" };
    const keep = await this.resolve(issuer, null, now);
    if (keep === null) return { type: "invalid_code" };
    const absorb = await this.resolve(account, displayName, now);
    if (absorb === null) return { type: "invalid_code" };
    if (keep === absorb) return { type: "already_linked" };
    await this.#merge(keep, absorb, now);
    const memories = this.#stores.memories ?? null;
    const moved = memories ? await memories.mergePerson(keep, absorb) : null;
    await identity.linkAccount(account, keep);
    await identity.mergePeople(keep, absorb);
    for (const [k, p] of this.#accounts) if (p === absorb) this.#accounts.set(k, keep);
    this.#personNames.delete(absorb);
    this.#ledgers.delete(absorb);
    const activity = this.#activity.get(absorb);
    if (activity) {
      this.#activity.delete(absorb);
      getOrInsert(this.#activity, keep, newActivity).lines.push(...activity.lines);
    }
    if (moved === null) log.info({ keep, absorb }, "accounts linked; memories are not merged");
    else log.info({ keep, absorb, memories: moved }, "accounts linked");
    return { type: "linked", keep, absorbed: absorb };
  }

  async #merge(keep: PersonId, absorb: PersonId, now: number): Promise<void> {
    const other =
      this.relationship(absorb) ?? (await this.#stores.relationships.get(this.profile, absorb));
    if (other) await this.modify(keep, "link: merge", now, (r) => mergeInto(r, other));
    await this.#gate.run(async () => {
      this.#rels.delete(absorb);
      await this.#stores.relationships.delete(this.profile, absorb);
    });
  }

  attitude(account: AccountRef): Attitude | null {
    const person = this.#accounts.get(accountRefString(account));
    if (person === undefined) return null;
    return this.attitudeOf(person);
  }

  /** The people she likes most (affinity at or above `min`), most liked first. */
  liked(min: number, max: number): PersonId[] {
    return [...this.#rels.values()]
      .filter((r) => r.affinity >= min && !isBlocked(r))
      .sort((a, b) => b.affinity - a.affinity)
      .slice(0, Math.max(max, 0))
      .map((r) => r.person);
  }

  attitudeOf(person: PersonId): Attitude | null {
    const r = this.#rels.get(person);
    return r ? { ...attitude(r), display_name: this.#personNames.get(person) ?? null } : null;
  }
}

/** The service key of the engine itself (Rust `Arc<Social>`). */
export const SocialKey = serviceKey<Social>("Social");

export function attitude(r: Relationship): Attitude {
  return {
    person: r.person,
    affinity: r.affinity,
    trust: r.trust,
    familiarity: r.familiarity,
    blocked: isBlocked(r),
    label: label(r),
    call_name: r.call_name,
    owner: isOwner(r),
    interactions: r.interactions,
    last_interaction: r.last_interaction,
  };
}

function laterTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return timestampMs(b) > timestampMs(a) ? b : a;
}

/** Keeps the side with the higher affinity; the rest is combined. */
export function mergeInto(keep: Relationship, other: Relationship): void {
  const person = keep.person;
  const profile = keep.profile;
  const tags = [...keep.tags, ...other.tags];
  const familiarity = Math.max(keep.familiarity, other.familiarity);
  const interactions = keep.interactions + other.interactions;
  const last = laterTimestamp(keep.last_interaction, other.last_interaction);
  const [base, rest] =
    other.affinity > keep.affinity ? [clone(other), clone(keep)] : [clone(keep), clone(other)];
  if (base.notes.trim() === "") base.notes = rest.notes;
  if (base.call_name === null) base.call_name = rest.call_name;
  Object.assign(keep, base, {
    profile,
    person,
    tags,
    familiarity,
    interactions,
    last_interaction: last,
  });
}
