// Evidence: what makes a memory part of her past (docs/design/v3-architecture.md §11).
//
// A person fact is stored only when a line somebody really said backs it. The check is lexical
// and runs without a model: the fact has to share content words with the line it cites, so a
// summarizer that invents "Owen 養了一隻貓" gets nothing stored, because nothing in the log says
// so. A line points at its EventLog event (`LogEvent.id`); when the log holds no event for it
// (the `facts` module is off, or the event was compacted away) it points at the chat line
// itself, `msg:<id>`.

import type { LogEntry } from "@miyoria/store";
import {
  type AccountRef,
  type EventLog,
  isJsonObject,
  type JsonValue,
  type LogEvent,
  timestampMs,
} from "@miyoria/types";
import type { EvidenceConfig } from "./config.js";
import { tokenize } from "./tokenize.js";

/** What the evidence checks and `forget` need of the EventLog. */
export type EventReader = Pick<EventLog, "query" | "get">;

/** Prefix of an evidence id that names a chat line the EventLog has no event for. */
export const LINE_REF_PREFIX = "msg:";

/** A line that was really said, with the id it is cited by. */
export interface EvidenceLine {
  /** EventLog id, or `msg:<chat line id>`. */
  ref: string;
  text: string;
  author: AccountRef;
  name: string;
  /** One of her own lines. */
  self: boolean;
}

/** True for an id that names an EventLog event (not a bare chat line). */
export function isEventRef(ref: string): boolean {
  return !ref.startsWith(LINE_REF_PREFIX);
}

/** The text of an observation's `summary`, when `event` is an observation. */
export function summaryOf(event: LogEvent): string | null {
  const body: JsonValue = event.body;
  if (!isJsonObject(body)) return null;
  const observation = body.observation;
  if (!isJsonObject(observation)) return null;
  return typeof observation.summary === "string" ? observation.summary : null;
}

/**
 * Pairs chat lines with the observations the `facts` module logged for them (matched by who
 * said what, near the same time) and returns each line with the id to cite. Without an event
 * log, or for a line the log does not hold, the id is `msg:<line id>`.
 */
export async function linkLines(
  events: EventReader | null,
  lines: readonly LogEntry[],
  config: EvidenceConfig,
): Promise<EvidenceLine[]> {
  const first = lines[0];
  const last = lines[lines.length - 1];
  const found = new Map<string, string>();
  if (events !== null && first && last) {
    const windowMs = config.match_window_secs * 1000;
    let logged: LogEvent[] = [];
    try {
      logged = await events.query({
        kinds: ["observation"],
        context: first.context,
        since: new Date(timestampMs(first.ts) - windowMs).toISOString(),
        until: new Date(timestampMs(last.ts) + windowMs + 1).toISOString(),
        order: "asc",
        limit: Math.max(200, lines.length * 4),
      });
    } catch {
      // The log is evidence, not a dependency: without it lines cite themselves.
    }
    const taken = new Set<string>();
    for (const entry of lines) {
      if (entry.is_self) continue;
      const wanted = `${entry.author_name}:${entry.text}`;
      const at = timestampMs(entry.ts);
      let best: LogEvent | null = null;
      for (const event of logged) {
        if (taken.has(event.id) || summaryOf(event) !== wanted) continue;
        if (Math.abs(timestampMs(event.at) - at) > windowMs) continue;
        if (
          best === null ||
          Math.abs(timestampMs(event.at) - at) < Math.abs(timestampMs(best.at) - at)
        ) {
          best = event;
        }
      }
      if (best !== null) {
        taken.add(best.id);
        found.set(entry.id, best.id);
      }
    }
  }
  return lines.map((entry) => ({
    ref: found.get(entry.id) ?? `${LINE_REF_PREFIX}${entry.id}`,
    text: entry.text,
    author: entry.author,
    name: entry.author_name,
    self: entry.is_self,
  }));
}

/** Content words of `text` minus the ones that only name people. */
function contentWords(text: string, ignore: ReadonlySet<string>): string[] {
  return [...new Set(tokenize(text))].filter((t) => !ignore.has(t));
}

/** The words that only name someone (their tokens are not content). */
export function nameWords(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const name of names) for (const t of tokenize(name)) out.add(t);
  return out;
}

/**
 * The lines among `lines` that back `statement`: each shares at least `min_overlap` of the
 * statement's content words (names left out). Best first; empty when nothing backs it.
 */
export function supporting(
  statement: string,
  lines: readonly EvidenceLine[],
  config: EvidenceConfig,
  names: ReadonlySet<string> = new Set(),
): EvidenceLine[] {
  const words = contentWords(statement, names);
  if (words.length === 0) return [];
  const scored: Array<[number, EvidenceLine]> = [];
  for (const line of lines) {
    const have = new Set(tokenize(line.text));
    const hit = words.filter((w) => have.has(w)).length;
    if (hit > 0 && hit / words.length >= config.min_overlap)
      scored.push([hit / words.length, line]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.map(([, line]) => line);
}

/** Evidence ids without repeats, kept to `max` (the newest, which come last, win). */
export function mergeRefs(
  max: number,
  ...lists: ReadonlyArray<readonly string[] | undefined>
): string[] {
  const seen = new Set<string>();
  for (const list of lists) for (const ref of list ?? []) seen.add(ref);
  const all = [...seen];
  return max > 0 && all.length > max ? all.slice(all.length - max) : all;
}
