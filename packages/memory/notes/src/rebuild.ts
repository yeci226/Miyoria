// Rebuilding her memory from the event log (docs/design/v5-brain.md, Q10): the chat lines since a
// date are grouped by session, cut into segments as the segment pass cuts a live session (a pause
// of `idleMs`, `maxLines` lines), and each segment goes through `runSegmentPass`, so the episodes
// and the documents are the ones the live pass would have written.
//
// - Nothing existing is touched: lines are added to the notes beside what is there, and episodes
//   are stored through the memory engine like any other. Old records, pages and documents stay.
// - A session's position is a cursor (`memory.rebuild`, key the session) holding the event `seq`
//   of the last line of the last segment handled; it moves in the transaction that writes the
//   segment's documents, so an interrupted run goes on from there. The transcript entries of the
//   pass are the event lines themselves, their `seq` the event's.
// - What a run costs is estimated before it starts from the prompt's size (characters, as
//   tokens) and, while it runs, counted from the pass's own usage against the model's price. A
//   run stops before a segment once `maxUsd` is spent.
// - With embeddings on, the lines written get vectors at the end (`rebuildVectors`), and the
//   pass finds related documents by meaning too.
// - With a `marker`, the first run records when the rebuild began and a run that handles its
//   whole plan records that it is done (`switch.ts`): from then on the notes are her memory's
//   source and the segment pass runs live.

import {
  CHAT_EVENT_TYPES,
  PlatformMessageCreated,
  PlatformMessageSchema,
  VoicePlaybackEvent,
  VoiceUtteranceEvent,
} from "@miyoria/contracts/events";
import { type Completer, callCost, type Pricing } from "@miyoria/llm/llm";
import { errorMessage } from "@miyoria/runtime/kernel";
import type { EventLogStore, LoggedEvent, SettingsStore, SqliteStore } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  type PersonId,
  type ProfileId,
  type ReasoningLevel,
  type Timestamp,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import { memoryConfig } from "../../memory/src/config.js";
import { MemoryEngine } from "../../memory/src/engine.js";
import { memoryTables } from "../../memory/src/tables.js";
import type { TranscriptEntry } from "../../transcript/src/types.js";
import { type EpisodeSink, memoryEpisodeSink } from "./episodes.js";
import {
  type PassUsage,
  runSegmentPass,
  type SegmentPassResult,
  type SegmentPerson,
} from "./pass.js";
import { segmentPassMessage, segmentPassPrompt } from "./pass-prompt.js";
import type { NotePlace, ScopeResolver } from "./scope.js";
import {
  DEFAULT_SEGMENT_IDLE_MS,
  DEFAULT_SEGMENT_LINES,
  type Segment,
  type SegmentCursor,
  segmentsBeforeCompaction,
} from "./segment.js";
import { type NotesStore, SELF_SEED } from "./store.js";
import { markRebuildStarted, markRebuilt } from "./switch.js";
import type { NotesIndex, NotesSearch } from "./vectors.js";

/** The consumer id of the rebuild's positions in `event_cursors`. */
export const REBUILD_CONSUMER = "memory.rebuild";
/** Where the rebuild starts unless told otherwise: the day the event log began. */
export const REBUILD_SINCE: Timestamp = toTimestamp(Date.UTC(2026, 10, 15));

/** Tokens the documents shown to the model add to a segment's prompt, on average. */
const DOCUMENT_TOKENS = 600;
/** Tokens of a reply on average without thinking: an episode, a few edits. */
const REPLY_TOKENS = 350;
/**
 * Tokens of a reply on average when the model thinks first: the thinking is billed as output.
 * Measured on the first live rebuild (2026-11-17, `summarizer` at `medium`: 3,000 to 3,700 a
 * segment, where 350 had been estimated). `low` and `high` were not measured and use the same.
 */
export const THINKING_REPLY_TOKENS = 3_300;
const PAGE = 2000;

/** Tokens of `text`: a character of Chinese is about 0.7, anything else a quarter. */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) tokens += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 0.7 : 0.25;
  return Math.ceil(tokens);
}

// ---- the lines --------------------------------------------------------------------------------

