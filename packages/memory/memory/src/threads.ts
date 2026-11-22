// Her questions to people across every place, and whether they answered (v4 §5.3, §5.6).
//
// 2026-11-10: she sent someone a DM asking how something went, they answered there twice, and
// within the next hour she asked them the same thing four times in a public channel. Sessions,
// recaps and "recently said" were all per place, so the channel knew neither that she had asked
// nor that they had answered. Here a question is hers wherever she asked it: grouped per person
// and topic, counted, with the first thing the person said to her about it afterwards as the
// answer. What may be shown where follows `places.ts`; `asked` carries no words, so planners
// can call it before raising a topic again.
//
// 2026-11-22: a question she sent to one person, by name, right after a reply to another, was
// recorded as asked of the other (the person of the turn), and that person's "?" to a different
// line of hers as the answer. A line is asked of whom it replies to, else whom it names, else of
// nobody in particular (then of nobody); an answer is a reply to that line, or a line of theirs
// said to her (a mention, her name, a DM) in the place she asked, never merely their next line.

import {
  type AskedLookup,
  type AskedQuestion,
  type Asking,
  contextKeyEquals,
  contextKeyString,
  directoryCandidates,
  type Handle,
  type HandleDirectory,
  namedIn,
  nameKey,
  type PersonCandidate,
  type PersonId,
  type PersonThread,
  type PersonThreads,
  safeName,
  type Timestamp,
  timestampMs,
  toTimestamp,
  type Whereabouts,
} from "@miyoria/types";
import type { RecentConfig } from "./config.js";
import { disclose, placeRef, quotable, type Viewer, WITHHELD } from "./places.js";
import type { Her, RecentLog, Said, Window } from "./recent-log.js";
import { textSimilarity, tokenize } from "./tokenize.js";

