// The replay log: one JSON object per line.
//
// * A bus envelope (`BusEnvelopeSchema` in @miyoria/contracts/events): one event as it was
//   published, every key present: `{"id", "at", "type", "v", "parent", "turn", "session",
//   "space_id", "room_id", "person_id", "account_id", "key", "scope", "source", "data"}`. `at`
//   orders the replay; the gap between two lines is replayed as (fake) time passing.
// * `{"meta": {...}}` (optional, first line by convention): what the log is (`name`, `notes`)
//   and how to replay it (`ReplayMeta`: her names, the scripted LLM, config overrides).
//
// Blank lines and `//` comment lines are skipped. A line in the old form (`{"at", "source",
// "event": {"type", "data"}}`, written before the bus carried one envelope) is refused with an
// error that says so; there is no reader for it.
//
// Only what she perceives is replayed (`isReplayInput`): messages, voice, presence, game and
// song events. What the replayed modules produce themselves (her turns, the Arbiter, the
// ActivityManager, world's signals) is recomputed, never fed back in; a recorded log may still
// carry it for reference.

import {
  type BusEnvelope,
  type BusEnvelopeJson,
  BusEnvelopeSchema,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@miyoria/types";

/** One recorded bus event: the envelope as JSON. */
export type ReplayEntry = BusEnvelopeJson;

/** How the scripted LLM answers (every field optional). */
export interface ScriptedLlmConfig {
  /** What she says in a reply (cycled; `<silence/>` for silence). Default: one short line. */
  replies?: string[];
  /** Time to the first token of every reply (ms). Default 1500. */
  latency_ms?: number;
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
  if ("event" in value && !("type" in value)) {
    throw new ReplayLogError(
      `line ${line}: an old-format replay line ({at, source, event}); this reader takes one bus envelope per line (BusEnvelopeSchema)`,
    );
  }
  const parsed = BusEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "(line)";
    throw new ReplayLogError(
      `line ${line}: not a bus envelope: \`${path}\`: ${issue?.message ?? "invalid"}`,
    );
  }
  if (Number.isNaN(Date.parse(parsed.data.at))) {
    throw new ReplayLogError(`line ${line}: \`at\` is not a timestamp`);
  }
  return parsed.data;
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

/** The entry of a bus envelope: its keys in the schema's order (the bus stamps another order). */
export function entryOf(envelope: BusEnvelope | ReplayEntry): ReplayEntry {
  return {
    id: envelope.id,
    at: envelope.at,
    type: envelope.type,
    v: envelope.v,
    parent: envelope.parent,
    turn: envelope.turn,
    session: envelope.session,
    space_id: envelope.space_id,
    room_id: envelope.room_id,
    person_id: envelope.person_id,
    account_id: envelope.account_id,
    key: envelope.key,
    scope: envelope.scope,
    source: envelope.source,
    data: envelope.data as JsonValue,
  };
}

/** One log line for a bus envelope (or an entry). */
export function formatEntry(envelope: BusEnvelope | ReplayEntry): string {
  return JSON.stringify(entryOf(envelope));
}

/** The topic of an entry's event (its `type`). */
export function entryTopic(entry: Pick<ReplayEntry, "type">): string {
  return entry.type;
}
