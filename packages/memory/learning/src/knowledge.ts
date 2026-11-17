// Her self-organized knowledge base. The envelope is fixed (subject, her kind label, title,
// per-field sources with confidence and privacy origin, versions, size caps); the content is
// whatever JSON she chooses, changed with JSON-patch-like operations, all or nothing.
//
// Overwrite protection, by who writes (`KnowledgeWriter.kind`):
// - `self` (her mind loop, her reflection) and `panel` (the owner): anything.
// - Documents about herself (`subject.type === "self"`, her self-model and rules): only those.
// - Anyone else (`said`: attributed to a speaker; `inferred`: she concluded it from a
//   conversation others can influence) may add new fields anywhere but about herself (what
//   someone says about someone else is capped at `said_confidence`), and may change or remove
//   only fields they own: their own documents (subject = their person) entirely, elsewhere only
//   fields whose source is them (`said` by the same account; `inferred` by `inferred`).
//   Renaming, deleting and merging documents need the same ownership of the whole document.
//
// Persistence: one settings record per document (`knowledge:doc:<id>`), cached in memory.

import { errorMessage, getLogger, SerialQueue } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type Clock,
  type ContextKey,
  contextKeyString,
  type FieldSource,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type KnowledgeBase,
  type KnowledgeChange,
  type KnowledgeDoc,
  type KnowledgeRenderOptions,
  type KnowledgeResult,
  type KnowledgeSubject,
  type KnowledgeVersion,
  type KnowledgeWriter,
  newId,
  type PatchOp,
  type ProfileId,
  safeName,
  sameAccount,
  subjectKey,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import type { KnowledgeConfig } from "./config.js";
import {
  type Applied,
  applyPatch,
  checkContent,
  cleanKey,
  formatPointer,
  isUnder,
  type JsonLimits,
  jsonChars,
  outline,
  PatchError,
  parseOps,
} from "./json-doc.js";

const log = getLogger("learning.knowledge");

/** Settings key prefix of her documents. */
export const DOC_PREFIX = "knowledge:doc:";

export function docKey(id: string): string {
  return `${DOC_PREFIX}${id}`;
}

/** The short id shown in prompts (`#` + the last 6 characters of the ULID). */
export function shortId(id: string): string {
  return `#${id.slice(-6).toLowerCase()}`;
}

const MAX_LABEL = 40;
const MAX_TITLE = 80;
/** Documents past the render budget still listed by title. */
const MAX_TITLES_PAST_BUDGET = 30;

/** Titles that name the same note: equal or one inside the other once spacing and punctuation go, or mostly the same character pairs. */
export function similarTitles(a: string, b: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const x = norm(a);
  const y = norm(b);
  if (x === "" || y === "") return false;
  if (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))))
    return true;
  const pairs = (t: string) => {
    const chars = [...t];
    const out = new Set<string>();
    for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
    return out;
  };
  const px = pairs(x);
  const py = pairs(y);
  if (px.size === 0 || py.size === 0) return false;
  let shared = 0;
  for (const p of px) if (py.has(p)) shared++;
  return shared / Math.min(px.size, py.size) >= 0.6;
}
const MAX_WHY = 200;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function cut(text: string, max: number): string {
  const c = [...text.trim()];
  return c.length > max ? c.slice(0, max).join("") : c.join("");
}

export function limitsOf(config: KnowledgeConfig): JsonLimits {
  return {
    maxDepth: config.max_depth,
    maxStringChars: config.max_field_chars,
    maxKeyChars: config.max_key_chars,
    maxKeys: config.max_keys,
    maxArray: config.max_array,
    maxChars: config.max_doc_chars,
  };
}

/** Privacy origin of what a writer writes from `context`. */
export function originOf(context: ContextKey | null): string | null {
  if (context === null) return null;
  if (context.kind === "dm" || context.scope === null) return `dm:${contextKeyString(context)}`;
  return `${context.platform}:${context.scope}`;
}

/**
 * Whether something learned at `origin` may be shown in `context`. With no context (her mind
 * without a focus, her reflection) everything but DMs is visible.
 */
export function originVisible(origin: string | null, context: ContextKey | null): boolean {
  if (origin === null) return true;
  if (origin.startsWith("dm:")) {
    return context !== null && origin === `dm:${contextKeyString(context)}`;
  }
  if (context === null) return true;
  return context.scope !== null && origin === `${context.platform}:${context.scope}`;
}

