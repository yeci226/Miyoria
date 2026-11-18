// Format-preserving edits of TOML files (`miyoria.toml`, `profile.toml`).
//
// The text is the source of truth: a small scanner finds table headers and `key = value`
// entries (with their exact spans), edits splice new text in, and every result is re-parsed
// with smol-toml so an edit can never produce an invalid file. Comments, blank lines, key order
// and the layout of untouched lines stay exactly as they were.
//
// Rules:
// * replacing a value keeps the key text, the spacing and the trailing comment;
// * a new key goes after the last entry of its table;
// * a new table goes right after the last table sharing its longest existing prefix
//   (`[modules.api.discord_oauth]` after `[modules.api]`), or at the end of the file; after that
//   table's trailing comments, never between it and them (a comment block that sits right above
//   the next table, after a blank line, stays with that table);
// * keys inside inline tables are edited by rewriting that inline table.

import { parse as parseToml, TomlDate } from "smol-toml";

export type TomlValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | TomlValue[]
  | { [key: string]: TomlValue };

export type TomlTable = { [key: string]: TomlValue };

export class TomlEditError extends Error {
  override readonly name = "TomlEditError";
}

// ---- dotted keys -------------------------------------------------------------------------

function isBareChar(c: string): boolean {
  return /^[A-Za-z0-9_-]$/.test(c);
}

/** Splits `modules."voice.link".bind` into `["modules", "voice.link", "bind"]`. */
export function parseKey(key: string): string[] {
  const s = key.trim();
  const segments: string[] = [];
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i] as string)) i++;
  };
  for (;;) {
    ws();
    let seg = "";
    const c = s[i];
    if (c === '"') {
      i++;
      for (;;) {
        const ch = s[i++];
        if (ch === undefined) throw new TomlEditError(`\`${key}\`:引號沒有結束`);
        if (ch === "\\") {
          const next = s[i++];
          if (next === undefined) throw new TomlEditError(`\`${key}\`:引號沒有結束`);
          seg += next;
        } else if (ch === '"') break;
        else seg += ch;
      }
    } else if (c === "'") {
      i++;
      for (;;) {
        const ch = s[i++];
        if (ch === undefined) throw new TomlEditError(`\`${key}\`:引號沒有結束`);
        if (ch === "'") break;
        seg += ch;
      }
    } else {
      while (i < s.length) {
        const ch = s[i] as string;
        if (ch === "." || /\s/.test(ch)) break;
        if (!isBareChar(ch)) {
          throw new TomlEditError(
            `\`${key}\`:鍵名裡有 \`${ch}\` 的部分要加引號,例如 modules."voice.link".bind`,
          );
        }
        seg += ch;
        i++;
      }
      if (seg === "") throw new TomlEditError(`\`${key}\`:有空的鍵名`);
    }
    segments.push(seg);
    ws();
    const next = s[i++];
    if (next === undefined) break;
    if (next !== ".") throw new TomlEditError(`\`${key}\`:多了 \`${next}\``);
  }
  return segments;
}

/** Inverse of `parseKey`; quotes segments that are not bare keys. */
export function formatKey(path: readonly string[]): string {
  return path
    .map((s) =>
      s !== "" && [...s].every(isBareChar)
        ? s
        : `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
    .join(".");
}

// ---- values ------------------------------------------------------------------------------

export function isTable(value: TomlValue | undefined): value is TomlTable {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** TOML text of a value (inline form). */
export function serializeValue(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Number.POSITIVE_INFINITY) return "inf";
    if (value === Number.NEGATIVE_INFINITY) return "-inf";
    return Number.isInteger(value) ? `${value}.0` : String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(serializeValue).join(", ")}]`;
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  return `{ ${entries.map(([k, v]) => `${formatKey([k])} = ${serializeValue(v)}`).join(", ")} }`;
}

/** Alias used for display: TOML text without surrounding whitespace or comments. */
export const showValue = serializeValue;

/** Strings without quotes, arrays as `a, b`, everything else as TOML. */
export function plainValue(value: TomlValue): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plainValue).join(", ");
  return serializeValue(value);
}

