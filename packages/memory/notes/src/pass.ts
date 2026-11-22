// The segment pass: the one writer of her memory (docs/design/v5-brain.md, 設計的結論). One model
// call reads a segment of a session's transcript together with what she already has about the
// people, the place and the topics in it, and answers with an episode, explicit edits of her
// documents, follow-ups and her promises. Because the model sees the lines it could contradict, a
// contradiction comes back as `replace` or `outdate` of a line it names, never as a second line
// beside it. In the same way it sees the follow-ups still open about these people and her promises
// still open in this place, so it closes what the segment answered or she did (`close`), changes a
// follow-up whose matter moved (`update`), and does not write one of them a second time.
//
// Before anything is written, code checks every edit (each rule is tested):
//
// 1. The document must be one shown or one the edit may open (a person present, this place, a
//    topic); her self document is the nightly reflection's, never the pass's; a DM has no place
//    document. A line edited must be one that was shown.
// 2. Present-tense state is not a fact (`isPresentState`, the memory engine's check).
// 3. Evidence (`supporting` of `evidence.ts`): a line about a person in a fact section rests on
//    that person's own words in the segment. Backed only by someone else's words it is stored as
//    told by them (`told_by_other`, confidence at most 0.5); backed by nobody's it is dropped.
//    What she thinks of them (`her_view`) is hers: `concluded`, confidence at most 0.4. A line of
//    a place or a topic rests on any line of the segment. Removing a line (`outdate`) needs its
//    quote to be in the segment, and not only in her own words when the line is a fact about
//    someone.
// 4. Scope: a new line is scoped to where it was said (`placeScope`); a replacement too, except
//    that a line kept to this very room stays kept to it (`replacementScope`). Never wider.
// 5. A line saying what an in-use line already says is dropped (`duplicate`), not rewritten.
// 6. Caps per pass: adds, changes, edits per document, follow-ups.
// 7. Every write records the segment (session and sequences) on the line, and the quoted entry
//    (its sequence and message id) as evidence, so a redaction of that message finds it.
//
// After that, for what is still open:
//
// 8. A close or an update names an item shown (`f1`, `c1`); any other id is ignored. Closing a
//    follow-up closes the open ones about the same person and matter with it (the memory engine's
//    `sameMatter`); keeping a promise keeps the open ones of the same matter in that place.
// 9. A new follow-up or promise that is the same matter as one shown (or one made in this reply)
//    is not written; the sink also refuses a follow-up it holds already in other words.
//
// The documents are written in one transaction with the session's position (`cursor`); the
// episode, the closes, the follow-ups and the promises go to the `EpisodeSink` and the
// `PromiseLedger` after. A reply that is not usable after one repair (`completeJson`) abandons the
// pass: nothing is written and the position stays.

import {
  type ChatRequest,
  type ChatResponse,
  type Completer,
  completeJson,
  StructuredOutputError,
  systemMessage,
  userMessage,
  withLlmTag,
} from "@miyoria/llm/llm";
import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type ContextKey,
  type PersonId,
  type Timestamp,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { type EvidenceConfig, EvidenceConfigSchema } from "../../memory/src/config.js";
import { type EvidenceLine, nameWords, supporting } from "../../memory/src/evidence.js";
import { isPresentState } from "../../memory/src/expiry.js";
import { sameMatter } from "../../memory/src/followups.js";
import { fromElsewhere } from "../../memory/src/places.js";
import { textSimilarity } from "../../memory/src/tokenize.js";
import type { TranscriptEntry } from "../../transcript/src/types.js";
import type { EpisodeSink, OpenFollowup } from "./episodes.js";
import {
  type PromptDocument,
  type PromptOpen,
  type PromptPerson,
  SOURCE_LABELS,
  segmentPassMessage,
  segmentPassPrompt,
} from "./pass-prompt.js";
import type { OpenPromise, PromiseLedger } from "./promises.js";
import type { DocumentKind, Provenance } from "./schema.js";
import {
  type NotePlace,
  type NoteScope,
  type NotesViewer,
  placeScope,
  replacementScope,
  viewerOf,
} from "./scope.js";
import { HER_VIEW_SECTION, MISC_SECTION, sectionKey } from "./sections.js";
import { markProcessed, type SegmentCursor } from "./segment.js";
import {
  cleanLine,
  type NotesStore,
  parseSubject,
  personSubject,
  placeSubject,
  SELF_SUBJECT,
  topicSubject,
} from "./store.js";
import type { EvidenceInput, NoteLine, NoteOp, NotesErrorCode, SegmentRef } from "./types.js";
import type { NotesSearch } from "./vectors.js";

// ---- the reply --------------------------------------------------------------------------------

/** A 0..1 score; 0..10 and 0..100 scales are rescaled, a numeric string is read. */
const unit = z.preprocess((v) => {
  const n = typeof v === "string" ? Number(v.trim().replace(/%$/, "")) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return v;
  return Math.min(1, Math.max(0, n > 10 ? n / 100 : n > 1 ? n / 10 : n));
}, z.number());

