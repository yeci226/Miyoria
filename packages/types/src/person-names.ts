// Which person a name means, the one way every tool that takes a person by name asks
// (2026-11-22: members renamed their server nicknames; she wrote the name she read in the chat,
// a tool knew only the handle, and after two failures her coins went to someone else).
//
// - The handle wins. Handles are unique and never follow a rename, so nobody takes one by
//   renaming: someone who renames to another person's handle is still found under their own.
// - Else a whole name: what their accounts are called now, the name at first sight, what she
//   calls them. One person: a match. Two or more: refused, all of them listed.
// - A part of a name is never a match: it is refused with the people it may be, by handle and
//   by the names they go by now, so she can try again with the right one.
//
// Names compare without case, width or spaces, and without a leading `@`. A name someone went by
// before and no longer does is not a way to find them (it could be someone else's now).

import type { Handle, HandleDirectory } from "./handle.js";
import type { PersonId } from "./ids.js";
import type { AccountRef } from "./platform.js";
import { safeName } from "./untrusted.js";

/** One person a name may mean, with every name they may be called by. */
export interface PersonCandidate {
  /** What tells two candidates apart: the person, else the handle. */
  key: string;
  /** Their handle: the name she uses for them, in prompts and in tools. */
  handle: Handle;
  /** Other handle rows of the same person (an account seen before it was linked). */
  handles?: readonly Handle[];
  person: PersonId | null;
  account: AccountRef | null;
  /** What their accounts are called now. */
  shown: readonly string[];
  /** The name at first sight (where the handle came from). */
  first: string | null;
  /** What she calls them (稱呼). */
  call: string | null;
}

export type PersonNameMatch =
  | { kind: "one"; candidate: PersonCandidate }
  /** Several people are called that. */
  | { kind: "ambiguous"; said: string; candidates: PersonCandidate[] }
  /** Nobody is called that; `candidates`: people part of whose name it is (or the other way). */
  | { kind: "none"; said: string; candidates: PersonCandidate[] };

/** Candidates a refusal lists at most. */
export const MAX_NAME_CANDIDATES = 5;

/** A name as names are compared: NFKC, lower case, no spaces, no leading `@`. */
export function nameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^[@＠]+/, "");
}

/** Every name of `c` but the handles, as keys. */
function otherNames(c: PersonCandidate): string[] {
  return [...c.shown, c.first ?? "", c.call ?? ""].map(nameKey).filter((k) => k !== "");
}

function handleKeys(c: PersonCandidate): string[] {
  return [c.handle, ...(c.handles ?? [])].map(nameKey).filter((k) => k !== "");
}

function distinct(list: readonly PersonCandidate[]): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  for (const c of list) if (!out.some((o) => o.key === c.key)) out.push(c);
  return out;
}

/** The one person `said` names among `candidates`, or why not (see the file's head). */
export function matchPersonName(
  said: string,
  candidates: readonly PersonCandidate[],
): PersonNameMatch {
  const text = said.trim();
  const want = nameKey(text);
  if (want === "") return { kind: "none", said: text, candidates: [] };
  const byHandle = distinct(candidates.filter((c) => handleKeys(c).includes(want)));
  if (byHandle.length === 1) return { kind: "one", candidate: byHandle[0] as PersonCandidate };
  if (byHandle.length > 1) return { kind: "ambiguous", said: text, candidates: byHandle };
  const whole = distinct(candidates.filter((c) => otherNames(c).includes(want)));
  if (whole.length === 1) return { kind: "one", candidate: whole[0] as PersonCandidate };
  if (whole.length > 1) return { kind: "ambiguous", said: text, candidates: whole };
  const close =
    [...want].length < 2
      ? []
      : distinct(
          candidates.filter((c) =>
            [...handleKeys(c), ...otherNames(c)].some(
              (k) => k.includes(want) || ([...k].length >= 2 && want.includes(k)),
            ),
          ),
        );
  return { kind: "none", said: text, candidates: close.slice(0, MAX_NAME_CANDIDATES) };
}

