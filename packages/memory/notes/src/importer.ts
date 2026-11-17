// Today's two document systems into the notes: her notebook pages (`notebook:page:*`) and her
// knowledge documents (`knowledge:doc:*`), read through their own readers (`parsePage` over the
// settings rows, `KnowledgeBase.docs`) and written as documents and lines with author `import`.
//
// - Idempotent: every line carries an import key (the source's id, where in it, and a hash of the
//   text), and a key already there is skipped. Run twice, the second run adds nothing; a page that
//   changed since adds its new lines and leaves the old ones.
// - Nothing is guessed. A page or a field whose place or person identity does not know, and a line
//   the limits refuse, is reported (`unmapped`) and not written.
// - Not run anywhere yet: the switch to the notes calls it once.
//
// | source                          | document                          | scope (from where it was written)       |
// |---------------------------------|-----------------------------------|-----------------------------------------|
// | page `人/<名字>` with its person | `person:<id>`                     | no place: `self`; a server: `space`;    |
// | page `自己/<名字>`               | `self` (section by the page name) |   a DM: `dm` of the partner             |
// | any other page                  | `topic:<path>`                    |                                         |
// | knowledge, person subject       | `person:<id>`                     | per field: origin `null`: `self`;       |
// | knowledge, guild subject        | `place:<space id>`                |   `<platform>:<guild>`: `space`;         |
// | knowledge, self / topic subject | `self` / `topic:<name>`           |   `dm:<context>`: `room` of that DM     |
//
// Provenance: a notebook line is something she wrote down herself (`observed`, 0.6); a knowledge
// field keeps its source (`said` by the person: told by them, by someone else: told by other;
// `inferred` and `self`: concluded; `panel`: observed) and its confidence.

import { createHash } from "node:crypto";
import type { SettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  type FieldSource,
  isJsonObject,
  type JsonValue,
  type KnowledgeDoc,
  type PersonId,
  type ProfileId,
} from "@miyoria/types";
import { effectiveSource } from "../../learning/src/knowledge.js";
import { PAGE_PREFIX, parsePage, type StoredPage } from "../../memory/src/notebook.js";
import type { DocumentKind, Provenance } from "./schema.js";
import type { NoteScope, ScopeResolver } from "./scope.js";
import { MISC_SECTION, sectionKey } from "./sections.js";
import {
  cleanLine,
  type NotesStore,
  personSubject,
  placeSubject,
  SELF_SUBJECT,
  topicSubject,
} from "./store.js";
import type { LineInput, NoteOp } from "./types.js";

export type { StoredPage as NotebookPageRecord } from "../../memory/src/notebook.js";

/** What is imported. */
export interface ImportSources {
  pages: readonly StoredPage[];
  knowledge: readonly KnowledgeDoc[];
}

/** Something that was not written, and why. */
export interface Unmapped {
  /** `notebook:<path>`, `knowledge:<title>`, with the line or field when it is one of them. */
  source: string;
  reason: string;
}

export interface ImportReport {
  /** Documents written to. */
  documents: number;
  /** Lines added. */
  added: number;
  /** Lines an earlier import already wrote. */
  already: number;
  unmapped: Unmapped[];
}