const seq = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? null : typeof v === "string" ? Number(v) : v),
  z.number().int().nullable(),
);

const text = z.string().trim().min(1);

const AddSchema = z.object({
  op: z.literal("add"),
  doc: text,
  section: z.string().trim().default(""),
  text,
  source: z.string().trim().default(""),
  quote: z.string().default(""),
  seq: seq.default(null),
});
const ReplaceSchema = z.object({
  op: z.literal("replace"),
  line: text,
  text,
  source: z.string().trim().default(""),
  quote: z.string().default(""),
  seq: seq.default(null),
});
const OutdateSchema = z.object({
  op: z.literal("outdate"),
  line: text,
  reason: z.string().default(""),
  quote: z.string().default(""),
  seq: seq.default(null),
});

/** Hours from now, up to 90 days; a numeric string is read. */
const hours = z.preprocess(
  (v) => (typeof v === "string" ? Number(v) : v),
  z
    .number()
    .min(0)
    .max(24 * 90),
);

/** An id the message showed (`f1`, `c1`); `"[f1]"` and a bare string are read too. */
const shownId = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().replace(/^\[|\]$/g, "") : v),
  text,
);
const CloseSchema = z.preprocess(
  (v) => (typeof v === "string" ? { id: v } : v),
  z.object({ id: shownId, reason: z.string().default("") }),
);

/** The pass's reply. Keys it does not know (a score of any kind among them) are dropped. */
export const SegmentReplySchema = z.object({
  episode: z
    .object({
      summary: text,
      who: z.array(z.string()).default([]),
      feeling: z.string().nullable().default(null),
      importance: unit.default(0.3),
    })
    .nullable()
    .default(null),
  edits: z.array(z.discriminatedUnion("op", [AddSchema, ReplaceSchema, OutdateSchema])).default([]),
  followups: z
    .array(
      z.object({
        who: z.string().nullable().default(null),
        about: text,
        due_in_hours: hours.default(24),
      }),
    )
    .default([]),
  close: z.array(CloseSchema).default([]),
  update: z
    .array(
      z.object({
        id: shownId,
        about: z.string().nullable().default(null),
        due_in_hours: hours.nullable().default(null),
      }),
    )
    .default([]),
  promises: z
    .array(
      z.object({
        to: z.string().nullable().default(null),
        what: text,
        due_in_hours: hours.nullable().default(null),
        seq: seq.default(null),
      }),
    )
    .default([]),
});
export type SegmentReply = z.output<typeof SegmentReplySchema>;
type Edit = SegmentReply["edits"][number];

// ---- inputs and outputs -----------------------------------------------------------------------

/** Someone in the segment. */
export interface SegmentPerson {
  person: PersonId;
  /** The name to write them by. */
  name: string;
  /** Other names they go by (nicknames, account names). */
  names?: readonly string[];
}

export interface SegmentPassInput {
  session: string;
  /** The segment: entries of `session`, in order (`Segment.entries`). */
  entries: readonly TranscriptEntry[];
  place: NotePlace;
  /** How the place reads in the prompt (a server and channel name); default by kind. */
  placeName?: string | null;
  /** The people present or speaking, with identity's ids. */
  people: readonly SegmentPerson[];
  /** Topics the caller knows the segment touches; the documents found by its words are added. */
  topics?: readonly string[];
  /** The platform context of the session: where her promises are recorded. `null`: none are. */
  context?: ContextKey | null;
}

/** How much one pass may change. */
export interface PassCaps {
  adds: number;
  /** `replace` and `outdate`. */
  changes: number;
  /** Edits of one document. */
  perDocument: number;
  followups: number;
  promises: number;
  /** Open follow-ups shown, and open promises shown, each. */
  open: number;
}

export const DEFAULT_PASS_CAPS: PassCaps = {
  adds: 8,
  changes: 8,
  perDocument: 5,
  followups: 3,
  promises: 3,
  open: 8,
};

export interface SegmentPassDeps {
  router: Completer;
  notes: NotesStore;
  /**
   * Finds the topic documents related to what was said by meaning too (`vectors.ts`), over the
   * same `notes`; absent: by words.
   */
  search?: NotesSearch | null;
  /**
   * Where the episode and the follow-ups go, and where the open follow-ups are read from and
   * closed; none: they are only returned.
   */
  episodes?: EpisodeSink | null;
  /** Her promises (`promises.ts`); none, or no `context` in the input: they are only returned. */
  promises?: PromiseLedger | null;
  /** The session's position, moved to the segment's end with the documents. */
  cursor?: SegmentCursor | null;
  now: () => number;
  /** Model purpose. Default `summarizer`. */
  purpose?: string;
  evidence?: Partial<EvidenceConfig>;
  caps?: Partial<PassCaps>;
  /** Characters of one document as shown to the model. Default 1500. */
  documentChars?: number;
  /** Characters of her self document as shown. Default 500. */
  selfChars?: number;
  maxTokens?: number;
  /** The request's session id (prefix cache), when the caller has one. */
  requestSession?: string | null;
  signal?: AbortSignal;
}