/** The names of `c` that are not its handle, each once, made inert. */
export function shownNames(
  handle: Handle,
  names: readonly (string | null | undefined)[],
): string[] {
  const own = nameKey(handle);
  const out: string[] = [];
  const seen = new Set<string>([own]);
  for (const n of names) {
    if (n === null || n === undefined) continue;
    const key = nameKey(n);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(safeName(n));
  }
  return out;
}

/** `「沒人」(現在叫「Lumen」)`: a candidate as a refusal lists it. */
export function describePerson(c: PersonCandidate): string {
  const shown = shownNames(c.handle, c.shown);
  const now = shown.length === 0 ? "" : `(現在叫${shown.map((n) => `「${n}」`).join("、")})`;
  const call =
    c.call !== null && shownNames(c.handle, [...c.shown, c.call]).length > shown.length
      ? `(你叫他「${safeName(c.call, 16)}」)`
      : "";
  return `「${safeName(c.handle)}」${now}${call}`;
}

/**
 * Why `match` names nobody, for her to try again: who it may be, by handle. The caller says what
 * did not happen (`沒有送出`).
 */
export function nameRefusal(match: Exclude<PersonNameMatch, { kind: "one" }>): string {
  const said = safeName(match.said, 64);
  const who = match.candidates.slice(0, MAX_NAME_CANDIDATES).map(describePerson).join("、");
  if (match.kind === "ambiguous") {
    return `「${said}」不只一個人:${who}。用「」裡的名字(handle)再試一次`;
  }
  if (match.candidates.length === 0) return `不知道「${said}」是誰`;
  return `不知道「${said}」是誰(名字要寫完整);是不是:${who}?用「」裡的名字(handle)再試一次`;
}

/** What she calls people, as the heart lists it (`HeartPeople.callNames`). */
export type CallNames = readonly { person: PersonId; call_name: string }[];

/** Everyone the handle table knows, as candidates, one per person (or per handle without one). */
export function directoryCandidates(
  handles: Pick<HandleDirectory, "list"> | null | undefined,
  callNames: CallNames = [],
): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const byPerson = new Map<string, PersonCandidate>();
  for (const e of handles?.list() ?? []) {
    if (e.person !== null) {
      const known = byPerson.get(e.person);
      if (known !== undefined) {
        known.handles = [...(known.handles ?? []), e.handle];
        known.shown = [...known.shown, ...(e.names ?? [])];
        continue;
      }
    }
    const c: PersonCandidate = {
      key: e.person === null ? `handle:${e.handle}` : `person:${e.person}`,
      handle: e.handle,
      person: e.person,
      account: e.account,
      shown: [...(e.names ?? [])],
      first: e.display_name,
      call: null,
    };
    out.push(c);
    if (e.person !== null) byPerson.set(e.person, c);
  }
  for (const { person, call_name } of callNames) {
    const c = byPerson.get(person);
    if (c !== undefined && call_name.trim() !== "") c.call = call_name;
  }
  return out;
}

/**
 * Whom `said` names in the handle table (`matchPersonName` over `directoryCandidates`); a handle
 * the table resolves exactly but does not list (a directory that lists nothing) is found too.
 */
export function directoryMatch(
  handles: Pick<HandleDirectory, "list" | "resolve"> | null | undefined,
  said: string,
  callNames: CallNames = [],
): PersonNameMatch {
  const match = matchPersonName(said, directoryCandidates(handles, callNames));
  if (match.kind !== "none" || match.candidates.length > 0) return match;
  const e = handles?.resolve(said.trim().replace(/^[@＠]+/, "")) ?? null;
  if (e === null) return match;
  const candidate: PersonCandidate = {
    key: e.person === null ? `handle:${e.handle}` : `person:${e.person}`,
    handle: e.handle,
    person: e.person,
    account: e.account,
    shown: [...(e.names ?? [])],
    first: e.display_name,
    call: null,
  };
  return { kind: "one", candidate };
}

