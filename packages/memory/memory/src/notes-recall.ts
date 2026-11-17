// What `recall` and the prompt's memory block (block 6 of the turn runner's prompt) read once her
// notes are the source (v5-brain.md, 記憶收成兩個寫入點; `notes/src/switch.ts`).
//
// - Before the rebuild has finished on an installation: the memory records, as before
//   (`MemoryRetriever`), so she does not wake up with an empty memory.
// - After it: lines of her documents (L3), found by `NotesSearch` (words, and meaning when
//   embeddings are on and the query's vector comes in time), plus the memory records written
//   since the rebuild began (the episodes and follow-ups of the segment pass, what `remember`
//   keeps) and the episodes older than the rebuild's start date, which it could not make again.
//   Records the old consolidation wrote after that date are left out: the rebuild wrote the same
//   stretches again as lines and episodes.
// - Scope order: first the lines of the documents about the people present, talking or named,
//   and of the place; then any document the place may see. A wider line comes after every scoped
//   one, so an unrelated document's line is less likely to stand in front.
// - Precision (`notes/src/precision.ts`): the floor and the stricter bar for meaning alone apply
//   to every line; when the lines are weak (nothing stands out), the prompt block shows none of
//   them, and `recall` returns them marked.

import type { MemoryRecord, SettingsStore } from "@miyoria/store";
import type {
  AccountRef,
  ContextKey,
  MemoryOrigin,
  MemoryRetrieval,
  PersonId,
  ProfileId,
  RetrievalQuery,
  RetrievedMemory,
  Timestamp,
  TurnRetrievalQuery,
} from "@miyoria/types";
import { timestampMs } from "@miyoria/types";
import { precise } from "../../notes/src/precision.js";
import type { NotesViewer, ScopeResolver } from "../../notes/src/scope.js";
import { type NotesStore, personSubject, placeSubject } from "../../notes/src/store.js";
import { type RebuildState, rebuildState, switched, writtenSince } from "../../notes/src/switch.js";
import type { NotesSearch } from "../../notes/src/vectors.js";
import { lineOf, PROMPT_KINDS, turnOf } from "./contributor.js";
import type { MemoryEngine } from "./engine.js";
import { LINE_REF_PREFIX } from "./evidence.js";
import { MemoryRetriever } from "./retrieval.js";
import { visibleScopes } from "./scope.js";
import { effectiveConfidence } from "./score.js";

/** The rebuild's state, read from the settings and kept for synchronous readers. */
export class NotesSourceState {
  readonly #settings: Pick<SettingsStore, "get"> | null;
  readonly #profile: ProfileId;
  #state: RebuildState | null = null;

  constructor(settings: Pick<SettingsStore, "get"> | null, profile: ProfileId) {
    this.#settings = settings;
    this.#profile = profile;
  }

  get state(): RebuildState | null {
    return this.#state;
  }

