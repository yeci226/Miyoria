// Schema-free JSON documents: validating that content is plain data within size limits,
// JSON pointers, and applying JSON-patch-like operations atomically while keeping per-field
// sources (provenance) in step with the paths they describe.
//
// Content is data, never code or markup: keys and strings are neutralized (chat-template
// tokens and invisible control characters removed, data-block delimiters replaced) before they
// are stored, and checked for size. Prototype-polluting keys are refused.

import { escapeData, type JsonObject, type JsonValue, type PatchOp } from "@miyoria/types";

export class PatchError extends Error {
  override readonly name = "PatchError";
}

/** Size limits of a document's content. */
export interface JsonLimits {
  /** Nesting depth (the document object itself is depth 1). */
  maxDepth: number;
  /** Characters of one string value. */
  maxStringChars: number;
  /** Characters of one key. */
  maxKeyChars: number;
  /** Keys of one object. */
  maxKeys: number;
  /** Items of one array. */
  maxArray: number;
  /** Characters of the whole content as compact JSON. */
  maxChars: number;
}

export const DEFAULT_LIMITS: JsonLimits = {
  maxDepth: 6,
  maxStringChars: 1200,
  maxKeyChars: 64,
  maxKeys: 40,
  maxArray: 50,
  maxChars: 6000,
};

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const chars = (s: string) => [...s].length;

/** A key as stored: neutralized, one line, trimmed. */
export function cleanKey(key: string): string {
  return escapeData(key)
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

/**
 * Plain data with neutralized keys and strings. Throws `PatchError` for values that are not
 * JSON (`undefined`, functions, non-finite numbers, class instances) or break the limits.
 */
export function cleanJson(value: unknown, limits: JsonLimits, depth = 1): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PatchError("numbers must be finite");
    return value;
  }
  if (typeof value === "string") {
    const s = escapeData(value);
    if (chars(s) > limits.maxStringChars) {
      throw new PatchError(`a text value is longer than ${limits.maxStringChars} characters`);
    }
    return s;
  }
  if (depth > limits.maxDepth) throw new PatchError(`nesting deeper than ${limits.maxDepth}`);
  if (Array.isArray(value)) {
    if (value.length > limits.maxArray) {
      throw new PatchError(`a list has more than ${limits.maxArray} items`);
    }
    return value.map((v) => cleanJson(v, limits, depth + 1));
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new PatchError("not plain data");
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > limits.maxKeys) {
      throw new PatchError(`an object has more than ${limits.maxKeys} keys`);
    }
    const out: JsonObject = Object.create(null);
    for (const [rawKey, v] of entries) {
      const key = cleanKey(rawKey);
      if (key === "") throw new PatchError("empty key");
      if (FORBIDDEN_KEYS.has(key)) throw new PatchError(`key \`${key}\` is not allowed`);
      if (chars(key) > limits.maxKeyChars) {
        throw new PatchError(`a key is longer than ${limits.maxKeyChars} characters`);
      }
      if (v === undefined) continue;
      out[key] = cleanJson(v, limits, depth + 1);
    }
    // Back to a normal object (JSON round trips and structuredClone keep it plain).
    return { ...out };
  }
  throw new PatchError("not JSON data");
}

/** Compact JSON length in characters. */
export function jsonChars(value: JsonValue): number {
  return chars(JSON.stringify(value));
}

/** Checks a whole document's content (depth, keys, strings, total size). */
export function checkContent(content: JsonValue, limits: JsonLimits): JsonObject {
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new PatchError("content must be an object");
  }
  const clean = cleanJson(content, limits) as JsonObject;
  if (jsonChars(clean) > limits.maxChars) {
    throw new PatchError(`the document is larger than ${limits.maxChars} characters`);
  }
  return clean;
}

/** A text value this short is dropped whole rather than cut again. */
const MIN_CUT_CHARS = 80;

const cutTo = (s: string, max: number): string =>
  `${[...s].slice(0, Math.max(max - 1, 0)).join("")}…`;