const privileged = (w: KnowledgeWriter) => w.kind === "self" || w.kind === "panel";

/** The source that applies at `pointer`: its own or the nearest ancestor's. */
export function effectiveSource(
  sources: Readonly<Record<string, FieldSource>>,
  pointer: string,
): FieldSource | undefined {
  let p = pointer;
  for (;;) {
    const s = sources[p];
    if (s) return s;
    if (p === "") return undefined;
    p = p.slice(0, p.lastIndexOf("/"));
  }
}

/** Every source that governs `pointer` and what is below it. */
function governing(doc: KnowledgeDoc, pointer: string): FieldSource[] {
  const out: FieldSource[] = [];
  const own = effectiveSource(doc.sources, pointer);
  if (own) out.push(own);
  for (const [k, s] of Object.entries(doc.sources)) {
    if (k !== pointer && isUnder(k, pointer)) out.push(s);
  }
  return out;
}

function owns(w: KnowledgeWriter, s: FieldSource): boolean {
  if (privileged(w)) return true;
  if (w.kind === "said") {
    return s.kind === "said" && s.account !== null && w.account !== null
      ? sameAccount(s.account, w.account)
      : false;
  }
  return w.kind === "inferred" && s.kind === "inferred";
}

function aboutWriter(w: KnowledgeWriter, doc: { subject: KnowledgeSubject }): boolean {
  return doc.subject.type === "person" && w.person !== null && doc.subject.person === w.person;
}

/** May `w` change or remove what is at `pointer` (and below)? */
function mayChange(w: KnowledgeWriter, doc: KnowledgeDoc, pointer: string): boolean {
  if (privileged(w) || aboutWriter(w, doc)) return true;
  const sources = governing(doc, pointer);
  return sources.length > 0 && sources.every((s) => owns(w, s));
}

export class KnowledgeError extends Error {
  override readonly name = "KnowledgeError";
}

function parseDoc(value: JsonValue): KnowledgeDoc | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.id !== "string" || !isJsonObject(value.subject)) return null;
  if (!isJsonObject(value.content) || !isJsonObject(value.sources)) return null;
  if (typeof value.kind !== "string" || typeof value.title !== "string") return null;
  const doc = value as unknown as KnowledgeDoc;
  if (!Array.isArray(doc.history)) doc.history = [];
  if (typeof doc.version !== "number") doc.version = doc.history.length;
  return doc;
}

function subjectEquals(a: KnowledgeSubject, b: KnowledgeSubject): boolean {
  return subjectKey(a) === subjectKey(b);
}

/** A subject from untrusted input (`null` if malformed). */
export function cleanSubject(subject: KnowledgeSubject): KnowledgeSubject | null {
  switch (subject.type) {
    case "person":
      return typeof subject.person === "string" && subject.person !== "" ? subject : null;
    case "guild":
      return typeof subject.guild === "string" && subject.guild !== "" ? subject : null;
    case "self":
      return { type: "self" };
    case "topic": {
      const name = cut(cleanKey(subject.name ?? ""), MAX_LABEL);
      return name === "" ? null : { type: "topic", name };
    }
    default:
      return null;
  }
}

function describeOp(a: Applied): string {
  return a.op === "move" ? `move ${a.from} → ${a.path}` : `${a.op} ${a.path}`;
}

/** Short source note for prompts, only where it matters. */
export function sourceTag(s: FieldSource | undefined, parent: FieldSource | undefined) {
  if (!s || s === parent) return null;
  if (s.kind === "said" && s.name) return `(${safeName(s.name, 16)} 說)`;
  if (s.confidence < 0.5) return "(不確定)";
  if (s.kind === "inferred" && s.confidence < 0.7) return "(推測)";
  return null;
}

export class KnowledgeStore implements KnowledgeBase {
  readonly #docs = new Map<string, KnowledgeDoc>();
  readonly #writes = new SerialQueue();
  readonly #limits: JsonLimits;

  constructor(
    private readonly store: SettingsStore | null,
    private readonly profile: ProfileId,
    readonly config: KnowledgeConfig,
    private readonly clock: Clock = systemClock,
    /** Called after every change (publishes `knowledge.changed`). */
    private readonly changed: (doc: KnowledgeDoc, deleted: boolean) => void = () => {},
  ) {
    this.#limits = limitsOf(config);
  }