  /** Whether the notes are the source. */
  get switched(): boolean {
    return switched(this.#state);
  }

  /** Reads the state again; a failed read keeps the last one. */
  async refresh(): Promise<RebuildState | null> {
    if (this.#settings === null) return this.#state;
    this.#state = await rebuildState(this.#settings, this.#profile);
    return this.#state;
  }
}

/** What one recall asks. */
export interface RecallAsk {
  context: ContextKey;
  accounts: readonly AccountRef[];
  present: readonly PersonId[];
  text: string;
  /** The lines before the one answered, oldest first. */
  recent?: readonly string[];
  /** The people she is talking with. */
  talkingWith?: readonly PersonId[];
  limit: number;
  now: Timestamp;
  /** A spoken turn: the query's vector is waited for only the voice wait. */
  voice?: boolean;
}

/** What a recall found. */
export interface Recollection {
  memories: RetrievedMemory[];
  /** Lines of her notes were found but none stands out (precision rule 3). */
  weak: boolean;
  /** `records`: the rebuild has not finished here, the memory records were read. */
  source: "notes" | "records";
}

export interface NotesRecallDeps {
  engine: MemoryEngine;
  notes: NotesStore;
  search: NotesSearch;
  source: NotesSourceState;
  /** Identity's places and accounts; default the notes' own (`NotesStore.resolver`). */
  resolver?: ScopeResolver;
}

/** One point of a person profile taken from a line of their document. */
export interface ProfilePoint {
  id: string;
  text: string;
  origin: MemoryOrigin;
  said_by: string | null;
}

/** The id of a line of her notes among the memories returned. */
const NOTE_PREFIX = "note:";

/** Reads `recall` and block 6 from her notes once they are the source (the file comment). */
export class NotesRecall implements MemoryRetrieval {
  readonly #d: NotesRecallDeps;
  readonly #records: MemoryRetriever;

  constructor(deps: NotesRecallDeps) {
    this.#d = deps;
    this.#records = new MemoryRetriever(deps.engine);
  }

  /** The prompt's memory block: weak lines are nothing found. */
  async retrieve(
    query: RetrievalQuery | TurnRetrievalQuery,
    signal?: AbortSignal,
  ): Promise<RetrievedMemory[]> {
    const turn = "recent" in query || "talking_with" in query || "voice" in query ? query : null;
    const found = await this.recollect(
      {
        context: query.context,
        accounts: query.accounts ?? [],
        present: query.present,
        text: query.text,
        ...(turn?.recent ? { recent: turn.recent } : {}),
        ...(turn?.talking_with ? { talkingWith: turn.talking_with } : {}),
        ...(turn?.voice ? { voice: true } : {}),
        limit: query.limit ?? this.#d.engine.config.recall_limit,
        now: query.now,
      },
      signal,
    );
    if (!found.weak) return found.memories;
    return found.memories.filter((m) => !m.id.startsWith(NOTE_PREFIX));
  }

  format(memories: readonly RetrievedMemory[], now: Timestamp): string {
    return memories.map((m) => lineOf(m, now)).join("\n");
  }

  /** What `ask` brings back, weak lines included and marked (`Recollection.weak`). */
  async recollect(ask: RecallAsk, signal?: AbortSignal): Promise<Recollection> {
    const state = this.#d.source.state;
    if (!switched(state) || state === null) {
      const memories = await this.#records.retrieve(
        {
          context: ask.context,
          present: ask.present,
          accounts: ask.accounts,
          text: ask.text,
          limit: ask.limit,
          now: ask.now,
          ...(ask.recent ? { recent: ask.recent } : {}),
          ...(ask.talkingWith ? { talking_with: ask.talkingWith } : {}),
        },
        signal,
      );
      return { memories, weak: false, source: "records" };
    }
    const engine = this.#d.engine;
    const config = engine.config;
    const limit = Math.max(1, ask.limit);
    const viewer = this.viewer(ask);
    const people = this.#people(ask, viewer);

    // Lines of her notes: the scoped documents first, then the rest.
    const search = this.#d.search;
    const vector = await search.vector(ask.text, {
      ...(ask.voice ? { voice: true } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
    const placeKey = viewer.dm === null ? (viewer.space ?? viewer.room) : null;
    const subjects = [
      ...people.map((p) => personSubject(p)),
      ...(placeKey === null ? [] : [placeSubject(placeKey)]),
    ];
    const scoped =
      subjects.length === 0
        ? []
        : search.linesWith(vector, ask.text, viewer, {
            subjects,
            limit: Math.max(1, config.notes_recall.scoped_limit),
          });
    const seen = new Set(scoped.map((h) => h.line.id));
    const wide = search
      .linesWith(vector, ask.text, viewer, { limit })
      .filter((h) => !seen.has(h.line.id));
    const { hits, weak } = precise([...scoped, ...wide], config.notes_recall, config.min_vector);
    const kept = new Set(hits.map((h) => h.line.id));
    const lines = [...scoped, ...wide]
      .filter((h) => kept.has(h.line.id))
      .map((h) => this.#lineMemory(h));
    const scopedCount = scoped.filter((h) => kept.has(h.line.id)).length;

    // Records written since the rebuild began, and episodes older than what it could make again.
    const since = state.since;
    const started = state.started_at;
    const keep = (r: MemoryRecord) =>
      writtenSince(r.id, started) ||
      (r.kind === "episode" && timestampMs(r.created_at) < timestampMs(since));
    const scopes = visibleScopes(ask.context, ask.accounts, ask.present);
    const recalled = await engine.recall(
      scopes,
      ask.present,
      ask.text,
      PROMPT_KINDS,
      limit,
      ask.now,
      signal,
      turnOf(ask.recent, ask.talkingWith),
      keep,
    );
    const records: RetrievedMemory[] = recalled.map(({ record, score }) => ({
      id: record.id,
      kind: record.kind === "followup" ? "fact" : record.kind,
      origin: record.origin ?? (record.source !== null ? "told" : "unknown"),
      content: record.content,
      said_by: record.source?.name ?? null,
      source_events: [...(record.source_events ?? [])],
      created_at: record.created_at,
      score,
      confidence: effectiveConfidence(config, record, ask.now),
    }));

    const first = lines.slice(0, scopedCount);
    const rest = [...lines.slice(scopedCount), ...records].sort((a, b) => b.score - a.score);
    return { memories: [...first, ...rest].slice(0, limit), weak, source: "notes" };
  }

  /**
   * What a person profile shows of `person` once the notes are the source: the lines of their
   * document that can be shown here, newest first, and whether a memory record is a fact written
   * since the rebuild began (`remember`; older facts are what the rebuild remade as lines).
   * `null` before the switch: the profile reads the facts.
   */
  personPoints(
    person: PersonId,
    where: Pick<RecallAsk, "context" | "accounts" | "present">,
  ): { lines: ProfilePoint[]; recordKept(id: string): boolean } | null {
    const state = this.#d.source.state;
    if (!switched(state) || state === null) return null;
    const handles = this.#d.engine.handles;
    const lines = this.#d.notes
      .lines(personSubject(person), this.viewer(where))
      .map((line): ProfilePoint => {
        const told = line.provenance === "told_by_subject" || line.provenance === "told_by_other";
        const teller =
          told && line.told_by !== null ? (handles?.ofPerson(line.told_by) ?? null) : null;
        return {
          id: `${NOTE_PREFIX}${line.id}`,
          text: line.text,
          origin: told ? "told" : "experienced",
          said_by: teller,
        };
      });
    return { lines, recordKept: (id) => writtenSince(id, state.started_at) };
  }

  /** Who reads from where `ask` is: the place as identity names it, and the people present. */
  viewer(ask: Pick<RecallAsk, "context" | "accounts" | "present">): NotesViewer {
    const resolver = this.#d.resolver ?? this.#d.notes.resolver();
    const present: PersonId[] = [...ask.present];
    for (const account of ask.accounts) {
      const p = resolver.personOf(account);
      if (p !== null && !present.includes(p)) present.push(p);
    }
    const context = ask.context;
    const dm = context.kind === "dm" || context.scope === null;
    return {
      space: dm ? null : resolver.spaceOf(context.platform, context.scope as string),
      room: resolver.roomOf(context),
      dm: dm ? (present[0] ?? null) : null,
      present,
    };
  }

  /** The people present, talking with her, or named in what is said or just before it. */
  #people(ask: RecallAsk, viewer: NotesViewer): PersonId[] {
    const out = new Set<PersonId>([...viewer.present, ...(ask.talkingWith ?? [])]);
    const said = `${ask.text}\n${(ask.recent ?? []).join("\n")}`.toLowerCase();
    for (const entry of this.#d.engine.handles?.list() ?? []) {
      if (entry.person === null) continue;
      const handle = entry.handle.toLowerCase();
      if ([...handle].length >= 2 && said.includes(handle)) out.add(entry.person);
    }
    return [...out].slice(0, 16);
  }

  #lineMemory(hit: Awaited<ReturnType<NotesSearch["lines"]>>[number]): RetrievedMemory {
    const { line, document } = hit;
    const handles = this.#d.engine.handles;
    const nameOf = (person: PersonId): string | null =>
      handles?.ofPerson(person) ?? (person === document.person_id ? document.title || null : null);
    const told = line.provenance === "told_by_subject" || line.provenance === "told_by_other";
    const origin: MemoryOrigin = told ? "told" : "experienced";
    const teller = told && line.told_by !== null ? nameOf(line.told_by) : null;
    const title =
      document.kind === "self"
        ? ""
        : document.kind === "person" && document.person_id !== null
          ? (nameOf(document.person_id) ?? document.title)
          : document.title;
    const bySubject = line.provenance === "told_by_subject" && teller !== null;
    const content =
      title === "" || bySubject || line.text.includes(title) ? line.text : `${title}:${line.text}`;
    return {
      id: `${NOTE_PREFIX}${line.id}`,
      kind: document.kind === "self" ? "self_note" : "fact",
      origin,
      content,
      said_by: told ? teller : null,
      source_events: line.evidence.flatMap((e) =>
        e.message_id === null ? [] : [`${LINE_REF_PREFIX}${e.message_id}`],
      ),
      created_at: line.created_at,
      score: hit.score,
      confidence: line.confidence,
    };
  }
}
