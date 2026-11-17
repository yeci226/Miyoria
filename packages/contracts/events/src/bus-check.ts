// Checking what is published on the in-process bus against the registered payload schemas
// (docs/design/v5-contracts.md §3, K12a). Tests only: the kernel's bus hands every envelope to a
// hook that exists only under Vitest, and the repository's test setup (`vitest.bus-check.ts`)
// feeds them to a `BusCheck`. Nothing in production validates a bus payload.
//
// For each event: its topic must be registered (its own definition or a family that covers it),
// its payload must parse with that schema, the parse must not drop a key the publisher set (the
// schema states everything that is published), and the payload must be plain JSON (no class
// instance, `Date`, `Map`, function, non-finite number). A property set to `undefined` is noted,
// not counted as a problem: JSON drops it, and the schema reads it as missing.
//
// Pure data and functions: no I/O, no bus, no Vitest.

import type { z } from "zod";
import type { EventRegistry } from "./registry.js";

/** How the test setup checks published events. */
export type BusCheckMode = "off" | "report" | "strict";

export const BUS_CHECK_MODES: readonly BusCheckMode[] = ["off", "report", "strict"];

/**
 * Off unless asked for: checking every event costs time on each test run and, under load, made a
 * timing-sensitive test fail. Work on payload schemas runs with `MIYORIA_BUS_CHECK=report`.
 */
export const DEFAULT_BUS_CHECK_MODE: BusCheckMode = "off";

/** The mode a setting names (`MIYORIA_BUS_CHECK`); unset or empty is the default. */
export function busCheckMode(value: string | undefined): BusCheckMode {
  const mode = (value ?? "").trim().toLowerCase();
  if (mode === "") return DEFAULT_BUS_CHECK_MODE;
  if ((BUS_CHECK_MODES as readonly string[]).includes(mode)) return mode as BusCheckMode;
  throw new Error(
    `MIYORIA_BUS_CHECK=${value}: expected one of ${BUS_CHECK_MODES.join(", ")} (unset: ${DEFAULT_BUS_CHECK_MODE})`,
  );
}

/** What is wrong with one published event. */
export type BusEventProblem =
  /** No definition and no family covers the topic. */
  | { kind: "unregistered" }
  /** The payload does not parse; `path` is the first failing one. */
  | { kind: "invalid"; path: string; message: string }
  /** The payload parses, but the schema has no place for a key the publisher set. */
  | { kind: "unknown_key"; path: string }
  /** Something that is not JSON: `what` says which (`Date`, `Map`, `instance of Foo`, ...). */
  | { kind: "not_json"; path: string; what: string };

export type BusEventProblemKind = BusEventProblem["kind"];

/** The result of checking one event. */
export interface BusEventCheck {
  /** The registered type or family that governs the topic; `null`: unregistered. */
  governedBy: string | null;
  problems: BusEventProblem[];
  /** Properties set to `undefined` (JSON drops them). */
  undefinedAt: string[];
}

/** At most this many unknown keys are reported per event. */
const MAX_UNKNOWN_KEYS = 5;

/** Deeper than this, a payload is not walked further. */
const MAX_DEPTH = 64;

/** `a.b[0].c`; the payload itself is `(payload)`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out === "" ? String(key) : `.${String(key)}`;
  }
  return out === "" ? "(payload)" : out;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** What a value that JSON cannot carry is, for a report. */
function notJsonKind(value: unknown): string {
  if (value instanceof Date) return "Date";
  if (value instanceof Map) return "Map";
  if (value instanceof Set) return "Set";
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name !== "" ? `instance of ${name}` : "non-plain object";
}

/** Walks `value` for what JSON cannot carry; appends to `problems` and `undefinedAt`. */
function walkJson(
  value: unknown,
  path: PropertyKey[],
  seen: Set<object>,
  problems: BusEventProblem[],
  undefinedAt: string[],
): void {
  if (path.length > MAX_DEPTH) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        problems.push({ kind: "not_json", path: formatPath(path), what: String(value) });
      }
      return;
    case "undefined":
      // Only reached for the payload itself and array items: properties are handled below.
      problems.push({
        kind: "not_json",
        path: formatPath(path),
        what: path.length === 0 ? "undefined" : "undefined in an array (JSON makes it null)",
      });
      return;
    case "bigint":
    case "symbol":
    case "function":
      problems.push({ kind: "not_json", path: formatPath(path), what: typeof value });
      return;
  }
  if (value === null) return;
  const object = value as object;
  if (seen.has(object)) {
    problems.push({ kind: "not_json", path: formatPath(path), what: "a cycle" });
    return;
  }
  seen.add(object);
  if (Array.isArray(object)) {
    object.forEach((item, i) => {
      walkJson(item, [...path, i], seen, problems, undefinedAt);
    });
  } else if (isPlainObject(object)) {
    for (const [key, item] of Object.entries(object)) {
      if (item === undefined) undefinedAt.push(formatPath([...path, key]));
      else walkJson(item, [...path, key], seen, problems, undefinedAt);
    }
  } else {
    problems.push({ kind: "not_json", path: formatPath(path), what: notJsonKind(object) });
  }
  seen.delete(object);
}

