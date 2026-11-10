// Prompt contributor `memory`: the section 「你記得的事」.

import type { MemoryKind, MemoryRecord } from "@miyoria/store";
import {
  type MemoryOrigin,
  type PersonId,
  type PromptContributor,
  type PromptRequest,
  type PromptSection,
  safeName,
  sameAccount,
  type Timestamp,
} from "@miyoria/types";
import type { MemoryEngine, Recalled, TurnQuery } from "./engine.js";
import { presentPeople, requestScopes } from "./scope.js";
import { relativeDate } from "./score.js";

export const CONTRIBUTOR_KEY = "memory";
export const SECTION_TITLE = "你記得的事";
/** Kinds recalled into the prompt (followups go through initiative instead). */
export const PROMPT_KINDS: readonly MemoryKind[] = ["episode", "fact", "self_note"];

export class MemoryContributor implements PromptContributor {
  readonly key = CONTRIBUTOR_KEY;
  readonly #engine: MemoryEngine;

  constructor(engine: MemoryEngine) {
    this.#engine = engine;
  }

  async contribute(request: PromptRequest, signal?: AbortSignal): Promise<PromptSection[]> {
    const scopes = requestScopes(request);
    const present = presentPeople(request);
    const recalled = await this.#engine.recall(
      scopes,
      present,
      request.query,
      PROMPT_KINDS,
      this.#engine.config.recall_limit,
      request.now,
      signal,
      turnOf(request.recent, speakingPeople(request)),
    );
    if (recalled.length === 0) return [];
    return [
      {
        key: CONTRIBUTOR_KEY,
        title: SECTION_TITLE,
        body: formatLines(recalled, request.now),
        order: 20,
      },
    ];
  }
}

/** Lines before the one being answered that a query reads (v4 §5.4: three to five). */
export const TURN_LINES = 4;

/** The turn around a line: its last `TURN_LINES` lines before it, and who is talking with her. */
export function turnOf(
  recent: readonly string[] | undefined,
  people: readonly PersonId[] | undefined,
): TurnQuery {
  const lines = (recent ?? []).slice(-TURN_LINES);
  return { context: lines.join("\n"), people: [...(people ?? [])] };
}

/** The people behind the speakers of a prompt request. */
export function speakingPeople(request: PromptRequest): PersonId[] {
  const out: PersonId[] = [];
  for (const account of request.speakers) {
    const p = request.participants.find((x) => sameAccount(x.account, account));
    if (p?.person && !out.includes(p.person)) out.push(p.person);
  }
  return out;
}

/** What a line of memory needs to be read back (a record or a retrieved memory). */
export interface Readable {
  content: string;
  origin: MemoryOrigin;
  said_by: string | null;
  created_at: Timestamp;
}

/**
 * One bullet with a relative date, by where it comes from: what she lived reads plainly
 * (`- Owen 喜歡拉麵(三天前)`); what she was told reads as what was said, not as a fact
 * (`- 「Owen」說過:下週三要考試(三天前)`); a memory of unknown provenance says so
 * (`- 外送 App 要改版(三天前,來源不明)`).
 */
export function lineOf(memory: Readable, now: Timestamp): string {
  const content = memory.content.replaceAll("\n", " ").trim();
  const when = relativeDate(memory.created_at, now);
  if (memory.origin === "told") {
    return memory.said_by !== null
      ? `- 「${safeName(memory.said_by)}」說過:${content}(${when})`
      : `- 聽說:${content}(${when})`;
  }
  if (memory.origin === "unknown") return `- ${content}(${when},來源不明)`;
  return `- ${content}(${when})`;
}

/** The record as a `Readable`. */
export function readable(record: MemoryRecord): Readable {
  return {
    content: record.content,
    origin: record.origin ?? (record.source !== null ? "told" : "unknown"),
    said_by: record.source?.name ?? null,
    created_at: record.created_at,
  };
}

/** Bullet lines of recalled records (`lineOf`). */
export function formatLines(recalled: readonly Recalled[], now: Timestamp): string {
  return recalled.map((r) => lineOf(readable(r.record), now)).join("\n");
}
