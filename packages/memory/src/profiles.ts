// Person profiles (v4 §5.6): one block per person present, with everything about them read once.
//
// Before this a fact about someone lived in four places (memory facts in the pinned people line,
// the person card's feeling in the agent's people block, her knowledge documents, the recap
// notes), and the card had the fields for when she last saw them but never printed them. A
// profile reads each source once and prints: the relationship and her stance, when she last saw
// them and where, what they last talked about, three to five points (retrieved memories left out)
// and, for the people she is talking with, her recent questions to them and whether they answered.
// Nothing stored moves or is deleted: this is a reader.

import { errorMessage, getLogger } from "@miyoria/kernel";
import type { MemoryRecord } from "@miyoria/store";
import {
  type AffectState,
  type EventLog,
  type Handle,
  type HandleDirectory,
  type KnowledgeBase,
  type PersonId,
  type PersonProfile,
  type PersonProfiles,
  type PlaceRef,
  type ProfileOptions,
  type SocialSignals,
  safeName,
  type Timestamp,
  timestampMs,
  toTimestamp,
  type Whereabouts,
  xmlAttrs,
} from "@miyoria/types";
import type { ProfilesConfig } from "./config.js";
import { readable } from "./contributor.js";
import { type MemoryEngine, memoryFilter } from "./engine.js";
import { disclose, PRIVATE_MARK, placeRef, quotable, type Viewer, withheldTalk } from "./places.js";
import { clockOf, type RecentDeps, viewerFor } from "./recent.js";
import { parseWindow, type RecentLog, type Said } from "./recent-log.js";
import { hasScope, visibleScopes } from "./scope.js";
import { questionLine, type Threads } from "./threads.js";
import { textSimilarity } from "./tokenize.js";

const log = getLogger("memory.profiles");
const MINUTE_MS = 60_000;

export interface ProfileSources {
  config: () => ProfilesConfig;
  affect: () => AffectState | null;
  social: () => SocialSignals | null;
  knowledge: () => KnowledgeBase | null;
  events: () => Pick<EventLog, "query"> | null;
  handles: () => HandleDirectory | null;
}

