// `@name` in her text lines, turned into the platform's mention markup for the people known in the
// place (`mention_users`). Applied to the text that is sent; the transcript keeps what she wrote.
// Role, `@everyone` and `@here` mentions never come out of here: only user mentions do.
//
// She does not always write a name the way the platform has it: the prompt shows her a cleaned
// name, she drops capitals, and of 「Owen Liu」 she writes 「@owen」. So a name is matched without
// regard to case, by any of its other forms (`aliases`), and by its first word when that word
// belongs to one person only. A form two people share mentions nobody.
//
// The same matching tells whom a name in her `<feel>` block is (`nameMatcher`, `feel.ts`).

export interface MentionTarget {
  /** Display name as the platform has it. */
  name: string;
  /** What `@name` becomes, e.g. `<@1234>` on Discord. */
  markup: string;
  /** Other forms she may write: the name as the prompt shows it, the person's handle. */
  aliases?: readonly string[];
}

/** A first word shorter than this is not taken for the person (「@a」 of 「A Lin」). */
const MIN_FIRST_WORD = 2;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fold(s: string): string {
  return s.normalize("NFKC").toLowerCase().trim();
}

/** Someone a written name may stand for: `key` is who (the same key is the same person). */
export interface NameTarget {
  name: string;
  aliases?: readonly string[];
  key: string;
}

/** Forms → key; a form two keys share is nobody's. Earlier groups win over later ones. */
function formsOf(targets: readonly NameTarget[]): Map<string, string> {
  const groups: ((t: NameTarget) => readonly string[])[] = [
    (t) => [t.name],
    (t) => t.aliases ?? [],
    (t) => {
      const first = t.name.trim().split(/\s+/u)[0] ?? "";
      return [...first].length >= MIN_FIRST_WORD ? [first] : [];
    },
  ];
  const settled = new Map<string, string>();
  for (const group of groups) {
    const round = new Map<string, string | null>();
    for (const target of targets) {
      for (const raw of group(target)) {
        const form = fold(raw);
        if (form === "" || settled.has(form)) continue;
        const held = round.get(form);
        round.set(form, held === undefined || held === target.key ? target.key : null);
      }
    }
    for (const [form, key] of round) if (key !== null) settled.set(form, key);
  }
  return settled;
}

/**
 * Who a name she wrote is, among `targets` (case aside, any of their forms, a first word only one
 * of them has, a leading `@` dropped): their key, or `null` for nobody or more than one.
 */
export function nameMatcher(targets: readonly NameTarget[]): (written: string) => string | null {
  const forms = formsOf(targets.filter((t) => t.name.trim() !== "" && t.key !== ""));
  return (written) => forms.get(fold(written.replace(/^@+/u, ""))) ?? null;
}

/**
 * Replaces `@name` (longest forms first, not followed by a letter or digit) with the target's
 * markup. Anything that is nobody's name stays as written. Code (fenced or inline) is left as it
 * is.
 */
export function linkMentions(text: string, targets: readonly MentionTarget[]): string {
  if (!text.includes("@")) return text;
  const forms = formsOf(
    targets
      .filter((t) => t.name.trim() !== "" && t.markup !== "")
      .map((t) => ({ name: t.name, ...(t.aliases ? { aliases: t.aliases } : {}), key: t.markup })),
  );
  if (forms.size === 0) return text;
  const longestFirst = [...forms.keys()].sort((a, b) => [...b].length - [...a].length);
  const pattern = new RegExp(
    // Not the `@` of a mail address.
    `(?<![A-Za-z0-9._%+-])@(${longestFirst.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/u)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(pattern, (whole, name: string) => forms.get(fold(name)) ?? whole),
    )
    .join("");
}
