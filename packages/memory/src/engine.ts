// `MemoryEngine`: storing with dedupe, hybrid recall, consolidation, forgetting and followups.
// Provided as the service `MemoryEngineKey` (and as `FollowupSourceKey`).

import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import {
  assistantMessage,
  type ChatRequest,
  type ChatResponse,
  contextHash,
  type LlmRouter,
  ProviderHttpError,
  sessionId,
  systemMessage,
  userMessage,
  withLlmTag,
} from "@miyoria/llm";
import {
  embeddingValues,
  type LogEntry,
  type MemoryFilter,
  type MemoryKind,
  type MemoryRecord,
  type MemoryRecordStore,
  type MemoryScope,
  type MemorySource,
  type MessageLog,
  type PeopleStore,
  type SettingsStore,
} from "@miyoria/store";
import {
  type AccountRef,
  type Clock,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  EventLogKey,
  type Followup,
  type FollowupSource,
  type HandleDirectory,
  HandleDirectoryKey,
  isJsonObject,
  isUlid,
  type JsonValue,
  type LogEvent,
  type MemoryOrigin,
  type MessageExcluded,
  newId,
  type PersonId,
  type ProfileId,
  repairHandleText,
  sameAccount,
  serviceKey,
  systemClock,
  type Timestamp,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import type { MemoryConfig } from "./config.js";
import { cosine, type Embedder, NoEmbedder } from "./embed.js";
import {
  type EventReader,
  type EvidenceLine,
  isEventRef,
  LINE_REF_PREFIX,
  linkLines,
  mergeRefs,
  nameWords,
  summaryOf,
  supporting,
} from "./evidence.js";
import { EXCLUDED_KEY, ExclusionList, lineHash, messageKey } from "./exclusion.js";
import { expired, expiryOf, isPresentState, isStateLifetime, wordingTtlHours } from "./expiry.js";
import {
  type Extraction,
  ExtractionError,
  parseExtraction,
  pendingBlock,
  systemPrompt,
  transcript,
} from "./extract.js";
import { sameMatter } from "./followups.js";
import { RepeatDamper } from "./repeat.js";
import {
  hasScope,
  isPrivate,
  mayRecall,
  type NamedPerson,
  noteAbout,
  scopeEquals,
  scopeForNew,
  visibleScopes,
  visibleToSelf,
} from "./scope.js";
import {
  effectiveConfidence,
  fadedConfidence,
  finalScore,
  signals,
  tokenOverlap,
} from "./score.js";
import { textSimilarity, tokenize, tokenString } from "./tokenize.js";

const log = getLogger("memory");

/** Settings key prefix of consolidation watermarks (`memory_watermark:<context>`). */
export const WATERMARK_PREFIX = "memory_watermark:";
/** Settings key of the last maintenance run. */
export const MAINTENANCE_KEY = "memory_maintenance_last";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Pending followups shown to the summarizer with a stretch of conversation. */
const PENDING_FOLLOWUPS = 8;
/** Followups read when looking for one about the same thing (newest first). */
const FOLLOWUP_WINDOW = 500;

export class MemoryError extends Error {
  override readonly name = "MemoryError";
}

/** The last log line already consolidated in a context (persisted as JSON). */
export interface Watermark {
  context: ContextKey;
  ts: Timestamp;
  /** ULID of the log entry. */
  id: string;
}

/** A memory to store. Field names mirror `MemoryRecord`. */
export interface NewMemory {
  kind: MemoryKind;
  scope: MemoryScope;
  subjects: PersonId[];
  content: string;
  importance: number;
  confidence: number;
  source_context: ContextKey | null;
  due: Timestamp | null;
  /** Who told her (`remember`, or the speaker a fact was heard from). */
  source?: MemorySource | null;
  /**
   * Whether she lived it or was told it. `unknown` is only for memories whose provenance was
   * lost (migrated records, and merges of them): a writer that knows says which.
   */
  origin: MemoryOrigin;
  /** EventLog ids (or `msg:<id>` of a chat line) the memory comes from. */
  source_events?: readonly string[];
}

/** Why a memory was not stored. */
export type Refusal =
  /** Nothing to store. */
  | "empty"
  /** It says what is happening right now: the state machine answers that, not memory. */
  | "present_state"
  /** A fact that nothing said backs: it is not part of her past. */
  | "no_evidence";

/** What `MemoryEngine.store` did. */
export type Stored =
  | { type: "inserted"; id: string }
  /** A near-identical record was updated in place (confidence raised). */
  | { type: "reinforced"; id: string }
  /** A similar record was replaced by a new one. */
  | { type: "superseded"; old: string; new: string }
  /** Nothing was written. */
  | { type: "refused"; reason: Refusal };

/** The id of the record that now holds the memory (throws for a refused one). */
export function storedId(stored: Stored): string {
  if (stored.type === "refused") throw new MemoryError(`memory refused: ${stored.reason}`);
  return stored.type === "superseded" ? stored.new : stored.id;
}

/** Ordered by how sure a claim of having been there is. */
const ORIGIN_RANK: Record<MemoryOrigin, number> = { experienced: 2, told: 1, unknown: 0 };

/** The surer of two origins (the same thing learned again keeps the better provenance). */
export function strongerOrigin(a: MemoryOrigin, b: MemoryOrigin): MemoryOrigin {
  return ORIGIN_RANK[a] >= ORIGIN_RANK[b] ? a : b;
}

/** The less sure of two origins (notes merged into one claim no more than the weakest says). */
export function weakerOrigin(a: MemoryOrigin, b: MemoryOrigin): MemoryOrigin {
  return ORIGIN_RANK[a] <= ORIGIN_RANK[b] ? a : b;
}

/** A recalled record with its final score. */
export interface Recalled {
  record: MemoryRecord;
  score: number;
}

/** A search result (`MemoryEngine.search`): the final score and the match scores behind it. */
export interface Searched extends Recalled {
  /** The backend's full-text relevance, 0 when it did not match the text. */
  text_score: number;
  /** Cosine similarity, `null` when no vectors were compared. */
  vector_score: number | null;
}

/**
 * The turn around the line being answered (v4 §5.4). 2026-11-10: the query was only the line
 * itself and needed a shared word, so a reply like "好啊" recalled nothing at all.
 */
export interface TurnQuery {
  /** The lines before the one answered, joined: they count `context_weight` of the line. */
  context?: string;
  /**
   * The people she is talking with: their `person_points` most important memories may come back
   * without a shared word. People named in the line or the context are added by the engine.
   */
  people?: readonly PersonId[];
}

/** What `MemoryEngine.#twin` compares of a followup (a stored one, or one being written). */
type FollowupLike = Pick<
  MemoryRecord,
  "subjects" | "content" | "done" | "source_context" | "created_at" | "updated_at" | "superseded_by"
>;

/** Score of the text signal given to a person's key memory found without a shared word. */
const POINT_TEXT = 0.3;

/** Candidate selection and ranking options shared by `recall` and `search`. */
interface RankOptions {
  /** Keep followups already brought up. */
  includeDone: boolean;
  /** Drop records scoring below this; `null` keeps every candidate. */
  minScore: number | null;
  /**
   * Recall for a turn (not browsing): records expired by their own lifetime are left out, a
   * memory found only through a present person needs a real match, and a gag recalled too
   * often is down-weighted.
   */
  forTurn: boolean;
  turn?: TurnQuery;
}

export interface ConsolidationReport {
  /** New log lines read. */
  lines: number;
  inserted: number;
  reinforced: number;
  superseded: number;
  /** Extracted items dropped (malformed or trivial). */
  skipped: number;
  /** Items left out because they say what is happening right now. */
  refusedState: number;
  /** Facts and notes left out because no line said to back them. */
  refusedEvidence: number;
  /**
   * Followups closed: ones the conversation asked or answered, and those about the same person
   * and matter (`followups.ts`).
   */
  closed: number;
  /** The summarizer's answer was not usable JSON (lines are skipped). */
  malformed: boolean;
}

/** What `MemoryEngine.forget` removed. */
export interface ForgetReport {
  /** Records deleted, `about` and `derived` together. */
  deleted: number;
  /** About the person: their subject, their person scope, their DM. */
  about: number;
  /** Told by their account, or resting on an EventLog event of theirs. */
  derived: number;
  /** Records resting on events the log no longer holds, so nothing tied them to the person. */
  unverified: number;
}

export interface MaintenanceReport {
  pruned: number;
  decayed: number;
  forgotten: number;
  /** Notes that went stale (present-tense states past their lifetime) and were deleted. */
  expired: number;
}

/** Someone who spoke in the lines being consolidated. */
interface Speaker {
  account: AccountRef;
  names: string[];
  person: PersonId | null;
}

export interface MemoryEngineOptions {
  embedder?: Embedder;
  people?: PeopleStore | null;
  messages?: MessageLog | null;
  settings?: SettingsStore | null;
  router?: LlmRouter | null;
  /** The EventLog: where evidence is checked and found. `attach` fills it in later. */
  events?: EventReader | null;
  /** Stable names of people, to tell whose events are whose. `attach` fills it in later. */
  handles?: HandleDirectory | null;
  /** Source of "now" for writes without an explicit time (`markDone`). */
  clock?: Clock;
}

/** A `MemoryFilter` with everything unset except `limit` and the given fields. */
export function memoryFilter(limit: number, fields: Partial<MemoryFilter> = {}): MemoryFilter {
  return {
    subject: null,
    scope: null,
    kind: null,
    before: null,
    include_superseded: false,
    ...fields,
    limit,
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ms = timestampMs;

/**
 * A fact or note written before present-tense states were kept out of memory (`正在下載`):
 * not brought up, whether or not maintenance has got to it yet.
 */
function staleState(record: MemoryRecord): boolean {
  return (record.kind === "fact" || record.kind === "self_note") && isPresentState(record.content);
}

/**
 * Cosine between `query` and a record's stored vector, read without decoding `record.embedding`
 * (which costs about a millisecond per thousand dimensions); null when the record has none.
 */
function recordCosine(query: readonly number[], record: MemoryRecord): number | null {
  const stored = embeddingValues(record);
  return stored === null ? null : cosine(query, stored);
}

function sortedUnique(ids: readonly PersonId[]): PersonId[] {
  return [...new Set(ids)].sort();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Statuses a provider answers with when it does not support `json_mode`. */
const JSON_MODE_REJECTED: ReadonlySet<number> = new Set([400, 415, 422]);

/** The extraction request again with the unusable reply and a short corrective instruction. */
function retryRequest(request: ChatRequest, response: ChatResponse): ChatRequest {
  const cut = response.finish_reason === "length";
  const note = cut
    ? "上一個回覆太長,寫到一半被截斷了。請寫得精簡一點,只回傳一個完整的 JSON 物件。"
    : "上一個回覆不是可用的 JSON。請只回傳一個 JSON 物件,不要加其他文字或程式碼區塊。";
  return {
    ...request,
    max_tokens:
      cut && typeof request.max_tokens === "number" ? request.max_tokens * 2 : request.max_tokens,
    messages: [
      ...request.messages,
      assistantMessage([...response.text].slice(0, 2000).join("")),
      userMessage(note),
    ],
  };
}

/** Long-term memory of one profile. */
export class MemoryEngine implements FollowupSource {
  readonly profile: ProfileId;
  readonly config: MemoryConfig;
  readonly records: MemoryRecordStore;
  readonly embedder: Embedder;
  readonly #people: PeopleStore | null;
  readonly #messages: MessageLog | null;
  readonly #settings: SettingsStore | null;
  readonly #router: LlmRouter | null;
  #events: EventReader | null;
  #handles: HandleDirectory | null;
  readonly #clock: Clock;
  readonly #watermarks = new Map<string, Watermark>();
  /** Contexts whose last batch was unusable and is being carried over once (key → true). */
  readonly #carried = new Set<string>();
  readonly #repeats: RepeatDamper;
  /** Messages she was asked not to remember: nothing derived from them is used or kept. */
  readonly exclusions = new ExclusionList();
  #lastMaintenance: Timestamp | null = null;
  #version = 0;

  constructor(
    profile: ProfileId,
    config: MemoryConfig,
    records: MemoryRecordStore,
    options: MemoryEngineOptions = {},
  ) {
    this.profile = profile;
    this.config = config;
    this.records = records;
    this.embedder = options.embedder ?? new NoEmbedder();
    this.#people = options.people ?? null;
    this.#messages = options.messages ?? null;
    this.#settings = options.settings ?? null;
    this.#router = options.router ?? null;
    this.#events = options.events ?? null;
    this.#handles = options.handles ?? null;
    this.#clock = options.clock ?? systemClock;
    this.#repeats = new RepeatDamper(config.repeat);
  }

  /**
   * Picks up the EventLog and the handle directory from `services` if the engine has none yet
   * (modules start in an order the engine must not depend on). Cheap: called on every tick.
   */
  attach(services: ServiceLookup): void {
    this.#events ??= services.get(EventLogKey) ?? null;
    this.#handles ??= services.get(HandleDirectoryKey) ?? null;
  }

  /** The EventLog evidence is checked against, when there is one. */
  get events(): EventReader | null {
    return this.#events;
  }

  /** The settings store (watermarks; her notebook keeps its pages there too). */
  get settings(): SettingsStore | null {
    return this.#settings;
  }

  /** The handle directory, when there is one. */
  get handles(): HandleDirectory | null {
    return this.#handles;
  }

  /** Every handle and whose it is (for `noteAbout`). */
  #knownNames(): NamedPerson[] {
    return (this.#handles?.list() ?? []).map((h) => ({ name: h.handle, person: h.person }));
  }

  /**
   * Gives vectors to up to `limit` records stored without one (written before embeddings were on,
   * or while the embedder was down), newest first. Returns how many got one.
   */
  async backfillEmbeddings(limit: number, signal?: AbortSignal): Promise<number> {
    if (!this.embedder.enabled || limit === 0) return 0;
    const rows = await this.records.list(this.profile, memoryFilter(Math.max(limit * 4, 100)));
    const missing = rows.filter((r) => r.embedding === null).slice(0, limit);
    if (missing.length === 0) return 0;
    let vectors: number[][];
    try {
      vectors = await this.embedder.embed(
        missing.map((r) => r.content),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn({ embedder: this.embedder.name, error: errorMessage(error) }, "backfill failed");
      return 0;
    }
    let done = 0;
    for (const [i, record] of missing.entries()) {
      const v = vectors[i];
      if (!v || v.length === 0) continue;
      await this.records.upsert({ ...record, embedding: v });
      done++;
    }
    return done;
  }

  /** Bumped by every write that can change what is pinned, so cached lines know to go stale. */
  get version(): number {
    return this.#version;
  }

  /** The name she uses for a person (their handle), when she has seen one of their accounts. */
  async nameOfPerson(person: PersonId): Promise<string | null> {
    const handle = this.#handles?.ofPerson(person);
    if (handle) return handle;
    if (!this.#people) return null;
    try {
      return (await this.#people.all()).find((p) => p.id === person)?.display_name ?? null;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "person lookup failed");
      return null;
    }
  }

  /**
   * Followups still open that may be shown in `scopes`, soonest first: her open commitments. One
   * that became due longer than `followup_max_age_hours` ago was dropped by the same rule as
   * `due`, so it is not listed either.
   */
  async openCommitments(
    scopes: readonly MemoryScope[],
    now: Timestamp,
    limit: number,
  ): Promise<MemoryRecord[]> {
    if (limit === 0) return [];
    const hours = this.config.followup_max_age_hours;
    const oldest = hours > 0 ? ms(now) - hours * 3_600_000 : null;
    const open = await this.records.list(this.profile, memoryFilter(500, { kind: "followup" }));
    return open
      .filter(
        (r) =>
          !r.done &&
          hasScope(scopes, r.scope) &&
          (oldest === null || r.due === null || ms(r.due) >= oldest),
      )
      .sort((a, b) => ms(a.due ?? a.created_at) - ms(b.due ?? b.created_at))
      .slice(0, limit);
  }

  /**
   * What she holds about a person that may be shown in `scopes`, the most reliable first
   * (confidence after fading, then importance). Present-tense states and expired notes are not
   * among them. One indexed read: nothing is searched.
   */
  async factsAbout(
    person: PersonId,
    scopes: readonly MemoryScope[],
    now: Timestamp,
    limit: number,
  ): Promise<MemoryRecord[]> {
    if (limit === 0) return [];
    const rows = await this.records.list(
      this.profile,
      memoryFilter(200, { subject: person, kind: "fact" }),
    );
    const rank = (r: MemoryRecord) =>
      effectiveConfidence(this.config, r, now) * (0.5 + r.importance);
    return rows
      .filter((r) => hasScope(scopes, r.scope) && !expired(r, now) && !staleState(r))
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, limit);
  }

  /** Whether consolidation can run (message log and LLM router present). */
  get canConsolidate(): boolean {
    return this.#messages !== null && this.#router !== null;
  }

  /** The name she knows an account by (its person's display name), when known. */
  async nameOf(account: AccountRef): Promise<string | null> {
    if (!this.#people) return null;
    try {
      const person = await this.#people.personByAccount(account);
      if (!person) return null;
      const own = person.accounts.find(
        (a) => a.account.platform === account.platform && a.account.id === account.id,
      );
      return own?.display_name ?? person.display_name;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "person lookup failed");
      return null;
    }
  }

  /** The person an account belongs to, when a people store is available. */
  async personOf(account: AccountRef): Promise<PersonId | null> {
    if (!this.#people) return null;
    try {
      return (await this.#people.personByAccount(account))?.id ?? null;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "person lookup failed");
      return null;
    }
  }

  /** `query`: a search, which some models embed differently from what is stored (`embedQuery`). */
  async #embedOne(text: string, signal?: AbortSignal, query = false): Promise<number[] | null> {
    if (!this.embedder.enabled || text.trim() === "") return null;
    try {
      const embedder = this.embedder;
      const v =
        query && embedder.embedQuery !== undefined
          ? await embedder.embedQuery([text], signal)
          : await embedder.embed([text], signal);
      const first = v.length === 1 ? v[0] : undefined;
      return first && first.length > 0 ? first : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn({ embedder: this.embedder.name, error: errorMessage(error) }, "embedding failed");
      return null;
    }
  }

  /**
   * Stores a memory, merging it with a near-identical or very similar existing record of the
   * same kind, scope and subjects.
   */
  async store(memory: NewMemory, now: Timestamp, signal?: AbortSignal): Promise<Stored> {
    // Memories are kept for good: a per-call code (`u7`) in one would point at someone else
    // later. Resolved from the text itself where it can be, otherwise the sentence is dropped.
    const content = repairHandleText(memory.content.trim())?.trim() ?? "";
    if (content === "") throw new MemoryError("empty memory");
    this.#version += 1;
    // What is happening right now is the state machine's to answer, never long-term memory.
    if ((memory.kind === "fact" || memory.kind === "self_note") && isPresentState(content)) {
      return { type: "refused", reason: "present_state" };
    }
    // A fact nothing said backs is not part of her past (`unknown` is a migrated record).
    const cited = mergeRefs(this.config.evidence.max_events, memory.source_events);
    // What rests on a message she was asked to forget is not evidence; with nothing else
    // behind it, it is not stored at all.
    const evidence = cited.filter((ref) => !this.exclusions.hasRef(ref));
    if (cited.length > 0 && evidence.length === 0) {
      return { type: "refused", reason: "no_evidence" };
    }
    if (memory.kind === "fact" && memory.origin !== "unknown" && evidence.length === 0) {
      return { type: "refused", reason: "no_evidence" };
    }
    const tokens = tokenString(content);
    const embedding = await this.#embedOne(content, signal);
    const subjects = sortedUnique(memory.subjects);

    const queryTokens = tokens.split(" ").filter((t) => t !== "");
    const hits =
      queryTokens.length === 0 && embedding === null
        ? []
        : await this.records.search({
            profile: this.profile,
            scopes: [memory.scope],
            kinds: [memory.kind],
            tokens: queryTokens,
            embedding,
            limit: 10,
          });

    const dedupe = this.config.dedupe;
    let identical: [number, MemoryRecord] | null = null;
    let similar: [number, MemoryRecord] | null = null;
    for (const hit of hits) {
      const record = hit.record;
      if (
        !sameList(sortedUnique(record.subjects), subjects) ||
        !scopeEquals(record.scope, memory.scope) ||
        record.superseded_by !== null ||
        record.done
      ) {
        continue;
      }
      const textSim = textSimilarity(record.content, content);
      const vecSim =
        hit.vector_score ?? (embedding !== null ? (recordCosine(embedding, record) ?? 0) : 0);
      if (textSim >= dedupe.text_similarity) {
        if (identical === null || textSim > identical[0]) identical = [textSim, record];
      } else if (vecSim >= dedupe.vector_similarity && (similar === null || vecSim > similar[0])) {
        similar = [vecSim, record];
      }
    }

    if (identical !== null) {
      const old = { ...identical[1] };
      old.content = content;
      old.tokens = tokens;
      if (embedding !== null) old.embedding = embedding;
      if (old.kind !== "followup") {
        old.confidence = clamp01(Math.max(old.confidence, memory.confidence) + dedupe.reinforce);
      }
      old.importance = clamp01(Math.max(old.importance, memory.importance));
      // Said again with a source: the better provenance wins and the evidence adds up.
      old.origin = strongerOrigin(old.origin ?? "unknown", memory.origin);
      old.source_events = mergeRefs(this.config.evidence.max_events, old.source_events, evidence);
      old.source = old.source ?? memory.source ?? null;
      old.updated_at = now;
      // Said again: a state note is true again from now on.
      if (old.kind !== "followup" && memory.due !== null) old.due = memory.due;
      await this.records.upsert(old);
      return { type: "reinforced", id: old.id };
    }

    const record: MemoryRecord = {
      id: newId(),
      profile: this.profile,
      kind: memory.kind,
      scope: memory.scope,
      subjects,
      content,
      tokens,
      embedding,
      importance: clamp01(memory.importance),
      confidence: clamp01(memory.confidence),
      created_at: now,
      updated_at: now,
      last_accessed: null,
      access_count: 0,
      source_context: memory.source_context,
      source: memory.source ?? null,
      origin: memory.origin,
      source_events: evidence,
      due: memory.due,
      done: false,
      superseded_by: null,
    };
    if (similar !== null) {
      const old = { ...similar[1] };
      record.confidence = Math.max(record.confidence, old.confidence);
      record.importance = Math.max(record.importance, old.importance);
      record.access_count = old.access_count;
      record.last_accessed = old.last_accessed;
      await this.records.upsert(record);
      old.superseded_by = record.id;
      await this.records.upsert(old);
      return { type: "superseded", old: old.id, new: record.id };
    }
    await this.records.upsert(record);
    return { type: "inserted", id: record.id };
  }

  /**
   * Hybrid recall among records in `scopes`. Records about `present` people are candidates
   * even without a text or vector match. Recalled records are touched.
   */
  async recall(
    scopes: readonly MemoryScope[],
    present: readonly PersonId[],
    query: string,
    kinds: readonly MemoryKind[],
    limit: number,
    now: Timestamp,
    signal?: AbortSignal,
    turn?: TurnQuery,
  ): Promise<Recalled[]> {
    const ranked = await this.#rank(
      scopes,
      present,
      query,
      kinds,
      limit,
      now,
      {
        includeDone: false,
        minScore: this.config.min_score,
        forTurn: true,
        ...(turn ? { turn } : {}),
      },
      signal,
    );
    this.#repeats.note(ranked.map((r) => r.record.tokens));
    if (ranked.length > 0) {
      try {
        await this.records.touch(
          ranked.map((r) => r.record.id),
          now,
        );
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "touching recalled memories failed");
      }
    }
    return ranked.map(({ record, score }) => ({ record, score }));
  }

  /**
   * Hybrid search for browsing (the admin API): the candidates and score of `recall` with
   * nobody present, but records are not touched, followups already brought up are kept and
   * there is no score threshold. Only records matching the text or the vector are returned.
   */
  async search(
    scopes: readonly MemoryScope[],
    query: string,
    kinds: readonly MemoryKind[],
    limit: number,
    now: Timestamp,
    signal?: AbortSignal,
  ): Promise<Searched[]> {
    return this.#rank(
      scopes,
      [],
      query,
      kinds,
      limit,
      now,
      { includeDone: true, minScore: null, forTurn: false },
      signal,
    );
  }

  async #rank(
    scopes: readonly MemoryScope[],
    present: readonly PersonId[],
    query: string,
    kinds: readonly MemoryKind[],
    limit: number,
    now: Timestamp,
    options: RankOptions,
    signal?: AbortSignal,
  ): Promise<Searched[]> {
    if (limit === 0 || scopes.length === 0) return [];
    const tokens = tokenize(query);
    const context = options.turn?.context?.trim() ?? "";
    const own = new Set(tokens);
    const contextTokens = [...new Set(tokenize(context))].filter((t) => !own.has(t));
    const people = this.#turnPeople(options.turn, `${query}\n${context}`);
    const embedding = await this.#embedOne(
      context === "" ? query : `${query}\n${context}`,
      signal,
      true,
    );
    const known = this.#knownNames();
    const wanted = (r: MemoryRecord) =>
      mayRecall(scopes, r, known) &&
      kinds.includes(r.kind) &&
      r.superseded_by === null &&
      (options.includeDone || !r.done) &&
      !(options.forTurn && (expired(r, now) || staleState(r)));
    const fetch = Math.max(this.config.candidate_limit, limit);

    // id -> (record, backend text score, vector score)
    const candidates = new Map<string, [MemoryRecord, number, number | null]>();
    if (tokens.length + contextTokens.length > 0 || embedding !== null) {
      const hits = await this.records.search({
        profile: this.profile,
        scopes: [...scopes],
        kinds: [...kinds],
        tokens: [...tokens, ...contextTokens],
        embedding,
        limit: fetch,
      });
      for (const hit of hits) {
        if (wanted(hit.record)) {
          candidates.set(hit.record.id, [hit.record, hit.text_score, hit.vector_score]);
        }
      }
    }
    for (const person of [...new Set([...present.slice(0, 16), ...people])]) {
      const records = await this.records.list(
        this.profile,
        memoryFilter(fetch, { subject: person }),
      );
      for (const record of records) {
        if (wanted(record) && !candidates.has(record.id)) {
          candidates.set(record.id, [record, 0, null]);
        }
      }
    }

    let maxText = 0;
    for (const [, t] of candidates.values()) maxText = Math.max(maxText, t);
    const points = options.forTurn
      ? this.#points(
          [...candidates.values()].map(([r]) => r),
          people,
          now,
        )
      : new Set<string>();
    // Only the lines before matched: they count for less than the line itself.
    const backendWeight = tokens.length > 0 ? 1 : this.config.context_weight;
    const ranked: Searched[] = [];
    for (const [record, text, vectorScore] of candidates.values()) {
      const vector = vectorScore ?? (embedding !== null ? recordCosine(embedding, record) : null);
      const backend = maxText > 0 ? (text / maxText) * backendWeight : 0;
      let t = Math.max(
        backend,
        tokenOverlap(tokens, record.tokens),
        this.config.context_weight * tokenOverlap(contextTokens, record.tokens),
      );
      if (t <= 0 && points.has(record.id)) t = POINT_TEXT;
      // Being about someone who is here is not a reason to bring a memory up (and the nearest
      // neighbour of an unrelated query is no match): it has to be about what is being said,
      // by a shared word or a close embedding.
      if (options.forTurn && t <= 0 && (vector ?? 0) < this.config.min_vector) continue;
      const s = signals(this.config, record, vector, t, present, now);
      let score = finalScore(this.config, record, s, now);
      if (options.forTurn) score *= this.#repeats.factor(record.tokens);
      if (options.minScore === null || score >= options.minScore) {
        ranked.push({ record, score, text_score: text, vector_score: vector });
      }
    }
    ranked.sort((a, b) => b.score - a.score || ms(b.record.updated_at) - ms(a.record.updated_at));
    ranked.length = Math.min(ranked.length, limit);
    return ranked;
  }

  /**
   * The people of a turn: the ones she is talking with, and anyone whose handle is named in what
   * is being said (a name is a shared word with every memory about them, however it is worded).
   */
  #turnPeople(turn: TurnQuery | undefined, text: string): PersonId[] {
    const out = new Set<PersonId>(turn?.people ?? []);
    const lower = text.toLowerCase();
    for (const entry of this.#handles?.list() ?? []) {
      if (entry.person === null || out.has(entry.person)) continue;
      const handle = entry.handle.toLowerCase();
      if ([...handle].length >= 2 && lower.includes(handle)) out.add(entry.person);
    }
    return [...out].slice(0, 16);
  }

  /** Each person's `person_points` most important memories among `records` (ids). */
  #points(
    records: readonly MemoryRecord[],
    people: readonly PersonId[],
    now: Timestamp,
  ): Set<string> {
    const out = new Set<string>();
    const n = this.config.person_points;
    if (n === 0) return out;
    const rank = (r: MemoryRecord) =>
      r.importance * (0.5 + 0.5 * effectiveConfidence(this.config, r, now));
    for (const person of people) {
      records
        .filter(
          (r) =>
            r.subjects.includes(person) &&
            (r.kind === "fact" || r.kind === "episode") &&
            r.importance >= this.config.person_point_importance,
        )
        .sort((a, b) => rank(b) - rank(a))
        .slice(0, n)
        .forEach((r) => {
          out.add(r.id);
        });
    }
    return out;
  }

  static watermarkKey(context: ContextKey): string {
    return `${WATERMARK_PREFIX}${contextKeyString(context)}`;
  }

  /** The consolidation watermark of a context. */
  async watermark(context: ContextKey): Promise<Watermark | null> {
    const key = MemoryEngine.watermarkKey(context);
    const cached = this.#watermarks.get(key);
    if (cached) return structuredClone(cached);
    if (!this.#settings) return null;
    let value: JsonValue | null;
    try {
      value = await this.#settings.get(this.profile, key);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "reading memory watermark failed");
      return null;
    }
    const w = parseWatermark(value);
    if (!w) return null;
    this.#watermarks.set(key, w);
    return structuredClone(w);
  }

  async #setWatermark(watermark: Watermark): Promise<void> {
    const key = MemoryEngine.watermarkKey(watermark.context);
    this.#watermarks.set(key, structuredClone(watermark));
    if (!this.#settings) return;
    try {
      await this.#settings.set(this.profile, key, watermarkJson(watermark));
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "persisting memory watermark failed");
    }
  }

  /** Contexts with a persisted watermark (checked for new lines on start). */
  async watermarkedContexts(): Promise<ContextKey[]> {
    if (!this.#settings) return [];
    try {
      const map = await this.#settings.list(this.profile, WATERMARK_PREFIX);
      const out: ContextKey[] = [];
      for (const v of map.values()) {
        const w = parseWatermark(v);
        if (w) out.push(w.context);
      }
      return out;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "listing memory watermarks failed");
      return [];
    }
  }

  /**
   * Consolidates the lines of `context` written after its watermark.
   *
   * LLM failures are thrown (the watermark stays, so it is retried). An unusable answer is
   * asked again once with a corrective note; if that fails too, the lines are carried over to
   * the next pass (watermark stays), and skipped only if that pass fails as well.
   */
  async consolidate(
    context: ContextKey,
    now: Timestamp,
    signal?: AbortSignal,
  ): Promise<ConsolidationReport> {
    const messages = this.#messages;
    const router = this.#router;
    if (!messages || !router) {
      throw new MemoryError("consolidation needs a message log and the LLM router");
    }
    const report: ConsolidationReport = {
      lines: 0,
      inserted: 0,
      reinforced: 0,
      superseded: 0,
      skipped: 0,
      refusedState: 0,
      refusedEvidence: 0,
      closed: 0,
      malformed: false,
    };
    const mark = await this.watermark(context);
    const allLines = (
      await messages.recent(this.profile, context, Math.max(1, this.config.max_lines_per_batch))
    ).filter((e) => mark === null || afterMark(e, mark));
    const last = allLines[allLines.length - 1];
    if (!last) return report;
    report.lines = allLines.length;
    const nextMark: Watermark = { context, ts: last.ts, id: last.id };
    // Lines she was asked not to remember are never shown to the extractor nor cited.
    const linked = await linkLines(this.#events, allLines, this.config.evidence);
    const kept = allLines.filter(
      (e, i) =>
        !this.exclusions.hasLine(context, e.author_name, e.text) &&
        !this.exclusions.hasRef(linked[i]?.ref ?? `${LINE_REF_PREFIX}${e.id}`) &&
        !this.exclusions.hasRef(`${LINE_REF_PREFIX}${e.id}`),
    );
    const evidence = linked.filter((_, i) => kept.includes(allLines[i] as LogEntry));
    const lines = kept;
    if (lines.every((e) => e.is_self || e.text.trim() === "")) {
      await this.#setWatermark(nextMark);
      return report;
    }

    const speakers = await this.#speakers(lines);
    const priv = isPrivate(context);
    const first = speakers[0];
    const dmPartner = priv && speakers.length === 1 && first ? first.account : null;
    // What she still means to ask them: the summarizer says which of it this stretch asked or
    // answered, and words nothing of it anew.
    const pending = await this.#pendingFollowups(context, speakers, dmPartner, now);
    const shown = pending.map((r, i) => ({ label: `f${i + 1}`, about: r.content }));
    const request: ChatRequest = {
      messages: [
        systemMessage(systemPrompt(this.config.self_label)),
        userMessage(
          transcript(lines, this.config.self_label, priv, this.config.utc_offset_minutes) +
            pendingBlock(shown),
        ),
      ],
      temperature: 0.2,
      max_tokens: 4000,
      json_mode: true,
      session: sessionId(this.profile, `memory-${contextHash(context)}`),
    };
    const ask = (req: ChatRequest) =>
      withLlmTag({ module: "memory", label: "extract" }, async () => {
        try {
          return await router.complete(this.config.purpose, req, signal);
        } catch (error) {
          // JSON mode is only a hint: a provider that rejects it gets the request without it.
          if (
            req.json_mode &&
            error instanceof ProviderHttpError &&
            JSON_MODE_REJECTED.has(error.status)
          ) {
            return router.complete(this.config.purpose, { ...req, json_mode: false }, signal);
          }
          throw error;
        }
      });
    const response = await ask(request);
    let extraction: Extraction;
    try {
      extraction = parseExtraction(response.text);
    } catch {
      // One corrective retry; a reply cut off at the token limit gets a bigger budget instead.
      try {
        extraction = parseExtraction((await ask(retryRequest(request, response))).text);
      } catch (second) {
        if (!(second instanceof ExtractionError)) throw second;
        const key = contextKeyString(context);
        const carry = !this.#carried.has(key);
        log.warn(
          { context: key, error: errorMessage(second), carried: carry },
          carry
            ? "unusable consolidation output, keeping lines for the next pass"
            : "unusable consolidation output again, skipping lines",
        );
        report.malformed = true;
        if (carry) {
          this.#carried.add(key);
        } else {
          this.#carried.delete(key);
          await this.#setWatermark(nextMark);
        }
        return report;
      }
    }
    this.#carried.delete(contextKeyString(context));
    await this.#apply(
      extraction,
      context,
      dmPartner,
      speakers,
      evidence,
      now,
      report,
      signal,
      pending,
    );
    await this.#setWatermark(nextMark);
    log.debug({ context: contextKeyString(context), report }, "consolidated");
    return report;
  }

  async #speakers(lines: readonly LogEntry[]): Promise<Speaker[]> {
    const out: Speaker[] = [];
    for (const entry of lines) {
      if (entry.is_self) continue;
      const s = out.find((x) => sameAccount(x.account, entry.author));
      if (s) {
        if (!s.names.includes(entry.author_name)) s.names.push(entry.author_name);
      } else {
        out.push({ account: entry.author, names: [entry.author_name], person: null });
      }
    }
    if (this.#people) {
      for (const speaker of out) {
        try {
          const person = await this.#people.personByAccount(speaker.account);
          if (!person) continue;
          speaker.person = person.id;
          const names = [person.display_name, ...person.accounts.map((a) => a.display_name)];
          for (const name of names) {
            if (name !== "" && !speaker.names.includes(name)) speaker.names.push(name);
          }
        } catch (error) {
          log.warn({ error: errorMessage(error) }, "person lookup failed");
        }
      }
    }
    return out;
  }

  async #apply(
    x: Extraction,
    context: ContextKey,
    dmPartner: AccountRef | null,
    speakers: readonly Speaker[],
    lines: readonly EvidenceLine[],
    now: Timestamp,
    report: ConsolidationReport,
    signal?: AbortSignal,
    pending: readonly MemoryRecord[] = [],
  ): Promise<void> {
    const min = this.config.min_importance;
    const evidence = this.config.evidence;
    report.skipped += x.skipped;
    const everyone = speakers.flatMap((s) => (s.person !== null ? [s.person] : []));
    const scope = (kind: MemoryKind, global: PersonId | null) =>
      scopeForNew(this.config, context, dmPartner, kind, global);
    const items: NewMemory[] = [];
    const base = { source_context: context, due: null };
    const names = nameWords(speakers.flatMap((s) => s.names));
    // A note of hers: global when about her alone, the person's when about one person alone,
    // the server's when about anyone else (`noteAbout`). Its subjects are that one person.
    const known: NamedPerson[] = [
      ...speakers.flatMap((s) => s.names.map((name) => ({ name, person: s.person }))),
      ...this.#knownNames(),
    ];
    const noteOf = (content: string, tagged: PersonId[]) => {
      const where = scopeForNew(
        this.config,
        context,
        dmPartner,
        "self_note",
        null,
        noteAbout(content, tagged, known),
      );
      return { scope: where, subjects: where.type === "person" ? [where.person] : tagged };
    };
    const others = lines.filter((l) => !l.self);

    // The lines backing a statement: among the ones the summarizer cited (else any line in
    // `from`), those sharing enough of its words. Empty: nothing said it.
    const backing = (
      statement: string,
      cited: readonly number[],
      from: readonly EvidenceLine[],
    ) => {
      const picked = cited
        .map((n) => lines[n - 1])
        .filter((l): l is EvidenceLine => l !== undefined && from.includes(l));
      const hit = supporting(statement, picked, evidence, names);
      return hit.length > 0 ? hit : supporting(statement, from, evidence, names);
    };
    const refsOf = (found: readonly EvidenceLine[]) => found.map((l) => l.ref);

    if (x.episode) {
      const ep = x.episode;
      if (ep.importance >= min && repairHandleText(ep.summary) !== null) {
        const emotion = ep.emotion?.trim() ?? "";
        items.push({
          ...base,
          kind: "episode",
          scope: scope("episode", null),
          subjects: [...everyone],
          content:
            emotion !== ""
              ? `${repairHandleText(ep.summary)}(當時我的心情:${emotion})`
              : (repairHandleText(ep.summary) ?? ep.summary),
          importance: ep.importance,
          confidence: 1,
          // She was in the conversation: the lines of this stretch are what she lived.
          origin: "experienced",
          source_events: refsOf(lines),
        });
      } else {
        report.skipped += 1;
      }
    }

    for (const fact of x.facts) {
      if (fact.importance < min || repairHandleText(fact.statement) === null) {
        report.skipped += 1;
        continue;
      }
      if (isStateLifetime(fact.valid_hours, this.config)) {
        report.refusedState += 1;
        continue;
      }
      let kind: MemoryKind = "fact";
      let subjects: PersonId[];
      switch (fact.subject.type) {
        case "myself":
          kind = "self_note";
          subjects = [];
          break;
        case "named":
          subjects = optional(resolveName(fact.subject.name, speakers));
          break;
        case "unknown":
          subjects = mentioned(fact.statement, speakers);
          break;
      }
      // A fact about someone rests on what others said (her own lines prove nothing about
      // them); something about herself rests on any line, her own included.
      const found = backing(fact.statement, fact.lines, kind === "fact" ? others : lines);
      const first = found[0];
      if (!first) {
        report.refusedEvidence += 1;
        continue;
      }
      const global = fact.subject.type === "named" && fact.global ? (subjects[0] ?? null) : null;
      items.push({
        ...base,
        kind,
        ...(kind === "self_note"
          ? noteOf(fact.statement, subjects)
          : { scope: scope(kind, global), subjects }),
        content: fact.statement,
        importance: fact.importance,
        confidence: fact.confidence,
        due: expiryOf(kind, fact.statement, fact.valid_hours, this.config, now),
        // What someone said about a person is what they said; what she says of herself she lived.
        origin: kind === "fact" ? "told" : "experienced",
        source: kind === "fact" ? { account: { ...first.author }, name: first.name } : null,
        source_events: refsOf(found),
      });
    }

    for (const note of x.self_notes) {
      if (note.importance < min || repairHandleText(note.note) === null) {
        report.skipped += 1;
        continue;
      }
      if (isStateLifetime(note.valid_hours, this.config)) {
        report.refusedState += 1;
        continue;
      }
      const found = backing(note.note, note.lines, lines);
      if (found.length === 0) {
        report.refusedEvidence += 1;
        continue;
      }
      items.push({
        ...base,
        kind: "self_note",
        ...noteOf(note.note, mentioned(note.note, speakers)),
        content: note.note,
        importance: note.importance,
        confidence: 1,
        due: expiryOf("self_note", note.note, note.valid_hours, this.config, now),
        origin: "experienced",
        source_events: refsOf(found),
      });
    }

    // What this stretch asked or answered is closed, with whatever else holds the same question
    // about them, before anything new is written: answered just now, it is not asked again.
    const allNames = speakers.flatMap((s) => s.names);
    for (const label of x.answered_followups) {
      const record = pending[Number(label.slice(1)) - 1];
      if (record) report.closed += await this.#closeFollowup(record, now, allNames);
    }
    // In a DM "問他" is the one person there.
    const partner = dmPartner === null ? null : (speakers[0]?.person ?? null);
    let asked: FollowupLike[] | null = null;
    for (const f of x.followups) {
      if (repairHandleText(f.about) === null) {
        report.skipped += 1;
        continue;
      }
      const same = f.same_as === null ? undefined : pending[Number(f.same_as.slice(1)) - 1];
      if (same) {
        report.reinforced += 1;
        continue;
      }
      let subjects: PersonId[];
      switch (f.subject.type) {
        case "named":
          subjects = optional(resolveName(f.subject.name, speakers));
          break;
        case "myself":
          subjects = [];
          break;
        case "unknown":
          subjects = mentioned(f.about, speakers);
          break;
      }
      if (subjects.length === 0 && f.subject.type !== "myself" && partner !== null) {
        subjects = [partner];
      }
      // Reworded, the same question is not a new one: one still open holds it, and one asked or
      // answered lately means it was asked.
      asked ??= await this.#followups();
      const twin = this.#twin(asked, subjects, f.about, context, allNames, now);
      if (twin !== null) {
        if (twin.done) report.skipped += 1;
        else report.reinforced += 1;
        continue;
      }
      const minutes = Math.round(f.due_in_hours * 60);
      items.push({
        kind: "followup",
        scope: scope("followup", null),
        subjects,
        content: f.about,
        importance: 0.5,
        confidence: 1,
        source_context: context,
        due: toTimestamp(ms(now) + minutes * MINUTE_MS),
        origin: "experienced",
        source_events: refsOf(supporting(f.about, lines, evidence, names)),
      });
      // Said twice in one answer is still one question.
      asked.unshift({
        subjects,
        content: f.about,
        done: false,
        source_context: context,
        created_at: now,
        updated_at: now,
        superseded_by: null,
      });
    }

    for (const item of items) {
      const stored = await this.store(item, now, signal);
      if (stored.type === "inserted") report.inserted += 1;
      else if (stored.type === "reinforced") report.reinforced += 1;
      else if (stored.type === "superseded") report.superseded += 1;
      else if (stored.reason === "present_state") report.refusedState += 1;
      else report.refusedEvidence += 1;
    }
  }

  /**
   * Daily forgetting: prunes stale unimportant episodes and deletes facts that faded away
   * (`decayed` counts the ones still fading: decay itself happens on read).
   */
  async maintain(now: Timestamp): Promise<MaintenanceReport> {
    const f = this.config.forgetting;
    const nowMs = ms(now);
    const report: MaintenanceReport = {
      pruned: await this.records.prune(this.profile, {
        created_before: toTimestamp(nowMs - f.episode_max_age_days * DAY_MS),
        max_importance: f.episode_max_importance,
        not_accessed_since: toTimestamp(nowMs - f.episode_not_accessed_days * DAY_MS),
      }),
      decayed: 0,
      forgotten: 0,
      expired: await this.#expireStates(now),
    };

    this.#version += 1;
    // Confidence fades when it is read (`fadedConfidence`); the stored value is left alone, so
    // reinforcing a fact starts it over. All that is left to do is to delete what faded away.
    let before: Timestamp | null = null;
    for (;;) {
      const page = await this.records.list(
        this.profile,
        memoryFilter(500, { kind: "fact", before }),
      );
      const oldest = page[page.length - 1];
      if (!oldest) break;
      const nextBefore = oldest.created_at;
      const full = page.length === 500;
      for (const record of page) {
        const confidence = fadedConfidence(this.config, record, now);
        if (confidence < f.forget_below_confidence) {
          if (await this.records.delete(record.id)) report.forgotten += 1;
        } else if (confidence < record.confidence) {
          report.decayed += 1;
        }
      }
      if (!full || (before !== null && ms(before) === ms(nextBefore))) break;
      before = nextBefore;
    }
    await this.#setLastMaintenance(now);
    return report;
  }

  /**
   * Gives notes written before lifetimes existed ("已經開台", "正在下載") the one their wording
   * implies, counted from when they were last written, and deletes notes that went stale more
   * than a week ago. Returns how many were deleted.
   */
  async #expireStates(now: Timestamp): Promise<number> {
    const nowMs = ms(now);
    let deleted = 0;
    for (const kind of ["fact", "self_note"] as const) {
      let before: Timestamp | null = null;
      for (;;) {
        const page = await this.records.list(this.profile, memoryFilter(500, { kind, before }));
        const oldest = page[page.length - 1];
        if (!oldest) break;
        for (const record of page) {
          let due = record.due;
          if (due === null) {
            const hours = wordingTtlHours(record.content, this.config);
            if (hours === null) continue;
            due = toTimestamp(ms(record.updated_at) + hours * 3_600_000);
            if (ms(due) > nowMs) {
              await this.records.upsert({ ...record, due });
              continue;
            }
          }
          if (nowMs - ms(due) >= 7 * DAY_MS) {
            if (await this.records.delete(record.id)) deleted += 1;
          } else if (due !== record.due) {
            await this.records.upsert({ ...record, due });
          }
        }
        const full = page.length === 500;
        if (!full || (before !== null && ms(before) === ms(oldest.created_at))) break;
        before = oldest.created_at;
      }
    }
    return deleted;
  }

  /** When maintenance last ran (memory first, then settings). */
  async lastMaintenanceRun(): Promise<Timestamp | null> {
    if (this.#lastMaintenance !== null) return this.#lastMaintenance;
    if (!this.#settings) return null;
    let value: JsonValue | null;
    try {
      value = await this.#settings.get(this.profile, MAINTENANCE_KEY);
    } catch {
      return null;
    }
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
    this.#lastMaintenance = value;
    return value;
  }

  async #setLastMaintenance(at: Timestamp): Promise<void> {
    this.#lastMaintenance = at;
    if (!this.#settings) return;
    try {
      await this.#settings.set(this.profile, MAINTENANCE_KEY, at);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "persisting maintenance time failed");
    }
  }

  /** Every record about this person or from the DM with this account, newest first. */
  async memoriesOf(
    person: PersonId | null,
    account: AccountRef,
    includeSuperseded: boolean,
  ): Promise<MemoryRecord[]> {
    const out: MemoryRecord[] = [];
    const filters: MemoryFilter[] = [
      memoryFilter(10_000, {
        scope: { type: "dm", account },
        include_superseded: includeSuperseded,
      }),
    ];
    if (person !== null) {
      filters.push(
        memoryFilter(10_000, { subject: person, include_superseded: includeSuperseded }),
        memoryFilter(10_000, {
          scope: { type: "person", person },
          include_superseded: includeSuperseded,
        }),
      );
    }
    const seen = new Set<string>();
    for (const filter of filters) {
      for (const record of await this.records.list(this.profile, filter)) {
        if (!seen.has(record.id)) {
          seen.add(record.id);
          out.push(record);
        }
      }
    }
    out.sort(
      (a, b) => ms(b.created_at) - ms(a.created_at) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0),
    );
    return out;
  }

  /**
   * What this person just said in `context`, from the EventLog (newest last): the lines a note
   * they ask her to keep must rest on. `null` when there is no EventLog to ask.
   */
  async heard(
    context: ContextKey,
    account: AccountRef,
    now: Timestamp,
    limit = 60,
  ): Promise<EvidenceLine[] | null> {
    const events = this.#events;
    if (!events) return null;
    const identities = await this.#identities(await this.personOf(account), account);
    if (identities.size === 0) return [];
    let found: LogEvent[] = [];
    try {
      found = await events.query({
        kinds: ["observation"],
        context,
        since: toTimestamp(ms(now) - 6 * 3_600_000),
        order: "desc",
        limit,
      });
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "reading recent speech failed");
      return [];
    }
    const name = (await this.nameOf(account)) ?? account.id;
    return found
      .filter((e) => e.person !== null && identities.has(e.person))
      .reverse()
      .flatMap((e) => {
        const summary = summaryOf(e);
        if (summary === null) return [];
        return [
          {
            ref: e.id,
            text: summary.replace(/^[^:：]*[:：]/, ""),
            author: account,
            name,
            self: false,
          },
        ];
      });
  }

  /**
   * Who a person is in the EventLog: their handles (and, with no handle directory, the names
   * they went by). An event is theirs when its `person` is one of these.
   */
  async #identities(person: PersonId | null, account: AccountRef): Promise<Set<string>> {
    const out = new Set<string>();
    let accounts: AccountRef[] = [account];
    let names: string[] = [];
    if (this.#people) {
      try {
        const found = await this.#people.personByAccount(account);
        if (found) {
          accounts = [account, ...found.accounts.map((a) => a.account)];
          names = [found.display_name, ...found.accounts.map((a) => a.display_name)];
        }
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "person lookup failed");
      }
    }
    const handles = this.#handles;
    if (handles) {
      for (const entry of handles.list()) {
        const owner = entry.account;
        const mine =
          (person !== null && entry.person === person) ||
          (owner !== null && accounts.some((a) => sameAccount(a, owner)));
        if (mine) out.add(entry.handle);
      }
      const own = person === null ? null : handles.ofPerson(person);
      if (own !== null) out.add(own);
    }
    // Without a handle the log names people by display name (`BusFacts`).
    if (out.size === 0) for (const name of names) if (name !== "") out.add(name);
    return out;
  }

  /**
   * Records derived from what this person said: told by their account, or resting on an
   * EventLog event of theirs. Those about them (`memoriesOf`) are not repeated. `unverified`
   * counts records resting on events the log no longer holds (compacted away): nothing ties
   * those to anyone any more.
   */
  async derivedFrom(
    person: PersonId | null,
    account: AccountRef,
    skip: ReadonlySet<string>,
  ): Promise<{ records: MemoryRecord[]; unverified: number }> {
    const identities = await this.#identities(person, account);
    const events = this.#events;
    const cache = new Map<string, boolean | null>();
    const theirs = async (ref: string): Promise<boolean | null> => {
      if (!events || !isEventRef(ref) || identities.size === 0) return null;
      if (cache.has(ref)) return cache.get(ref) ?? null;
      let result: boolean | null = null;
      try {
        const event = await events.get(ref);
        if (event) result = event.person !== null && identities.has(event.person);
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "event lookup failed");
      }
      cache.set(ref, result);
      return result;
    };
    const out: MemoryRecord[] = [];
    let unverified = 0;
    let before: Timestamp | null = null;
    for (;;) {
      const page = await this.records.list(
        this.profile,
        memoryFilter(500, { before, include_superseded: true }),
      );
      const oldest = page[page.length - 1];
      if (!oldest) break;
      for (const record of page) {
        if (skip.has(record.id)) continue;
        if (record.source && sameAccount(record.source.account, account)) {
          out.push(record);
          continue;
        }
        let hit = false;
        let lost = false;
        for (const ref of record.source_events ?? []) {
          const mine = await theirs(ref);
          if (mine === true) {
            hit = true;
            break;
          }
          if (mine === null && isEventRef(ref)) lost = true;
        }
        if (hit) out.push(record);
        else if (lost) unverified += 1;
      }
      if (page.length < 500 || (before !== null && ms(before) === ms(oldest.created_at))) break;
      before = oldest.created_at;
    }
    return { records: out, unverified };
  }

  /**
   * Forgets what she has of this person: the memories about them, the ones told by their
   * account and the ones derived from their events; with a `keyword` only those matching it.
   * The EventLog and the chat history stay: they are the evidence, wiped on their own.
   */
  async forget(
    person: PersonId | null,
    account: AccountRef,
    keyword: string | null,
  ): Promise<ForgetReport> {
    const report: ForgetReport = { deleted: 0, about: 0, derived: 0, unverified: 0 };
    this.#version += 1;
    const own = await this.memoriesOf(person, account, true);
    const ownIds = new Set(own.map((r) => r.id));
    const derived = await this.derivedFrom(person, account, ownIds);
    report.unverified = derived.unverified;
    const wanted = (r: MemoryRecord) => keyword === null || matchesKeyword(r, keyword);
    for (const record of own) {
      if (wanted(record) && (await this.records.delete(record.id))) report.about += 1;
    }
    for (const record of derived.records) {
      if (wanted(record) && (await this.records.delete(record.id))) report.derived += 1;
    }
    if (keyword === null && person !== null) {
      report.about += await this.records.deleteBySubject(this.profile, person);
    }
    report.deleted = report.about + report.derived;
    return report;
  }

  // ---- messages she was asked not to remember ---------------------------------------------

  /** Reads the stored list; called once at start. */
  async loadExclusions(): Promise<void> {
    if (!this.#settings) return;
    try {
      this.exclusions.load(await this.#settings.get(this.profile, EXCLUDED_KEY));
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot read the list of excluded messages");
    }
  }

  /**
   * A message was excluded: finds what stands for it in the EventLog and the chat log, keeps
   * that (bounded, persisted), and takes it out of what is already derived. A memory resting
   * on this message alone is deleted; one with other evidence stays and loses only this
   * reference. Records that name no evidence cannot be tied to the message and stay.
   */
  async excludeMessage(excluded: MessageExcluded): Promise<{ deleted: number; trimmed: number }> {
    const platform = excluded.message.context.platform;
    const key = messageKey(platform, excluded.message.id);
    const refs: string[] = [];
    const hashes: string[] = [];
    if (this.#events) {
      try {
        const found = await this.#events.query({
          kinds: ["observation"],
          attention_key: key,
          limit: 10,
        });
        for (const event of found) {
          refs.push(event.id);
          const summary = summaryOf(event);
          if (summary !== null && !summary.endsWith(":(略過)")) hashes.push(lineHash(summary));
        }
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "cannot look up the excluded message's event");
      }
    }
    if (this.#messages && hashes.length > 0) {
      try {
        const lines = await this.#messages.recent(this.profile, excluded.context, 500);
        for (const line of lines) {
          if (hashes.includes(lineHash(`${line.author_name}:${line.text}`))) {
            refs.push(`${LINE_REF_PREFIX}${line.id}`);
          }
        }
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "cannot look up the excluded message's line");
      }
    }
    this.exclusions.add({
      c: contextKeyString(excluded.context),
      key,
      refs,
      hashes,
      at: Date.parse(excluded.at) || this.#clock.now(),
    });
    this.#version += 1;
    if (this.#settings) {
      try {
        await this.#settings.set(
          this.profile,
          EXCLUDED_KEY,
          this.exclusions.toJSON() as unknown as JsonValue,
        );
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "cannot save the list of excluded messages");
      }
    }
    return this.#unlearn(new Set(refs));
  }

  /** Drops `refs` from the evidence of every record; a record left with none is deleted. */
  async #unlearn(refs: ReadonlySet<string>): Promise<{ deleted: number; trimmed: number }> {
    const out = { deleted: 0, trimmed: 0 };
    if (refs.size === 0) return out;
    let before: Timestamp | null = null;
    for (;;) {
      const page = await this.records.list(
        this.profile,
        memoryFilter(500, { before, include_superseded: true }),
      );
      const oldest = page[page.length - 1];
      if (!oldest) break;
      for (const record of page) {
        const evidence = record.source_events ?? [];
        if (!evidence.some((r) => refs.has(r))) continue;
        const rest = evidence.filter((r) => !refs.has(r));
        if (rest.length === 0) {
          if (await this.records.delete(record.id)) out.deleted += 1;
        } else {
          await this.records.upsert({ ...record, source_events: rest });
          out.trimmed += 1;
        }
      }
      if (page.length < 500 || (before !== null && ms(before) === ms(oldest.created_at))) break;
      before = oldest.created_at;
    }
    return out;
  }

  // ---- FollowupSource ------------------------------------------------------------------

  /**
   * Followups due now, newest first. One nobody brought up within `followup_max_age_hours` of
   * its time is closed instead of offered (a question about "tomorrow's exam" a week later is
   * noise, and 181 of them were still open).
   */
  async due(profile: ProfileId, now: Timestamp): Promise<Followup[]> {
    const hours = this.config.followup_max_age_hours;
    const maxAgeMs = hours > 0 ? hours * 3_600_000 : null;
    if (maxAgeMs !== null) {
      try {
        await this.records.expireFollowups(profile, toTimestamp(ms(now) - maxAgeMs));
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "closing stale followups failed");
      }
    }
    return (await this.records.dueFollowups(profile, now, maxAgeMs)).map(toFollowup);
  }

  async markDone(id: string): Promise<void> {
    if (!isUlid(id.toUpperCase())) {
      throw new MemoryError(`invalid followup id \`${id}\`: not a ULID`);
    }
    const record = await this.records.get(id);
    if (!record) throw new MemoryError(`unknown followup \`${id}\``);
    if (record.kind !== "followup") throw new MemoryError(`memory \`${id}\` is not a followup`);
    // Brought up: what else holds the same question about them is closed with it.
    await this.#closeFollowup(record, toTimestamp(this.#clock.now()));
  }

  /**
   * Closes `record` and the open followups about the same person and matter (`sameMatter`),
   * whatever their wording, scope or place: one question asked or answered is all of them
   * (2026-11-10: answered in a DM, still asked seven times in the channel). A followup that names
   * nobody is taken to be about anyone. Returns how many were closed.
   */
  async #closeFollowup(
    record: MemoryRecord,
    now: Timestamp,
    names: readonly string[] = [],
  ): Promise<number> {
    let closed = 0;
    if (!record.done) {
      await this.records.upsert({ ...record, done: true, updated_at: now });
      closed += 1;
    }
    const words = [...names, ...(await this.#namesOf(record.subjects))];
    for (const r of await this.#followups()) {
      if (r.id === record.id || r.done || r.superseded_by !== null) continue;
      const together =
        r.subjects.length === 0 ||
        record.subjects.length === 0 ||
        r.subjects.some((p) => record.subjects.includes(p));
      if (!together || !sameMatter(record.content, r.content, words)) continue;
      try {
        await this.records.upsert({ ...r, done: true, updated_at: now });
        closed += 1;
      } catch (error) {
        log.warn({ id: r.id, error: errorMessage(error) }, "closing a followup failed");
      }
    }
    if (closed > 0) this.#version += 1;
    return closed;
  }

  /** The latest followups, newest first (empty when the store fails). */
  async #followups(): Promise<MemoryRecord[]> {
    try {
      return await this.records.list(
        this.profile,
        memoryFilter(FOLLOWUP_WINDOW, { kind: "followup" }),
      );
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "reading followups failed");
      return [];
    }
  }

  /** Names of `people`, which say nothing about what a followup about them asks. */
  async #namesOf(people: readonly PersonId[]): Promise<string[]> {
    const out: string[] = [];
    for (const person of people) {
      const name = await this.nameOfPerson(person);
      if (name !== null) out.push(name);
    }
    return out;
  }

  /**
   * The followup among `known` that already holds one about `subjects` asking `about`: one still
   * open, or one brought up or answered within `followup_repeat_hours` (one that closed only
   * because nobody brought it up in time does not count). They are about the same people when
   * they share one, or name nobody and come from the same place.
   */
  #twin(
    known: readonly FollowupLike[],
    subjects: readonly PersonId[],
    about: string,
    context: ContextKey,
    names: readonly string[],
    now: Timestamp,
  ): FollowupLike | null {
    const repeatMs = this.config.followup_repeat_hours * HOUR_MS;
    for (const r of known) {
      if (r.superseded_by !== null) continue;
      if (r.done) {
        const touched = ms(r.updated_at) > ms(r.created_at);
        if (repeatMs <= 0 || !touched || ms(now) - ms(r.updated_at) > repeatMs) continue;
      }
      const same =
        subjects.length > 0 && r.subjects.length > 0
          ? r.subjects.some((p) => subjects.includes(p))
          : r.source_context !== null && contextKeyEquals(r.source_context, context);
      if (same && sameMatter(r.content, about, names)) return r;
    }
    return null;
  }

  /**
   * Open followups about the people of a stretch of conversation that may be shown there (a DM
   * sees what may be shown to its one person), newest first; ones that name nobody count when
   * they come from the same place. Shown to the summarizer as `f1`, `f2`, ….
   */
  async #pendingFollowups(
    context: ContextKey,
    speakers: readonly Speaker[],
    dmPartner: AccountRef | null,
    now: Timestamp,
  ): Promise<MemoryRecord[]> {
    const persons = speakers.flatMap((s) => (s.person !== null ? [s.person] : []));
    const scopes = visibleScopes(
      context,
      speakers.map((s) => s.account),
      persons,
    );
    const hours = this.config.followup_max_age_hours;
    const oldest = hours > 0 ? ms(now) - hours * HOUR_MS : null;
    const partner = dmPartner === null ? null : (speakers[0]?.person ?? null);
    const shown = (r: MemoryRecord): boolean => {
      if (r.subjects.length === 0) {
        return r.source_context !== null && contextKeyEquals(r.source_context, context);
      }
      if (!r.subjects.some((p) => persons.includes(p))) return false;
      return dmPartner !== null
        ? visibleToSelf(r.scope, dmPartner, partner)
        : hasScope(scopes, r.scope);
    };
    return (await this.#followups())
      .filter(
        (r) =>
          !r.done &&
          r.superseded_by === null &&
          (oldest === null || r.due === null || ms(r.due) >= oldest) &&
          shown(r),
      )
      .slice(0, PENDING_FOLLOWUPS);
  }
}

