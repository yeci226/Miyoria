// Nobody else's name on what she writes for one person (a card, a fortune slip). What the member
// page passes (`shown`: the names she knows people by, moderation) catches the names in her
// directory; a memory she is given can still hold one the directory does not know (a friend who
// never joined, a nickname: 「她說阿凱推薦的那首歌」), and she may copy it. So every text she
// writes is checked against both: the directory's names of everyone else, and the names guessed in
// what she was given (`nameLikeWords`), the person's own names taken out first. The guess is made to
// catch more than it misses; a text it flags is written again without the memory it came from, or
// left off.

import { nameLikeWords, simplify } from "@miyoria/memory/memory";
import { mentionsAnother, type NameSplit } from "@miyoria/types";

/** One text she was given and the names guessed in it, squashed. */
interface Given {
  text: string;
  names: readonly string[];
}

/** What a text she wrote is checked against. */
export interface NameScreen {
  names: NameSplit;
  given: readonly Given[];
  /** The person's own names, squashed, longest first. */
  own: readonly string[];
}

/** Where a text names someone else: which of the given texts the name came from (by index). */
export interface NameHit {
  /** The name as guessed from a given text; `null` when it is one of the directory's. */
  name: string | null;
  from: readonly number[];
}

/** Case, width, script (traditional and simplified), spaces and punctuation do not matter. */
function squash(text: string): string {
  return simplify(text.normalize("NFKC"))
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\p{C}]+/gu, "");
}

/** The screen for one person: `names` from the directory, `given` what she is shown of them. */
export function nameScreen(names: NameSplit, given: readonly string[]): NameScreen {
  const own = names.own
    .map(squash)
    .filter((n) => [...n].length >= 2)
    .sort((a, b) => b.length - a.length);
  const mine = (n: string) => own.some((o) => o.includes(n) || n.includes(o));
  return {
    names,
    own,
    given: given.map((text) => ({
      text,
      names: [...new Set(nameLikeWords(text).map(squash))].filter(
        (n) => [...n].length >= 2 && !mine(n),
      ),
    })),
  };
}

/** Where `text` names someone other than the person; `null` when it names nobody else. */
export function otherNameIn(screen: NameScreen, text: string): NameHit | null {
  if (mentionsAnother(text, screen.names)) return { name: null, from: [] };
  let body = squash(text);
  for (const name of screen.own) body = body.replaceAll(name, "");
  for (const given of screen.given) {
    const name = given.names.find((n) => body.includes(n));
    if (name === undefined) continue;
    const from = screen.given.flatMap((g, i) => (g.names.includes(name) ? [i] : []));
    return { name, from };
  }
  return null;
}