/** Every notebook page of `profile`, as stored (`notebook:page:*`), including where it was written. */
export async function notebookPages(
  settings: SettingsStore,
  profile: ProfileId,
): Promise<StoredPage[]> {
  const rows = await settings.list(profile, PAGE_PREFIX);
  const out: StoredPage[] = [];
  for (const value of rows.values()) {
    const page = parsePage(value);
    if (page !== null) out.push(page);
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** `text` in pieces of at most `max` characters, cut after a sentence where it can be. */
export function pieces(text: string, max: number): string[] {
  const all = [...text];
  if (all.length <= max) return [text];
  const out: string[] = [];
  let rest = all;
  while (rest.length > max) {
    let at = max;
    for (let i = max; i > max / 2; i--) {
      if (/[。!?！？;；.]/.test(rest[i - 1] ?? "")) {
        at = i;
        break;
      }
    }
    out.push(rest.slice(0, at).join("").trim());
    rest = rest.slice(at);
  }
  const tail = rest.join("").trim();
  if (tail !== "") out.push(tail);
  return out.filter((p) => p !== "");
}

/** A planned line with where it is from. */
interface Planned {
  input: LineInput;
  source: string;
}

/** Imports `sources` into `notes` (see the module comment). */
export function importLegacy(
  notes: NotesStore,
  sources: ImportSources,
  resolver: ScopeResolver,
): ImportReport {
  const report: ImportReport = { documents: 0, added: 0, already: 0, unmapped: [] };
  const byDoc = new Map<string, { title: string | undefined; lines: Planned[] }>();
  const plan = (subject: string, title: string | undefined, line: Planned) => {
    const doc = byDoc.get(subject) ?? { title, lines: [] };
    doc.lines.push(line);
    byDoc.set(subject, doc);
  };

  const max = notes.limits.lineChars;
  for (const page of sources.pages) pagePlan(page, resolver, plan, report, max);
  for (const doc of sources.knowledge) knowledgePlan(doc, resolver, plan, report, max);

  for (const [subject, doc] of byDoc) {
    const ops: NoteOp[] = doc.lines.map((l) => ({ op: "add", ...l.input }));
    const result = notes.apply(
      subject,
      ops,
      { author: "import", reason: "imported", lenient: true },
      doc.title,
    );
    if (result.applied.length > 0) report.documents++;
    report.added += result.applied.length;
    for (const r of result.refused) {
      if (r.code === "duplicate") report.already++;
      else
        report.unmapped.push({ source: doc.lines[r.index]?.source ?? subject, reason: r.message });
    }
  }
  return report;
}

type Plan = (subject: string, title: string | undefined, line: Planned) => void;

function pageScope(page: StoredPage, resolver: ScopeResolver): NoteScope | string {
  const o = page.origin;
  if (o === null) return { type: "self" };
  if (o.type === "guild") {
    const space = resolver.spaceOf(o.platform, o.guild);
    return space === null
      ? `the server ${o.platform}:${o.guild} is not known`
      : { type: "space", space };
  }
  const account: AccountRef = { platform: o.platform, id: o.account };
  const person = resolver.personOf(account);
  return person === null
    ? `the DM partner ${o.platform}:${o.account} is not known`
    : { type: "dm", person };
}

function pagePlan(
  page: StoredPage,
  resolver: ScopeResolver,
  plan: Plan,
  report: ImportReport,
  max: number,
) {
  const source = `notebook:${page.path}`;
  const parts = page.path.split("/");
  const folder = parts[0] ?? "";
  let subject: string;
  let kind: DocumentKind;
  let title: string | undefined;
  let section = MISC_SECTION;
  if (folder === "人") {
    if (page.about === null) {
      report.unmapped.push({ source, reason: "the person of the page is not known" });
      return;
    }
    subject = personSubject(page.about);
    kind = "person";
  } else if (folder === "自己") {
    subject = SELF_SUBJECT;
    kind = "self";
    section = sectionKey("self", parts.slice(1).join("/")) ?? MISC_SECTION;
  } else {
    const name = (folder === "主題" ? parts.slice(1) : parts).join("/");
    subject = topicSubject(name === "" ? page.path : name);
    kind = "topic";
    title = name === "" ? page.path : name;
  }
  const scope = pageScope(page, resolver);
  if (typeof scope === "string") {
    report.unmapped.push({ source, reason: scope });
    return;
  }
  for (const line of bodyLines(kind, page.body, section, max)) {
    plan(subject, title, {
      source: `${source}:${[...line.text].slice(0, 20).join("")}`,
      input: {
        section: line.section,
        text: line.text,
        provenance: "observed",
        scope,
        confidence: 0.6,
        import_key: `notebook:${page.id}:${hash(`${line.section}\n${line.text}`)}`,
      },
    });
  }
}

/**
 * A notebook body as lines: one per row of text (a bullet's mark and a `## heading` are not text),
 * in the section a heading or a `label:` prefix names (else `fallback`), cut into pieces of at
 * most `max` characters.
 */
export function bodyLines(
  kind: DocumentKind,
  body: string,
  fallback: string,
  max: number,
): Array<{ section: string; text: string }> {
  const out: Array<{ section: string; text: string }> = [];
  let current = fallback;
  for (const raw of body.split("\n")) {
    const heading = /^\s*#{1,6}\s*(.+)$/.exec(raw);
    if (heading?.[1]) {
      current = sectionKey(kind, heading[1]) ?? fallback;
      continue;
    }
    let text = raw.replace(/^\s*(?:[-*•・]|\d+[.、)])\s*/, "").trim();
    let section = current;
    const at = text.search(/[::]/);
    if (at > 0) {
      const key = sectionKey(kind, text.slice(0, at));
      if (key !== null) {
        section = key;
        text = text.slice(at + 1).trim();
      }
    }
    const clean = cleanLine(text);
    if (clean === "") continue;
    for (const piece of pieces(clean, max)) out.push({ section, text: piece });
  }
  return out;
}

/** A DM origin (`dm:<context key>`) as its context. */
function dmContext(origin: string): ContextKey | null {
  const parts = origin.slice("dm:".length).split(":");
  const platform = parts[0];
  if (platform === undefined || parts.length < 3) return null;
  const voice = parts[2] === "voice";
  const channel = parts.slice(voice ? 3 : 2).join(":");
  if (channel === "") return null;
  const scope = parts[1] === "dm" ? null : (parts[1] ?? null);
  return { platform, scope, channel, kind: voice ? "voice" : scope === null ? "dm" : "channel" };
}

function fieldScope(source: FieldSource | undefined, resolver: ScopeResolver): NoteScope | string {
  const origin = source?.origin ?? null;
  if (origin === null) return { type: "self" };
  if (origin.startsWith("dm:")) {
    const ctx = dmContext(origin);
    const room = ctx === null ? null : resolver.roomOf(ctx);
    return room === null ? `the DM \`${origin}\` is not known` : { type: "room", room };
  }
  const at = origin.indexOf(":");
  const space = at < 0 ? null : resolver.spaceOf(origin.slice(0, at), origin.slice(at + 1));
  return space === null ? `the server \`${origin}\` is not known` : { type: "space", space };
}

function fieldProvenance(
  source: FieldSource | undefined,
  about: PersonId | null,
  resolver: ScopeResolver,
): { provenance: Provenance; told_by: PersonId | null } {
  switch (source?.kind) {
    case "said": {
      const by = source.account === null ? null : resolver.personOf(source.account);
      return by !== null && by === about
        ? { provenance: "told_by_subject", told_by: by }
        : { provenance: "told_by_other", told_by: by };
    }
    case "panel":
      return { provenance: "observed", told_by: null };
    default:
      return { provenance: "concluded", told_by: null };
  }
}

const scalarText = (v: JsonValue): string =>
  typeof v === "string" ? v : v === null ? "" : String(v);

/** The leaves of `value` at `pointer`, each with its labels (the keys above it) and its pointer. */
export function leaves(
  value: JsonValue,
  pointer: string,
  labels: readonly string[],
  out: Array<{ pointer: string; labels: string[]; text: string }>,
) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      leaves(v, `${pointer}/${i}`, labels, out);
    });
  } else if (isJsonObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      leaves(v, `${pointer}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`, [...labels, k], out);
    }
  } else {
    const text = scalarText(value).trim();
    if (text !== "") out.push({ pointer, labels: [...labels], text });
  }
}