/** `MemoryEngine` service (Rust `Arc<MemoryEngine>`). */
export const MemoryEngineKey = serviceKey<MemoryEngine>("MemoryEngine");

function afterMark(e: LogEntry, w: Watermark): boolean {
  const a = ms(e.ts);
  const b = ms(w.ts);
  return a > b || (a === b && e.id > w.id);
}

function watermarkJson(w: Watermark): JsonValue {
  return {
    context: { ...w.context },
    ts: w.ts,
    id: w.id,
  };
}

function parseWatermark(value: JsonValue | null | undefined): Watermark | null {
  if (!isJsonObject(value)) return null;
  const { context, ts, id } = value;
  if (!isJsonObject(context) || typeof ts !== "string" || typeof id !== "string") return null;
  const { platform, scope, channel, kind } = context;
  if (
    typeof platform !== "string" ||
    !(scope === null || typeof scope === "string") ||
    typeof channel !== "string" ||
    !(kind === "channel" || kind === "thread" || kind === "dm" || kind === "voice") ||
    Number.isNaN(Date.parse(ts)) ||
    !isUlid(id)
  ) {
    return null;
  }
  return { context: { platform, scope, channel, kind }, ts, id };
}

/** Content contains the keyword, or the record has all of its tokens. */
export function matchesKeyword(record: MemoryRecord, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (kw === "") return false;
  if (record.content.toLowerCase().includes(kw)) return true;
  const tokens = tokenize(kw);
  return tokens.length > 0 && tokens.every((t) => tokenOverlap([t], record.tokens) > 0);
}

