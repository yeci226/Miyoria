// The pinned layer (docs/design/v3-architecture.md §11): what is in every prompt without being
// looked up. Persona and rules come from whoever owns them (`PinnedSource`); the open
// commitments and one line per person present are composed here from memory.
//
// Everything is capped, section by section and in total, and nothing here runs a model or a
// search: a person's line is their most reliable facts joined, from one indexed read that is
// reused for `cache_secs` (a write or a forget resets it).

import { getLogger } from "@miyoria/kernel";
import type { MemoryRecord } from "@miyoria/store";
import {
  type Clock,
  type PersonId,
  type Pinned,
  type PinnedContext,
  type PinnedKey,
  type PinnedMemory,
  type PinnedSection,
  type PinnedSource,
  safeName,
  systemClock,
} from "@miyoria/types";
import type { PinnedConfig } from "./config.js";
import type { MemoryEngine } from "./engine.js";
import { visibleScopes } from "./scope.js";

const log = getLogger("memory.pinned");

export const PINNED_TITLE: Record<PinnedKey, string> = {
  persona: "人格",
  rules: "規則",
  commitments: "還沒兌現的事",
  people: "在場的人",
};

const ELLIPSIS = "…";

const chars = (s: string) => [...s].length;

/** `text` cut to `max` characters, ending in 「…」 when something was cut. */
function cut(text: string, max: number): string {
  if (chars(text) <= max) return text;
  return `${[...text].slice(0, Math.max(0, max - 1)).join("")}${ELLIPSIS}`;
}

/**
 * Lines kept while they fit in `max` characters; the one that does not fit is cut to what is
 * left, and nothing after it is kept. A line that would be cut to nothing is dropped.
 */
function withinCap(lines: readonly string[], max: number): { lines: string[]; truncated: boolean } {
  const out: string[] = [];
  let left = max;
  let truncated = false;
  for (const raw of lines) {
    const line = raw.replaceAll("\n", " ").trim();
    if (line === "") continue;
    const n = chars(line);
    if (n <= left) {
      out.push(line);
      left -= n;
      continue;
    }
    truncated = true;
    if (left >= 2) out.push(cut(line, left));
    break;
  }
  return { lines: out, truncated };
}

interface CachedLine {
  at: number;
  version: number;
  line: string | null;
}

export class PinnedReader implements PinnedMemory {
  readonly #engine: MemoryEngine;
  readonly #clock: Clock;
  readonly #sources = new Map<PinnedSource["key"], PinnedSource>();
  readonly #lines = new Map<string, CachedLine>();

  constructor(engine: MemoryEngine, clock: Clock = systemClock) {
    this.#engine = engine;
    this.#clock = clock;
  }

  get #config(): PinnedConfig {
    return this.#engine.config.pinned;
  }

  addSource(source: PinnedSource): () => void {
    this.#sources.set(source.key, source);
    return () => {
      if (this.#sources.get(source.key) === source) this.#sources.delete(source.key);
    };
  }

  async pinned(context: PinnedContext): Promise<Pinned> {
    const cfg = this.#config;
    const sections: PinnedSection[] = [];
    let left = cfg.max_chars;
    let truncated = false;

    const add = (key: PinnedKey, lines: readonly string[], cap: number) => {
      const fitted = withinCap(lines, Math.min(cap, left));
      // Cut by the section's own cap, or dropped by what the total had left.
      const over =
        fitted.truncated || fitted.lines.length < lines.filter((l) => l.trim() !== "").length;
      if (over) truncated = true;
      if (fitted.lines.length === 0) return;
      left -= fitted.lines.reduce((n, l) => n + chars(l), 0);
      sections.push({ key, title: PINNED_TITLE[key], lines: fitted.lines, truncated: over });
    };

    if (cfg.persona_chars > 0) {
      add("persona", await this.#source("persona", context), cfg.persona_chars);
    }
    add("rules", await this.#source("rules", context), cfg.rules_chars);
    const scopes = visibleScopes(context.context, context.accounts ?? [], context.present);
    add("commitments", await this.#commitments(scopes, context), left);
    add("people", await this.#people(scopes, context), left);

    return { sections, chars: cfg.max_chars - left, truncated };
  }

  async #source(key: PinnedSource["key"], context: PinnedContext): Promise<string[]> {
    const source = this.#sources.get(key);
    if (!source) return [];
    try {
      return [...(await source.lines(context))];
    } catch (error) {
      log.warn(
        { key, error: error instanceof Error ? error.message : String(error) },
        "pinned source failed",
      );
      return [];
    }
  }

  async #commitments(
    scopes: ReturnType<typeof visibleScopes>,
    context: PinnedContext,
  ): Promise<string[]> {
    const cfg = this.#config;
    try {
      const open = await this.#engine.openCommitments(scopes, context.now, cfg.max_commitments);
      return open.map(
        (r) => `- ${cut(r.content.replaceAll("\n", " ").trim(), cfg.commitment_chars)}`,
      );
    } catch (error) {
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "reading commitments failed",
      );
      return [];
    }
  }

  async #people(
    scopes: ReturnType<typeof visibleScopes>,
    context: PinnedContext,
  ): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<PersonId>();
    for (const person of context.present) {
      if (out.length >= this.#config.max_people) break;
      if (seen.has(person)) continue;
      seen.add(person);
      const line = await this.#personLine(person, scopes, context);
      if (line !== null) out.push(line);
    }
    return out;
  }

  /** One person's line, composed from their facts, or `null` when she holds none. */
  async #personLine(
    person: PersonId,
    scopes: ReturnType<typeof visibleScopes>,
    context: PinnedContext,
  ): Promise<string | null> {
    const cfg = this.#config;
    // The scopes decide what may be said here, so they are part of what is reused.
    const key = `${person}|${JSON.stringify(scopes)}`;
    const nowMs = this.#clock.now();
    const version = this.#engine.version;
    const hit = this.#lines.get(key);
    if (hit && hit.version === version && nowMs - hit.at < cfg.cache_secs * 1000) return hit.line;

    let line: string | null = null;
    try {
      const facts = await this.#engine.factsAbout(person, scopes, context.now, cfg.person_facts);
      if (facts.length > 0) {
        const name = (await this.#engine.nameOfPerson(person)) ?? "有人";
        line = `- ${cut(`${safeName(name)}:${facts.map((f) => factPhrase(f, name)).join(";")}`, cfg.person_chars)}`;
      }
    } catch (error) {
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "composing a person line failed",
      );
      return null;
    }
    if (this.#lines.size > 256) this.#lines.clear();
    this.#lines.set(key, { at: nowMs, version, line });
    return line;
  }
}

/**
 * A fact inside a person's line: told by someone else, or of unknown origin, it says so;
 * what they said about themselves, or what she saw, stands plain.
 */
function factPhrase(record: MemoryRecord, subjectName: string): string {
  const content = record.content.replaceAll("\n", " ").trim();
  const origin = record.origin ?? "unknown";
  if (origin === "unknown") return `${content}(來源不明)`;
  const by = record.source?.name;
  if (origin === "told" && by !== undefined && by !== subjectName) {
    return `${content}(${safeName(by)}說的)`;
  }
  return content;
}