/**
 * Parses a command-line value as TOML (`3`, `true`, `["a"]`, `"x"`); anything that is not a
 * single valid TOML value is taken as a plain string.
 */
export function parseValue(text: string): TomlValue {
  try {
    const parsed = parseToml(`v = ${text.trim()}`, { integersAsBigInt: true }) as TomlTable;
    const keys = Object.keys(parsed);
    if (keys.length === 1 && keys[0] === "v" && parsed.v !== undefined) return parsed.v;
  } catch {
    // not TOML: a plain string
  }
  return text;
}

export function parseTomlText(text: string): TomlTable {
  return parseToml(text, { integersAsBigInt: true }) as TomlTable;
}

export interface Leaf {
  path: string[];
  value: TomlValue;
}

/** Every value in document order; tables and arrays of tables are walked into. */
export function leaves(value: TomlValue, prefix: string[] = []): Leaf[] {
  const out: Leaf[] = [];
  const walk = (v: TomlValue, path: string[]) => {
    if (isTable(v)) {
      for (const [k, child] of Object.entries(v)) walk(child, [...path, k]);
    } else if (Array.isArray(v) && v.length > 0 && v.every(isTable)) {
      v.forEach((t, i) => {
        walk(t, [...path, String(i)]);
      });
    } else {
      out.push({ path, value: v });
    }
  };
  walk(value, prefix);
  return out;
}

/** Value at `path` in a parsed tree (numeric segments index arrays). */
export function getIn(root: TomlValue, path: readonly string[]): TomlValue | undefined {
  let cur: TomlValue | undefined = root;
  for (const seg of path) {
    if (isTable(cur)) cur = cur[seg];
    else if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else return undefined;
  }
  return cur;
}

// ---- scanner -----------------------------------------------------------------------------

interface Header {
  path: string[];
  array: boolean;
  lineStart: number;
  /** After the header line (including its newline). */
  end: number;
}

interface Entry {
  /** Path of the enclosing `[table]` header. */
  table: string[];
  /** The (possibly dotted) key of the entry. */
  key: string[];
  /** Under a `[[array]]` header. */
  inArray: boolean;
  /** Index of the enclosing header in `headers`, -1 for the root table. */
  header: number;
  lineStart: number;
  valueStart: number;
  valueEnd: number;
  /** After the entry's last line (including its newline). */
  end: number;
}

const DATE_TIME_SPACE = /^\d{4}-\d{2}-\d{2} \d/;

class Scanner {
  readonly headers: Header[] = [];
  readonly entries: Entry[] = [];
  i = 0;

  constructor(readonly s: string) {
    this.#scan();
  }