/**
 * `content` made to fit `limits`, for notes a model keeps rewriting: what is over a limit is cut
 * instead of the whole document being refused. A refusal loses everything the reply had and the
 * next attempt is fed the same lines again (2026-11-07 to 11-10: a fold over `max_notes_chars`
 * failed, was retried every two minutes and failed the same way).
 *
 * Long texts and keys are cut, a long list keeps its last items, an object its first keys, and
 * what is not plain data or nested too deep goes. If the whole is still too large, the largest
 * part gives until it fits: a list loses its oldest item, a long text its second half, anything
 * else goes whole. `cut` counts what was changed (0: `content` was fine as it was).
 */
export function fitContent(
  content: JsonValue,
  limits: JsonLimits,
): { content: JsonObject; cut: number } {
  let cut = 0;
  const trim = (value: unknown, depth: number): JsonValue | undefined => {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      cut += 1;
      return undefined;
    }
    if (typeof value === "string") {
      const s = escapeData(value);
      if (chars(s) <= limits.maxStringChars) return s;
      cut += 1;
      return cutTo(s, limits.maxStringChars);
    }
    const plain =
      typeof value === "object" &&
      (Array.isArray(value) ||
        Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null);
    if (!plain || depth > limits.maxDepth) {
      cut += 1;
      return undefined;
    }
    if (Array.isArray(value)) {
      if (value.length > limits.maxArray) cut += 1;
      return value
        .slice(-limits.maxArray)
        .map((v) => trim(v, depth + 1))
        .filter((v): v is JsonValue => v !== undefined);
    }
    const out: JsonObject = Object.create(null);
    let kept = 0;
    for (const [rawKey, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      const clean = cleanKey(rawKey);
      const key =
        chars(clean) > limits.maxKeyChars
          ? [...clean].slice(0, limits.maxKeyChars).join("")
          : clean;
      if (key === "" || FORBIDDEN_KEYS.has(key) || kept >= limits.maxKeys) {
        cut += 1;
        continue;
      }
      if (key !== clean) cut += 1;
      const child = trim(v, depth + 1);
      if (child === undefined) continue;
      out[key] = child;
      kept += 1;
    }
    return { ...out };
  };
  const root = content !== null && typeof content === "object" && !Array.isArray(content);
  const doc = (root ? trim(content, 1) : undefined) as JsonObject | undefined;
  if (doc === undefined) return { content: {}, cut: cut + (root ? 0 : 1) };
  while (jsonChars(doc) > limits.maxChars && shrink(doc)) cut += 1;
  return { content: doc, cut };
}

/** Makes the largest part of `node` smaller. `false`: there is nothing left to take. */
function shrink(node: JsonObject | JsonValue[]): boolean {
  if (Array.isArray(node)) {
    if (node.length === 0) return false;
    // The oldest item of a list is its first.
    if (node.length > 1) {
      node.shift();
      return true;
    }
  }
  const members: [string | number, JsonValue][] = Array.isArray(node)
    ? node.map((v, i) => [i, v])
    : Object.entries(node);
  let largest: [string | number, JsonValue] | undefined;
  for (const m of members) {
    if (largest === undefined || jsonChars(m[1]) > jsonChars(largest[1])) largest = m;
  }
  if (largest === undefined) return false;
  const [key, value] = largest;
  const slots = node as Record<string | number, JsonValue>;
  if (isContainer(value) && shrink(value)) return true;
  if (typeof value === "string" && chars(value) > MIN_CUT_CHARS) {
    slots[key] = cutTo(value, Math.ceil(chars(value) / 2));
    return true;
  }
  if (Array.isArray(node)) node.splice(key as number, 1);
  else delete slots[key];
  return true;
}

// ---- pointers -----------------------------------------------------------------------------