interface Line {
  entry: TranscriptEntry;
  context: ContextKey | null;
  space: string | null;
  room: string | null;
  handle: string | null;
}

/** A chat event as a line of its session; `null`: not a line anybody said (or one taken out). */
function lineOf(logged: LoggedEvent): Line | null {
  const env = logged.envelope;
  if (env.redacted_at !== null || env.session === null || env.seq === null) return null;
  let kind: "other" | "self";
  let content: string;
  let account: AccountRef | null;
  let author: string | null;
  let messageId: string | null;
  if (env.type === PlatformMessageCreated.type) {
    const parsed = PlatformMessageSchema.safeParse(env.data);
    if (!parsed.success || parsed.data.card === true) return null;
    const m = parsed.data;
    kind = m.self === true ? "self" : "other";
    content = m.text;
    account = m.author.account;
    author = m.author.display_name;
    messageId = m.id.id;
  } else if (env.type === VoiceUtteranceEvent.type) {
    const parsed = VoiceUtteranceEvent.data.safeParse(env.data);
    if (!parsed.success) return null;
    kind = "other";
    content = parsed.data.text;
    account = parsed.data.speaker.account;
    author = parsed.data.speaker.display_name;
    messageId = parsed.data.id;
  } else if (env.type === VoicePlaybackEvent.type) {
    const parsed = VoicePlaybackEvent.data.safeParse(env.data);
    if (!parsed.success || parsed.data.state !== "started" || parsed.data.blocked) return null;
    kind = "self";
    content = parsed.data.text;
    account = parsed.data.speaker?.account ?? null;
    author = parsed.data.speaker?.display_name ?? null;
    messageId = null;
  } else return null;
  content = content.trim();
  if (content === "") return null;
  return {
    entry: {
      session: env.session,
      seq: env.seq,
      kind,
      person_id: kind === "other" ? (env.person_id as PersonId | null) : null,
      account,
      author,
      content,
      images: [],
      tool_calls: [],
      tool_call_id: null,
      reasoning: null,
      turn: null,
      message_id: messageId,
      reply_to: null,
      label: null,
      about_seq: null,
      addressed: false,
      bot: false,
      spoken: kind === "self",
      flagged: null,
      interrupted: false,
      heard: null,
      tokens: estimateTokens(content),
      at: env.at,
      redacted_at: null,
    },
    context: logged.context,
    space: env.space_id,
    room: env.room_id,
    handle: logged.handle,
  };
}

/** Every chat line since `since`, oldest first (the event log's own order). */
export async function readChatLines(
  events: Pick<EventLogStore, "query">,
  since: Timestamp,
): Promise<Line[]> {
  const out: Line[] = [];
  let after = 0;
  for (;;) {
    const page = await events.query({
      types: CHAT_EVENT_TYPES,
      since,
      afterSeq: after,
      order: "asc",
      limit: PAGE,
    });
    for (const logged of page) {
      const line = lineOf(logged);
      if (line !== null) out.push(line);
    }
    const last = page.at(-1);
    if (page.length < PAGE || last === undefined) return out;
    after = last.envelope.seq ?? after;
  }
}

// ---- the plan ---------------------------------------------------------------------------------

export interface RebuildOptions {
  /** Lines before this time are left out. Default `REBUILD_SINCE`. */
  since?: Timestamp;
  /** A pause this long ends a segment. Default `DEFAULT_SEGMENT_IDLE_MS`. */
  idleMs?: number;
  /** Lines in a segment at most. Default `DEFAULT_SEGMENT_LINES`. */
  maxLines?: number;
}

/** A segment of a session, with where it was and who was in it. */
export interface PlannedSegment {
  session: string;
  segment: Segment;
  place: NotePlace;
  people: SegmentPerson[];
  /** Lines of people and hers in it. */
  lines: number;
  /** When its last line was said. */
  at: Timestamp;
}

export interface PlannedSession {
  session: string;
  lines: number;
  /** All its segments, and how many of them a cursor already stands behind. */
  segments: number;
  done: number;
  /** Nothing to scope what is learned by: its segments are not run. */
  unplaced: boolean;
}