const cut = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join("")}…` : flat;
};

/** The same thing said twice (a point that retrieval already shows). */
function repeats(text: string, exclude: readonly string[]): boolean {
  return exclude.some((x) => x === text || textSimilarity(x, text) >= 0.6);
}

export class Profiles implements PersonProfiles {
  readonly #engine: MemoryEngine;
  readonly #log: RecentLog;
  readonly #threads: Threads;
  readonly #deps: RecentDeps;
  readonly #src: ProfileSources;

  constructor(
    engine: MemoryEngine,
    log: RecentLog,
    threads: Threads,
    deps: RecentDeps,
    sources: ProfileSources,
  ) {
    this.#engine = engine;
    this.#log = log;
    this.#threads = threads;
    this.#deps = deps;
    this.#src = sources;
  }

  async profiles(where: Whereabouts, options: ProfileOptions = {}): Promise<PersonProfile[]> {
    const cfg = this.#src.config();
    const talking = where.talking_with ?? [];
    const order = [...talking, ...where.present.filter((p) => !talking.includes(p))];
    const out: PersonProfile[] = [];
    for (const person of [...new Set(order)].slice(0, cfg.max_people)) {
      try {
        const profile = await this.#profile(person, where, options, talking.includes(person));
        if (profile !== null) out.push(profile);
      } catch (error) {
        log.warn({ err: errorMessage(error) }, "cannot compose a person profile");
      }
    }
    return out;
  }

  async #profile(
    person: PersonId,
    where: Whereabouts,
    options: ProfileOptions,
    talking: boolean,
  ): Promise<PersonProfile | null> {
    const cfg = this.#src.config();
    const handle: Handle =
      this.#src.handles()?.ofPerson(person) ?? (await this.#engine.nameOfPerson(person)) ?? "";
    if (handle === "") return null;
    const card = this.#src.affect()?.card(person) ?? null;
    const attitude = card === null ? (this.#src.social()?.attitudeOf?.(person) ?? null) : null;
    if (attitude?.blocked || card?.blocked) return null;

    const nowMs = timestampMs(where.now);
    const window = await this.#log.window(nowMs);
    const viewer = viewerFor(where, window, this.#deps);
    const seen = await this.#lastSeen(handle, window.said, viewer, nowMs, cfg.session_gap_mins);
    const scopes = visibleScopes(where.context, where.accounts ?? [], where.present);
    const exclude = options.exclude ?? [];

    let lastTopic: string | null = null;
    let topicPrivate = false;
    const episodes = await this.#engine.records.list(
      this.#engine.profile,
      memoryFilter(10, { subject: person, kind: "episode" }),
    );
    const episode = episodes.find(
      (r) =>
        hasScope(scopes, r.scope) &&
        timestampMs(r.created_at) < seen.stretchStart &&
        !repeats(r.content, exclude) &&
        !exclude.includes(r.id),
    );
    if (episode !== undefined) lastTopic = cut(episode.content, cfg.topic_chars);
    else if (seen.said !== null && seen.private && !quotable("private", viewer)) {
      // Their DM, seen from a channel: that they talked, not about what.
      lastTopic = withheldTalk(handle);
    } else if (seen.said !== null) {
      lastTopic = `${safeName(handle)}說:「${cut(seen.said.text, cfg.topic_chars)}」`;
      topicPrivate = seen.private;
    }

    const points: PersonProfile["points"] = [];
    const facts = await this.#engine.factsAbout(person, scopes, where.now, cfg.points * 2);
    for (const fact of facts) {
      if (points.length >= cfg.points) break;
      if (exclude.includes(fact.id) || repeats(fact.content, exclude)) continue;
      const r = readable(fact);
      points.push({ text: r.content, origin: r.origin, said_by: r.said_by });
    }
    for (const line of this.#knowledgeLines(person, where)) {
      if (points.length >= cfg.points) break;
      if (repeats(line, exclude) || points.some((p) => textSimilarity(p.text, line) >= 0.6))
        continue;
      points.push({ text: line, origin: "experienced", said_by: null });
    }

    return {
      person,
      handle,
      label: card?.label ?? attitude?.label ?? null,
      level: card?.level ?? null,
      call_name: card?.call_name ?? attitude?.call_name ?? null,
      feeling: card !== null && card.feeling.trim() !== "" ? card.feeling : null,
      stance: card?.stance?.trim() ? card.stance : null,
      last_seen:
        seen.at === null ? fallbackSeen(card, attitude, seen.stretchStart) : toTimestamp(seen.at),
      last_place: seen.place,
      last_topic: lastTopic,
      last_topic_private: topicPrivate,
      points,
      questions: talking ? await this.#threads.questionsTo(handle, where) : [],
    };
  }

  /**
   * The last thing they said before the current stretch of talk (one that `viewer` may know of),
   * looked up in the log beyond the window when the window does not reach.
   */
  async #lastSeen(
    handle: Handle,
    said: readonly Said[],
    viewer: Viewer,
    nowMs: number,
    gapMins: number,
  ): Promise<{
    at: number | null;
    place: PlaceRef | null;
    said: Said | null;
    private: boolean;
    stretchStart: number;
  }> {
    const gap = gapMins * MINUTE_MS;
    const theirs = said.filter((s) => s.handle === handle && s.at <= nowMs);
    // The current stretch: their lines with no gap longer than `gap` up to now.
    let stretchStart = nowMs;
    let i = theirs.length - 1;
    if (i >= 0 && nowMs - (theirs[i] as Said).at <= gap) {
      stretchStart = (theirs[i] as Said).at;
      while (i > 0 && stretchStart - (theirs[i - 1] as Said).at <= gap) {
        i--;
        stretchStart = (theirs[i] as Said).at;
      }
      i--;
    }
    const pick = (s: Said) => {
      const d = disclose(s.context, viewer, [handle]);
      return d === "hide"
        ? null
        : {
            at: s.at,
            place: placeRef(s.context, viewer),
            said: s,
            private: d === "private",
            stretchStart,
          };
    };
    for (; i >= 0; i--) {
      const hit = pick(theirs[i] as Said);
      if (hit !== null) return hit;
    }
    const events = this.#src.events();
    if (events !== null) {
      try {
        const older = await events.query({
          person: handle,
          kinds: ["observation"],
          until: toTimestamp(Math.min(stretchStart, ...theirs.slice(0, 1).map((s) => s.at))),
          order: "desc",
          limit: 20,
        });
        const parsed = parseWindow(older, 0, this.#engine.exclusions).said.filter(
          (s) => s.handle === handle,
        );
        for (let j = parsed.length - 1; j >= 0; j--) {
          const hit = pick(parsed[j] as Said);
          if (hit !== null) return hit;
        }
      } catch (error) {
        log.warn({ err: errorMessage(error) }, "cannot read when someone was last seen");
      }
    }
    return { at: null, place: null, said: null, private: false, stretchStart };
  }

  /** The content lines of her documents about `person`, visible here. */
  #knowledgeLines(person: PersonId, where: Whereabouts): string[] {
    const kb = this.#src.knowledge();
    if (kb === null) return [];
    try {
      const text = kb.render([{ type: "person", person }], {
        context: where.context,
        maxChars: 600,
      });
      return text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("(內容放不下"))
        .map((l) => cut(l, 60));
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot read documents about someone");
      return [];
    }
  }

  async render(
    where: Whereabouts,
    maxChars: number,
    options: ProfileOptions = {},
  ): Promise<string> {
    const cfg = this.#src.config();
    const offset = this.#deps.utcOffsetMinutes;
    const clock = (at: Timestamp) => clockOf(at, where.now, offset);
    const blocks: string[] = [];
    let left = maxChars;
    for (const p of await this.profiles(where, options)) {
      const asked = p.questions
        .map((q) => {
          const line = questionLine(q, clock);
          return line === "" ? "" : `${line}${q.private ? `(${PRIVATE_MARK})` : ""}`;
        })
        .filter((l) => l !== "");
      // The questions were lines of their own under the person, outside the person's budget.
      const room = cfg.person_chars + asked.reduce((n, l) => n + [...l].length + 1, 0);
      const text = profileLine(p, clock, room, asked);
      // The block's budget (`maxChars`) counts the tag as it is: what she reads.
      const n = [...text].length + 1;
      if (n > left) continue;
      blocks.push(text);
      left -= n;
    }
    return blocks.join("\n");
  }
}

/** When neither the log nor the window knows: what the card or the social record says. */
function fallbackSeen(
  card: { last_together: Timestamp | null; last_seen: Timestamp | null } | null,
  attitude: { last_interaction?: Timestamp | null } | null,
  stretchStart: number,
): Timestamp | null {
  for (const at of [card?.last_together, card?.last_seen, attitude?.last_interaction]) {
    if (at && timestampMs(at) < stretchStart) return at;
  }
  return null;
}

/** A point read back by where it comes from (as `lineOf` does for memories). */
function pointText(p: PersonProfile["points"][number], handle: Handle): string {
  if (p.origin === "unknown") return `${p.text}(來源不明)`;
  if (p.origin === "told" && p.said_by !== null && p.said_by !== handle) {
    return `${p.text}(${safeName(p.said_by)}說的)`;
  }
  return p.text;
}

/**
 * `<person name="Owen" relation="好朋友" level="12" call_as="歐文" last_seen="昨天 21:30,語音" …/>`:
 * one person's profile as one tag, every value escaped (`xmlAttrs`). Within `maxChars` (0: no
 * limit) the least important values go first, from the end; the name always stays. `asked`: her
 * questions to them, when she is talking with them.
 */
export function profileLine(
  p: PersonProfile,
  clock: (at: Timestamp) => string,
  maxChars = 0,
  asked: readonly string[] = [],
): string {
  const attrs: [string, string | number | null][] = [
    ["relation", p.label],
    ["level", p.label === null ? null : p.level],
    ["call_as", p.call_name ? safeName(p.call_name, 16) : null],
    ["impression", p.feeling],
    ["stance", p.stance],
    [
      "last_seen",
      p.last_seen === null
        ? null
        : `${clock(p.last_seen)}${p.last_place !== null && p.last_place.label !== "" ? `,${p.last_place.label}` : ""}`,
    ],
    [
      "last_topic",
      p.last_topic === null
        ? null
        : `${p.last_topic}${p.last_topic_private ? `(${PRIVATE_MARK})` : ""}`,
    ],
    ["notes", p.points.length === 0 ? null : p.points.map((x) => pointText(x, p.handle)).join(";")],
    ["asked", asked.length === 0 ? null : asked.join(";")],
  ];
  if (attrs.every(([, v]) => v === null || String(v).trim() === "")) {
    attrs.push(["note", "還不太認識"]);
  }
  const name = safeName(p.handle);
  // What the budget counts is what is said (the name and the values), as it was for the line
  // this tag replaced, not the markup around it.
  const size = (kept: readonly [string, string | number | null][]) =>
    kept.reduce((n, [, v]) => n + (v === null ? 0 : [...String(v)].length), [...name].length);
  let kept = attrs;
  // Too long: the longest of the free-text values is cut, then values go from the end.
  while (maxChars > 0 && size(kept) > maxChars && kept.length > 0) {
    const free = kept
      .map(([k, v], i) => ({ i, k, n: typeof v === "string" ? [...v].length : 0 }))
      .filter((a) => FREE_TEXT.has(a.k) && a.n > MIN_VALUE)
      .sort((a, b) => b.n - a.n)[0];
    if (free !== undefined) {
      const over = size(kept) - maxChars;
      const [k, v] = kept[free.i] as [string, string];
      const next = cut(v, Math.max(MIN_VALUE, free.n - over));
      kept = kept.map((a, i) => (i === free.i ? [k, next] : a));
    } else {
      kept = kept.slice(0, -1);
    }
  }
  return `<person${xmlAttrs({ name, ...Object.fromEntries(kept) })}/>`;
}

/** Values of `profileLine` that are cut before any is left out. */
const FREE_TEXT = new Set(["impression", "stance", "last_topic", "notes", "asked"]);
/** A cut value keeps at least this many characters. */
const MIN_VALUE = 12;

/** For callers holding records: their ids and contents, as `ProfileOptions.exclude`. */
export function excludeOf(records: readonly Pick<MemoryRecord, "id" | "content">[]): string[] {
  return records.flatMap((r) => [r.id, r.content]);
}