/** The question sentences of one of her lines (`""`: none). */
export function questionOf(line: string): string {
  const sentences = line
    .replace(/<[^>]*>/g, "")
    .split(/(?<=[。！!？?\n~～…])/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return sentences
    .filter((s) => /[?？]$|[嗎呢][~～…]*$/u.test(s.replace(/[\s。!！]+$/u, "")))
    .join(" ")
    .trim();
}

/** Two questions ask about the same thing. */
export function sameQuestion(a: string, b: string): boolean {
  if (textSimilarity(a, b) >= 0.5) return true;
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / Math.min(x.size, y.size) >= 0.5;
}

/** The people a window knows by the names they spoke under, for a line that names them. */
export function windowPeople(window: Window): PersonCandidate[] {
  const out = new Map<string, PersonCandidate>();
  for (const s of window.said) {
    const known = out.get(s.handle);
    if (known === undefined) {
      out.set(s.handle, {
        key: `handle:${s.handle}`,
        handle: s.handle,
        person: null,
        account: null,
        shown: [s.name],
        first: null,
        call: null,
      });
    } else if (!known.shown.includes(s.name)) known.shown = [...known.shown, s.name];
  }
  return [...out.values()];
}

/**
 * Whom a line of hers was said to: in a DM, the other person; else who it was recorded as said to
 * (`Delivery.to`: whom it replies to, else whom it names); an older line without that, whom it
 * names (`people`), else the one person it was for. Nobody in particular: none.
 */
function addressees(line: Her, window: Window, people: readonly PersonCandidate[]): Handle[] {
  if (line.context.kind === "dm") {
    const partner = window.partners.get(contextKeyString(line.context)) ?? line.audience[0];
    return partner === undefined ? [] : [partner];
  }
  if (line.to !== undefined) return [...new Set(line.to)];
  const named = [...new Set(namedIn(line.said, people).map((c) => c.handle))];
  if (named.length > 0) return named;
  return line.audience.length === 1 ? [line.audience[0] as Handle] : [];
}

/** A line of hers and the text a reply quotes of it: the same line. */
function sameLine(said: string, quoted: string): boolean {
  const flat = (t: string) =>
    nameKey(t.replace(/<[^>]*>/g, "").replace(/[@＠]\S+/g, "")).replace(/[。,，!！?？~～…、]/g, "");
  const a = flat(said);
  const b = flat(quoted);
  if (a === "" || b === "") return false;
  const head = (t: string) => [...t].slice(0, 16).join("");
  return a.includes(head(b)) || b.includes(head(a)) || textSimilarity(a, b) >= 0.6;
}

/**
 * Whether `s` answers `q`: in a DM, anything they say to her; a reply, only to one of the lines
 * she asked with (her newest line there before it, when the platform did not quote it); else a
 * line said to her (a mention, her name) in a place she asked in.
 */
function answers(q: RawQuestion, s: Said, window: Window): boolean {
  if (s.context.kind === "dm")
    return q.asked.some((a) => contextKeyEquals(a.line.context, s.context));
  const here = q.asked.filter((a) => contextKeyEquals(a.line.context, s.context));
  if (s.reply !== undefined) {
    if (!s.reply.self) return false;
    const quoted = s.reply.text;
    if (quoted !== null) return q.asked.some((a) => sameLine(a.line.said, quoted));
    const last = window.her
      .filter((h) => contextKeyEquals(h.context, s.context) && h.at <= s.at)
      .at(-1);
    return last !== undefined && here.some((a) => a.line.id === last.id);
  }
  return s.addressed && here.length > 0;
}

/** One question of hers, every time she asked, and the answer (raw, before the place rule). */
export interface RawQuestion {
  key: string;
  handle: Handle;
  question: string;
  asked: { line: Her; said: string }[];
  /** The first thing the person said to her after the first asking, anywhere. */
  answer: Said | null;
  /** Everything they said within `answer_hours` of the first asking (a viewer picks the first it may see). */
  replies: Said[];
}

/**
 * Her questions in the window, grouped per person and topic, oldest first. `people`: whom a line
 * without a recorded addressee may name (default: the people of the window, by the names they
 * spoke under).
 */
export function questions(
  window: Window,
  config: RecentConfig,
  nowMs: number,
  people: readonly PersonCandidate[] = windowPeople(window),
): RawQuestion[] {
  const since = nowMs - config.question_hours * 3_600_000;
  const out: RawQuestion[] = [];
  for (const line of window.her) {
    if (line.at < since || line.at > nowMs) continue;
    const said = questionOf(line.said);
    if (said === "") continue;
    for (const handle of addressees(line, window, people)) {
      const same = out.find((q) => q.handle === handle && sameQuestion(q.question, said));
      if (same) same.asked.push({ line, said });
      else {
        out.push({
          key: `ask:${handle}:${line.id}`,
          handle,
          question: said,
          asked: [{ line, said }],
          answer: null,
          replies: [],
        });
      }
    }
  }
  const answerMs = config.answer_hours * 3_600_000;
  for (const q of out) {
    const first = q.asked[0]?.line.at ?? 0;
    q.replies = window.said.filter(
      (s) =>
        s.handle === q.handle &&
        s.at > first &&
        s.at - first <= answerMs &&
        s.at <= nowMs &&
        answers(q, s, window),
    );
    q.answer = q.replies[0] ?? null;
  }
  return out;
}

const cut = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join("")}…` : flat;
};

/** A question as `viewer` may see it (`null`: none of it may be shown). */
export function visibleQuestion(
  q: RawQuestion,
  viewer: Viewer,
  person: PersonId | null,
  quoteChars: number,
): AskedQuestion | null {
  const asked: Asking[] = [];
  let priv = false;
  for (const { line, said } of q.asked) {
    const d = disclose(line.context, viewer, [q.handle]);
    if (d === "hide") continue;
    if (d === "private") priv = true;
    asked.push({
      at: toTimestamp(line.at),
      place: placeRef(line.context, viewer),
      // Asked in a DM, seen from a channel: that she asked, not what (`""`).
      said: quotable(d, viewer) ? cut(said, quoteChars) : "",
      private: d === "private",
    });
  }
  if (asked.length === 0) return null;
  // The first reply this viewer may know of, after the first asking it may know of.
  const firstSeen = timestampMs(asked[0]?.at ?? toTimestamp(0));
  let answer: Said | null = null;
  let shown: ReturnType<typeof disclose> = "hide";
  for (const reply of q.replies) {
    if (reply.at <= firstSeen) continue;
    const d = disclose(reply.context, viewer, [q.handle]);
    if (d === "hide") continue;
    answer = reply;
    shown = d;
    break;
  }
  if (shown === "private") priv = true;
  return {
    key: q.key,
    handle: q.handle,
    person,
    question: asked.find((a) => a.said !== "")?.said ?? "",
    asked,
    answered_at: answer !== null && shown !== "hide" ? toTimestamp(answer.at) : null,
    answered_in: answer !== null && shown !== "hide" ? placeRef(answer.context, viewer) : null,
    // Answered in a DM, seen from a channel: that they answered, not what.
    answer:
      answer !== null && shown !== "hide" && quotable(shown, viewer)
        ? cut(answer.text, quoteChars)
        : null,
    private: priv,
  };
}

/** Builds the reader's `Viewer` from where it is. */
export type ViewerOf = (where: Whereabouts, window: Window) => Viewer;

export class Threads implements PersonThreads {
  readonly #log: RecentLog;
  readonly #config: () => RecentConfig;
  readonly #handles: () => HandleDirectory | null;
  readonly #viewer: ViewerOf;

  constructor(
    log: RecentLog,
    config: () => RecentConfig,
    handles: () => HandleDirectory | null,
    viewer: ViewerOf,
  ) {
    this.#log = log;
    this.#config = config;
    this.#handles = handles;
    this.#viewer = viewer;
  }

  /** Whom a line of hers may name: the handle table's people, and the window's by name. */
  #people(window: Window): PersonCandidate[] {
    return [...directoryCandidates(this.#handles()), ...windowPeople(window)];
  }

  /** The visible questions to `handle`, newest asking last. */
  async questionsTo(handle: Handle, where: Whereabouts): Promise<AskedQuestion[]> {
    const now = timestampMs(where.now);
    const window = await this.#log.window(now);
    const viewer = this.#viewer(where, window);
    const person = this.#handles()?.resolve(handle)?.person ?? null;
    const quote = this.#config().quote_chars;
    return questions(window, this.#config(), now, this.#people(window))
      .filter((q) => q.handle === handle)
      .flatMap((q) => visibleQuestion(q, viewer, person, quote) ?? []);
  }

  async thread(person: PersonId, where: Whereabouts): Promise<PersonThread | null> {
    const handle = this.#handles()?.ofPerson(person) ?? null;
    if (handle === null) return null;
    const now = timestampMs(where.now);
    const window = await this.#log.window(now);
    const viewer = this.#viewer(where, window);
    let last: Said | null = null;
    for (const s of window.said) {
      if (s.handle !== handle || s.at > now) continue;
      if (disclose(s.context, viewer, [handle]) === "hide") continue;
      last = s;
    }
    const questions = await this.questionsTo(handle, where);
    if (last === null && questions.length === 0) return null;
    return {
      person,
      handle,
      last_said_at: last === null ? null : toTimestamp(last.at),
      last_place: last === null ? null : placeRef(last.context, viewer),
      questions,
    };
  }

  async asked(person: PersonId, text: string, now: Timestamp): Promise<AskedLookup | null> {
    const handle = this.#handles()?.ofPerson(person) ?? null;
    if (handle === null) return null;
    const nowMs = timestampMs(now);
    const window = await this.#log.window(nowMs);
    const wanted = questionOf(text) || text;
    const q = questions(window, this.#config(), nowMs, this.#people(window)).find(
      (x) => x.handle === handle && sameQuestion(x.question, wanted),
    );
    if (!q) return null;
    const lastLine = q.asked[q.asked.length - 1]?.line;
    return {
      key: q.key,
      times: q.asked.length,
      last_asked_at: toTimestamp(lastLine?.at ?? nowMs),
      answered_at: q.answer === null ? null : toTimestamp(q.answer.at),
      private: q.asked.some((a) => a.line.context.kind === "dm") || q.answer?.context.kind === "dm",
    };
  }
}

/** One line for a question: `你問 S「…」(共 4 次,私訊 11:07 起);S 11:22 回了:「…」`. */
export function questionLine(q: AskedQuestion, clock: (at: Timestamp) => string): string {
  const first = q.asked[0];
  const lastAsk = q.asked[q.asked.length - 1];
  if (first === undefined || lastAsk === undefined) return "";
  const where = (a: Asking) => (a.place.label === "" ? "" : `${a.place.label} `);
  const times =
    q.asked.length === 1
      ? `${where(first)}${clock(first.at)}`
      : `共 ${q.asked.length} 次,${where(first)}${clock(first.at)} 到 ${where(lastAsk)}${clock(lastAsk.at)}`;
  const answered =
    q.answered_at === null
      ? ";還沒回你"
      : `;${safeName(q.handle)} ${clock(q.answered_at)}${q.answered_in !== null && q.answered_in.label !== "" ? ` 在${q.answered_in.label}` : ""}回了${q.answer === null ? "" : `:「${q.answer}」`}`;
  const what = q.question === "" ? ` 一件事${WITHHELD}` : `「${q.question}」`;
  return `你問過 ${safeName(q.handle)}${what}(${times})${answered}`;
}