  async load(): Promise<void> {
    if (!this.store) return;
    const records = await this.store.list(this.profile, DOC_PREFIX);
    this.#docs.clear();
    for (const value of records.values()) {
      const doc = parseDoc(value);
      if (doc) this.#docs.set(doc.id, doc);
    }
  }

  flush(): Promise<void> {
    return this.#writes.run(async () => {});
  }

  // ---- reads --------------------------------------------------------------------------------

  docs(subject?: KnowledgeSubject): KnowledgeDoc[] {
    return [...this.#docs.values()]
      .filter((d) => subject === undefined || subjectEquals(d.subject, subject))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .map((d) => structuredClone(d));
  }

  get(id: string): KnowledgeDoc | null {
    const d = this.#docs.get(id);
    return d ? structuredClone(d) : null;
  }

  /** A document by id or short id (`#abc123`, unique suffix). */
  resolve(ref: string): KnowledgeDoc | null {
    const r = ref.trim().replace(/^#/, "").toLowerCase();
    if (r === "") return null;
    const exact = this.#docs.get(ref.trim());
    if (exact) return structuredClone(exact);
    const found = [...this.#docs.values()].filter((d) => d.id.toLowerCase().endsWith(r));
    return found.length === 1 ? structuredClone(found[0] as KnowledgeDoc) : null;
  }

  // ---- writes -------------------------------------------------------------------------------

  async apply(change: KnowledgeChange, writer: KnowledgeWriter): Promise<KnowledgeResult> {
    try {
      const result = this.#apply(change, writer);
      for (const [doc, deleted] of result) {
        this.#persist(doc, deleted);
        this.changed(structuredClone(doc), deleted);
      }
      const kept = result.find(([, deleted]) => !deleted)?.[0] ?? null;
      return { ok: true, doc: kept ? structuredClone(kept) : null };
    } catch (error) {
      if (error instanceof PatchError || error instanceof KnowledgeError) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }

  #source(writer: KnowledgeWriter, confidence: number | undefined, capped: boolean): FieldSource {
    let c = clamp01(confidence ?? (writer.kind === "said" ? 0.8 : 0.7));
    if (capped) c = Math.min(c, this.config.said_confidence);
    return {
      kind: writer.kind,
      account: writer.kind === "said" && writer.account ? { ...writer.account } : null,
      name: writer.name === null ? null : safeName(writer.name, 32),
      origin: originOf(writer.context),
      confidence: c,
      at: toTimestamp(this.clock.now()),
    };
  }

  #version(doc: KnowledgeDoc, writer: KnowledgeWriter, why: string, ops: string[]): void {
    doc.version += 1;
    const entry: KnowledgeVersion = {
      version: doc.version,
      at: toTimestamp(this.clock.now()),
      by: writer.kind,
      name: writer.name === null ? null : safeName(writer.name, 32),
      why: cut(why, MAX_WHY),
      ops: ops.slice(0, 12),
    };
    doc.history = [...doc.history, entry].slice(-Math.max(this.config.history_keep, 1));
    doc.updated_at = entry.at;
  }

  #checkSubjectSize(subject: KnowledgeSubject, replacing: string | null, add: number): void {
    const others = [...this.#docs.values()].filter(
      (d) => subjectEquals(d.subject, subject) && d.id !== replacing,
    );
    const total = others.reduce((n, d) => n + jsonChars(d.content), 0) + add;
    if (total > this.config.max_subject_chars) {
      throw new KnowledgeError(
        `documents about this subject would exceed ${this.config.max_subject_chars} characters; condense or merge some`,
      );
    }
  }

  #need(ref: string): KnowledgeDoc {
    const doc = this.resolve(ref);
    if (!doc) throw new KnowledgeError(`no document \`${ref}\``);
    return doc;
  }