export interface RebuildPlan {
  since: Timestamp;
  /** Chat lines read. */
  lines: number;
  /** When the newest of them was said; `null`: none. */
  upto: Timestamp | null;
  sessions: PlannedSession[];
  /** What is still to do, in the order the lines were said. */
  segments: PlannedSegment[];
  /** The platform context of each session, for the episodes. */
  contexts: Map<string, ContextKey>;
}

/** Reads the chat lines and cuts them into segments; `cursor` says what is done already. */
export async function planRebuild(
  events: Pick<EventLogStore, "query">,
  cursor: Pick<SegmentCursor, "get">,
  options: RebuildOptions = {},
): Promise<RebuildPlan> {
  const since = options.since ?? REBUILD_SINCE;
  const lines = await readChatLines(events, since);
  const bySession = new Map<string, Line[]>();
  for (const line of lines) {
    const list = bySession.get(line.entry.session) ?? [];
    list.push(line);
    bySession.set(line.entry.session, list);
  }
  const plan: RebuildPlan = {
    since,
    lines: lines.length,
    upto: lines.reduce<Timestamp | null>(
      (latest, l) =>
        latest === null || timestampMs(l.entry.at) > timestampMs(latest) ? l.entry.at : latest,
      null,
    ),
    sessions: [],
    segments: [],
    contexts: new Map(),
  };
  const segmentOptions = {
    idleMs: options.idleMs ?? DEFAULT_SEGMENT_IDLE_MS,
    maxLines: options.maxLines ?? DEFAULT_SEGMENT_LINES,
  };
  for (const [session, list] of bySession) {
    const entries = list.map((l) => l.entry);
    const first = list[0] as Line;
    const context = list.find((l) => l.context !== null)?.context ?? null;
    if (context !== null) plan.contexts.set(session, context);
    const dm = /^[^:]+:dm:/.test(session);
    const partner = dm ? (entries.find((e) => e.kind === "other")?.person_id ?? null) : null;
    const place: NotePlace = {
      space: dm ? null : first.space,
      room: first.room,
      dm: partner,
    };
    const people = new Map<PersonId, SegmentPerson>();
    for (const l of list) {
      const person = l.entry.person_id;
      if (person === null || l.entry.kind !== "other") continue;
      const known = people.get(person);
      const name = l.entry.author ?? l.handle ?? person;
      if (known === undefined) {
        people.set(person, { person, name, names: l.handle === null ? [] : [l.handle] });
      } else if (l.handle !== null && !(known.names ?? []).includes(l.handle)) {
        known.names = [...(known.names ?? []), l.handle];
      }
    }
    const lastSeq = entries.at(-1)?.seq ?? 0;
    const all = segmentsBeforeCompaction(session, entries, 0, lastSeq, segmentOptions);
    const position = cursor.get(REBUILD_CONSUMER, session);
    const todo = all.filter((s) => s.to > position);
    const unplaced = place.space === null && place.room === null && place.dm === null;
    plan.sessions.push({
      session,
      lines: entries.filter((e) => e.kind === "other" || e.kind === "self").length,
      segments: all.length,
      done: all.length - todo.length,
      unplaced,
    });
    if (unplaced) continue;
    for (const segment of todo) {
      const last = segment.entries.at(-1);
      plan.segments.push({
        session,
        segment,
        place,
        people: [...people.values()],
        lines: segment.entries.filter((e) => e.kind === "other" || e.kind === "self").length,
        at: last?.at ?? toTimestamp(0),
      });
    }
  }
  plan.segments.sort((a, b) => a.segment.to - b.segment.to);
  return plan;
}

// ---- what it costs ----------------------------------------------------------------------------

export interface RebuildEstimate {
  segments: number;
  lines: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** `null`: no price for the model (or no model). */
  usd: number | null;
}

/**
 * The estimate for what `plan` still has to do, at `price`, the pass's model reasoning at
 * `reasoning` (its thinking is output too).
 */
