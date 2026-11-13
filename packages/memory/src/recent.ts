// "Just now" and "elsewhere" (v4 §5.2, §5.3).
//
// * `Timeline` (`JustNowKey`): a compact, time-stamped list of what she did and what happened
//   around her in the last hours, in every place she may speak of from where she is: songs,
//   games, voice, Go Live, notices, people who talked to her and what she answered, and her
//   questions to people with whether they answered. Before this, what she sang ten minutes ago was
//   visible only while it was still in the transcript.
// * `OtherPlaces` (`ElsewhereKey`): what is going on in the other places she is in right now,
//   her recap of each (conversation states) and its last lines, so a voice turn knows what the
//   text channel is on about and the other way round. DMs are never among them.
//
// Both read the EventLog through `RecentLog` and show only what `places.ts` allows.

import {
  type ContextKey,
  type ConversationStates,
  contextKeyEquals,
  contextKeyString,
  type Elsewhere,
  type Handle,
  type HandleDirectory,
  type JustNow,
  type JustNowEntry,
  type PlaceAccess,
  type PlaceSummary,
  safeName,
  type Timestamp,
  timestampMs,
  toTimestamp,
  type Whereabouts,
} from "@miyoria/types";
import type { RecentConfig } from "./config.js";
import {
  disclose,
  PRIVATE_MARK,
  partnerOf,
  placeRef,
  quotable,
  type Viewer,
  WITHHELD,
  withheldTalk,
} from "./places.js";
import type { RecentLog, Window } from "./recent-log.js";
import { questionLine, questions, visibleQuestion } from "./threads.js";

const MINUTE_MS = 60_000;

/** Everything the readers need besides the log, looked up when asked (start order is free). */
export interface RecentDeps {
  config: () => RecentConfig;
  handles: () => HandleDirectory | null;
  access: () => PlaceAccess | null;
  states: () => ConversationStates | null;
  /** Minutes east of UTC of the clock shown to her. */
  utcOffsetMinutes: number;
}

const cut = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join("")}…` : flat;
};

/** `HH:MM` local; `昨天 HH:MM` / `M/D HH:MM` for other days. */
export function clockOf(at: Timestamp, now: Timestamp, offsetMinutes: number): string {
  const local = (ms: number) => new Date(ms + offsetMinutes * MINUTE_MS);
  const d = local(timestampMs(at));
  const n = local(timestampMs(now));
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => Math.floor(x.getTime() / 86_400_000);
  const diff = day(n) - day(d);
  if (diff === 0) return hhmm;
  if (diff === 1) return `昨天 ${hhmm}`;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hhmm}`;
}

/** The handles of people, through the directory. */
function handlesOf(
  directory: HandleDirectory | null,
  people: readonly Whereabouts["present"][number][],
): Set<Handle> {
  const out = new Set<Handle>();
  if (directory === null) return out;
  for (const person of people) {
    const handle = directory.ofPerson(person);
    if (handle !== null) out.add(handle);
  }
  return out;
}

/** The viewer of the place rule for `where`. */
export function viewerFor(where: Whereabouts, window: Window, deps: RecentDeps): Viewer {
  return {
    context: where.context,
    talkingWith: handlesOf(deps.handles(), where.talking_with ?? []),
    accounts: where.accounts ?? [],
    hidden: new Set(deps.config().hidden_channels),
    access: deps.access(),
    partners: window.partners,
  };
}

/**
 * Fits lines into `maxChars`, the newest first, and gives them back oldest first. A line that does
 * not fit is left out (older ones may still fit).
 */
export function fitNewest(lines: readonly string[], maxChars: number): string[] {
  const kept: string[] = [];
  let left = maxChars;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    const n = [...line].length + 1;
    if (n > left) continue;
    kept.push(line);
    left -= n;
  }
  return kept.reverse();
}

export class Timeline implements JustNow {
  readonly #log: RecentLog;
  readonly #deps: RecentDeps;

  constructor(log: RecentLog, deps: RecentDeps) {
    this.#log = log;
    this.#deps = deps;
  }