  /** Validates and computes the change; returns the documents to write (`true` = deleted). */
  #apply(change: KnowledgeChange, writer: KnowledgeWriter): [KnowledgeDoc, boolean][] {
    const why = typeof change.why === "string" ? change.why : "";
    switch (change.type) {
      case "create": {
        const subject = cleanSubject(change.subject);
        if (!subject) throw new KnowledgeError("bad subject");
        if (subject.type === "self" && !privileged(writer)) {
          throw new KnowledgeError("only she writes documents about herself");
        }
        if (this.#docs.size >= this.config.max_docs) {
          throw new KnowledgeError("too many documents; merge or delete some first");
        }
        if (this.docs(subject).length >= this.config.max_docs_per_subject) {
          throw new KnowledgeError("too many documents about this subject; merge some first");
        }
        const kind = cut(cleanKey(change.kind ?? ""), MAX_LABEL);
        const title = cut(cleanKey(change.title ?? ""), MAX_TITLE);
        if (kind === "" || title === "")
          throw new KnowledgeError("a document needs a kind and a title");
        const twin = this.docs(subject).find((d) => similarTitles(d.title, title));
        if (twin) {
          throw new KnowledgeError(
            `a document like this already exists (${shortId(twin.id)}「${twin.title}」): patch it instead`,
          );
        }
        const now = toTimestamp(this.clock.now());
        const capped = !privileged(writer) && !aboutWriter(writer, { subject });
        const source = this.#source(writer, change.confidence, capped);
        const content = checkContent(change.content ?? {}, this.#limits);
        this.#checkSubjectSize(subject, null, jsonChars(content));
        const doc: KnowledgeDoc = {
          id: newId(),
          subject,
          kind,
          title,
          content,
          sources: { "": source },
          created_at: now,
          updated_at: now,
          version: 0,
          history: [],
        };
        this.#version(doc, writer, why, ["created"]);
        this.#docs.set(doc.id, doc);
        return [[doc, false]];
      }
      case "patch": {
        const doc = this.#need(change.doc);
        if (doc.subject.type === "self" && !privileged(writer)) {
          throw new KnowledgeError("only she changes documents about herself");
        }
        // Ops may come straight from a model: re-validated here, whoever the caller is.
        const ops = parseOps(change.ops);
        if (ops.length === 0) throw new KnowledgeError("no ops");
        if (ops.length > 30) throw new KnowledgeError("at most 30 ops at once");
        this.#authorize(doc, writer, ops);
        const capped = !privileged(writer) && !aboutWriter(writer, doc);
        const source = this.#source(writer, change.confidence, capped);
        const next = applyPatch(doc.content, doc.sources, ops, source, this.#limits);
        this.#checkSubjectSize(doc.subject, doc.id, jsonChars(next.content));
        const updated: KnowledgeDoc = { ...doc, content: next.content, sources: next.sources };
        this.#version(updated, writer, why, next.applied.map(describeOp));
        this.#docs.set(doc.id, updated);
        return [[updated, false]];
      }
      case "retitle": {
        const doc = this.#need(change.doc);
        this.#wholeDoc(doc, writer);
        const kind = change.kind === null ? doc.kind : cut(cleanKey(change.kind), MAX_LABEL);
        const title = change.title === null ? doc.title : cut(cleanKey(change.title), MAX_TITLE);
        if (kind === "" || title === "")
          throw new KnowledgeError("a document needs a kind and a title");
        const updated = { ...doc, kind, title };
        this.#version(updated, writer, why, [`retitle ${kind}「${title}」`]);
        this.#docs.set(doc.id, updated);
        return [[updated, false]];
      }
      case "delete": {
        const doc = this.#need(change.doc);
        this.#wholeDoc(doc, writer);
        this.#docs.delete(doc.id);
        return [[doc, true]];
      }
      case "merge": {
        const from = this.#need(change.doc);
        const into = this.#need(change.into);
        if (from.id === into.id) throw new KnowledgeError("cannot merge a document into itself");
        this.#wholeDoc(from, writer);
        if (into.subject.type === "self" && !privileged(writer)) {
          throw new KnowledgeError("only she changes documents about herself");
        }
        const path = change.path === "" ? `/${from.title}` : change.path;
        const target = this.#need(into.id);
        if (getExisting(target, path)) this.#wholeDoc(target, writer);
        // The merged fields keep their sources, moved under `path`.
        const placeholder = this.#source(writer, undefined, false);
        const next = applyPatch(
          target.content,
          target.sources,
          [{ op: "add", path, value: from.content }],
          placeholder,
          this.#limits,
        );
        const resolved = next.applied[0]?.path ?? path;
        const sources = { ...next.sources };
        delete sources[resolved];
        for (const [k, s] of Object.entries(from.sources)) sources[`${resolved}${k}`] = s;
        this.#checkSubjectSize(into.subject, into.id, jsonChars(next.content));
        const updated: KnowledgeDoc = { ...target, content: next.content, sources };
        this.#version(updated, writer, why, [`merged ${shortId(from.id)} → ${resolved}`]);
        this.#docs.set(into.id, updated);
        this.#docs.delete(from.id);
        return [
          [updated, false],
          [from, true],
        ];
      }
      default:
        throw new KnowledgeError("unknown change");
    }
  }

  /** Every op of a non-privileged writer must touch only what it may. */
  #authorize(doc: KnowledgeDoc, writer: KnowledgeWriter, ops: readonly PatchOp[]): void {
    if (privileged(writer) || aboutWriter(writer, doc)) return;
    for (const op of ops) {
      const targets = op.op === "move" ? [op.from, op.path] : [op.path];
      for (const p of targets) {
        const exists = getExisting(doc, p);
        // Adding something new is fine; changing what is there needs ownership.
        if (op.op === "add" && !exists) continue;
        if (op.op === "move" && p === op.path && !exists) continue;
        if (!mayChange(writer, doc, p)) {
          throw new KnowledgeError(
            `\`${p}\` was written by someone else; only they (or she) can change it`,
          );
        }
      }
    }
  }

