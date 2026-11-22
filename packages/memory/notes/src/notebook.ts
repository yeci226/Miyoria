// Her notebook over the notes: the same paths, tools and limits as the notebook pages
// (`memory/src/notebook.ts`), the text kept as lines of a document.
//
// | path                          | document                 | section                              |
// |-------------------------------|--------------------------|--------------------------------------|
// | `人/<handle>` of a known person | `person:<id>`            | by heading or `label:`, else `misc`  |
// | `人/<name>` nobody has        | `topic:人/<name>`        | same                                 |
// | `自己/<section>`               | `self`                   | that section (a label), else `misc`  |
// | `主題/<name>`, any other path | `topic:<name>`           | same                                 |
//
// - A write is one change set (author `tool`): each row of the text is a line, `observed` at 0.6
//   like an imported page. `append` adds lines; `replace` marks the lines in use that were written
//   to this place's scope (and this section, for `自己/…`) outdated first. Nothing is deleted:
//   `notebook_delete` marks the same lines outdated.
// - The scope of what is written is the place it is written in (`self` with no place, the space of
//   a server, the partner of a DM), so a DM's lines are read only in that DM as before. Reading a
//   path shows every line of the document the place may see, with the ids and dates the document
//   view has, so lines the segment pass wrote show up too.
// - The limits are the notebook's (`NotebookConfig`) with their texts: characters of a page, pages,
//   writes per hour. The lines of a document and of her self document are limited by the notes
//   themselves (`NotesLimits`).
// - The page limit is on what she wrote down herself: the documents with a line in use written
//   through these tools. The documents the segment pass, the reflection and the import made are
//   not hers to tidy from here, so they do not fill her notebook. Only a write that starts a
//   document (one with no line in use anywhere) is counted, so a full notebook can still be
//   rewritten, shortened and added to: tidying never needs room first.
// - A rewrite or a delete takes out the lines of this place only. When the page has lines written
//   elsewhere, the answer says how many stay, so the one tidying knows what it could not reach.

import {
  type Clock,
  type HandleDirectory,
  type Notebook,
  type NotebookEntry,
  type NotebookPage,
  type NotebookWhere,
  type PersonId,
  systemClock,
} from "@miyoria/types";
import type { NotebookConfig } from "../../memory/src/config.js";
import {
  cleanBody,
  cleanPath,
  NotebookError,
  type WriteMode,
  type WriteResult,
} from "../../memory/src/notebook.js";
import { bodyLines } from "./importer.js";
import type { DocumentKind } from "./schema.js";
import { type NoteScope, type NotesViewer, type ScopeResolver, sameScope } from "./scope.js";
import { MISC_SECTION, sectionKey, sectionLabel } from "./sections.js";
import {
  NotesError,
  type NotesStore,
  parseSubject,
  personSubject,
  SELF_SUBJECT,
  topicSubject,
} from "./store.js";
import type { NoteOp } from "./types.js";

/** Folder of the pages about a person, and of her own. */
const PERSON_FOLDER = "人";
const SELF_FOLDER = "自己";
const TOPIC_FOLDER = "主題";
/** Notebook lines are what she wrote down herself. */
const WRITTEN_CONFIDENCE = 0.6;
/** Characters of a document's text read in one go (the tool cuts it by `read_chars`). */
const READ_ALL = 200_000;

const chars = (s: string) => [...s].length;

/** What a path stands for. */
interface Target {
  subject: string;
  kind: DocumentKind;
  title: string | undefined;
  /** `自己/<name>`: the section of the self document it is; `null`: the whole document. */
  section: string | null;
}

export interface NotesNotebookOptions {
  notes: NotesStore;
  resolver: ScopeResolver;
  config: () => NotebookConfig;
  handles?: () => HandleDirectory | null;
  clock?: Clock;
}

/** Her notebook on the notes; also the `Notebook` the panel and `/me memory forget` read. */
export class NotesNotebook implements Notebook {
  readonly #notes: NotesStore;
  readonly #resolver: ScopeResolver;
  readonly #config: () => NotebookConfig;
  readonly #handles: () => HandleDirectory | null;
  readonly #clock: Clock;
  /** Write times of the last hour (ms). */
  #writes: number[] = [];

  constructor(options: NotesNotebookOptions) {
    this.#notes = options.notes;
    this.#resolver = options.resolver;
    this.#config = options.config;
    this.#handles = options.handles ?? (() => null);
    this.#clock = options.clock ?? systemClock;
  }

  // ---- paths and places ---------------------------------------------------------------------

