// Her knowledge documents over the notes: `knowledge_note` and the nightly reflection change
// documents with the same changes as before (`KnowledgeChange`), and the prompt reads them back.
//
// - A subject is a document: a person (`person:<id>`), a server (`place:<space>`), a topic she
//   names (`topic:<slug>`) or herself (`self`). `kind` (her label) is not stored; the title is a
//   topic's name or a place's first title.
// - The content is JSON; the notes hold lines. A leaf of the content is a line `a / b: text`; when
//   its first key is a section of the document's kind (`喜好`, `規矩` ...) the line goes in that
//   section without the key, else in `其他`. A patch finds the lines it changes by the same
//   labels: a pointer names every line under it (an array's index is not kept).
// - Who may change what follows who wrote it: the owner and her own reflection (`panel`, `self`)
//   anything; a person anything in their own document; otherwise only the lines the writer told
//   her (`said`) or wrote down as her own conclusion (`inferred`). Her self document is hers and
//   the reflection's.
// - What is written takes the scope of the place it is written in (`self` with no place), and how
//   she knows it from who writes (told by the subject, told by someone else, concluded).

import type {
  AccountRef,
  ContextKey,
  FieldSource,
  JsonValue,
  KnowledgeBase,
  KnowledgeChange,
  KnowledgeDoc,
  KnowledgeResult,
  KnowledgeSubject,
  KnowledgeVersion,
  KnowledgeWriter,
  PatchOp,
  PersonId,
} from "@miyoria/types";
import { cleanKey } from "../../learning/src/json-doc.js";
import { leaves, pieces } from "./importer.js";
import type { DocumentKind, NoteAuthor, Provenance } from "./schema.js";
import type { NoteScope, NotesReader, NotesViewer, ScopeResolver } from "./scope.js";
import { MISC_SECTION, sectionKey, sectionLabel } from "./sections.js";
import {
  type CardOptions,
  cleanLine,
  DEFAULT_CONFIDENCE,
  NotesError,
  type NotesStore,
  parseSubject,
  personSubject,
  placeSubject,
  SELF_SUBJECT,
  shortLineId,
  topicSubject,
} from "./store.js";
import type { NoteDocument, NoteLine, NoteOp } from "./types.js";

export const KIND_LABEL: Readonly<Record<DocumentKind, string>> = {
  person: "人物",
  place: "地點",
  topic: "主題",
  self: "自己",
};

/** Who a line is attributed to, in the old words. */
function sourceKind(line: NoteLine): FieldSource["kind"] {
  if (line.author === "reflect") return "self";
  if (line.author === "panel") return "panel";
  return line.provenance === "told_by_subject" || line.provenance === "told_by_other"
    ? "said"
    : "inferred";
}

/** A document that is none of the subjects of a change, or the reason it cannot be one. */
interface Resolved {
  subject: string;
  kind: DocumentKind;
  /** The title to give the document when it is made. */
  title: string | undefined;
}

export interface NotesKnowledgeOptions {
  notes: NotesStore;
  resolver: ScopeResolver;
  /** What a document is called in the prompt; default: its title, else its subject. */
  titleOf?: (document: NoteDocument) => string;
}

const privileged = (w: KnowledgeWriter) => w.kind === "self" || w.kind === "panel";

const authorOf = (w: KnowledgeWriter): NoteAuthor =>
  w.kind === "self" ? "reflect" : w.kind === "panel" ? "panel" : "tool";

/** The tokens of a JSON pointer that name something (an array's index and `-` do not). */
function labelsOf(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"))
    .filter((t) => !/^(?:\d+|-)$/.test(t));
}

/** The section and the line's text of a statement under `labels`, in a `kind` document. */
function place(
  kind: DocumentKind,
  labels: readonly string[],
  text: string,
): { section: string; text: string } {
  const [head, ...rest] = labels;
  const key = head === undefined ? null : sectionKey(kind, head);
  const used = key === null ? labels : rest;
  return {
    section: key ?? MISC_SECTION,
    text: cleanLine(used.length > 0 ? `${used.join(" / ")}: ${text}` : text),
  };
}

/** Her documents as `KnowledgeBase` changes and prompt text, on the notes. */
export class NotesKnowledge {
  readonly notes: NotesStore;
  readonly resolver: ScopeResolver;
  readonly #titleOf: (document: NoteDocument) => string;

  constructor(options: NotesKnowledgeOptions) {
    this.notes = options.notes;
    this.resolver = options.resolver;
    this.#titleOf = options.titleOf ?? ((d) => (d.title === "" ? d.subject : d.title));
  }