function optional<T>(value: T | null): T[] {
  return value === null ? [] : [value];
}

const charCount = (s: string) => [...s].length;

/** The person a name from the summarizer refers to. */
function resolveName(raw: string, speakers: readonly Speaker[]): PersonId | null {
  const name = raw.trim().replace(/^@+/, "").toLowerCase();
  if (name === "") return null;
  const exact = speakers.find((s) => s.names.some((n) => n.toLowerCase() === name));
  if (exact) return exact.person;
  const partial = speakers.filter((s) =>
    s.names.some((n) => {
      const lower = n.toLowerCase();
      return charCount(lower) >= 2 && (name.includes(lower) || lower.includes(name));
    }),
  );
  return partial.length === 1 ? (partial[0]?.person ?? null) : null;
}

/** People whose names appear in `text`. */
function mentioned(raw: string, speakers: readonly Speaker[]): PersonId[] {
  const text = raw.toLowerCase();
  return speakers
    .filter((s) => s.names.some((n) => charCount(n) >= 2 && text.includes(n.toLowerCase())))
    .flatMap((s) => (s.person !== null ? [s.person] : []));
}

/** Turns a followup record into the shared `Followup` type. */
export function toFollowup(record: MemoryRecord): Followup {
  return {
    id: record.id,
    profile: record.profile,
    person: record.subjects[0] ?? null,
    context: record.source_context,
    about: record.content,
    due: record.due ?? record.created_at,
  };
}
