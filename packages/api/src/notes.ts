// `/api/notes/*`: her documents (`@miyoria/memory/notes`) as the owner reads them, and the one
// thing the owner may do to them: roll a document back to a version. She writes them (her tools,
// the segment pass, the nightly reflection); the old `/api/knowledge` and `/api/notebook` routes
// read the same documents in their old shapes.

import type {
  NoteDocumentEntry,
  NoteDocumentView,
  NoteKind,
  NoteLineView,
  NoteVersion,
} from "@miyoria/contracts/api";
import { PeopleDirectoryKey } from "@miyoria/heart/person";
import {
  DOCUMENT_KINDS,
  type NoteDocument,
  type NoteLine,
  type NoteScope,
  NotesError,
  type NotesStore,
  notesTables,
  parseSubject,
  sectionLabel,
  sectionOrder,
  shortLineId,
} from "@miyoria/memory/notes";
import { StoreKey } from "@miyoria/store";
import type { PersonId } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import type { ApiState } from "./state.js";

function store(state: ApiState): NotesStore {
  const found = state.optional(StoreKey)?.plugin(notesTables);
  if (found === undefined) throw ApiError.unavailable("her documents are not available");
  return found;
}

function nameOf(state: ApiState, person: PersonId | null): string | null {
  return person === null ? null : (state.optional(PeopleDirectoryKey)?.displayName(person) ?? null);
}

function scopeLabel(state: ApiState, scope: NoteScope): string {
  switch (scope.type) {
    case "public":
      return "公開";
    case "self":
      return "她自己";
    case "space":
      return "某個伺服器";
    case "room":
      return "某個頻道";
    case "dm":
      return `和 ${nameOf(state, scope.person) ?? "某人"} 的私訊`;
    case "person":
      return `有 ${nameOf(state, scope.person) ?? "某人"} 在時`;
  }
}

function documentLabel(state: ApiState, notes: NotesStore, doc: NoteDocument): string {
  if (doc.kind === "self") return "她自己";
  if (doc.kind === "person") {
    return nameOf(state, doc.person_id) ?? (doc.title === "" ? doc.subject : doc.title);
  }
  if (doc.title !== "") return doc.title;
  const space = parseSubject(doc.subject)?.key ?? "";
  const guild = notes.resolver().guildOf(space);
  return guild === null ? doc.subject : `伺服器 ${guild.guild}`;
}

function entryOf(
  state: ApiState,
  notes: NotesStore,
  doc: NoteDocument,
  lines: number,
): NoteDocumentEntry {
  return {
    id: doc.id,
    short_id: shortLineId(doc.id),
    subject: doc.subject,
    kind: doc.kind,
    label: documentLabel(state, notes, doc),
    lines,
    version: doc.version,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

/** The document by its id; `404` for none. */
function need(notes: NotesStore, id: string): NoteDocument {
  const doc = id.length > 0 ? notes.documentByRef(id) : null;
  if (doc === null) throw ApiError.notFound(`no document \`${id.slice(0, 80)}\``);
  return doc;
}

function lineView(state: ApiState, line: NoteLine): NoteLineView {
  return {
    id: line.id,
    short_id: shortLineId(line.id),
    text: line.text,
    provenance: line.provenance,
    told_by: line.told_by,
    told_by_name: nameOf(state, line.told_by),
    scope: { type: line.scope.type, label: scopeLabel(state, line.scope) },
    confidence: line.confidence,
    author: line.author,
    evidence: line.evidence.map((e) => ({
      quote: e.quote,
      person_id: e.person_id,
      person_name: nameOf(state, e.person_id),
      at: e.at,
      redacted: e.redacted,
    })),
    created_at: line.created_at,
    updated_at: line.updated_at,
    outdated_at: line.outdated_at,
    outdated_reason: line.outdated_reason,
  };
}

function listView(state: ApiState, kind: NoteKind | undefined) {
  const notes = store(state);
  const all = notes.list("owner");
  const counts = DOCUMENT_KINDS.map((k) => {
    const of = all.filter((e) => e.document.kind === k);
    return { kind: k, documents: of.length, lines: of.reduce((n, e) => n + e.lines, 0) };
  });
  return {
    documents: all
      .filter((e) => kind === undefined || e.document.kind === kind)
      .map((e) => entryOf(state, notes, e.document, e.lines)),
    counts,
  };
}

function documentView(state: ApiState, id: string, outdated: boolean): NoteDocumentView {
  const notes = store(state);
  const doc = need(notes, id);
  const inUse = notes.lines(doc.subject, "owner");
  const all = notes.lines(doc.subject, "owner", { outdated: true });
  const shown = outdated ? all : inUse;
  const keys = [...new Set(shown.map((l) => l.section))].sort(
    (a, b) => sectionOrder(doc.kind, a) - sectionOrder(doc.kind, b),
  );
  return {
    document: entryOf(state, notes, doc, inUse.length),
    sections: keys.map((key) => ({
      key,
      label: sectionLabel(doc.kind, key),
      lines: shown.filter((l) => l.section === key).map((l) => lineView(state, l)),
    })),
    outdated: all.length - inUse.length,
  };
}

function historyView(state: ApiState, id: string) {
  const notes = store(state);
  const doc = need(notes, id);
  const byVersion = new Map<number, NoteVersion>();
  for (const h of notes.history(doc.subject)) {
    let v = byVersion.get(h.version);
    if (v === undefined) {
      v = { version: h.version, at: h.at, author: h.author, reason: h.reason, changes: [] };
      byVersion.set(h.version, v);
    }
    v.changes.push({
      op: h.op,
      line_id: h.line_id,
      section: h.section,
      section_label: sectionLabel(doc.kind, h.section),
      text: h.text,
    });
  }
  const inUse = notes.lines(doc.subject, "owner").length;
  return {
    document: entryOf(state, notes, doc, inUse),
    versions: [...byVersion.values()].sort((a, b) => a.version - b.version),
  };
}

/** The notes routes on the route table (`@miyoria/contracts/api`). */
export const notesRpc = {
  documents: os.notes.documents.handler(({ input, context }) =>
    listView(context.state, input.query.kind),
  ),
  document: os.notes.document.handler(({ input, context }) =>
    documentView(context.state, input.params.id, input.query.outdated === "true"),
  ),
  history: os.notes.history.handler(({ input, context }) =>
    historyView(context.state, input.params.id),
  ),
  /** Admin only. Writes a new version (the old ones stay) and an audit record. */
  revert: os.notes.revert.handler(async ({ input, context }) => {
    const { state, c } = context;
    const notes = store(state);
    const doc = need(notes, input.params.id);
    const { version } = input.body;
    let result: ReturnType<NotesStore["revert"]>;
    try {
      result = notes.revert(doc.subject, version, {
        author: "panel",
        reason: `reverted to version ${version}`,
      });
    } catch (error) {
      await state.audit(c, "notes.revert", doc.subject, { version }, false);
      if (error instanceof NotesError && error.code === "bad_version") {
        throw ApiError.badRequest(error.message);
      }
      throw error;
    }
    await state.audit(
      c,
      "notes.revert",
      doc.subject,
      {
        version,
        made: result.version,
        restored: result.restored.length,
        outdated: result.outdated.length,
      },
      true,
    );
    return {
      document: entryOf(state, notes, result.document, notes.lines(doc.subject, "owner").length),
      version: result.version,
      restored: result.restored.length,
      outdated: result.outdated.length,
      gone: result.gone.length,
    };
  }),
};