  #wholeDoc(doc: KnowledgeDoc, writer: KnowledgeWriter): void {
    if (doc.subject.type === "self" && !privileged(writer)) {
      throw new KnowledgeError("only she changes documents about herself");
    }
    if (!mayChange(writer, doc, "")) {
      throw new KnowledgeError("parts of this document were written by someone else");
    }
  }

  #persist(doc: KnowledgeDoc, deleted: boolean): void {
    const store = this.store;
    if (!store) return;
    const value = deleted ? null : (JSON.parse(JSON.stringify(doc)) as JsonValue);
    void this.#writes
      .run(async () => {
        try {
          await store.set(this.profile, docKey(doc.id), value);
        } catch (error) {
          log.warn({ err: errorMessage(error) }, "cannot persist her document");
        }
      })
      .catch(() => undefined);
  }

  // ---- rendering ----------------------------------------------------------------------------

  /** One document as a compact outline (visible fields only); `null` if nothing is visible. */
  renderDoc(doc: KnowledgeDoc, context: ContextKey | null): string | null {
    const visible = (p: string) =>
      originVisible(effectiveSource(doc.sources, p)?.origin ?? null, context);
    if (!visible("")) return null;
    const lines = outline(
      doc.content,
      {
        visible,
        tag: (p) => {
          const parent =
            p === "" ? undefined : effectiveSource(doc.sources, p.slice(0, p.lastIndexOf("/")));
          return sourceTag(doc.sources[p] ?? undefined, parent);
        },
      },
      "  ",
    );
    const docTag = sourceTag(doc.sources[""], undefined);
    const head = `${shortId(doc.id)} ${doc.kind}「${doc.title}」${docTag === null ? "" : ` ${docTag}`}`;
    return [head, ...lines].join("\n");
  }

  /**
   * Her documents about `subjects` as outlines, up to `maxChars`. Documents past the budget are
   * still listed by id and title, so she always knows what she has already written.
   */
  render(subjects: readonly KnowledgeSubject[], options: KnowledgeRenderOptions): string {
    const seen = new Set<string>();
    const parts: string[] = [];
    const rest: string[] = [];
    let used = 0;
    for (const subject of subjects) {
      const key = subjectKey(subject);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const doc of this.docs(subject)) {
        const text = this.renderDoc(doc, options.context);
        if (text === null) continue;
        const ref = options.refs?.get(doc.id);
        const block = ref ? `${ref} ${text}` : text;
        const len = [...block].length + 2;
        if (rest.length > 0 || used + len > options.maxChars) {
          if (rest.length < MAX_TITLES_PAST_BUDGET) {
            rest.push(`${ref ? `${ref} ` : ""}${shortId(doc.id)} ${doc.kind}「${doc.title}」`);
          }
          continue;
        }
        used += len;
        parts.push(block);
      }
    }
    if (rest.length > 0) parts.push(`(內容放不下,只列標題:)\n${rest.join("\n")}`);
    return parts.join("\n\n");
  }
}

function getExisting(doc: KnowledgeDoc, pointer: string): boolean {
  try {
    let cur: JsonValue | undefined = doc.content;
    for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
      const t = token.replaceAll("~1", "/").replaceAll("~0", "~");
      if (cur === null || typeof cur !== "object") return false;
      if (Array.isArray(cur)) {
        if (t === "-") return false;
        cur = cur[Number(t)];
      } else cur = Object.hasOwn(cur, t) ? (cur as JsonObject)[t] : undefined;
      if (cur === undefined) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export { formatPointer };
