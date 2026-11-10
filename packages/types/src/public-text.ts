// What may be shown to one person about themselves (docs/design/v3-architecture.md §17.1). Text
// she wrote can name anyone, so before a line reaches a page it must be shown to carry nobody
// else's name. The check fails closed: a line that merely looks like it names someone is dropped,
// because showing nothing costs far less than showing one person another's name.

import type { PersonId } from "./ids.js";
import { type AccountRef, sameAccount } from "./platform.js";

/** One name somebody goes by. `person` and `account` say whose it is, as far as that is known. */
export interface KnownName {
  name: string;
  person: PersonId | null;
  account: AccountRef | null;
}

/** The names of one person, and the names of everyone else. */
export interface NameSplit {
  own: readonly string[];
  others: readonly string[];
}

/** Case, width, spaces, punctuation and invisible characters do not make a name another name. */
function squash(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\p{C}]+/gu, "");
}

/** `Owen#2` is also just `Owen`. */
function forms(name: string): string[] {
  const base = name.replace(/#\d+$/, "");
  return base === name ? [name] : [name, base];
}

/** A single ASCII character is no name: it would match almost any text. */
function usable(squashed: string): boolean {
  return squashed !== "" && !/^[\p{ASCII}]$/u.test(squashed);
}

/** Splits every known name into `person`'s (or `accounts`') and everyone else's. */
export function splitNames(
  known: readonly KnownName[],
  person: PersonId | null,
  accounts: readonly AccountRef[],
): NameSplit {
  const own: string[] = [];
  const others: string[] = [];
  for (const entry of known) {
    const byPerson = person !== null && entry.person === person;
    const account = entry.account;
    const byAccount = account !== null && accounts.some((a) => sameAccount(a, account));
    (byPerson || byAccount ? own : others).push(entry.name);
  }
  return { own, others };
}

/**
 * Whether `text` names anyone in `names.others`. The person's own names are taken out first, so
 * `Owen0924` does not count as naming a different `Owen`. Discord mentions and long ids count as
 * naming someone whoever they belong to.
 */
export function mentionsAnother(text: string, names: NameSplit): boolean {
  if (/<@[!&]?\d+>/.test(text) || /(?<!\d)\d{17,20}(?!\d)/.test(text)) return true;
  let body = squash(text);
  const own = names.own
    .flatMap(forms)
    .map(squash)
    .filter(usable)
    .sort((a, b) => b.length - a.length);
  for (const name of own) body = body.replaceAll(name, "");
  const ownSet = new Set(own);
  return names.others
    .flatMap(forms)
    .map(squash)
    .some((name) => usable(name) && !ownSet.has(name) && body.includes(name));
}