/** Why the pass left an edit out. */
export type DropReason =
  | "unknown_document"
  | "self_document"
  | "no_place"
  | "unknown_line"
  | "present_state"
  | "no_evidence"
  | "duplicate"
  | "cap"
  | NotesErrorCode;

export interface PassEdit {
  /** Its place among the reply's edits. */
  index: number;
  op: Edit["op"];
  subject: string;
  /** The line added, or the one outdated. */
  line: string;
  /** `replace`: the line replaced. */
  replaced: string | null;
  provenance: Provenance | null;
  scope: NoteScope | null;
}

export interface PassDrop {
  index: number;
  op: Edit["op"];
  reason: DropReason;
  detail: string;
}

export interface PassFollowup {
  about: string;
  person: PersonId | null;
  due: Timestamp;
  /** The open follow-up shown that is the same matter: not written again. */
  same: string | null;
  /** The id the sink stored it as; `null`: not stored (no sink, refused, held already). */
  stored: string | null;
}

/** A follow-up or a promise the reply closed. */
export interface PassClosed {
  kind: "followup" | "promise";
  id: string;
  /** What it asked or promised. */
  about: string;
  reason: string;
  /** Records closed, itself and the open ones of the same matter; 0: none (already closed). */
  count: number;
}

/** A promise of hers found in the segment. */
export interface PassPromise {
  what: string;
  to: PersonId | null;
  due: Timestamp | null;
  /** The open promise shown that is the same matter: not recorded again. */
  same: string | null;
  /** The id it was recorded as; `null`: not recorded. */
  stored: string | null;
}

