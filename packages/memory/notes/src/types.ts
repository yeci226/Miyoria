// The shapes the notes store reads and writes (`store.ts`). Persisted, so snake_case and
// `T | null` with every key present on what is read back; what is written may leave fields out.

import type { PersonId, Timestamp } from "@miyoria/types";
import type { DocumentKind, HistoryOp, NoteAuthor, Provenance } from "./schema.js";
import type { NoteScope } from "./scope.js";

export type { DocumentKind, HistoryOp, NoteAuthor, NoteScopeType, Provenance } from "./schema.js";

/** A document as stored. */
export interface NoteDocument {
  id: string;
  /** `person:<person id>`, `place:<space or room id>`, `topic:<slug>` or `self`. */
  subject: string;
  kind: DocumentKind;
  person_id: PersonId | null;
  title: string;
  /** The number of its last change set; 0: never changed. */
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** What a line rests on: quoted words and where they are from. */
export interface NoteEvidence {
  /** Empty once redacted, and for a source without words. */
  quote: string;
  /** Who said them; `null`: herself, a tool, or not known. */
  person_id: PersonId | null;
  session: string | null;
  seq_from: number | null;
  seq_to: number | null;
  message_id: string | null;
  event_id: string | null;
  at: Timestamp;
  redacted: boolean;
}

/** Evidence to record with a write. */
export type EvidenceInput = Partial<Omit<NoteEvidence, "at" | "redacted">>;

/** The transcript segment a write was made from. */
export interface SegmentRef {
  session: string;
  seq_from: number;
  seq_to: number;
}

/** A line as stored. */
export interface NoteLine {
  id: string;
  document_id: string;
  /** The section's key (`sections.ts`). */
  section: string;
  /** Empty once redacted. */
  text: string;
  provenance: Provenance;
  told_by: PersonId | null;
  scope: NoteScope;
  confidence: number;
  author: NoteAuthor;
  /** The segment it was written from. */
  segment: SegmentRef | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  outdated_at: Timestamp | null;
  outdated_reason: string | null;
  replaced_by: string | null;
  redacted: boolean;
  evidence: NoteEvidence[];
}

/** A line to add. */
export interface LineInput {
  /** A section of the document's kind, by key or by label. */
  section: string;
  text: string;
  provenance: Provenance;
  scope: NoteScope;
  told_by?: PersonId | null;
  /** 0..1; default by provenance (`DEFAULT_CONFIDENCE`). */
  confidence?: number;
  evidence?: readonly EvidenceInput[];
  /** The importer's key: a line with it already there is left as it is. */
  import_key?: string | null;
}

/** One change to a document. */
export type NoteOp =
  | ({ op: "add" } & LineInput)
  | {
      op: "replace";
      /** The line replaced: its id, or `#` and the last characters of it. */
      line: string;
      text: string;
      /** Default: the replaced line's. */
      section?: string;
      provenance?: Provenance;
      scope?: NoteScope;
      told_by?: PersonId | null;
      confidence?: number;
      evidence?: readonly EvidenceInput[];
    }
  | { op: "outdate"; line: string; reason: string };

/** Lines put together into one (`NotesStore.merge`). */
export interface MergeInput {
  /** The lines it takes the place of: ids, or `#` and the last characters of one. */
  from: readonly string[];
  /** The line written instead; its scope must be the scope of every line of `from`. */
  line: LineInput;
}

/** Who makes a change set, and from what. */
export interface ChangeMeta {
  author: NoteAuthor;
  /** Why, in a few words; never anybody's words. */
  reason?: string | null;
  /** The segment the lines are written from. */
  segment?: SegmentRef | null;
  /**
   * `true`: an operation the store refuses is left out and reported (`ChangeResult.refused`), the
   * rest is written. Default: the first refusal throws and nothing is written.
   */
  lenient?: boolean;
}

/** What one operation of a change set did. */
export interface AppliedOp {
  /** Its place in the operations given. */
  index: number;
  op: NoteOp["op"];
  /** The line added (`add`, `replace`), or the one outdated. */
  line: string;
  /** `replace`: the line that was replaced. */
  replaced: string | null;
}

export interface RefusedOp {
  index: number;
  code: NotesErrorCode;
  message: string;
}

export interface ChangeResult {
  document: NoteDocument;
  /** The version the change set got; `null` when it changed nothing. */
  version: number | null;
  applied: AppliedOp[];
  refused: RefusedOp[];
}

/** One row of a document's history. */
export interface HistoryEntry {
  version: number;
  at: Timestamp;
  op: HistoryOp;
  author: NoteAuthor;
  reason: string | null;
  line_id: string;
  section: string;
  /** The line's text as it is now (empty once redacted). */
  text: string;
}

/** A document in a listing. */
export interface DocumentEntry {
  document: NoteDocument;
  /** Its lines in use that the reader may see. */
  lines: number;
}

export interface SearchHit extends DocumentEntry {
  /** 0..1: the share of the query's words the document holds. */
  score: number;
  /** The lines that matched, best first. */
  matches: NoteLine[];
}

/** Why the store refused something. */
export type NotesErrorCode =
  | "unknown_document"
  | "unknown_line"
  | "bad_subject"
  | "bad_section"
  | "bad_scope"
  | "bad_version"
  | "empty"
  | "too_long"
  | "document_full"
  | "section_full"
  | "outdated"
  | "duplicate"
  | "mixed_people";

/** Size limits, so a prompt card stays bounded. */
export interface NotesLimits {
  /** Characters of one line. */
  lineChars: number;
  /** Characters of one quote. */
  quoteChars: number;
  /** Evidence rows of one line. */
  evidencePerLine: number;
  /** Lines in use of one document. */
  linesPerDocument: number;
  /** Lines in use of one section. */
  linesPerSection: number;
  /** Lines in use of her self document. */
  selfLines: number;
  /** Characters of a title. */
  titleChars: number;
}