export function estimateRebuild(
  plan: RebuildPlan,
  price: Pricing | null,
  reasoning: ReasoningLevel = "off",
): RebuildEstimate {
  const system = estimateTokens(segmentPassPrompt());
  let prompt = 0;
  let lines = 0;
  for (const s of plan.segments) {
    const people = s.people.map((p) => ({
      code: `p${s.people.indexOf(p) + 1}`,
      person: p.person,
      name: p.name,
      names: [p.name, ...(p.names ?? [])],
    }));
    const message = segmentPassMessage({
      placeLabel: s.place.dm === null ? "伺服器頻道" : "私訊(一對一)",
      people,
      entries: s.segment.entries,
      documents: [],
      self: SELF_SEED.join("\n"),
    });
    prompt += system + estimateTokens(message) + DOCUMENT_TOKENS;
    lines += s.lines;
  }
  const completion =
    plan.segments.length * (reasoning === "off" ? REPLY_TOKENS : THINKING_REPLY_TOKENS);
  return {
    segments: plan.segments.length,
    lines,
    prompt_tokens: prompt,
    completion_tokens: completion,
    usd:
      price === null
        ? null
        : callCost(price, {
            prompt_tokens: prompt,
            completion_tokens: completion,
            cached_prompt_tokens: null,
          }),
  };
}

// ---- running it -------------------------------------------------------------------------------

export interface RebuildDeps {
  router: Completer;
  notes: NotesStore;
  /** The segment pass's related documents by meaning too (`vectors.ts`); absent: by words. */
  search?: NotesSearch | null;
  /** Where the episodes go; `null`: the documents only. */
  episodes: EpisodeSink | null;
  /** `EventCursors`, or a fake in tests. */
  cursor: SegmentCursor;
  /** What a model call costs per token; the run counts its own spending against `maxUsd`. */
  price: Pricing;
  /** Stop before the next segment once this much is spent. */
  maxUsd: number;
  /** Model purpose of the pass. Default `summarizer`. */
  purpose?: string;
  signal?: AbortSignal;
  /** Called after each segment. */
  onSegment?: (done: number, of: number, result: SegmentPassResult) => void;
  /**
   * Where the rebuild's state is kept (`switch.ts`): its first start, and its end once a run has
   * handled every segment, which makes the notes her memory's source. Absent: not recorded.
   */
  marker?: { settings: Pick<SettingsStore, "get" | "set">; profile: ProfileId };
  /** Wall-clock time of the marker. Default `Date.now`. */
  wallClock?: () => number;
}

export interface RebuildReport {
  /** `done`: every segment handled; `budget`: `maxUsd` was spent; `error`: a call failed; `aborted`. */
  status: "done" | "budget" | "error" | "aborted";
  error: string | null;
  /** Segments handled by a call, and the plan's total. */
  segments: number;
  total: number;
  /** Segments with nothing anybody said, or whose reply was not usable. */
  empty: number;
  abandoned: number;
  /** Lines added or changed, and edits the pass left out. */
  written: number;
  dropped: number;
  episodes: number;
  usage: PassUsage;
  usd: number;
}

/** A session's position in the rebuild's own consumer, whatever consumer the pass names. */
function rebuildCursor(cursor: SegmentCursor): SegmentCursor {
  return {
    get: (_consumer, key) => cursor.get(REBUILD_CONSUMER, key),
    advance: (_consumer, key, seq) => cursor.advance(REBUILD_CONSUMER, key, seq),
  };
}