  #target(path: string): Target {
    const parts = path.split("/");
    const folder = parts[0] ?? "";
    if (folder === PERSON_FOLDER && parts.length > 1) {
      const person = this.#handles()?.resolve(parts.slice(1).join("/"))?.person ?? null;
      if (person !== null) {
        return { subject: personSubject(person), kind: "person", title: undefined, section: null };
      }
    }
    if (folder === SELF_FOLDER) {
      const name = parts.slice(1).join("/");
      return {
        subject: SELF_SUBJECT,
        kind: "self",
        title: undefined,
        section: name === "" ? null : (sectionKey("self", name) ?? MISC_SECTION),
      };
    }
    const name = (folder === TOPIC_FOLDER ? parts.slice(1) : parts).join("/");
    const title = name === "" ? path : name;
    return { subject: topicSubject(title), kind: "topic", title, section: null };
  }

  /** The path a document is listed and read by. */
  #pathOf(subject: string, title: string, person: PersonId | null): string {
    if (person !== null) {
      const handle = this.#handles()?.ofPerson(person) ?? null;
      return `${PERSON_FOLDER}/${handle ?? (title === "" ? person.slice(-6) : title)}`;
    }
    const parsed = parseSubject(subject);
    const name = title === "" ? (parsed?.key ?? subject) : title;
    return name.includes("/") ? name : `${TOPIC_FOLDER}/${name}`;
  }

  #personOf(where: NotebookWhere): PersonId | null {
    for (const account of where.accounts ?? []) {
      const person = this.#resolver.personOf(account);
      if (person !== null) return person;
    }
    return null;
  }

  #viewer(where: NotebookWhere): NotesViewer {
    const c = where.context;
    const present = (where.accounts ?? []).flatMap((a) => {
      const p = this.#resolver.personOf(a);
      return p === null ? [] : [p];
    });
    if (c === null) return { space: null, room: null, dm: null, present: [] };
    const dm = c.kind === "dm" || c.scope === null;
    return {
      space: dm || c.scope === null ? null : this.#resolver.spaceOf(c.platform, c.scope),
      room: this.#resolver.roomOf(c),
      dm: dm ? (present[0] ?? null) : null,
      present,
    };
  }

  /** The scope of what is written from `where`; `null`: the place is not one identity knows. */
  #scopeOf(where: NotebookWhere): NoteScope | null {
    const c = where.context;
    if (c === null) return { type: "self" };
    if (c.kind === "dm" || c.scope === null) {
      const person = this.#personOf(where);
      return person === null ? null : { type: "dm", person };
    }
    const space = this.#resolver.spaceOf(c.platform, c.scope);
    return space === null ? null : { type: "space", space };
  }

  // ---- reading ------------------------------------------------------------------------------

  index(where: NotebookWhere): NotebookEntry[] {
    const out: NotebookEntry[] = [];
    for (const { document, sections } of this.#notes.outline(this.#viewer(where))) {
      if (document.kind === "self") {
        for (const s of sections) {
          out.push({
            path: `${SELF_FOLDER}/${sectionLabel("self", s.section)}`,
            chars: s.chars,
            updated_at: s.updated_at,
            about: null,
          });
        }
        continue;
      }
      out.push({
        path: this.#pathOf(document.subject, document.title, document.person_id),
        chars: sections.reduce((n, s) => n + s.chars, 0),
        updated_at: [document.created_at, ...sections.map((s) => s.updated_at)]
          .sort()
          .at(-1) as string,
        about: document.person_id,
      });
    }
    return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  read(path: string, where: NotebookWhere): NotebookPage | null {
    let clean: string;
    try {
      clean = cleanPath(path, this.#config().path_chars);
    } catch {
      return null;
    }
    const target = this.#target(clean);
    const doc = this.#notes.document(target.subject);
    if (doc === null) return null;
    const body = this.#notes.full(target.subject, this.#viewer(where), {
      header: false,
      maxChars: READ_ALL,
      ...(target.section === null ? {} : { section: target.section }),
    });
    if (body === null) return null;
    const mine = this.index(where).find((e) => e.path === clean);
    return {
      path: clean,
      chars: chars(body),
      updated_at: mine?.updated_at ?? doc.updated_at,
      about: doc.person_id,
      body,
      created_at: doc.created_at,
    };
  }

  // ---- writing ------------------------------------------------------------------------------

  /** The lines in use of the page of this place: what a rewrite or a delete takes out. */
  #here(target: Target, scope: NoteScope) {
    return this.#notes
      .lines(target.subject, "owner")
      .filter(
        (l) =>
          sameScope(l.scope, scope) && (target.section === null || l.section === target.section),
      );
  }

  /** Writes a page of the place `where` is (refused with a reason past a limit). */
  async write(
    path: string,
    text: string,
    mode: WriteMode,
    where: NotebookWhere,
  ): Promise<WriteResult> {
    const cfg = this.#config();
    const clean = cleanPath(path, cfg.path_chars);
    const body = cleanBody(text);
    if (body === "") throw new NotebookError("內容是空的");
    const now = this.#clock.now();
    this.#writes = this.#writes.filter((t) => now - t < 3_600_000);
    if (this.#writes.length >= cfg.writes_per_hour) {
      throw new NotebookError(`這一小時寫太多次了(上限 ${cfg.writes_per_hour} 次),晚點再寫`);
    }
    const scope = this.#scopeOf(where);
    if (scope === null) throw new NotebookError("這裡的人或地方我還對不上,晚點再寫");
    const target = this.#target(clean);
    const fresh = bodyLines(
      target.kind,
      body,
      target.section ?? MISC_SECTION,
      this.#notes.limits.lineChars,
    );
    if (fresh.length === 0) throw new NotebookError("內容是空的");
    const here = this.#here(target, scope);
    const before = here.reduce((n, l) => n + chars(l.text), 0);
    const added = fresh.reduce((n, l) => n + chars(l.text), 0);
    const next = mode === "replace" ? added : before + added;
    if (next > cfg.page_chars) {
      throw new NotebookError(
        `這頁會超過 ${cfg.page_chars} 字(現在 ${before} 字),先整理或改寫成精簡版`,
      );
    }
    const all = this.#notes.lines(target.subject, "owner");
    if (all.length === 0 && this.#notes.writtenBy("tool") >= cfg.max_pages) {
      throw new NotebookError(`筆記本滿了(${cfg.max_pages} 頁),先刪掉或合併幾頁`);
    }
    const ops: NoteOp[] = [
      ...(mode === "replace"
        ? here.map((l): NoteOp => ({ op: "outdate", line: l.id, reason: "rewritten" }))
        : []),
      ...fresh.map(
        (l): NoteOp => ({
          op: "add",
          section: l.section,
          text: l.text,
          provenance: "observed",
          scope,
          confidence: WRITTEN_CONFIDENCE,
        }),
      ),
    ];
    try {
      this.#notes.apply(
        target.subject,
        ops,
        { author: "tool", reason: mode, lenient: false },
        target.title,
      );
    } catch (error) {
      if (!(error instanceof NotesError)) throw error;
      throw new NotebookError(
        error.code === "document_full" || error.code === "section_full"
          ? "這頁的行數滿了,先用 mode=replace 整理成精簡版"
          : "存不進去,等一下再試",
      );
    }
    this.#writes.push(now);
    return {
      path: clean,
      chars: next,
      created: here.length === 0,
      elsewhere: this.#elsewhere(target, all, here),
    };
  }

  /** The lines in use of the page that a rewrite or a delete from this place does not reach. */
  #elsewhere(
    target: Target,
    all: readonly { id: string; section: string }[],
    here: readonly { id: string }[],
  ): number {
    const mine = new Set(here.map((l) => l.id));
    return all.filter(
      (l) => !mine.has(l.id) && (target.section === null || l.section === target.section),
    ).length;
  }

  /** How many lines in use of the page at `path` were written somewhere else than `where`. */
  elsewhere(path: string, where: NotebookWhere): number {
    let clean: string;
    try {
      clean = cleanPath(path, this.#config().path_chars);
    } catch {
      return 0;
    }
    const scope = this.#scopeOf(where);
    const target = this.#target(clean);
    const all = this.#notes.lines(target.subject, "owner");
    return this.#elsewhere(target, all, scope === null ? [] : this.#here(target, scope));
  }

  /** Marks the lines of this place's page at `path` outdated (nothing is deleted). */
  async remove(path: string, where: NotebookWhere): Promise<boolean> {
    const clean = cleanPath(path, this.#config().path_chars);
    const scope = this.#scopeOf(where);
    if (scope === null) return false;
    const target = this.#target(clean);
    const here = this.#here(target, scope);
    if (here.length === 0) return false;
    this.#notes.apply(
      target.subject,
      here.map((l): NoteOp => ({ op: "outdate", line: l.id, reason: "deleted" })),
      { author: "tool", reason: "deleted", lenient: false },
    );
    return true;
  }

  /** Forgets what the notes hold about `person`; returns the lines taken out or emptied. */
  async forgetPerson(person: PersonId): Promise<number> {
    const r = this.#notes.forgetPerson([person]);
    return r.lines + r.redacted;
  }
}