/** Keys of `input` (set, not `undefined`) that the parsed `output` no longer has. */
function droppedKeys(input: unknown, output: unknown, path: PropertyKey[], out: string[]): void {
  if (out.length >= MAX_UNKNOWN_KEYS || path.length > MAX_DEPTH) return;
  if (typeof input !== "object" || input === null) return;
  if (typeof output !== "object" || output === null) return;
  if (Array.isArray(input)) {
    if (!Array.isArray(output)) return;
    input.forEach((item, i) => {
      droppedKeys(item, output[i], [...path, i], out);
    });
    return;
  }
  if (!isPlainObject(input) || Array.isArray(output)) return;
  const parsed = output as Record<string, unknown>;
  for (const [key, item] of Object.entries(input)) {
    if (item === undefined) continue;
    if (!Object.hasOwn(parsed, key)) out.push(formatPath([...path, key]));
    else droppedKeys(item, parsed[key], [...path, key], out);
    if (out.length >= MAX_UNKNOWN_KEYS) return;
  }
}

/** Checks one published event against `registry`. */
export function checkBusEvent(
  registry: EventRegistry,
  topic: string,
  payload: unknown,
): BusEventCheck {
  const problems: BusEventProblem[] = [];
  const undefinedAt: string[] = [];
  walkJson(payload, [], new Set(), problems, undefinedAt);
  const definition = registry.resolve(topic);
  if (definition === null) {
    problems.push({ kind: "unregistered" });
    return { governedBy: null, problems, undefinedAt };
  }
  const parsed = (definition.data as z.ZodType).safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    problems.push({
      kind: "invalid",
      path: formatPath(issue?.path ?? []),
      message: issue?.message ?? parsed.error.message,
    });
  } else {
    const dropped: string[] = [];
    droppedKeys(payload, parsed.data, [], dropped);
    for (const path of dropped) problems.push({ kind: "unknown_key", path });
  }
  return { governedBy: definition.type, problems, undefinedAt };
}

/** One published event, as the test setup hands it over. */
export interface BusCheckEvent {
  topic: string;
  /** The publishing module (the envelope's `source`). */
  source: string;
  payload: unknown;
}

/** Where an event was published: the test file and the running test, when known. */
export interface BusCheckPlace {
  file: string | null;
  test: string | null;
}

/** One problem, with where it was seen. Repeats of the same problem are counted, not listed. */
export type BusCheckFinding = BusEventProblem & {
  topic: string;
  source: string;
  file: string | null;
  test: string | null;
  count: number;
};

/** What a topic did over a run. */
export interface BusCheckTopic {
  count: number;
  /** The registered type or family that governs it; `null`: unregistered. */
  governedBy: string | null;
  sources: string[];
  files: string[];
  /** Properties some payload set to `undefined`. */
  undefinedAt: string[];
}

/** Everything a run saw, JSON so test workers can hand it to the run's summary. */
export interface BusCheckReport {
  events: number;
  topics: Record<string, BusCheckTopic>;
  findings: BusCheckFinding[];
}

/** The strict mode's failure: what the test's events got wrong. */
export class BusCheckError extends Error {
  override name = "BusCheckError";
  constructor(readonly findings: readonly BusCheckFinding[]) {
    super(
      `bus check: ${findings.length} published event problem(s)\n${findings.map((f) => `  ${describeFinding(f)}`).join("\n")}`,
    );
  }
}

function findingKey(f: BusCheckFinding): string {
  const detail = f.kind === "unregistered" ? "" : f.path;
  return `${f.topic}\u0000${f.source}\u0000${f.kind}\u0000${detail}`;
}

/** One line for a finding: the topic, the publishing module, what is wrong and where. */
export function describeFinding(f: BusCheckFinding): string {
  const head = `\`${f.topic}\` from ${f.source}`;
  const where = f.file === null ? "" : ` (${f.file}${f.test === null ? "" : `: ${f.test}`})`;
  const times = f.count > 1 ? ` [${f.count}x]` : "";
  switch (f.kind) {
    case "unregistered":
      return `${head}: unregistered topic${times}${where}`;
    case "invalid":
      return `${head}: invalid at ${f.path}: ${f.message}${times}${where}`;
    case "unknown_key":
      return `${head}: the schema has no ${f.path}${times}${where}`;
    case "not_json":
      return `${head}: not JSON at ${f.path}: ${f.what}${times}${where}`;
  }
}