  #scan(): void {
    const s = this.s;
    let table: string[] = [];
    let inArray = false;
    let header = -1;
    while (this.i < s.length) {
      const lineStart = this.i;
      this.#spaces();
      const c = s[this.i];
      if (c === undefined) break;
      if (c === "\n") {
        this.i++;
        continue;
      }
      if (c === "\r" || c === "#") {
        this.#restOfLine();
        continue;
      }
      if (c === "[") {
        const array = s[this.i + 1] === "[";
        this.i += array ? 2 : 1;
        const path = this.#keyPath();
        this.#spaces();
        this.i += array ? 2 : 1;
        this.#restOfLine();
        this.headers.push({ path, array, lineStart, end: this.i });
        table = path;
        inArray = array;
        header = this.headers.length - 1;
        continue;
      }
      const key = this.#keyPath();
      this.#spaces();
      this.i++; // '='
      this.#spaces();
      const valueStart = this.i;
      this.#value();
      const valueEnd = this.i;
      this.#restOfLine();
      this.entries.push({
        table,
        key,
        inArray,
        header,
        lineStart,
        valueStart,
        valueEnd,
        end: this.i,
      });
    }
  }

  #spaces(): void {
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
  }

  /** Whitespace, newlines and comments (inside arrays). */
  #blank(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else if (c === "#") {
        while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
      } else return;
    }
  }

  /** Skips the rest of the line, including its newline. */
  #restOfLine(): void {
    const nl = this.s.indexOf("\n", this.i);
    this.i = nl === -1 ? this.s.length : nl + 1;
  }

  #keyPath(): string[] {
    const s = this.s;
    const path: string[] = [];
    for (;;) {
      this.#spaces();
      const c = s[this.i];
      if (c === '"' || c === "'") {
        const start = this.i;
        this.#string();
        path.push(decodeString(s.slice(start, this.i)));
      } else {
        const start = this.i;
        while (this.i < s.length && isBareChar(s[this.i] as string)) this.i++;
        path.push(s.slice(start, this.i));
      }
      this.#spaces();
      if (s[this.i] !== ".") return path;
      this.i++;
    }
  }

  #string(): void {
    this.i = scanStringEnd(this.s, this.i);
  }

  #value(): void {
    const s = this.s;
    const c = s[this.i];
    if (c === '"' || c === "'") {
      this.#string();
      return;
    }
    if (c === "[") {
      this.i++;
      for (;;) {
        this.#blank();
        if (this.i >= s.length) return;
        if (s[this.i] === "]") {
          this.i++;
          return;
        }
        this.#value();
        this.#blank();
        if (s[this.i] === ",") this.i++;
      }
    }
    if (c === "{") {
      this.i++;
      for (;;) {
        this.#spaces();
        if (this.i >= s.length) return;
        if (s[this.i] === "}") {
          this.i++;
          return;
        }
        this.#keyPath();
        this.#spaces();
        this.i++; // '='
        this.#spaces();
        this.#value();
        this.#spaces();
        if (s[this.i] === ",") this.i++;
      }
    }
    while (this.i < s.length) {
      const ch = s[this.i] as string;
      if (ch === " " && DATE_TIME_SPACE.test(s.slice(this.i - 10, this.i + 2))) {
        this.i++;
        continue;
      }
      if (" \t#,]}\r\n".includes(ch)) return;
      this.i++;
    }
  }
}

/** Decodes a TOML basic or literal string token (single-line or multi-line). */
function decodeString(token: string): string {
  const parsed = parseToml(`v = ${token}`) as { v?: unknown };
  return typeof parsed.v === "string" ? parsed.v : token;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((seg, i) => path[i] === seg);
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && startsWith(a, b);
}

// ---- document ----------------------------------------------------------------------------

/** A TOML file edited in place. */
export class TomlDocument {
  #text: string;
  #data: TomlTable;
  #scan: Scanner;

  private constructor(text: string, data: TomlTable) {
    this.#text = text;
    this.#data = data;
    this.#scan = new Scanner(text);
  }

  /** Parses `text`; throws smol-toml's error for invalid TOML. */
  static parse(text: string): TomlDocument {
    return new TomlDocument(text, parseTomlText(text));
  }

  toString(): string {
    return this.#text;
  }

  /** The parsed tree (integers are `bigint`). */
  get data(): TomlTable {
    return this.#data;
  }

  get(path: readonly string[]): TomlValue | undefined {
    return getIn(this.#data, path);
  }

  get #nl(): string {
    return this.#text.includes("\r\n") ? "\r\n" : "\n";
  }