/** Runs the segments of `plan` through the pass (see the module comment). */
export async function applyRebuild(plan: RebuildPlan, deps: RebuildDeps): Promise<RebuildReport> {
  const report: RebuildReport = {
    status: "done",
    error: null,
    segments: 0,
    total: plan.segments.length,
    empty: 0,
    abandoned: 0,
    written: 0,
    dropped: 0,
    episodes: 0,
    usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0 },
    usd: 0,
  };
  const cursor = rebuildCursor(deps.cursor);
  const wall = () => toTimestamp((deps.wallClock ?? Date.now)());
  if (deps.marker) {
    await markRebuildStarted(deps.marker.settings, deps.marker.profile, plan.since, wall());
  }
  for (const planned of plan.segments) {
    if (deps.signal?.aborted) {
      report.status = "aborted";
      return report;
    }
    if (report.usd >= deps.maxUsd) {
      report.status = "budget";
      return report;
    }
    let result: SegmentPassResult;
    try {
      result = await runSegmentPass(
        {
          session: planned.session,
          entries: planned.segment.entries,
          place: planned.place,
          people: planned.people,
        },
        {
          router: deps.router,
          notes: deps.notes,
          ...(deps.search ? { search: deps.search } : {}),
          episodes: deps.episodes,
          cursor,
          now: () => timestampMs(planned.at),
          ...(deps.purpose === undefined ? {} : { purpose: deps.purpose }),
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        },
      );
    } catch (error) {
      if (deps.signal?.aborted) {
        report.status = "aborted";
        return report;
      }
      report.status = "error";
      report.error = errorMessage(error);
      return report;
    }
    report.segments += 1;
    report.usage.calls += result.usage.calls;
    report.usage.prompt_tokens += result.usage.prompt_tokens;
    report.usage.completion_tokens += result.usage.completion_tokens;
    report.usd += callCost(deps.price, {
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      cached_prompt_tokens: null,
    });
    if (result.status === "empty") report.empty += 1;
    else if (result.status === "abandoned") report.abandoned += 1;
    report.written += result.applied.length;
    report.dropped += result.dropped.length;
    if ((result.episode?.stored ?? null) !== null) report.episodes += 1;
    deps.onSegment?.(report.segments, report.total, result);
  }
  if (deps.marker) {
    await markRebuilt(
      deps.marker.settings,
      deps.marker.profile,
      plan.since,
      plan.upto ?? plan.since,
      wall(),
    );
  }
  return report;
}

export interface VectorReport {
  /** Lines given a vector by this call. */
  done: number;
  /** Lines in use that still have none of the model in use. */
  waiting: number;
  /** `off`: the embedder is off or turned itself off (the runtime or the model could not load). */
  status: "done" | "off" | "stalled" | "aborted";
}

/** Lines embedded per backfill call at the end of a rebuild. */
const REBUILD_VECTOR_BATCH = 64;

/**
 * The end of a rebuild with embeddings on: every line in use without a vector of the model gets
 * one, `REBUILD_VECTOR_BATCH` at a time. What is done is kept as it goes, so a stop loses at most
 * a batch, and the running Core's backfill finishes what is left. `stalled`: a call gave no
 * vector (the embedder failed; logged).
 */
export async function rebuildVectors(
  index: NotesIndex,
  options: { signal?: AbortSignal; onBatch?: (done: number, waiting: number) => void } = {},
): Promise<VectorReport> {
  await index.idle();
  let done = 0;
  let status: VectorReport["status"] = "done";
  for (;;) {
    if (!index.enabled) {
      status = "off";
      break;
    }
    if (options.signal?.aborted) {
      status = "aborted";
      break;
    }
    if (index.counts().waiting === 0) break;
    let n: number;
    try {
      n = await index.backfill(REBUILD_VECTOR_BATCH, options.signal);
    } catch (error) {
      if (!options.signal?.aborted) throw error;
      status = "aborted";
      break;
    }
    done += n;
    if (n === 0) {
      status = index.enabled ? "stalled" : "off";
      break;
    }
    options.onBatch?.(done, index.counts().waiting);
  }
  return { done, waiting: index.counts().waiting, status };
}

/**
 * The episode sink of a rebuild: the memory engine over `store`'s memory records, with no
 * embedder (the running Core gives vectors to records without one, a batch at a time).
 */
export function rebuildEpisodeSink(
  store: SqliteStore,
  profile: ProfileId,
  resolver: ScopeResolver,
  plan: Pick<RebuildPlan, "contexts">,
): EpisodeSink {
  const engine = new MemoryEngine(profile, memoryConfig(), store.plugin(memoryTables), {
    people: store.people,
    messages: store.messages,
    settings: store.settings,
    handles: store.handles,
    chat: store.chat,
    personData: store.personData,
  });
  return memoryEpisodeSink(engine, {
    resolver,
    contextOf: (session) => plan.contexts.get(session) ?? null,
  });
}