function knowledgePlan(
  doc: KnowledgeDoc,
  resolver: ScopeResolver,
  plan: Plan,
  report: ImportReport,
  max: number,
) {
  const source = `knowledge:${doc.title}`;
  let subject: string;
  let kind: DocumentKind;
  let title: string | undefined;
  let about: PersonId | null = null;
  switch (doc.subject.type) {
    case "person":
      subject = personSubject(doc.subject.person);
      kind = "person";
      about = doc.subject.person;
      break;
    case "guild": {
      const space = resolver.spaceOf(doc.subject.platform, doc.subject.guild);
      if (space === null) {
        report.unmapped.push({ source, reason: "its server is not known" });
        return;
      }
      subject = placeSubject(space);
      kind = "place";
      title = doc.title;
      break;
    }
    case "self":
      subject = SELF_SUBJECT;
      kind = "self";
      break;
    case "topic":
      subject = topicSubject(doc.subject.name);
      kind = "topic";
      title = doc.subject.name;
      break;
    default:
      report.unmapped.push({ source, reason: "its subject is not one the notes have" });
      return;
  }
  const found: Array<{ pointer: string; labels: string[]; text: string }> = [];
  leaves(doc.content, "", [], found);
  for (const leaf of found) {
    const [head, ...rest] = leaf.labels;
    const key = head === undefined ? null : sectionKey(kind, head);
    const section = key ?? MISC_SECTION;
    const labels = key === null ? leaf.labels : rest;
    const at = `${source}${leaf.pointer}`;
    const fieldSource = effectiveSource(doc.sources, leaf.pointer);
    const scope = fieldScope(fieldSource, resolver);
    if (typeof scope === "string") {
      report.unmapped.push({ source: at, reason: scope });
      continue;
    }
    const { provenance, told_by } = fieldProvenance(fieldSource, about, resolver);
    const statement = cleanLine(
      labels.length > 0 ? `${labels.join(" / ")}: ${leaf.text}` : leaf.text,
    );
    if (statement === "") continue;
    pieces(statement, max).forEach((piece, i) => {
      plan(subject, title, {
        source: at,
        input: {
          section,
          text: piece,
          provenance,
          told_by,
          scope,
          confidence: fieldSource?.confidence ?? 0.6,
          import_key: `knowledge:${doc.id}:${leaf.pointer}:${i}:${hash(piece)}`,
        },
      });
    });
  }
}