/** Collects the checks of one test file's events. */
export class BusCheck {
  readonly mode: Exclude<BusCheckMode, "off">;
  readonly #registry: EventRegistry;
  #events = 0;
  readonly #topics = new Map<string, BusCheckTopic>();
  readonly #findings = new Map<string, BusCheckFinding>();
  /** Findings since the last `endTest`, for the strict mode. */
  #pending: BusCheckFinding[] = [];

  constructor(registry: EventRegistry, mode: Exclude<BusCheckMode, "off">) {
    this.#registry = registry;
    this.mode = mode;
  }

  /** Checks one event. Never throws: the publisher must not notice. */
  published(event: BusCheckEvent, place: BusCheckPlace): void {
    const check = checkBusEvent(this.#registry, event.topic, event.payload);
    this.#events++;
    const topic = this.#topics.get(event.topic) ?? {
      count: 0,
      governedBy: check.governedBy,
      sources: [],
      files: [],
      undefinedAt: [],
    };
    topic.count++;
    addOnce(topic.sources, event.source);
    if (place.file !== null) addOnce(topic.files, place.file);
    for (const path of check.undefinedAt) addOnce(topic.undefinedAt, path);
    this.#topics.set(event.topic, topic);
    for (const problem of check.problems) {
      const finding: BusCheckFinding = {
        ...problem,
        topic: event.topic,
        source: event.source,
        file: place.file,
        test: place.test,
        count: 1,
      };
      const key = findingKey(finding);
      const known = this.#findings.get(key);
      if (known === undefined) this.#findings.set(key, finding);
      else known.count++;
      this.#pending.push(finding);
    }
  }

  /**
   * Ends a test (or a file's hooks). In strict mode, throws `BusCheckError` when anything the
   * test published had a problem; in report mode, does nothing.
   */
  endTest(): void {
    const pending = this.#pending;
    this.#pending = [];
    if (this.mode === "strict" && pending.length > 0) throw new BusCheckError(pending);
  }

  report(): BusCheckReport {
    return {
      events: this.#events,
      topics: Object.fromEntries(
        [...this.#topics.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v]),
      ),
      findings: [...this.#findings.values()],
    };
  }
}

function addOnce(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/** One report of several (the files of a run, or the runs of several packages). */
export function mergeBusCheckReports(reports: Iterable<BusCheckReport>): BusCheckReport {
  let events = 0;
  const topics = new Map<string, BusCheckTopic>();
  const findings = new Map<string, BusCheckFinding>();
  for (const report of reports) {
    events += report.events;
    for (const [name, t] of Object.entries(report.topics)) {
      const known = topics.get(name);
      if (known === undefined) {
        topics.set(name, {
          ...t,
          sources: [...t.sources],
          files: [...t.files],
          undefinedAt: [...t.undefinedAt],
        });
        continue;
      }
      known.count += t.count;
      for (const s of t.sources) addOnce(known.sources, s);
      for (const f of t.files) addOnce(known.files, f);
      for (const p of t.undefinedAt) addOnce(known.undefinedAt, p);
    }
    for (const f of report.findings) {
      const key = findingKey(f);
      const known = findings.get(key);
      if (known === undefined) findings.set(key, { ...f });
      else known.count += f.count;
    }
  }
  return {
    events,
    topics: Object.fromEntries([...topics.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    findings: [...findings.values()],
  };
}

const KIND_TITLES: Record<BusEventProblemKind, string> = {
  unregistered: "unregistered topics",
  invalid: "payloads that do not parse",
  unknown_key: "keys the schema does not have",
  not_json: "values that are not JSON",
};

/** The summary a run prints: one line when everything fits, one block per kind of problem. */
export function formatBusCheckSummary(
  report: BusCheckReport,
  options: { mode: BusCheckMode; project: string },
): string {
  const topics = Object.keys(report.topics).length;
  const head = `bus check (${options.mode}) ${options.project}: ${report.events} event(s) on ${topics} topic(s)`;
  if (report.findings.length === 0) return `${head}, every payload fits its schema`;
  const lines = [`${head}, ${report.findings.length} problem(s):`];
  for (const kind of Object.keys(KIND_TITLES) as BusEventProblemKind[]) {
    const of = report.findings.filter((f) => f.kind === kind);
    if (of.length === 0) continue;
    lines.push(`  ${KIND_TITLES[kind]}:`);
    if (kind === "unregistered") {
      const byTopic = new Map<string, { sources: Set<string>; count: number }>();
      for (const f of of) {
        const t = byTopic.get(f.topic) ?? { sources: new Set(), count: 0 };
        t.sources.add(f.source);
        t.count += f.count;
        byTopic.set(f.topic, t);
      }
      for (const [topic, t] of [...byTopic.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        lines.push(`    \`${topic}\` from ${[...t.sources].join(", ")} [${t.count}x]`);
      }
      continue;
    }
    for (const f of of) lines.push(`    ${describeFinding(f)}`);
  }
  return lines.join("\n");
}
