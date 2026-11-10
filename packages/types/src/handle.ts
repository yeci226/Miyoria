// Stable handles (docs/design/v2-architecture.md §3.1, phase 0 item 13): the one name she uses
// for a person in prompts and in everything she writes down (lessons, recaps, agenda, feelings).
//
// A handle is the person's display name, kept in a persistent table so it does not change from
// one call to the next; only when two people share a name does the later one get a suffix
// (`Owen`, `Owen#2`). Per-call codes like `u1` / `p2` / `g3` are prompt-local references and
// must never reach persisted data: run `ephemeralHandlesIn` over anything before storing it.

import type { PersonId } from "./ids.js";
import type { AccountRef } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** A person's stable name (`"Owen"`, `"御坂"`, `"Owen#2"`). Untrusted text: names are user input. */
export type Handle = string;

/** Longest handle, in UTF-16 code units (before the collision suffix). */
export const MAX_HANDLE_LENGTH = 32;

/** Separator of the collision suffix: the second `Owen` is `Owen#2`. */
export const HANDLE_SUFFIX_SEPARATOR = "#";

/** One row of the handle table. */
export interface HandleEntry {
  handle: Handle;
  /** `null` until the account is linked to a person. */
  person: PersonId | null;
  /** The account it was first assigned for. */
  account: AccountRef | null;
  /** The display name it was made from (the handle does not follow later renames). */
  display_name: string;
  created_at: Timestamp;
}

/**
 * Provided by the app with the store (`packages/core/src/boot.ts`); answers from memory and
 * persists new rows in the background. The only place handles are assigned.
 */
export interface HandleDirectory {
  /**
   * The account's handle, assigned from `displayName` (and persisted) on first sight. A caller
   * that knows which person the account belongs to passes it, so `ofPerson` can answer.
   */
  ofAccount(account: AccountRef, displayName: string, person?: PersonId | null): Handle;
  /** The person's handle, `null` when none of their accounts was seen yet. */
  ofPerson(person: PersonId): Handle | null;
  /** The row of `handle` (exact match), or `null`. */
  resolve(handle: Handle): HandleEntry | null;
  /** Every row, oldest first. */
  list(): HandleEntry[];
}

export const HandleDirectoryKey = serviceKey<HandleDirectory>("HandleDirectory");

/** A whole string that is a per-call reference code: `u1`, `p12`, `g3` (lower case). */
const EPHEMERAL = /^[upg][0-9]{1,4}$/;
/** The same codes inside text (ASCII word boundaries; CJK characters count as boundaries). */
const EPHEMERAL_IN_TEXT = /(?<![A-Za-z0-9_])[upg][0-9]{1,4}(?![A-Za-z0-9_])/g;

/** True for per-call reference codes (`u1`, `p2`, `g3`), which are never valid handles. */
export function isEphemeralHandle(value: string): boolean {
  return EPHEMERAL.test(value.trim());
}

/**
 * The per-call reference codes found in `text`, in order of appearance (duplicates kept once).
 * Writers of persisted text refuse, or rewrite, text where this is not empty.
 */
export function ephemeralHandlesIn(text: string): string[] {
  return [...new Set(text.match(EPHEMERAL_IN_TEXT) ?? [])];
}

/** A display name cleaned into a handle base: no control characters, single spaces, capped. */
export function handleBase(displayName: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
  const clean = displayName.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
  return [...clean.trim()].slice(0, MAX_HANDLE_LENGTH).join("").trim();
}

/** True when `value` may be stored as a handle. */
export function isValidHandle(value: string): boolean {
  return (
    value !== "" &&
    value === value.trim() &&
    !isEphemeralHandle(value) &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
    !/[\u0000-\u001f\u007f]/.test(value) &&
    [...value].length <= MAX_HANDLE_LENGTH + 6
  );
}

/**
 * The handle for a new person named `displayName`, given the handles already taken: the
 * cleaned name, else the name with the first free suffix (`Owen#2`, `Owen#3` ...). An empty
 * name, or one that looks like a reference code (someone called `u1`), always gets a suffix.
 */
export function assignHandle(displayName: string, taken: (handle: Handle) => boolean): Handle {
  const base = handleBase(displayName) || "?";
  const bare = base !== "?" && !isEphemeralHandle(base);
  if (bare && !taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${HANDLE_SUFFIX_SEPARATOR}${n}`;
    if (!taken(candidate)) return candidate;
  }
}