/** Whether `name` reads as an ordinary word (`nameKey`d): see `ORDINARY_WORDS`. */
export function isOrdinaryWord(name: string): boolean {
  return ORDINARY_WORDS.has(nameKey(name));
}

/**
 * Words that mean nobody, everyone, someone or a pronoun, and the words tools read as a target
 * (`speaker`, `here`, `self`). A new handle made from one gets a suffix (`assignHandle`), so a line
 * like 「補送給沒人」 is never about a person called that; a name in a line of hers that is one of
 * these is not taken as whom it is said to.
 */
export const ORDINARY_WORDS: ReadonlySet<string> = new Set(
  [
    "沒人",
    "没人",
    "沒有人",
    "没有人",
    "有人",
    "大家",
    "所有人",
    "每個人",
    "每个人",
    "某人",
    "某個人",
    "某个人",
    "任何人",
    "別人",
    "别人",
    "誰",
    "谁",
    "你",
    "我",
    "他",
    "她",
    "它",
    "你們",
    "你们",
    "我們",
    "我们",
    "他們",
    "他们",
    "她們",
    "她们",
    "咱們",
    "咱们",
    "自己",
    "本人",
    "對方",
    "对方",
    "主人",
    "nobody",
    "noone",
    "none",
    "everyone",
    "everybody",
    "someone",
    "somebody",
    "anyone",
    "anybody",
    "all",
    "you",
    "me",
    "i",
    "we",
    "us",
    "he",
    "him",
    "she",
    "her",
    "they",
    "them",
    "self",
    "speaker",
    "here",
  ].map(nameKey),
);

/** A name with an ASCII letter or digit matches only as a whole word inside a text. */
const ASCII = /[a-z0-9]/;

/**
 * The candidates `text` names (a line of hers): a handle, a name they go by now or her call name
 * written in it, `@` or not. Names under two characters and ordinary words (`ORDINARY_WORDS`)
 * count only after an `@`. In order of the first name found.
 */
export function namedIn(text: string, candidates: readonly PersonCandidate[]): PersonCandidate[] {
  const flat = text.normalize("NFKC").toLowerCase();
  const found: { span: Span; c: PersonCandidate }[] = [];
  for (const c of candidates) {
    for (const raw of [c.handle, ...(c.handles ?? []), ...c.shown, c.call ?? ""]) {
      const key = nameKey(raw);
      if (key === "") continue;
      const loose = [...key].length < 2 || ORDINARY_WORDS.has(key);
      const span = findName(flat, key, loose);
      if (span !== null) found.push({ span, c });
    }
  }
  // A name written inside a longer name that was found is that longer name ("Lumen" in
  // "Model-9 Lumen").
  const kept = found.filter(
    (f) =>
      !found.some(
        (g) =>
          g.c.key !== f.c.key &&
          g.span.start <= f.span.start &&
          g.span.end >= f.span.end &&
          g.span.end - g.span.start > f.span.end - f.span.start,
      ),
  );
  return distinct(kept.sort((a, b) => a.span.start - b.span.start).map((f) => f.c));
}

interface Span {
  start: number;
  end: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where the name `key` is written in `flat` (spaces inside it allowed), else `null`. A name with
 * ASCII letters or digits only as a whole word; `atOnly`: only right after an `@`.
 */
function findName(flat: string, key: string, atOnly: boolean): Span | null {
  const pattern = [...key].map(escapeRegExp).join("\\s*");
  const before = atOnly ? "[@＠]\\s*" : ASCII.test(key) ? "(?<![a-z0-9_])" : "";
  const after = atOnly ? "(?![\\p{L}\\p{N}_])" : ASCII.test(key) ? "(?![a-z0-9_])" : "";
  const m = new RegExp(`${before}${pattern}${after}`, "u").exec(flat);
  return m === null ? null : { start: m.index, end: m.index + m[0].length };
}