export interface PassUsage {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface SegmentPassResult {
  /** `empty`: nothing anybody said, no call made; `abandoned`: nothing written (`error`). */
  status: "applied" | "empty" | "abandoned";
  error: string | null;
  segment: SegmentRef;
  episode: { text: string; importance: number; stored: string | null; error: string | null } | null;
  applied: PassEdit[];
  dropped: PassDrop[];
  followups: PassFollowup[];
  closed: PassClosed[];
  /** Ids of the follow-ups reworded or moved. */
  updated: string[];
  promises: PassPromise[];
  usage: PassUsage;
}

// ---- the documents shown ----------------------------------------------------------------------

interface Shown {
  subject: string;
  kind: DocumentKind;
  title: string;
  ref: string;
  /** Person documents: whom. */
  person: PersonId | null;
}

const normalize = (s: string) => s.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
const chars = (s: string) => [...s].length;

/** Short line ids, longer where two of the lines shown would read the same. */
function lineRefs(lines: readonly NoteLine[]): Map<string, NoteLine> {
  for (let size = 6; ; size += 2) {
    const out = new Map<string, NoteLine>();
    let clash = false;
    for (const l of lines) {
      const ref = `#${l.id.slice(-size).toLowerCase()}`;
      if (out.has(ref)) clash = true;
      out.set(ref, l);
    }
    if (!clash || size >= 26) return out;
  }
}

/** The newest lines of a document within `budget` characters. */
function within(lines: readonly NoteLine[], budget: number): NoteLine[] {
  const out: NoteLine[] = [];
  let left = budget;
  for (const l of lines) {
    const cost = chars(l.text) + 16;
    if (cost > left) break;
    left -= cost;
    out.push(l);
  }
  return out;
}

// ---- the pass ---------------------------------------------------------------------------------

/** Replaces the codes of the people shown (`p1`) with their names. */
function namesForCodes(raw: string, people: readonly PromptPerson[]): string {
  return raw.replace(/(?<![A-Za-z0-9_])p([0-9]{1,4})(?![A-Za-z0-9_])/g, (whole) => {
    const found = people.find((p) => p.code === whole);
    return found ? found.name : whole;
  });
}

function provenanceOf(label: string): Provenance | null {
  const wanted = label.trim();
  for (const [key, value] of Object.entries(SOURCE_LABELS)) {
    if (wanted === value || wanted === key) return key as Provenance;
  }
  if (/別人|聽說/.test(wanted)) return "told_by_other";
  if (/推測|看法|覺得/.test(wanted)) return "concluded";
  if (/看到|觀察/.test(wanted)) return "observed";
  if (/本人|自己說/.test(wanted)) return "told_by_subject";
  return null;
}

/** A transcript entry as `supporting` reads it. */
function evidenceLine(entry: TranscriptEntry): EvidenceLine {
  return {
    ref: entry.message_id ?? `seq:${entry.seq}`,
    text: entry.content,
    author: entry.account ?? { platform: "", id: entry.person_id ?? "" },
    name: entry.author ?? "",
    self: entry.kind === "self",
  };
}

interface Backed {
  entry: TranscriptEntry;
  evidence: EvidenceInput;
}

/**
 * Runs the segment pass over `input` (see the module comment). Provider errors are thrown as
 * they are; an unusable reply abandons the pass.
 */
export async function runSegmentPass(
  input: SegmentPassInput,
  deps: SegmentPassDeps,
): Promise<SegmentPassResult> {
  const caps = { ...DEFAULT_PASS_CAPS, ...deps.caps };
  const evidenceConfig = EvidenceConfigSchema.parse(deps.evidence ?? {});
  const notes = deps.notes;
  const usage: PassUsage = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  const entries = [...input.entries].sort((a, b) => a.seq - b.seq);
  const first = entries[0]?.seq ?? 0;
  const last = entries.at(-1)?.seq ?? 0;
  const segment: SegmentRef = { session: input.session, seq_from: first, seq_to: last };
  const result: SegmentPassResult = {
    status: "applied",
    error: null,
    segment,
    episode: null,
    applied: [],
    dropped: [],
    followups: [],
    closed: [],
    updated: [],
    promises: [],
    usage,
  };
  const spoken = entries.filter(
    (e) => (e.kind === "other" || e.kind === "self") && e.redacted_at === null && e.content !== "",
  );
  if (spoken.length === 0) {
    result.status = "empty";
    const cursor = deps.cursor;
    if (cursor && last > 0) notes.tx(() => markProcessed(cursor, input.session, last));
    return result;
  }
  const here = placeScope(input.place);
  if (here === null) {
    result.status = "abandoned";
    result.error = "the place names nothing to scope what is learned by";
    return result;
  }

  // Who is here, by code.
  const people: PromptPerson[] = [];
  for (const p of input.people) {
    if (people.some((x) => x.person === p.person)) continue;
    people.push({
      code: `p${people.length + 1}`,
      person: p.person,
      name: p.name,
      names: [...new Set([p.name, ...(p.names ?? [])])].filter((n) => n.trim() !== ""),
    });
  }
  const viewer: NotesViewer = viewerOf(
    input.place,
    people.map((p) => p.person),
  );

  // The documents shown, and the lines they show.
  const budget = Math.max(200, deps.documentChars ?? 1500);
  const shown: Shown[] = people.map((p) => ({
    subject: personSubject(p.person),
    kind: "person",
    title: p.name,
    ref: p.code,
    person: p.person,
  }));
  const placeKey = input.place.dm === null ? (input.place.space ?? input.place.room) : null;
  if (placeKey !== null) {
    shown.push({
      subject: placeSubject(placeKey),
      kind: "place",
      title: input.placeName ?? "",
      ref: "地點",
      person: null,
    });
  }
  const topicSubjects = new Set<string>();
  for (const name of input.topics ?? []) topicSubjects.add(topicSubject(name));
  const said = spoken.map((e) => e.content).join("\n");
  const related = deps.search
    ? await deps.search.documents(said, viewer, {
        kind: "topic",
        limit: 3,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      })
    : notes.search(said, viewer, { kind: "topic", limit: 3 });
  for (const hit of related) topicSubjects.add(hit.document.subject);
  for (const subject of topicSubjects) {
    const doc = notes.document(subject);
    const name = doc?.title || subject.slice("topic:".length);
    shown.push({ subject, kind: "topic", title: name, ref: `主題:${name}`, person: null });
  }
  const linesBySubject = new Map<string, NoteLine[]>();
  const all: NoteLine[] = [];
  for (const d of shown) {
    const lines = within(notes.lines(d.subject, viewer), budget);
    linesBySubject.set(d.subject, lines);
    all.push(...lines);
  }
  const refs = lineRefs(all);
  const refOf = new Map([...refs.entries()].map(([ref, line]) => [line.id, ref]));
  const subjectOfLine = new Map<string, Shown>();
  for (const d of shown)
    for (const l of linesBySubject.get(d.subject) ?? []) subjectOfLine.set(l.id, d);
  const documents: PromptDocument[] = shown.map((d) => ({
    ref: d.ref,
    title: d.title,
    kind: d.kind,
    lines: (linesBySubject.get(d.subject) ?? []).map((line) => ({
      ref: refOf.get(line.id) ?? line.id,
      line,
    })),
  }));

  // What is still open here: her follow-ups about these people, her promises made in this place.
  const sink = deps.episodes ?? null;
  const context = input.context ?? null;
  const ledger = context === null ? null : (deps.promises ?? null);
  let openFollowups: OpenFollowup[] = [];
  if (sink?.openFollowups) {
    try {
      openFollowups = await sink.openFollowups(
        {
          people: people.map((p) => p.person),
          scope: here,
          session: input.session,
          limit: Math.max(0, caps.open),
          at: toTimestamp(deps.now()),
        },
        deps.signal,
      );
    } catch {
      openFollowups = [];
    }
  }
  const openPromises: OpenPromise[] =
    ledger === null || context === null ? [] : ledger.open(context);
  const followupRefs = new Map(openFollowups.map((f, i) => [`f${i + 1}`, f]));
  const promiseRefs = new Map(
    openPromises.slice(-Math.max(0, caps.open)).map((p, i) => [`c${i + 1}`, p]),
  );
  const nameOfPerson = (person: PersonId | null) =>
    person === null ? null : (people.find((p) => p.person === person)?.name ?? null);
  const open: PromptOpen[] = [
    ...[...followupRefs].map(([ref, f]) => ({
      ref,
      kind: "followup" as const,
      text: f.about,
      who: nameOfPerson(f.person),
    })),
    ...[...promiseRefs].map(([ref, p]) => ({
      ref,
      kind: "promise" as const,
      text: p.what,
      who: null,
    })),
  ];

  const placeLabel =
    input.place.dm !== null
      ? "私訊(一對一)"
      : `伺服器頻道${input.placeName ? `「${input.placeName}」` : ""}`;
  const request: ChatRequest = {
    messages: [
      systemMessage(segmentPassPrompt()),
      userMessage(
        segmentPassMessage({
          placeLabel,
          people,
          entries,
          documents,
          open,
          self: notes.readSelf({ budget: deps.selfChars ?? 500 }),
        }),
      ),
    ],
    json_mode: true,
    temperature: 0.2,
    max_tokens: deps.maxTokens ?? 3000,
    ...(deps.requestSession ? { session: deps.requestSession } : {}),
  };
  const counting: Completer = {
    async complete(purpose, req, signal): Promise<ChatResponse> {
      const response = await deps.router.complete(purpose, req, signal);
      usage.calls += 1;
      usage.prompt_tokens += response.usage?.prompt_tokens ?? 0;
      usage.completion_tokens += response.usage?.completion_tokens ?? 0;
      return response;
    },
  };
  let reply: SegmentReply;
  try {
    const done = await withLlmTag({ module: "notes", label: "segment" }, () =>
      completeJson(counting, deps.purpose ?? "summarizer", request, SegmentReplySchema, {
        repairs: 1,
        ...(deps.signal ? { signal: deps.signal } : {}),
      }),
    );
    reply = done.value;
  } catch (error) {
    if (!(error instanceof StructuredOutputError)) throw error;
    result.status = "abandoned";
    result.error = error.message;
    return result;
  }

  // ---- checking every edit --------------------------------------------------------------------

  const now = deps.now();
  const names = nameWords(people.flatMap((p) => p.names));
  const others = spoken.filter((e) => e.kind === "other");
  // What she read of another place backs nothing here (`fromElsewhere`).
  const tools = entries.filter(
    (e) => e.kind === "tool_result" && e.redacted_at === null && !fromElsewhere(e.content),
  );
  const drop = (index: number, op: Edit["op"], reason: DropReason, detail: string) => {
    result.dropped.push({ index, op, reason, detail });
  };
  /** The entries of `pool` backing `statement`, the cited one first; `null`: none. */
  const back = (
    statement: string,
    edit: { quote: string; seq: number | null },
    pool: readonly TranscriptEntry[],
  ): Backed | null => {
    if (pool.length === 0) return null;
    const quote = normalize(edit.quote);
    const cited = pool.filter(
      (e) => e.seq === edit.seq || (chars(quote) >= 2 && normalize(e.content).includes(quote)),
    );
    const lines = (list: readonly TranscriptEntry[]) => list.map(evidenceLine);
    let found = supporting(statement, lines(cited), evidenceConfig, names);
    if (found.length === 0) found = supporting(statement, lines(pool), evidenceConfig, names);
    const hit = found[0];
    if (hit === undefined) return null;
    const entry = pool.find((e) => evidenceLine(e).ref === hit.ref) as TranscriptEntry;
    return { entry, evidence: evidenceOf(entry, edit.quote) };
  };
  const evidenceOf = (entry: TranscriptEntry, quote: string): EvidenceInput => {
    const q = normalize(quote);
    const inside = chars(q) >= 2 && normalize(entry.content).includes(q);
    return {
      quote: inside ? quote : entry.content,
      person_id: entry.kind === "other" ? entry.person_id : null,
      session: input.session,
      seq_from: entry.seq,
      seq_to: entry.seq,
      message_id: entry.message_id,
    };
  };
  /** Where a quote is in the segment, among `pool`; `null`: it is not. */
  const quoted = (
    edit: { quote: string; seq: number | null },
    pool: readonly TranscriptEntry[],
  ) => {
    const q = normalize(edit.quote);
    if (chars(q) < 2) return null;
    const entry =
      pool.find((e) => e.seq === edit.seq && normalize(e.content).includes(q)) ??
      pool.find((e) => normalize(e.content).includes(q)) ??
      pool.find(
        (e) =>
          e.seq === edit.seq &&
          supporting(edit.quote, [evidenceLine(e)], evidenceConfig).length > 0,
      );
    return entry === undefined ? null : { entry, evidence: evidenceOf(entry, edit.quote) };
  };

  interface Planned {
    index: number;
    op: NoteOp;
    edit: Edit;
    provenance: Provenance | null;
    scope: NoteScope | null;
  }
  const planned = new Map<string, Planned[]>();
  const titles = new Map<string, string>();
  let adds = 0;
  let changes = 0;
  const added: Array<{ subject: string; text: string }> = [];

  /** Provenance, who told, confidence and evidence of a statement about `doc`, or why not. */
  const judge = (
    doc: Shown,
    section: string,
    statement: string,
    edit: Edit & { op: "add" | "replace" },
  ): {
    provenance: Provenance;
    told_by: PersonId | null;
    confidence: number;
    evidence: EvidenceInput[];
  } | null => {
    const asked = provenanceOf(edit.source);
    if (doc.kind === "person" && doc.person !== null) {
      if (section === HER_VIEW_SECTION) {
        const found = quoted(edit, [...spoken, ...tools]);
        return {
          provenance: "concluded",
          told_by: null,
          confidence: 0.4,
          evidence: found ? [found.evidence] : [],
        };
      }
      const own = back(
        statement,
        edit,
        others.filter((e) => e.person_id === doc.person),
      );
      if (own !== null) {
        return {
          provenance: "told_by_subject",
          told_by: doc.person,
          confidence: 0.9,
          evidence: [own.evidence],
        };
      }
      const heard = back(
        statement,
        edit,
        others.filter((e) => e.person_id !== doc.person),
      );
      if (heard !== null) {
        return {
          provenance: "told_by_other",
          told_by: heard.entry.person_id,
          confidence: 0.5,
          evidence: [heard.evidence],
        };
      }
      if (asked === "observed") {
        const seen = back(statement, edit, tools);
        if (seen !== null) {
          return {
            provenance: "observed",
            told_by: null,
            confidence: 0.8,
            evidence: [seen.evidence],
          };
        }
      }
      return null;
    }
    const found = back(statement, edit, [...spoken, ...tools]);
    if (found === null) return null;
    const by = found.entry.kind === "other" ? found.entry.person_id : null;
    return by !== null
      ? { provenance: "told_by_other", told_by: by, confidence: 0.7, evidence: [found.evidence] }
      : { provenance: "observed", told_by: null, confidence: 0.8, evidence: [found.evidence] };
  };

  /** The document an `add` names; a string: why it may not be written. */
  const docOf = (ref: string): Shown | DropReason => {
    const r = ref.trim();
    const lower = r.toLowerCase();
    if (["self", "我", "我自己", "我最近是誰"].includes(r) || lower === SELF_SUBJECT)
      return "self_document";
    const code = people.find((p) => p.code === lower || p.names.includes(r));
    if (code) return shown.find((d) => d.person === code.person) as Shown;
    if (["地點", "這裡", "place"].includes(lower) || lower.startsWith("place:")) {
      return shown.find((d) => d.kind === "place") ?? "no_place";
    }
    const topic = /^(?:主題|topic)\s*[::]\s*(.+)$/i.exec(r);
    if (topic?.[1]) {
      const name = cleanLine(topic[1]);
      if (name === "") return "unknown_document";
      const subject = topicSubject(name);
      const known = shown.find((d) => d.subject === subject);
      if (known) return known;
      const doc: Shown = { subject, kind: "topic", title: name, ref: `主題:${name}`, person: null };
      shown.push(doc);
      return doc;
    }
    const parsed = parseSubject(r);
    if (parsed?.kind === "self") return "self_document";
    return shown.find((d) => d.subject === r) ?? "unknown_document";
  };

  const perDoc = new Map<string, number>();
  const plan = (doc: Shown, p: Planned): boolean => {
    const n = perDoc.get(doc.subject) ?? 0;
    if (n >= caps.perDocument) {
      drop(p.index, p.edit.op, "cap", `at most ${caps.perDocument} edits of one document`);
      return false;
    }
    perDoc.set(doc.subject, n + 1);
    const list = planned.get(doc.subject) ?? [];
    list.push(p);
    planned.set(doc.subject, list);
    if (doc.title !== "") titles.set(doc.subject, doc.title);
    return true;
  };
  const inUse = (subject: string) => linesBySubject.get(subject) ?? [];
  const repeats = (subject: string, statement: string) =>
    inUse(subject).some((l) => textSimilarity(l.text, statement) >= 0.85) ||
    added.some((a) => a.subject === subject && textSimilarity(a.text, statement) >= 0.85);

  /** Checks one edit and plans it; what it returns is why it was left out. */
  const check = (edit: Edit, index: number): [DropReason, string] | null => {
    if (edit.op === "add") {
      const doc = docOf(edit.doc);
      if (typeof doc === "string") return [doc, `\`${edit.doc}\``];
      const statement = cleanLine(namesForCodes(edit.text, people));
      if (statement === "") return ["empty", "nothing left of the text"];
      if (isPresentState(statement)) return ["present_state", statement];
      const section = sectionKey(doc.kind, edit.section) ?? MISC_SECTION;
      if (repeats(doc.subject, statement)) return ["duplicate", statement];
      const judged = judge(doc, section, statement, edit);
      if (judged === null) return ["no_evidence", statement];
      if (adds >= caps.adds) return ["cap", `at most ${caps.adds} new lines`];
      const ok = plan(doc, {
        index,
        edit,
        provenance: judged.provenance,
        scope: here,
        op: {
          op: "add",
          section,
          text: statement,
          provenance: judged.provenance,
          told_by: judged.told_by,
          scope: here,
          confidence: judged.confidence,
          evidence: judged.evidence,
        },
      });
      if (ok) {
        adds++;
        added.push({ subject: doc.subject, text: statement });
      }
      return null;
    }
    const line = refs.get(edit.line.trim().toLowerCase()) ?? null;
    const doc = line === null ? undefined : subjectOfLine.get(line.id);
    if (line === null || doc === undefined) {
      return ["unknown_line", `\`${edit.line}\` was not shown`];
    }
    if (edit.op === "replace") {
      const statement = cleanLine(namesForCodes(edit.text, people));
      if (statement === "") return ["empty", "nothing left of the text"];
      if (isPresentState(statement)) return ["present_state", statement];
      if (normalize(statement) === normalize(line.text)) {
        return ["duplicate", "the same as the line it replaces"];
      }
      const judged = judge(doc, line.section, statement, edit);
      if (judged === null) return ["no_evidence", statement];
      const scope = replacementScope(line.scope, input.place);
      if (scope === null) return ["bad_scope", "no scope here"];
      if (changes >= caps.changes) return ["cap", `at most ${caps.changes} changes`];
      if (
        plan(doc, {
          index,
          edit,
          provenance: judged.provenance,
          scope,
          op: {
            op: "replace",
            line: line.id,
            text: statement,
            provenance: judged.provenance,
            told_by: judged.told_by,
            scope,
            confidence: judged.confidence,
            evidence: judged.evidence,
          },
        })
      ) {
        changes++;
      }
      return null;
    }
    // outdate
    const fact = doc.kind === "person" && line.section !== HER_VIEW_SECTION;
    const found = quoted(edit, fact ? others : [...spoken, ...tools]);
    if (found === null) return ["no_evidence", "the quote is not in the segment"];
    if (changes >= caps.changes) return ["cap", `at most ${caps.changes} changes`];
    const reason = cleanLine(namesForCodes(edit.reason, people));
    if (
      plan(doc, {
        index,
        edit,
        provenance: null,
        scope: null,
        op: { op: "outdate", line: line.id, reason: reason === "" ? "no longer true" : reason },
      })
    ) {
      changes++;
    }
    return null;
  };
  reply.edits.forEach((edit, index) => {
    const why = check(edit, index);
    if (why !== null) drop(index, edit.op, why[0], why[1]);
  });

  // ---- writing --------------------------------------------------------------------------------

  notes.tx(() => {
    for (const [subject, list] of planned) {
      const done = notes.apply(
        subject,
        list.map((p) => p.op),
        { author: "segment", reason: "segment pass", segment, lenient: true },
        titles.get(subject),
      );
      for (const a of done.applied) {
        const p = list[a.index] as Planned;
        result.applied.push({
          index: p.index,
          op: p.edit.op,
          subject,
          line: a.line,
          replaced: a.replaced,
          provenance: p.provenance,
          scope: p.scope,
        });
      }
      for (const r of done.refused) {
        const p = list[r.index] as Planned;
        drop(p.index, p.edit.op, r.code, r.message);
      }
    }
    if (deps.cursor) markProcessed(deps.cursor, input.session, last);
  });
  result.applied.sort((a, b) => a.index - b.index);
  result.dropped.sort((a, b) => a.index - b.index);

  // ---- the episode and the follow-ups ---------------------------------------------------------

  const at = toTimestamp(now);
  const personOf = (who: string | null): PersonId | null => {
    if (who === null) return null;
    const w = who.trim();
    return people.find((p) => p.code === w.toLowerCase() || p.names.includes(w))?.person ?? null;
  };
  if (reply.episode !== null) {
    const summary = cleanLine(namesForCodes(reply.episode.summary, people));
    if (summary !== "") {
      const speakers = new Set<PersonId>();
      for (const e of others) {
        if (e.person_id !== null && people.some((p) => p.person === e.person_id))
          speakers.add(e.person_id);
      }
      for (const who of reply.episode.who) {
        const p = personOf(who);
        if (p !== null) speakers.add(p);
      }
      const feeling =
        reply.episode.feeling === null ? null : cleanLine(reply.episode.feeling) || null;
      const episode = {
        text: feeling === null ? summary : `${summary}(當時我的心情:${feeling})`,
        importance: reply.episode.importance,
        stored: null as string | null,
        error: null as string | null,
      };
      result.episode = episode;
      if (deps.episodes) {
        try {
          episode.stored = await deps.episodes.episode(
            {
              summary,
              feeling,
              importance: reply.episode.importance,
              people: [...speakers],
              scope: here,
              session: input.session,
              seq_from: first,
              seq_to: last,
              message_ids: entries.flatMap((e) => (e.message_id === null ? [] : [e.message_id])),
              at,
            },
            deps.signal,
          );
        } catch (error) {
          episode.error = errorMessage(error);
        }
      }
    }
  }
  // ---- what is still open ---------------------------------------------------------------------

  const allNames = people.flatMap((p) => p.names);
  const hoursAfter = (from: Timestamp, h: number) =>
    toTimestamp(timestampMs(from) + Math.round(h * 3_600_000));
  /** Two items about the same people (either naming nobody counts) and the same matter. */
  const same = (a: PersonId | null, aText: string, b: PersonId | null, bText: string) =>
    (a === null || b === null || a === b) && sameMatter(aText, bText, allNames);

  // Closed first: answered just now, it is not written again below.
  const closedIds = new Set<string>();
  for (const c of reply.close) {
    const ref = c.id.toLowerCase();
    const reason = cleanLine(namesForCodes(c.reason, people));
    const f = followupRefs.get(ref);
    if (f !== undefined) {
      if (closedIds.has(f.id)) continue;
      closedIds.add(f.id);
      let count = 0;
      try {
        count = (await sink?.closeFollowup?.(f.id, at, allNames)) ?? 0;
      } catch {
        count = 0;
      }
      result.closed.push({ kind: "followup", id: f.id, about: f.about, reason, count });
      continue;
    }
    const p = promiseRefs.get(ref);
    if (p === undefined || ledger === null || context === null || closedIds.has(p.id)) continue;
    // Kept once is all of them: an open promise here of the same matter is kept with it.
    let count = 0;
    for (const o of ledger.open(context)) {
      if (o.id !== p.id && !sameMatter(p.what, o.what, allNames)) continue;
      closedIds.add(o.id);
      if (ledger.keep(o.id)) count += 1;
    }
    result.closed.push({ kind: "promise", id: p.id, about: p.what, reason, count });
  }

  for (const u of reply.update) {
    const f = followupRefs.get(u.id.toLowerCase());
    if (f === undefined || closedIds.has(f.id) || !sink?.updateFollowup) continue;
    const about = u.about === null ? "" : cleanLine(namesForCodes(u.about, people));
    const due = u.due_in_hours === null ? null : hoursAfter(at, u.due_in_hours);
    if (about === "" && due === null) continue;
    try {
      const changed = await sink.updateFollowup(
        f.id,
        { about: about === "" ? null : about, due },
        at,
        deps.signal,
      );
      if (changed) result.updated.push(f.id);
    } catch {
      // left as it was
    }
  }

  for (const f of reply.followups.slice(0, caps.followups)) {
    const about = cleanLine(namesForCodes(f.about, people));
    if (about === "") continue;
    const person = personOf(f.who);
    const twin = [...followupRefs.values()].find((o) => same(o.person, o.about, person, about));
    const followup: PassFollowup = {
      about,
      person,
      due: hoursAfter(at, f.due_in_hours),
      same: twin?.id ?? null,
      stored: null,
    };
    result.followups.push(followup);
    const write = sink?.followup;
    if (twin === undefined && write) {
      try {
        followup.stored = await write.call(
          sink,
          {
            about,
            person: followup.person,
            due: followup.due,
            scope: here,
            session: input.session,
            at,
            names: allNames,
          },
          deps.signal,
        );
      } catch {
        followup.stored = null;
      }
    }
  }

  const made: OpenPromise[] = [];
  for (const p of reply.promises.slice(0, caps.promises)) {
    const what = cleanLine(namesForCodes(p.what, people));
    if (what === "") continue;
    // From when she said it: the line it cites, else the segment's last.
    const said = entries.find((e) => e.seq === p.seq && e.kind === "self") ?? entries.at(-1);
    const due = p.due_in_hours === null ? null : hoursAfter(said?.at ?? at, p.due_in_hours);
    const known = ledger === null || context === null ? [] : ledger.open(context);
    const twin = [...known, ...made].find((o) => sameMatter(o.what, what, allNames));
    const promise: PassPromise = {
      what,
      to: personOf(p.to),
      due,
      same: twin?.id ?? null,
      stored: null,
    };
    result.promises.push(promise);
    if (twin !== undefined || ledger === null || context === null) continue;
    promise.stored = ledger.make({ what, to: promise.to, due, context });
    if (promise.stored !== null) {
      made.push({ id: promise.stored, what, due: due ?? at, made_at: at });
    }
  }
  return result;
}