  /** Who reads from `context`: the place it is and the people of `accounts` that identity knows. */
  viewerFor(context: ContextKey | null, accounts: readonly AccountRef[] = []): NotesViewer {
    const present = accounts.flatMap((a) => {
      const p = this.resolver.personOf(a);
      return p === null ? [] : [p];
    });
    if (context === null) return { space: null, room: null, dm: null, present: [] };
    const dm = context.kind === "dm" || context.scope === null;
    return {
      space: dm ? null : this.resolver.spaceOf(context.platform, context.scope as string),
      room: this.resolver.roomOf(context),
      dm: dm ? (present[0] ?? null) : null,
      present,
    };
  }

  // ---- subjects, places, provenance ---------------------------------------------------------

  #resolve(subject: KnowledgeSubject, title: string): Resolved | string {
    switch (subject.type) {
      case "person":
        return { subject: personSubject(subject.person), kind: "person", title: undefined };
      case "guild": {
        const space = this.resolver.spaceOf(subject.platform, subject.guild);
        return space === null
          ? "this server is not known yet"
          : { subject: placeSubject(space), kind: "place", title };
      }
      case "self":
        return { subject: SELF_SUBJECT, kind: "self", title: undefined };
      case "topic": {
        const name = cleanKey(subject.name);
        return name === ""
          ? "bad subject"
          : { subject: topicSubject(name), kind: "topic", title: name };
      }
    }
  }

  #scopeOf(writer: KnowledgeWriter): NoteScope | null {
    const c: ContextKey | null = writer.context;
    if (c === null) return { type: "self" };
    if (c.kind === "dm" || c.scope === null) {
      const person =
        writer.person ?? (writer.account === null ? null : this.resolver.personOf(writer.account));
      return person === null ? null : { type: "dm", person };
    }
    const space = this.resolver.spaceOf(c.platform, c.scope);
    return space === null ? null : { type: "space", space };
  }

  #provenance(
    writer: KnowledgeWriter,
    about: PersonId | null,
    confidence: number | undefined,
  ): { provenance: Provenance; told_by: PersonId | null; confidence: number } {
    let provenance: Provenance;
    let told_by: PersonId | null = null;
    if (writer.kind === "said") {
      told_by = writer.person;
      provenance = about !== null && writer.person === about ? "told_by_subject" : "told_by_other";
    } else {
      provenance = writer.kind === "panel" ? "observed" : "concluded";
    }
    const most = DEFAULT_CONFIDENCE[provenance];
    return {
      provenance,
      told_by,
      confidence: privileged(writer) ? (confidence ?? most) : Math.min(confidence ?? most, most),
    };
  }

  /** Whether `writer` may change `line` of `doc`. */
  #mayChange(writer: KnowledgeWriter, doc: NoteDocument, line: NoteLine): boolean {
    if (privileged(writer)) return true;
    if (doc.person_id !== null && writer.person === doc.person_id) return true;
    if (writer.kind === "said") return writer.person !== null && line.told_by === writer.person;
    return line.author === "tool" && line.provenance === "concluded";
  }

  #stub(doc: NoteDocument, kind: string, title: string): KnowledgeDoc {
    const parsed = parseSubject(doc.subject);
    const guild = parsed?.kind === "place" ? this.resolver.guildOf(parsed.key) : null;
    const subject: KnowledgeSubject =
      doc.person_id !== null
        ? { type: "person", person: doc.person_id }
        : guild !== null
          ? { type: "guild", platform: guild.platform, guild: guild.guild }
          : doc.kind === "self"
            ? { type: "self" }
            : { type: "topic", name: parsed?.key ?? doc.subject };
    return {
      id: doc.id,
      subject,
      kind,
      title,
      content: {},
      sources: {},
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      version: doc.version,
      history: [],
    };
  }

  #need(ref: string): NoteDocument {
    const doc = this.notes.documentByRef(ref);
    if (doc === null) throw new NotesError("unknown_document", `no document \`${ref}\``);
    return doc;
  }

  // ---- changes ------------------------------------------------------------------------------

  /** The lines of `doc` in use that a change under `labels` touches. */
  #under(doc: NoteDocument, labels: readonly string[]): NoteLine[] {
    const lines = this.notes.lines(doc.subject, "owner");
    if (labels.length === 0) return lines;
    const [head, ...rest] = labels;
    const key = head === undefined ? null : sectionKey(doc.kind, head);
    const section = key ?? MISC_SECTION;
    const used = key === null ? labels : rest;
    const prefix = used.join(" / ");
    return lines.filter(
      (l) =>
        l.section === section &&
        (used.length === 0 ||
          l.text.startsWith(`${prefix}: `) ||
          l.text.startsWith(`${prefix} / `)),
    );
  }

  /** The lines a patch adds for `value` under `pointer`. */
  #lines(doc: NoteDocument, pointer: string, value: JsonValue) {
    const found: Array<{ pointer: string; labels: string[]; text: string }> = [];
    leaves(value, "", labelsOf(pointer), found);
    const max = this.notes.limits.lineChars;
    return found.flatMap((leaf) =>
      pieces(cleanLine(leaf.text), max).map((piece) => place(doc.kind, leaf.labels, piece)),
    );
  }

  /**
   * Applies one change (all of it or none). A refusal comes back as `{ ok: false, error }` in
   * English, like the knowledge store's.
   */
  async apply(change: KnowledgeChange, writer: KnowledgeWriter): Promise<KnowledgeResult> {
    try {
      return this.notes.tx(() => this.#apply(change, writer));
    } catch (error) {
      if (error instanceof NotesError) return { ok: false, error: error.message };
      throw error;
    }
  }

  #apply(change: KnowledgeChange, writer: KnowledgeWriter): KnowledgeResult {
    const why = change.why;
    const meta = { author: authorOf(writer), reason: why === "" ? null : why, lenient: false };
    switch (change.type) {
      case "create": {
        const kind = cleanKey(change.kind);
        const title = cleanKey(change.title);
        if (kind === "" || title === "") {
          throw new NotesError("empty", "a document needs a kind and a title");
        }
        const target = this.#resolve(change.subject, title);
        if (typeof target === "string") throw new NotesError("bad_subject", target);
        if (target.kind === "self" && !privileged(writer)) {
          throw new NotesError("outdated", "only she writes documents about herself");
        }
        const scope = this.#scopeOf(writer);
        if (scope === null) throw new NotesError("bad_scope", "this place is not known yet");
        const existing = this.notes.document(target.subject);
        const doc = this.notes.ensure(
          target.subject,
          existing === null || existing.title === "" ? target.title : undefined,
        );
        const about = target.kind === "person" ? doc.person_id : null;
        const how = this.#provenance(writer, about, change.confidence);
        const ops = this.#lines(doc, "", change.content).map(
          (l): NoteOp => ({ op: "add", section: l.section, text: l.text, scope, ...how }),
        );
        const done = ops.length === 0 ? doc : this.notes.apply(target.subject, ops, meta).document;
        return { ok: true, doc: this.#stub(done, kind, title) };
      }
      case "patch": {
        const doc = this.#need(change.doc);
        if (doc.kind === "self" && !privileged(writer)) {
          throw new NotesError("outdated", "only she changes documents about herself");
        }
        if (change.ops.length === 0) throw new NotesError("empty", "no ops");
        if (change.ops.length > 30) throw new NotesError("too_long", "at most 30 ops at once");
        const scope = this.#scopeOf(writer);
        if (scope === null) throw new NotesError("bad_scope", "this place is not known yet");
        const how = this.#provenance(writer, doc.person_id, change.confidence);
        const ops: NoteOp[] = [];
        const outdated = new Set<string>();
        const take = (lines: readonly NoteLine[], path: string) => {
          for (const l of lines) {
            if (!this.#mayChange(writer, doc, l)) {
              throw new NotesError(
                "outdated",
                `\`${path}\` was written by someone else; only they (or she) can change it`,
              );
            }
            if (outdated.has(l.id)) continue;
            outdated.add(l.id);
            ops.push({ op: "outdate", line: l.id, reason: why === "" ? "changed" : why });
          }
        };
        const add = (pointer: string, value: JsonValue) => {
          for (const l of this.#lines(doc, pointer, value)) {
            ops.push({ op: "add", section: l.section, text: l.text, scope, ...how });
          }
        };
        for (const op of change.ops as readonly PatchOp[]) {
          if (op.op === "add") {
            add(op.path, op.value);
          } else if (op.op === "replace") {
            take(this.#under(doc, labelsOf(op.path)), op.path);
            add(op.path, op.value);
          } else if (op.op === "remove") {
            const lines = this.#under(doc, labelsOf(op.path));
            if (lines.length === 0) throw new NotesError("unknown_line", `no field \`${op.path}\``);
            take(lines, op.path);
          } else {
            const lines = this.#under(doc, labelsOf(op.from));
            if (lines.length === 0) throw new NotesError("unknown_line", `no field \`${op.from}\``);
            take(lines, op.from);
            for (const l of lines) {
              const at = l.text.indexOf(": ");
              const text = at < 0 ? l.text : l.text.slice(at + 2);
              const moved = place(doc.kind, labelsOf(op.path), text);
              ops.push({
                op: "add",
                section: moved.section,
                text: moved.text,
                scope: l.scope,
                provenance: l.provenance,
                told_by: l.told_by,
                confidence: l.confidence,
              });
            }
          }
        }
        if (ops.length === 0) throw new NotesError("empty", "the change writes nothing");
        const done = this.notes.apply(doc.subject, ops, meta).document;
        return { ok: true, doc: this.#stub(done, KIND_LABEL[done.kind], this.#titleOf(done)) };
      }
      case "retitle": {
        const doc = this.#need(change.doc);
        if (doc.kind === "self" && !privileged(writer)) {
          throw new NotesError("outdated", "only she changes documents about herself");
        }
        if (doc.kind === "person") {
          throw new NotesError("bad_subject", "a person's document is named for the person");
        }
        for (const l of this.notes.lines(doc.subject, "owner")) {
          if (!this.#mayChange(writer, doc, l)) {
            throw new NotesError("outdated", "parts of this document were written by someone else");
          }
        }
        const title = change.title === null ? doc.title : cleanKey(change.title);
        if (title === "") throw new NotesError("empty", "a document needs a kind and a title");
        const done = this.notes.ensure(doc.subject, title);
        return { ok: true, doc: this.#stub(done, change.kind ?? KIND_LABEL[done.kind], title) };
      }
      case "delete": {
        const doc = this.#need(change.doc);
        if (doc.kind === "self" && !privileged(writer)) {
          throw new NotesError("outdated", "only she changes documents about herself");
        }
        const lines = this.notes.lines(doc.subject, "owner");
        for (const l of lines) {
          if (!this.#mayChange(writer, doc, l)) {
            throw new NotesError("outdated", "parts of this document were written by someone else");
          }
        }
        if (lines.length > 0) {
          this.notes.apply(
            doc.subject,
            lines.map((l): NoteOp => ({ op: "outdate", line: l.id, reason: why || "deleted" })),
            meta,
          );
        }
        return { ok: true, doc: null };
      }
      case "merge": {
        const from = this.#need(change.doc);
        const into = this.#need(change.into);
        if (from.id === into.id) {
          throw new NotesError("duplicate", "cannot merge a document into itself");
        }
        if ((from.kind === "self" || into.kind === "self") && !privileged(writer)) {
          throw new NotesError("outdated", "only she changes documents about herself");
        }
        const lines = this.notes.lines(from.subject, "owner");
        for (const l of lines) {
          if (!this.#mayChange(writer, from, l)) {
            throw new NotesError("outdated", "parts of this document were written by someone else");
          }
        }
        const label = labelsOf(change.path).join(" / ") || this.#titleOf(from);
        const adds = lines.map((l): NoteOp => {
          const moved = place(into.kind, [], cleanLine(`${label}: ${l.text}`));
          return {
            op: "add",
            section: sectionKey(into.kind, l.section) ?? moved.section,
            text: moved.text,
            scope: l.scope,
            provenance: l.provenance,
            told_by: l.told_by,
            confidence: l.confidence,
          };
        });
        if (adds.length > 0) {
          this.notes.apply(into.subject, adds, meta);
          this.notes.apply(
            from.subject,
            lines.map(
              (l): NoteOp => ({ op: "outdate", line: l.id, reason: `merged into ${into.subject}` }),
            ),
            meta,
          );
        }
        const done = this.notes.document(into.subject) ?? into;
        return { ok: true, doc: this.#stub(done, KIND_LABEL[done.kind], this.#titleOf(done)) };
      }
    }
  }

  // ---- reading as documents -----------------------------------------------------------------

  /**
   * A document in the old shape: the lines in use, by section label, in the order they were
   * written; where each line came from; the change sets as versions. Everything: the reader is the
   * owner.
   */
  #asDoc(doc: NoteDocument): KnowledgeDoc {
    const lines = [...this.notes.lines(doc.subject, "owner")].reverse();
    const content: Record<string, string[]> = {};
    const sources: Record<string, FieldSource> = {};
    for (const l of lines) {
      const label = sectionLabel(doc.kind, l.section);
      const list = content[label] ?? [];
      content[label] = list;
      sources[`/${label}/${list.length}`] = {
        kind: sourceKind(l),
        account: null,
        name: null,
        origin: null,
        confidence: l.confidence,
        at: l.created_at,
      };
      list.push(l.text);
    }
    const stub = this.#stub(doc, KIND_LABEL[doc.kind], this.#titleOf(doc));
    return { ...stub, content, sources, history: this.#versions(doc) };
  }

  #versions(doc: NoteDocument): KnowledgeVersion[] {
    const byVersion = new Map<number, KnowledgeVersion>();
    for (const h of this.notes.history(doc.subject)) {
      let v = byVersion.get(h.version);
      if (v === undefined) {
        v = {
          version: h.version,
          at: h.at,
          by: h.author === "reflect" ? "self" : h.author === "panel" ? "panel" : "inferred",
          name: null,
          why: h.reason ?? "",
          ops: [],
        };
        byVersion.set(h.version, v);
      }
      v.ops.push(`${h.op} ${sectionLabel(doc.kind, h.section)}`);
    }
    return [...byVersion.values()].sort((a, b) => a.version - b.version);
  }

  /** The documents that have lines in use (an emptied one is as good as deleted). */
  docs(subject?: KnowledgeSubject): KnowledgeDoc[] {
    const wanted = subject === undefined ? null : this.#resolve(subject, "");
    if (typeof wanted === "string") return [];
    return this.notes
      .list("owner")
      .filter((e) => e.lines > 0 && (wanted === null || e.document.subject === wanted.subject))
      .map((e) => this.#asDoc(e.document));
  }

  /** A document by its id (or `#` and the end of it); `null`: none, or none with lines in use. */
  get(id: string): KnowledgeDoc | null {
    const doc = this.notes.documentByRef(id);
    if (doc === null) return null;
    return this.notes.lines(doc.subject, "owner").length === 0 ? null : this.#asDoc(doc);
  }

  /**
   * These documents as the `KnowledgeBase` the other modules read and write: the listing, changes
   * and prompt text all come from the notes (no context: everything, as for her reflection).
   */
  base(): KnowledgeBase {
    return {
      docs: (subject) => this.docs(subject),
      get: (id) => this.get(id),
      apply: (change, writer) => this.apply(change, writer),
      render: (subjects, options) => {
        if (options.context === null) return this.render(subjects, "owner", options.maxChars);
        const people = subjects.flatMap((s) => (s.type === "person" ? [s.person] : []));
        const viewer = this.viewerFor(options.context);
        const reader: NotesViewer =
          viewer.dm === null && viewer.space === null && people.length > 0
            ? { ...viewer, dm: people[0] ?? null, present: people }
            : viewer;
        return this.render(subjects, reader, options.maxChars);
      },
    };
  }

  // ---- reading for a prompt -----------------------------------------------------------------

  /**
   * The documents of `subjects` as the knowledge section: each with its short id, kind and title,
   * then a row per section of the lines `reader` may see. Within `maxChars`; documents past it
   * are listed by id and title only.
   */
  render(
    subjects: readonly KnowledgeSubject[],
    reader: NotesReader,
    maxChars: number,
    options: Pick<CardOptions, "query" | "vector" | "ranking"> = {},
  ): string {
    const seen = new Set<string>();
    const parts: string[] = [];
    const rest: string[] = [];
    let used = 0;
    for (const subject of subjects) {
      const target = this.#resolve(subject, "");
      if (typeof target === "string" || seen.has(target.subject)) continue;
      seen.add(target.subject);
      const doc = this.notes.document(target.subject);
      if (doc === null) continue;
      const card = this.notes.card(target.subject, reader, {
        budget: Math.max(0, Math.min(600, maxChars - used)),
        ...(options.query === undefined ? {} : { query: options.query }),
        ...(options.vector ? { vector: options.vector } : {}),
        ...(options.ranking === undefined ? {} : { ranking: options.ranking }),
      });
      if (card === "") continue;
      const head = `${shortLineId(doc.id)} ${KIND_LABEL[doc.kind]}「${this.#titleOf(doc)}」`;
      const block = `${head}\n${card
        .split("\n")
        .map((row) => `  ${row}`)
        .join("\n")}`;
      const length = [...block].length + 2;
      if (rest.length > 0 || used + length > maxChars) {
        if (rest.length < 30) rest.push(head);
        continue;
      }
      used += length;
      parts.push(block);
    }
    if (rest.length > 0) parts.push(`(內容放不下,只列標題:)\n${rest.join("\n")}`);
    return parts.join("\n\n");
  }
}
