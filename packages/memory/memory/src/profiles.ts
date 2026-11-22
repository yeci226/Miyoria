// Person profiles (v4 §5.6): one block per person present, with everything about them read once.
//
// Before this a fact about someone lived in four places (memory facts in the pinned people line,
// the person card's feeling in the agent's people block, her knowledge documents, the recap
// notes), and the card had the fields for when she last saw them but never printed them. A
// profile reads each source once and prints: the relationship and her stance, when she last saw
// them and where, what they last talked about, three to five points (retrieved memories left out)
// and, for the people she is talking with, her recent questions to them and whether they answered.
// Nothing stored moves or is deleted: this is a reader.

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import {
  AFFINITY_LEVEL_MAX,
  affinityLevel,
  BOND_SCALE_LINE,
  type EventLog,
  type Handle,
  type HandleDirectory,
  type HeartPeople,
  heartWords,
  type KnowledgeBase,
  type PersonId,
  type PersonProfile,
  type PersonProfiles,
  type PlaceRef,
  type ProfileOptions,
  relationshipLabel,
  safeName,
  shownNames,
  type Timestamp,
  timestampMs,
  toTimestamp,
  type Whereabouts,
  xmlAttrs,
} from "@miyoria/types";
import type { ProfilesConfig } from "./config.js";
import { readable } from "./contributor.js";
import { type MemoryEngine, memoryFilter } from "./engine.js";
import type { NotesRecall } from "./notes-recall.js";
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
  /**
   * Her numbers and words for each person (`HeartKey`, docs/design/v5-heart.md §2.9): the tier,
   * the level, the slow values and her words. Unset or `null`: none of them.
   */
  heart?: () => HeartPeople | null;
  knowledge: () => KnowledgeBase | null;
  events: () => Pick<EventLog, "query"> | null;
  handles: () => HandleDirectory | null;
  /** Where the notes are the source (`NotesRecall`); unset or `null`: the facts are the points. */
  notes?: () => Pick<NotesRecall, "personPoints"> | null;
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
    const view = this.#src.heart?.()?.view(person) ?? null;
    if (view?.blocked) return null;

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
    // Once the notes are the source the segment pass writes lines into the person's document, not
    // facts: those are the points, then the facts written since (`remember`).
    const noted = this.#src.notes?.()?.personPoints(person, {
      context: where.context,
      accounts: where.accounts ?? [],
      present: where.present,
    });
    for (const line of noted?.lines ?? []) {
      if (points.length >= cfg.points) break;
      if (exclude.includes(line.id) || repeats(line.text, exclude)) continue;
      if (points.some((p) => textSimilarity(p.text, line.text) >= 0.6)) continue;
      points.push({ text: line.text, origin: line.origin, said_by: line.said_by });
    }
    const facts = await this.#engine.factsAbout(person, scopes, where.now, cfg.points * 2);
    for (const fact of facts) {
      if (points.length >= cfg.points) break;
      if (noted !== null && noted !== undefined && !noted.recordKept(fact.id)) continue;
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

    // How she feels about them and her words (call name, impression, stance) are their heart
    // row's: the nightly reflection, `set_call_name` and the panel write them there. Someone
    // without a row yet has none of it.
    const said = (text: string | null | undefined) =>
      text === null || text === undefined || text.trim() === "" ? null : text;
    const words = view === null ? null : heartWords(view);
    // What their accounts are called now, when not the handle: a name in the chat maps to it.
    const shown = shownNames(handle, [
      ...(this.#src.handles()?.resolve(handle)?.names ?? []),
      ...(options.shown?.[person] ?? []),
    ]);
    return {
      person,
      handle,
      ...(shown.length === 0 ? {} : { shown_as: shown }),
      label: view === null ? null : relationshipLabel({ affinity: view.bond }),
      level: view === null ? null : affinityLevel(view.bond),
      owner: view?.owner ?? false,
      trust: null,
      values:
        words === null
          ? null
          : {
              trust: words.trust,
              familiarity: words.familiarity,
              respect: words.respect,
              ease: words.ease,
              rapport: words.rapport,
            },
      call_name: said(view?.call_name),
      feeling: said(view?.impression),
      stance: said(view?.stance),
      last_seen: seen.at === null ? fallbackSeen(view, seen.stretchStart) : toTimestamp(seen.at),
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
        const parsed = parseWindow(older, 0).said.filter((s) => s.handle === handle);
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
    // The scale once, so a level reads as a place on it (outside the people's own room).
    if (blocks.some((b) => b.includes(" level="))) {
      blocks.unshift(`<scale>${BOND_SCALE_LINE}</scale>`);
    }
    return blocks.join("\n");
  }
}

/** When neither the log nor the window knows: what their heart row says. */
function fallbackSeen(
  view: { last_together: Timestamp | null; last_seen: Timestamp | null } | null,
  stretchStart: number,
): Timestamp | null {
  for (const at of [view?.last_together, view?.last_seen]) {
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
    // First, so it is the last to go when the tag is cut: how a name in the chat maps to them.
    [
      "shown_as",
      p.shown_as === undefined || p.shown_as.length === 0 ? null : p.shown_as.join("、"),
    ],
    ["relation", p.label],
    ["level", p.label === null || p.level === null ? null : `${p.level}/${AFFINITY_LEVEL_MAX}`],
    ["owner", p.owner === true ? "主人" : null],
    [
      "trust",
      p.label === null ? null : (p.values?.trust ?? (p.trust == null ? null : Math.round(p.trust))),
    ],
    ["familiar", p.values?.familiarity ?? null],
    ["respect", p.values?.respect ?? null],
    ["ease", p.values?.ease ?? null],
    ["rapport", p.values?.rapport ?? null],
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
  if (attrs.every(([k, v]) => k === "shown_as" || v === null || String(v).trim() === "")) {
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