  #fullPath(e: Entry): string[] {
    return [...e.table, ...e.key];
  }

  #replace(start: number, end: number, insert: string): void {
    const text = this.#text.slice(0, start) + insert + this.#text.slice(end);
    let data: TomlTable;
    try {
      data = parseTomlText(text);
    } catch (error) {
      throw new TomlEditError(
        `internal error: edit produced invalid TOML: ${(error as Error).message}`,
        {
          cause: error,
        },
      );
    }
    this.#text = text;
    this.#data = data;
    this.#scan = new Scanner(text);
  }

  /** End of a section's content: after its last entry, or after the header line. */
  #contentEnd(header: number): number {
    let end = header === -1 ? 0 : (this.#scan.headers[header] as Header).end;
    for (const e of this.#scan.entries) if (e.header === header) end = Math.max(end, e.end);
    return end;
  }

  /**
   * Where a table goes that follows the header `at`: after its last entry and the comment lines
   * that trail it (commented-out entries, notes), before the blank lines that precede the next
   * table. A comment block that touches the next table and is set off from the entries by a blank
   * line belongs to that table, so it stays below the new one.
   */
  #afterSection(at: number): number {
    const { headers } = this.#scan;
    const start = this.#contentEnd(at);
    const next = headers[at + 1];
    const text = this.#text;
    let limit = next === undefined ? text.length : next.lineStart;
    // The lines of the gap, each with its offset; the gap ends at a line start (or the file's end).
    const lines: Array<{ from: number; text: string }> = [];
    for (let from = start; from < limit; ) {
      const nl = text.indexOf("\n", from);
      const to = nl === -1 || nl >= limit ? limit : nl + 1;
      lines.push({ from, text: text.slice(from, to) });
      from = to;
    }
    const isComment = (l: { text: string }) => l.text.trimStart().startsWith("#");
    // A comment block that ends at the next table, with a blank line above it, is that table's.
    let block = lines.length;
    while (block > 0 && isComment(lines[block - 1] as { text: string })) block--;
    const above = lines[block - 1];
    if (next !== undefined && block < lines.length && above !== undefined) {
      if (above.text.trim() === "") limit = (lines[block] as { from: number }).from;
    }
    // Back over blank lines: the new table follows the last line with content.
    let pos = limit;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] as { from: number; text: string };
      if (line.from >= limit) continue;
      if (line.text.trim() !== "") break;
      pos = line.from;
    }
    return pos;
  }

  #arrayTableAt(path: readonly string[]): Header | undefined {
    return this.#scan.headers.find((h) => h.array && startsWith(path, h.path));
  }

  /**
   * Sets a value, creating missing tables. Throws `TomlEditError` when `path` is a table or
   * goes through a non-table value.
   */
  set(path: readonly string[], value: TomlValue): void {
    if (path.length === 0) throw new TomlEditError("鍵名是空的");
    const shown = formatKey(path);
    if (this.#arrayTableAt(path)) {
      throw new TomlEditError(`\`${shown}\` 在 [[陣列表格]] 裡,請用 \`miyoria config edit\` 修改`);
    }
    const { headers, entries } = this.#scan;
    const exact = entries.find((e) => !e.inArray && same(this.#fullPath(e), path));
    if (exact) {
      this.#replace(exact.valueStart, exact.valueEnd, serializeValue(value));
      return;
    }
    const isTablePath =
      headers.some((h) => startsWith(h.path, path)) ||
      entries.some((e) => !e.inArray && startsWith(this.#fullPath(e), path));
    if (isTablePath) throw new TomlEditError(`\`${shown}\` 是表格,不能設成單一值`);

    const outer = entries.find((e) => !e.inArray && startsWith(path, this.#fullPath(e)));
    if (outer) {
      const outerPath = this.#fullPath(outer);
      const current = this.get(outerPath);
      if (!isTable(current)) {
        // Name the deepest existing non-table (like toml_edit).
        throw new TomlEditError(`\`${formatKey(outerPath)}\` 是單一值,不是表格`);
      }
      const rest = path.slice(outerPath.length);
      const updated = setIn(structuredClone(current), rest, value, outerPath);
      this.#replace(outer.valueStart, outer.valueEnd, serializeValue(updated));
      return;
    }

    const parents = path.slice(0, -1);
    const last = path.slice(-1);
    const nl = this.#nl;
    // The table exists as a header: append after its last entry.
    const headerIndex = headers.findIndex((h) => !h.array && same(h.path, parents));
    if (headerIndex !== -1 || parents.length === 0) {
      this.#insertEntry(headerIndex, last, value);
      return;
    }
    // The table exists implicitly through dotted keys (`a.b = 1` under `[t]`).
    const dotted = entries.filter(
      (e) => !e.inArray && e.key.length > 1 && startsWith(this.#fullPath(e), parents),
    );
    const anchor = dotted.at(-1);
    if (anchor) {
      const rel = path.slice(anchor.table.length);
      this.#insertAfter(anchor, `${formatKey(rel)} = ${serializeValue(value)}`);
      return;
    }
    // A new table: after the last table sharing the longest existing prefix.
    const line = `[${formatKey(parents)}]${nl}${formatKey(last)} = ${serializeValue(value)}${nl}`;
    for (let n = parents.length - 1; n >= 1; n--) {
      const prefix = parents.slice(0, n);
      let at = -1;
      headers.forEach((h, i) => {
        if (startsWith(h.path, prefix)) at = i;
      });
      if (at !== -1) {
        const pos = this.#afterSection(at);
        const lead = this.#text[pos - 1] === "\n" ? "" : nl;
        this.#replace(pos, pos, `${lead}${nl}${line}`);
        return;
      }
    }
    const text = this.#text;
    let lead = "";
    if (text.trim() !== "") lead = text.endsWith("\n") ? nl : nl + nl;
    this.#replace(text.length, text.length, `${lead}${line}`);
  }

  #insertEntry(header: number, key: string[], value: TomlValue): void {
    const own = this.#scan.entries.filter((e) => e.header === header);
    const lastEntry = own.at(-1);
    const line = `${formatKey(key)} = ${serializeValue(value)}`;
    if (lastEntry) {
      this.#insertAfter(lastEntry, line);
      return;
    }
    const nl = this.#nl;
    if (header === -1) {
      this.#replace(0, 0, `${line}${nl}`);
      return;
    }
    const pos = (this.#scan.headers[header] as Header).end;
    const lead = this.#text[pos - 1] === "\n" ? "" : nl;
    this.#replace(pos, pos, `${lead}${line}${nl}`);
  }

  #insertAfter(entry: Entry, line: string): void {
    const nl = this.#nl;
    const indent = /^[ \t]*/.exec(this.#text.slice(entry.lineStart))?.[0] ?? "";
    const lead = this.#text[entry.end - 1] === "\n" ? "" : nl;
    this.#replace(entry.end, entry.end, `${lead}${indent}${line}${nl}`);
  }

  /** Removes a key or a whole table; `false` when it was not there. */
  unset(path: readonly string[]): boolean {
    if (path.length === 0 || this.get(path) === undefined) return false;
    const { headers, entries } = this.#scan;
    const exact = entries.find((e) => same(this.#fullPath(e), path));
    if (exact && !exact.inArray) {
      this.#removeRange(exact.lineStart, exact.end);
      return true;
    }
    const ranges: Array<[number, number]> = [];
    headers.forEach((h, i) => {
      if (startsWith(h.path, path)) ranges.push([h.lineStart, this.#contentEnd(i)]);
    });
    for (const e of entries) {
      const full = this.#fullPath(e);
      if (startsWith(full, path) && !startsWith(e.table, path) && !e.inArray) {
        ranges.push([e.lineStart, e.end]);
      }
    }
    if (ranges.length > 0) {
      ranges.sort((a, b) => b[0] - a[0]);
      for (const [start, end] of ranges) this.#removeRange(start, end);
      return true;
    }
    const outer = entries.find((e) => !e.inArray && startsWith(path, this.#fullPath(e)));
    if (outer) {
      const outerPath = this.#fullPath(outer);
      const current = this.get(outerPath);
      if (!isTable(current)) return false;
      const copy = structuredClone(current);
      const rest = path.slice(outerPath.length);
      const parent = getIn(copy, rest.slice(0, -1));
      if (!isTable(parent)) return false;
      delete parent[rest.at(-1) as string];
      this.#replace(outer.valueStart, outer.valueEnd, serializeValue(copy));
      return true;
    }
    return false;
  }

  /** Removes `[start, end)`; drops one of two blank lines left around the gap. */
  #removeRange(start: number, end: number): void {
    const t = this.#text;
    const blankBefore = start === 0 || /\n[ \t]*\r?\n$/.test(t.slice(0, start));
    const after = /^[ \t]*\r?\n/.exec(t.slice(end));
    const removeEnd = blankBefore && after && start > 0 ? end + after[0].length : end;
    this.#replace(start, removeEnd, "");
  }

  /**
   * Replaces the string `old` with `replacement` in every array entry directly under the table
   * `table` (e.g. the `[llm.purposes]` chains), keeping the rest of the text. Returns whether
   * anything was replaced.
   */
  replaceStringInArrays(table: readonly string[], old: string, replacement: string): boolean {
    const hits: Array<[number, number]> = [];
    for (const e of this.#scan.entries) {
      const full = this.#fullPath(e);
      if (e.inArray || full.length !== table.length + 1 || !startsWith(full, table)) continue;
      if (this.#text[e.valueStart] !== "[") continue;
      for (const [start, end] of stringTokens(this.#text, e.valueStart, e.valueEnd)) {
        if (decodeString(this.#text.slice(start, end)) === old) hits.push([start, end]);
      }
    }
    if (hits.length === 0) return false;
    hits.sort((a, b) => b[0] - a[0]);
    for (const [start, end] of hits) this.#replace(start, end, serializeValue(replacement));
    return true;
  }
}

function setIn(
  root: TomlTable,
  path: readonly string[],
  value: TomlValue,
  shown: string[],
): TomlTable {
  let cur: TomlTable = root;
  for (const [i, seg] of path.slice(0, -1).entries()) {
    const next: TomlValue | undefined = cur[seg];
    if (next === undefined) {
      const created: TomlTable = {};
      cur[seg] = created;
      cur = created;
    } else if (isTable(next)) {
      cur = next;
    } else {
      throw new TomlEditError(
        `\`${formatKey([...shown, ...path.slice(0, i + 1)])}\` 是單一值,不是表格`,
      );
    }
  }
  const lastSeg = path.at(-1) as string;
  if (isTable(cur[lastSeg])) {
    throw new TomlEditError(`\`${formatKey([...shown, ...path])}\` 是表格,不能設成單一值`);
  }
  cur[lastSeg] = value;
  return root;
}

/** Spans of the string tokens in `text[start, end)` (comments skipped). */
function stringTokens(text: string, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === "#") {
      while (i < end && text[i] !== "\n") i++;
    } else if (c === '"' || c === "'") {
      const tokenEnd = scanStringEnd(text, i);
      out.push([i, tokenEnd]);
      i = tokenEnd;
    } else i++;
  }
  return out;
}

/** End of the string token starting at `from` (basic, literal, single- or multi-line). */
function scanStringEnd(s: string, from: number): number {
  const q = s[from] as string;
  let i = from;
  if (s.startsWith(q.repeat(3), i)) {
    i += 3;
    while (i < s.length) {
      if (q === '"' && s[i] === "\\") {
        i += 2;
        continue;
      }
      if (s.startsWith(q.repeat(3), i)) {
        i += 3;
        let extra = 0;
        while (extra < 2 && s[i] === q) {
          i++;
          extra++;
        }
        return i;
      }
      i++;
    }
    return i;
  }
  i++;
  while (i < s.length) {
    const c = s[i];
    if (q === '"' && c === "\\") {
      i += 2;
      continue;
    }
    i++;
    if (c === q) return i;
  }
  return i;
}

export { TomlDate };
