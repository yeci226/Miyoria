// The replay log: one JSON object per line.
//
// * `{"at": "<RFC 3339>", "source": "<module id>", "event": <Event>}`: one bus event as it was
//   published (the `Envelope` without ids). `at` orders the replay; the gap between two lines is
//   replayed as (fake) time passing.
// * `{"meta": {...}}` (optional, first line by convention): what the log is (`name`, `notes`)
//   and how to replay it (`ReplayMeta`: her names, the scripted LLM, config overrides).
//
// Only what she perceives is replayed (`isReplayInput`): messages, voice, presence, game and
// song events. What the replayed modules produce themselves (her turns, the Arbiter, the
// ActivityManager, world's signals) is recomputed, never fed back in; a recorded log may still
// carry it for reference.

import {
  type Event,
  eventTopic,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type Timestamp,
} from "@miyoria/types";

/** One recorded bus event. */
export interface ReplayEntry {
  at: Timestamp;
  source: string;
  event: Event;
}

/** How the scripted LLM answers (every field optional). */
export interface ScriptedLlmConfig {
  /** What she says in a reply (cycled; `<silence/>` for silence). Default: one short line. */
  replies?: string[];
  /** Time to the first token of every reply (ms). Default 1500. */
  latency_ms?: number;
  /** What a Plan call answers (JSON text, cycled). Default `{}` (nothing to do). */
  plans?: string[];
  /**
   * Plan reads her ledger: while its limits say "not now" it answers `{}` (default true; false:
   * she plans blind, as the v1 mind did).
   */
  plan_reads_ledger?: boolean;
}

export interface ReplayMeta {
  name?: string;
  notes?: string;
  /** Her display name and nicknames (who "addresses her" in voice). */
  her?: { display_name?: string; nicknames?: string[] };
  llm?: ScriptedLlmConfig;
  /** Module config overrides, by module id (merged over the replay defaults). */
  modules?: Record<string, JsonValue>;
  /** Fake time after the last event (ms) so pending turns can end. Default 60 000. */
  tail_ms?: number;
}

export interface ReplayLog {
  meta: ReplayMeta;
  entries: ReplayEntry[];
}

export class ReplayLogError extends Error {
  override readonly name = "ReplayLogError";
}

/** Topics (prefixes end in `.`) that are replayed as input. */
const INPUT_TOPICS: readonly string[] = [
  "platform.ready",
  "platform.message.created",
  "platform.typing",
  "platform.presence",
  "platform.voice_state",
  "platform.member",
  "voice.joined",
  "voice.left",
  "voice.participants",
  "voice.speaking",
  "voice.utterance",
  "voice.golive",
  "stage.status",
  "game.director.session",
  "sing.cue",
  "llm.budget",
];

/** Whether `topic` is something she perceives (replayed) rather than something she produced. */
/** The modules a replay runs (what they publish is recomputed, never replayed). */
export const REPLAYED_MODULES: readonly string[] = [
  "agent",
  "actions",
  "activity",
  "arbiter",
  "world",
  "self",
  "mind",
  "llm",
  "scheduler",
];

/**
 * Topics that are input only when a module the replay does not run published them: impulses of
 * the singer, the game director or the memory's followups, and old-style initiative requests.
 */
const FOREIGN_TOPICS: readonly string[] = ["arbiter.impulse", "agent.initiative"];

/**
 * Whether an event is something she perceives (replayed) rather than something the replayed
 * modules produce (recomputed). `source`: the module that published it.
 */
export function isReplayInput(topic: string, source: string): boolean {
  if (FOREIGN_TOPICS.includes(topic)) return !REPLAYED_MODULES.includes(source);
  return INPUT_TOPICS.some((t) => (t.endsWith(".") ? topic.startsWith(t) : topic === t));
}

/** The topics a recorder writes by default (her input, plus her outcomes for reference). */
export const DEFAULT_RECORD_TOPICS: readonly string[] = [
  ...INPUT_TOPICS,
  ...FOREIGN_TOPICS,
  "agent.turn.outcome",
  "arbiter.decision",
  "activity.changed",
];

function parseEntry(value: JsonObject, line: number): ReplayEntry {
  const { at, source, event } = value;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) {
    throw new ReplayLogError(`line ${line}: \`at\` is not a timestamp`);
  }
  if (!isJsonObject(event) || typeof event.type !== "string") {
    throw new ReplayLogError(`line ${line}: \`event\` is not an event`);
  }
  if (event.type === "custom") {
    const data = event.data;
    if (!isJsonObject(data) || typeof data.topic !== "string") {
      throw new ReplayLogError(`line ${line}: a custom event needs \`data.topic\``);
    }
  }
  return {
    at,
    source: typeof source === "string" && source !== "" ? source : "replay",
    event: event as unknown as Event,
  };
}

/** Parses a JSONL replay log (blank lines and `//` comment lines are skipped). */
export function parseReplayLog(text: string): ReplayLog {
  const meta: ReplayMeta = {};
  const entries: ReplayEntry[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    let value: JsonValue;
    try {
      value = JSON.parse(line) as JsonValue;
    } catch (error) {
      throw new ReplayLogError(`line ${i + 1}: not JSON`, { cause: error });
    }
    if (!isJsonObject(value)) throw new ReplayLogError(`line ${i + 1}: not an object`);
    if (isJsonObject(value.meta)) {
      Object.assign(meta, value.meta as unknown as ReplayMeta);
      continue;
    }
    entries.push(parseEntry(value, i + 1));
  }
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { meta, entries };
}

/** One log line for `entry`. */
export function formatEntry(entry: ReplayEntry): string {
  return JSON.stringify({ at: entry.at, source: entry.source, event: entry.event });
}

/** The topic of an entry's event. */
export function entryTopic(entry: ReplayEntry): string {
  return eventTopic(entry.event);
}
