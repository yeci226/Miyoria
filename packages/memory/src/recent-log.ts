// The last hours of the EventLog as the "just now" readers need them (v4 §5.2, §5.3): what
// people said, what she said (only what was delivered), and what she did. One read of the log is
// reused for `cache_secs`, so the voice hot path pays for it once every few seconds, and nothing
// here lives only in memory: after a restart the log is read again.

import { errorMessage, getLogger } from "@miyoria/kernel";
import {
  type ContextKey,
  contextKeyString,
  type EventLog,
  type Handle,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type JustNowKind,
  type LogEvent,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import type { RecentConfig } from "./config.js";
import type { ExclusionList } from "./exclusion.js";

const log = getLogger("memory.recent");

/** What the readers need of the EventLog. */
export type RecentReader = Pick<EventLog, "query">;

/** Someone said something (chat or voice). */
export interface Said {
  id: string;
  at: number;
  context: ContextKey;
  handle: Handle;
  name: string;
  text: string;
  /** To her: a mention, a reply to her, her name, or a DM. */
  addressed: boolean;
}

/** A line of hers that reached someone. */
export interface Her {
  id: string;
  at: number;
  context: ContextKey;
  said: string;
  audience: Handle[];
}

/** Something she did or that happened to her. */
export interface Happening {
  id: string;
  at: number;
  kind: Exclude<JustNowKind, "talk" | "asked">;
  key: string;
  /** The state it reports (`started`, `ended`, `members`, ...), for merging. */
  state: string;
  /** What it is about (song title, game, names). */
  what: string;
  context: ContextKey | null;
}

/** The parsed window, oldest first. */
export interface Window {
  from: number;
  said: Said[];
  her: Her[];
  happenings: Happening[];
  /** DM context → the other person in it. */
  partners: Map<string, Handle>;
}

const str = (v: JsonValue | undefined): string | null => (typeof v === "string" ? v : null);

function obj(v: JsonValue | undefined): JsonObject | null {
  return isJsonObject(v ?? null) ? (v as JsonObject) : null;
}

/** The text and name of what was said, from the bus event behind the observation. */
function spoken(body: JsonObject, summary: string): { name: string; text: string } {
  const event = obj(obj(body.origin)?.event);
  const data = obj(event?.data);
  if (data !== null) {
    const text = str(data.text);
    const who = obj(data.author) ?? obj(data.speaker);
    const name = str(who?.display_name);
    if (text !== null && name !== null) return { name, text };
  }
  // `name:text`, the input defence's note on the next line.
  const first = summary.split("\n")[0] ?? "";
  const at = first.indexOf(":");
  return at < 0
    ? { name: "", text: first }
    : { name: first.slice(0, at), text: first.slice(at + 1) };
}

const SPEECH_SOURCES = /^(platform\.|voice\.asr$)/;

/** One observation as something she did, or `null` when it is not one of those. */
function happening(
  event: LogEvent,
  source: string,
  summary: string,
  key: string,
): Happening | null {
  const at = timestampMs(event.at);
  const base = { id: event.id, at, key, context: event.context };
  if (source === "sing") {
    if (summary.startsWith("正在唱:"))
      return { ...base, kind: "song", state: "started", what: summary.slice(4) };
    if (summary.startsWith("唱完了:"))
      return { ...base, kind: "song", state: "ended", what: summary.slice(4) };
    return null;
  }
  if (source === "game.session") {
    const started = /^正在玩 (.+)$/.exec(summary);
    if (started) return { ...base, kind: "game", state: "started", what: started[1] ?? "" };
    const ended = /^不玩 (.+) 了$/.exec(summary);
    if (ended) return { ...base, kind: "game", state: "ended", what: ended[1] ?? "" };
    return null;
  }
  if (source === "game.director" && summary.startsWith("完成目標:")) {
    return { ...base, kind: "game", state: "goal", what: summary.slice(5) };
  }
  if (source === "voice.presence") {
    if (summary.startsWith("語音頻道裡有:")) {
      return { ...base, kind: "voice", state: "members", what: summary.slice(7) };
    }
    if (summary.startsWith("她離開了語音頻道")) {
      return { ...base, kind: "voice", state: "left", what: "" };
    }
    return null;
  }
  if (source === "stream" && summary.startsWith("Go Live:")) {
    const state = summary.slice(8);
    return state === "started" || state === "stopped"
      ? { ...base, kind: "stream", state, what: "" }
      : null;
  }
  if (source.startsWith("notice.")) return { ...base, kind: "notice", state: "", what: summary };
  if (source === "activity" && key.startsWith("task:") && summary.includes("失敗")) {
    return { ...base, kind: "notice", state: "failed", what: summary };
  }
  return null;
}

/** Turns log events into a window. Exported for the tests. */
export function parseWindow(
  events: readonly LogEvent[],
  from: number,
  excluded?: Pick<ExclusionList, "hasEvent"> | null,
): Window {
  const window: Window = { from, said: [], her: [], happenings: [], partners: new Map() };
  // What someone asked her not to remember is not part of any window.
  const visible = excluded ? events.filter((e) => !excluded.hasEvent(e)) : events;
  const sorted = [...visible].sort((a, b) => timestampMs(a.at) - timestampMs(b.at));
  for (const event of sorted) {
    const body = obj(event.body);
    if (body === null) continue;
    const at = timestampMs(event.at);
    if (event.kind === "delivered") {
      const said = str(body.said);
      if (event.context === null || said === null || said.trim() === "") continue;
      const audience = Array.isArray(body.audience)
        ? body.audience.filter((h): h is string => typeof h === "string")
        : [];
      window.her.push({ id: event.id, at, context: event.context, said, audience });
      if (event.context.kind === "dm" && audience.length === 1 && audience[0] !== undefined) {
        const place = contextKeyString(event.context);
        if (!window.partners.has(place)) window.partners.set(place, audience[0]);
      }
      continue;
    }
    if (event.kind !== "observation") continue;
    const observation = obj(body.observation);
    if (observation === null) continue;
    const source = str(observation.source) ?? event.source;
    const summary = str(observation.summary) ?? "";
    const key = str(observation.attention_key) ?? "";
    const from = str(observation.from) ?? event.person;
    if (SPEECH_SOURCES.test(source) && from !== null && event.context !== null) {
      if (summary.endsWith(":(略過)")) continue;
      const { name, text } = spoken(body, summary);
      if (text.trim() === "") continue;
      window.said.push({
        id: event.id,
        at,
        context: event.context,
        handle: from,
        name: name === "" ? from : name,
        text,
        addressed: observation.addressed_to_her === true || event.context.kind === "dm",
      });
      // A DM has one other person in it.
      if (event.context.kind === "dm") window.partners.set(contextKeyString(event.context), from);
      continue;
    }
    const h = happening(event, source, summary, key);
    if (h !== null) window.happenings.push(h);
  }
  return window;
}

/** Reads the window, reusing one read for `cache_secs`. */
export class RecentLog {
  readonly #config: () => RecentConfig;
  readonly #events: () => RecentReader | null;
  readonly #excluded: () => ExclusionList | null;
  #cached: { at: number; window: Window } | null = null;
  #pending: Promise<Window> | null = null;

  constructor(
    config: () => RecentConfig,
    events: () => RecentReader | null,
    excluded: () => ExclusionList | null = () => null,
  ) {
    this.#config = config;
    this.#events = events;
    this.#excluded = excluded;
  }

  /** The window ending at `nowMs`. A failing log gives an empty window (and a warning). */
  async window(nowMs: number): Promise<Window> {
    const cfg = this.#config();
    const cached = this.#cached;
    if (cached !== null && nowMs >= cached.at && nowMs - cached.at < cfg.cache_secs * 1000) {
      return cached.window;
    }
    // Readers of one turn ask at once: they share the read.
    if (this.#pending !== null) return this.#pending;
    const pending = this.#read(nowMs, cfg).finally(() => {
      this.#pending = null;
    });
    this.#pending = pending;
    return pending;
  }

  async #read(nowMs: number, cfg: RecentConfig): Promise<Window> {
    const from = nowMs - cfg.hours * 3_600_000;
    const events = this.#events();
    if (events === null || cfg.max_events === 0) return parseWindow([], from);
    let rows: LogEvent[];
    try {
      rows = await events.query({
        kinds: ["observation", "delivered"],
        since: toTimestamp(from),
        until: toTimestamp(nowMs + 1),
        order: "desc",
        limit: cfg.max_events,
      });
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot read the event log");
      return parseWindow([], from);
    }
    const window = parseWindow(rows, from, this.#excluded());
    this.#cached = { at: nowMs, window };
    return window;
  }

  /** The next read goes to the log again. */
  invalidate(): void {
    this.#cached = null;
  }
}