  async entries(where: Whereabouts): Promise<JustNowEntry[]> {
    const cfg = this.#deps.config();
    const nowMs = timestampMs(where.now);
    const window = await this.#log.window(nowMs);
    const viewer = viewerFor(where, window, this.#deps);
    const clock = (at: Timestamp) => clockOf(at, where.now, this.#deps.utcOffsetMinutes);
    const out: JustNowEntry[] = [];

    out.push(...this.#happenings(window, viewer, nowMs, cfg));
    out.push(...this.#talk(window, viewer, nowMs, cfg));
    const people = new Map(
      (this.#deps.handles()?.list() ?? []).map((e) => [e.handle, e.person] as const),
    );
    for (const q of questions(window, cfg, nowMs)) {
      const shown = visibleQuestion(q, viewer, people.get(q.handle) ?? null, cfg.quote_chars);
      if (shown === null) continue;
      const last = shown.asked[shown.asked.length - 1];
      if (last === undefined) continue;
      out.push({
        at: last.at,
        kind: "asked",
        place: last.place,
        text: questionLine(shown, clock),
        private: shown.private,
      });
    }
    return out.sort((a, b) => timestampMs(a.at) - timestampMs(b.at));
  }

  #happenings(window: Window, viewer: Viewer, nowMs: number, cfg: RecentConfig): JustNowEntry[] {
    // `what`: the title the start gave (the end of a song only names its id).
    const out: (JustNowEntry & { key: string; state: string; what: string })[] = [];
    for (const h of window.happenings) {
      if (h.at > nowMs) continue;
      const d = disclose(h.context, viewer);
      // What went on in a DM is not a channel's business, not even as a title.
      if (d === "hide" || !quotable(d, viewer)) continue;
      const place = placeRef(h.context, viewer);
      const prev = [...out].reverse().find((e) => e.key === h.key);
      const at = toTimestamp(h.at);
      const add = (text: string) =>
        out.push({
          at,
          kind: h.kind,
          place,
          text,
          private: d === "private",
          key: h.key,
          state: h.state,
          what: h.what,
        });
      switch (h.kind) {
        case "song": {
          const title = cut(h.what, 40);
          if (h.state === "ended" && prev?.state === "started") {
            prev.text = `唱了〈${cut(prev.what, 40)}〉`;
            prev.state = "sung";
          } else add(h.state === "started" ? `開始唱〈${title}〉` : `唱完〈${title}〉`);
          break;
        }
        case "game": {
          const what = cut(h.what, 40);
          if (h.state === "goal") add(`遊戲裡完成目標:${what}`);
          else if (h.state === "ended" && prev?.state === "started") {
            prev.text = `玩了 ${cut(prev.what, 40)}(到 ${clockOf(at, toTimestamp(nowMs), this.#deps.utcOffsetMinutes)})`;
            prev.state = "played";
          } else add(h.state === "started" ? `開始玩 ${what}` : `不玩 ${what} 了`);
          break;
        }
        case "voice": {
          const text = h.state === "left" ? "離開語音" : `語音裡有:${cut(h.what, 60)}`;
          // Who is in voice changes all the time: one line per stretch.
          if (
            prev?.state === "members" &&
            h.state === "members" &&
            h.at - timestampMs(prev.at) < cfg.coalesce_mins * MINUTE_MS
          ) {
            prev.text = text;
          } else add(text);
          break;
        }
        case "stream":
          add(h.state === "started" ? "開始 Go Live" : "結束 Go Live");
          break;
        case "notice":
          add(cut(h.what, 80));
          break;
      }
    }
    return out.map(({ key: _k, state: _s, what: _w, ...entry }) => entry);
  }

  /** People who talked to her elsewhere and what she answered, the newest `talk_entries`. */
  #talk(window: Window, viewer: Viewer, nowMs: number, cfg: RecentConfig): JustNowEntry[] {
    const out: JustNowEntry[] = [];
    // DM → when its last withheld line was, so one stretch of talk is one line.
    const withheld = new Map<string, number>();
    for (const s of window.said) {
      if (!s.addressed || s.at > nowMs) continue;
      // This place is in the transcript already.
      if (contextKeyEquals(s.context, viewer.context)) continue;
      const d = disclose(s.context, viewer, [s.handle]);
      if (d === "hide") continue;
      if (!quotable(d, viewer)) {
        const key = contextKeyString(s.context);
        const last = withheld.get(key);
        withheld.set(key, s.at);
        if (last !== undefined && s.at - last <= cfg.coalesce_mins * MINUTE_MS) continue;
        out.push({
          at: toTimestamp(s.at),
          kind: "talk",
          place: { kind: "dm", label: "", context: s.context },
          text: withheldTalk(partnerOf(viewer, s.context)),
          private: true,
        });
        continue;
      }
      const reply = window.her.find(
        (h) =>
          contextKeyEquals(h.context, s.context) && h.at >= s.at && h.at - s.at <= 3 * MINUTE_MS,
      );
      const said = `${safeName(s.name)}對你說:「${cut(s.text, cfg.quote_chars)}」`;
      out.push({
        at: toTimestamp(s.at),
        kind: "talk",
        place: placeRef(s.context, viewer),
        text: reply === undefined ? said : `${said};你回:「${cut(reply.said, cfg.quote_chars)}」`,
        private: d === "private",
      });
    }
    return out.slice(Math.max(0, out.length - cfg.talk_entries));
  }

  async render(where: Whereabouts, maxChars: number): Promise<string> {
    const entries = await this.entries(where);
    const lines = entries.map((e) => entryLine(e, where.now, this.#deps.utcOffsetMinutes));
    return fitNewest(lines, maxChars).join("\n");
  }
}

/** `- 14:05 語音 唱了〈X〉`, private ones marked (a withheld one has nothing to mark). */
export function entryLine(entry: JustNowEntry, now: Timestamp, offset: number): string {
  const where = entry.place.label === "" || entry.kind === "asked" ? "" : `${entry.place.label} `;
  const mark = entry.private && !entry.text.endsWith(WITHHELD) ? `(${PRIVATE_MARK})` : "";
  return `- ${clockOf(entry.at, now, offset)} ${where}${entry.text}${mark}`;
}

export class OtherPlaces implements Elsewhere {
  readonly #log: RecentLog;
  readonly #deps: RecentDeps;

  constructor(log: RecentLog, deps: RecentDeps) {
    this.#log = log;
    this.#deps = deps;
  }

  async places(where: Whereabouts): Promise<PlaceSummary[]> {
    const cfg = this.#deps.config();
    const nowMs = timestampMs(where.now);
    const window = await this.#log.window(nowMs);
    const viewer = viewerFor(where, window, this.#deps);
    const since = nowMs - cfg.elsewhere_mins * MINUTE_MS;
    // place → its lines (theirs and hers), oldest first.
    const byPlace = new Map<
      string,
      { context: ContextKey; lines: { at: number; text: string }[] }
    >();
    const add = (context: ContextKey, at: number, text: string) => {
      if (at < since || at > nowMs) return;
      if (contextKeyEquals(context, where.context) || context.kind === "dm") return;
      // Seen from a DM, nothing of a guild is a summary of its own.
      if (disclose(context, viewer) !== "show" || viewer.context.kind === "dm") return;
      const key = `${contextKeyString(context)}|${context.kind}`;
      let place = byPlace.get(key);
      if (!place) {
        place = { context, lines: [] };
        byPlace.set(key, place);
      }
      place.lines.push({ at, text });
    };
    for (const s of window.said)
      add(s.context, s.at, `${safeName(s.name)}:${cut(s.text, cfg.quote_chars)}`);
    for (const h of window.her) add(h.context, h.at, `你:${cut(h.said, cfg.quote_chars)}`);
    const states = this.#deps.states();
    const out: PlaceSummary[] = [];
    for (const { context, lines } of byPlace.values()) {
      lines.sort((a, b) => a.at - b.at);
      const last = lines[lines.length - 1];
      if (last === undefined) continue;
      const state = states?.get(context) ?? null;
      const recap =
        state === null || state.recap.trim() === ""
          ? null
          : cut(state.recap, cfg.elsewhere_recap_chars);
      out.push({
        place: placeRef(context, viewer),
        recap,
        recap_at: recap === null ? null : (state?.updated_at ?? null),
        lines: lines.slice(Math.max(0, lines.length - cfg.elsewhere_lines)).map((l) => l.text),
        last_at: toTimestamp(last.at),
      });
    }
    out.sort((a, b) => timestampMs(b.last_at) - timestampMs(a.last_at));
    return out.slice(0, cfg.elsewhere_places);
  }

  async render(where: Whereabouts, maxChars: number): Promise<string> {
    const places = await this.places(where);
    const blocks: string[] = [];
    let left = maxChars;
    const offset = this.#deps.utcOffsetMinutes;
    for (const p of places) {
      const head = `[${p.place.label}](最後一句 ${clockOf(p.last_at, where.now, offset)})`;
      const recap =
        p.recap === null || p.recap_at === null
          ? []
          : [
              `提要(${clockOf(p.recap_at, where.now, offset)} 寫的${timestampMs(p.recap_at) < timestampMs(p.last_at) ? ",之後還有新的話" : ""}):${p.recap}`,
            ];
      const block = [head, ...recap, ...p.lines.map((l) => `- ${l}`)].join("\n");
      const n = [...block].length + 1;
      if (n > left) continue;
      blocks.push(block);
      left -= n;
    }
    return blocks.join("\n");
  }
}