/** RFC 6901 tokens of a pointer (`""` = root). */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new PatchError(`bad path \`${pointer}\`: must start with /`);
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function formatPointer(tokens: readonly string[]): string {
  return tokens.map((t) => `/${t.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

/** `pointer` is `ancestor` or below it. */
export function isUnder(pointer: string, ancestor: string): boolean {
  return ancestor === "" || pointer === ancestor || pointer.startsWith(`${ancestor}/`);
}

function isContainer(v: JsonValue | undefined): v is JsonObject | JsonValue[] {
  return v !== null && typeof v === "object";
}

function child(parent: JsonValue, token: string): JsonValue | undefined {
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
    return parent[Number(token)];
  }
  if (isContainer(parent) && Object.hasOwn(parent, token)) return (parent as JsonObject)[token];
  return undefined;
}

/** The value at `pointer`, or `undefined`. */
export function getAt(doc: JsonValue, pointer: string): JsonValue | undefined {
  let cur: JsonValue | undefined = doc;
  for (const token of parsePointer(pointer)) {
    if (cur === undefined || !isContainer(cur)) return undefined;
    cur = child(cur, token);
  }
  return cur;
}

// ---- sources ------------------------------------------------------------------------------

/** Moves source keys from below `from` to below `to`. */
function moveKeys<T>(sources: Record<string, T>, from: string, to: string): void {
  const moved: [string, T][] = [];
  for (const [k, v] of Object.entries(sources)) {
    if (isUnder(k, from) && from !== "") {
      moved.push([to + k.slice(from.length), v]);
      delete sources[k];
    }
  }
  for (const [k, v] of moved) sources[k] = v;
}

function dropKeys<T>(sources: Record<string, T>, under: string): void {
  for (const k of Object.keys(sources)) if (isUnder(k, under)) delete sources[k];
}

/** Shifts the indexes ≥ `index` of the array at `parent` by `delta` in the source keys. */
function shiftIndexes<T>(
  sources: Record<string, T>,
  parent: string,
  index: number,
  delta: number,
): void {
  const prefix = `${parent}/`;
  const moved: [string, T][] = [];
  for (const [k, v] of Object.entries(sources)) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    const slash = rest.indexOf("/");
    const head = slash < 0 ? rest : rest.slice(0, slash);
    if (!/^\d+$/.test(head)) continue;
    const i = Number(head);
    if (i < index) continue;
    moved.push([`${prefix}${i + delta}${slash < 0 ? "" : rest.slice(slash)}`, v]);
    delete sources[k];
  }
  for (const [k, v] of moved) sources[k] = v;
}

// ---- patching -----------------------------------------------------------------------------

/** What one applied op touched (normalized paths, `-` resolved). */
export interface Applied {
  op: PatchOp["op"];
  path: string;
  from: string | null;
  /** The path existed before (`add` on an existing member replaces it). */
  existed: boolean;
}

interface Located {
  parent: JsonObject | JsonValue[];
  token: string;
  parentPointer: string;
}

function locate(doc: JsonObject, pointer: string): Located {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) throw new PatchError("the document itself cannot be changed this way");
  const token = tokens.at(-1) as string;
  const parentPointer = formatPointer(tokens.slice(0, -1));
  const parent = getAt(doc, parentPointer);
  if (!isContainer(parent)) throw new PatchError(`\`${parentPointer || "/"}\` does not exist`);
  return { parent, token, parentPointer };
}

function arrayIndex(arr: JsonValue[], token: string, allowEnd: boolean): number {
  if (token === "-" && allowEnd) return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new PatchError(`bad list index \`${token}\``);
  const i = Number(token);
  if (i > arr.length || (!allowEnd && i === arr.length)) {
    throw new PatchError(`list index ${i} is out of range`);
  }
  return i;
}

function insert(
  doc: JsonObject,
  pointer: string,
  value: JsonValue,
  sources: Record<string, unknown>,
): Applied & { resolved: string } {
  const { parent, token, parentPointer } = locate(doc, pointer);
  if (Array.isArray(parent)) {
    const i = arrayIndex(parent, token, true);
    parent.splice(i, 0, value);
    shiftIndexes(sources, parentPointer, i, 1);
    const resolved = `${parentPointer}/${i}`;
    return { op: "add", path: resolved, from: null, existed: false, resolved };
  }
  const key = cleanKey(token);
  if (key === "" || FORBIDDEN_KEYS.has(key))
    throw new PatchError(`key \`${token}\` is not allowed`);
  const existed = Object.hasOwn(parent, key);
  (parent as JsonObject)[key] = value;
  const resolved = formatPointer([...parsePointer(parentPointer), key]);
  if (existed) dropKeys(sources, resolved);
  return { op: "add", path: resolved, from: null, existed, resolved };
}

function take(
  doc: JsonObject,
  pointer: string,
  sources: Record<string, unknown>,
): [JsonValue, string] {
  const { parent, token, parentPointer } = locate(doc, pointer);
  if (Array.isArray(parent)) {
    const i = arrayIndex(parent, token, false);
    const [value] = parent.splice(i, 1);
    const resolved = `${parentPointer}/${i}`;
    dropKeys(sources, resolved);
    shiftIndexes(sources, parentPointer, i + 1, -1);
    return [value as JsonValue, resolved];
  }
  if (!Object.hasOwn(parent, token)) throw new PatchError(`\`${pointer}\` does not exist`);
  const value = (parent as JsonObject)[token] as JsonValue;
  delete (parent as JsonObject)[token];
  dropKeys(sources, pointer);
  return [value, pointer];
}

/**
 * Applies `ops` to a copy of `content` and of `sources` (keys = pointers). `source` is set on
 * every added or replaced path. All or nothing: throws `PatchError` and changes nothing on the
 * first failing op. Returns the new content, sources and what each op touched.
 */
export function applyPatch<T>(
  content: JsonObject,
  sources: Readonly<Record<string, T>>,
  ops: readonly PatchOp[],
  source: T,
  limits: JsonLimits,
): { content: JsonObject; sources: Record<string, T>; applied: Applied[] } {
  const doc = structuredClone(content) as JsonObject;
  const src: Record<string, T> = { ...sources };
  const applied: Applied[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "add": {
        const value = cleanJson(op.value, limits, depthOf(op.path) + 1);
        const done = insert(doc, op.path, value, src as Record<string, unknown>);
        src[done.resolved] = source;
        applied.push(done);
        break;
      }
      case "replace": {
        if (getAt(doc, op.path) === undefined)
          throw new PatchError(`\`${op.path}\` does not exist`);
        const value = cleanJson(op.value, limits, depthOf(op.path) + 1);
        const { parent, token } = locate(doc, op.path);
        if (Array.isArray(parent)) parent[arrayIndex(parent, token, false)] = value;
        else (parent as JsonObject)[token] = value;
        dropKeys(src, op.path);
        src[op.path] = source;
        applied.push({ op: "replace", path: op.path, from: null, existed: true });
        break;
      }
      case "remove": {
        const [, resolved] = take(doc, op.path, src as Record<string, unknown>);
        applied.push({ op: "remove", path: resolved, from: null, existed: true });
        break;
      }
      case "move": {
        if (isUnder(op.path, op.from) && op.path !== op.from) {
          throw new PatchError("cannot move a field into itself");
        }
        if (getAt(doc, op.from) === undefined)
          throw new PatchError(`\`${op.from}\` does not exist`);
        // Keep the moved fields' sources: park them, take, insert, restore under the new path.
        const parked: Record<string, T> = {};
        for (const [k, v] of Object.entries(src)) if (isUnder(k, op.from)) parked[k] = v;
        const [value, from] = take(doc, op.from, src as Record<string, unknown>);
        const done = insert(doc, op.path, value, src as Record<string, unknown>);
        moveKeys(parked, from, done.resolved);
        Object.assign(src, parked);
        applied.push({ op: "move", path: done.resolved, from, existed: done.existed });
        break;
      }
      default:
        throw new PatchError("unknown op");
    }
  }
  const checked = checkContent(doc, limits);
  return { content: checked, sources: src, applied };
}

function depthOf(pointer: string): number {
  return parsePointer(pointer).length;
}

/** Parses untrusted ops (from a model): drops nothing silently, throws on the first bad one. */
export function parseOps(raw: unknown): PatchOp[] {
  if (!Array.isArray(raw)) throw new PatchError("ops must be a list");
  return raw.map((o, i) => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) {
      throw new PatchError(`op ${i + 1} is not an object`);
    }
    const r = o as Record<string, unknown>;
    const path = typeof r.path === "string" ? r.path : null;
    if (path === null) throw new PatchError(`op ${i + 1} has no path`);
    switch (r.op) {
      case "add":
      case "replace":
        if (!("value" in r) || r.value === undefined) {
          throw new PatchError(`op ${i + 1} has no value`);
        }
        return { op: r.op, path, value: r.value as JsonValue };
      case "remove":
        return { op: "remove", path };
      case "move":
        if (typeof r.from !== "string") throw new PatchError(`op ${i + 1} has no from`);
        return { op: "move", from: r.from, path };
      default:
        throw new PatchError(`op ${i + 1}: unknown op \`${String(r.op)}\``);
    }
  });
}

// ---- rendering ----------------------------------------------------------------------------

export interface OutlineOptions {
  /** Whether the node at `pointer` is shown (hidden nodes and everything below them go). */
  visible?: (pointer: string) => boolean;
  /** A short note after the node at `pointer` (e.g. `(Owen 說)`), or `null`. */
  tag?: (pointer: string) => string | null;
}

const isScalar = (v: JsonValue) => v === null || typeof v !== "object";

function scalarText(v: JsonValue): string {
  if (v === null) return "(無)";
  if (typeof v === "string") return v.trim() === "" ? "(空)" : v.trim();
  return String(v);
}

/** Text with its continuation lines indented under its bullet. */
function block(text: string, indent: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join(`\n${indent}  `);
}

const pointerToken = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * A compact Markdown-like outline of a JSON object: one `- key: value` bullet per field,
 * nested bullets for nested objects, lists of scalars joined with `、`, lists of objects as
 * numbered items, no quotes or braces. Text values may hold Markdown (kept as is, continuation
 * lines indented). Deterministic: keys keep their stored order. Callers wrap the result in a
 * data block, which escapes the delimiters.
 */
export function outline(content: JsonObject, options: OutlineOptions = {}, indent = ""): string[] {
  return objectLines(content, "", indent, options);
}

function objectLines(
  obj: JsonObject,
  pointer: string,
  indent: string,
  o: OutlineOptions,
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const p = `${pointer}/${pointerToken(key)}`;
    if (o.visible && !o.visible(p)) continue;
    out.push(...nodeLines(block(key, indent), value, p, indent, o));
  }
  return out;
}

function withTag(text: string, tag: string | null): string {
  return tag === null ? text : `${text} ${tag}`;
}

/** Lines of one node; `label` is `key` for object members, `(n)` for list items. */
function nodeLines(
  label: string,
  value: JsonValue,
  pointer: string,
  indent: string,
  o: OutlineOptions,
): string[] {
  const tag = o.tag?.(pointer) ?? null;
  if (isScalar(value)) {
    return [withTag(`${indent}- ${label}: ${block(scalarText(value), indent)}`, tag)];
  }
  if (Array.isArray(value)) {
    const shown = value
      .map((v, i) => [v, `${pointer}/${i}`] as const)
      .filter(([, p]) => !o.visible || o.visible(p));
    if (shown.length === 0) return [withTag(`${indent}- ${label}: (空)`, tag)];
    if (shown.every(([v]) => isScalar(v))) {
      const items = shown.map(([v, p]) =>
        withTag(block(scalarText(v), indent), o.tag?.(p) ?? null),
      );
      return [withTag(`${indent}- ${label}: ${items.join("、")}`, tag)];
    }
    const lines = [withTag(`${indent}- ${label}:`, tag)];
    shown.forEach(([v, p], i) => {
      lines.push(...nodeLines(`(${i + 1})`, v, p, `${indent}  `, o));
    });
    return lines;
  }
  const children = objectLines(value as JsonObject, pointer, `${indent}  `, o);
  if (children.length === 0) return [withTag(`${indent}- ${label}: (空)`, tag)];
  return [withTag(`${indent}- ${label}:`, tag), ...children];
}
