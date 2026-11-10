// Text forms the rules match against. One pass builds all of them lazily, so a rule list that
// only uses `norm` never pays for the squashed form.
//
//   raw      NFKC, invisible characters removed, case kept (secrets, ids, addresses)
//   norm     raw lowercased, katakana folded to hiragana (so a rule is written once for both)
//   squashed norm with look-alike letters folded and everything but letters and digits removed
//            (`n i g g e r`, `n.1.g.g.3.r`): only for rules that name an unambiguous string

/** Zero-width, bidirectional, tag and other invisible code points, and C0/C1 controls (not \t \n). */
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿\u{e0000}-\u{e007f}]/gu;

/** How many invisible characters `text` holds (a way to hide instructions from people). */
export function countInvisible(text: string): number {
  return text.match(INVISIBLE)?.length ?? 0;
}

/** Look-alikes folded before squashing: leetspeak and a few Cyrillic / Greek letters. */
const LOOKALIKE: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
  а: "a",
  е: "e",
  о: "o",
  с: "c",
  р: "p",
  х: "x",
  і: "i",
  α: "a",
  ο: "o",
};
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKE).join("")}]`, "gu");
const NOT_WORD = /[^\p{L}\p{N}]+/gu;
const KATAKANA = /[ァ-ヶ]/gu;

/** Hiragana of every katakana code point; everything else is unchanged. */
export function foldKana(text: string): string {
  return text.replace(KATAKANA, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export type TextForm = "raw" | "norm" | "squashed";

export class Forms {
  readonly raw: string;
  #norm: string | null = null;
  #squashed: string | null = null;
  #rawSquashed: string | null = null;

  /** `allow`: phrases cut out of `norm` and `squashed` before matching (not out of `raw`). */
  constructor(
    text: string,
    private readonly allow: readonly RegExp[] = [],
  ) {
    this.raw = text.normalize("NFKC").replace(INVISIBLE, "");
  }

  get norm(): string {
    if (this.#norm === null) {
      this.#norm = excise(foldKana(this.raw.toLowerCase()), this.allow);
    }
    return this.#norm;
  }

  get squashed(): string {
    if (this.#squashed === null) {
      this.#squashed = this.norm
        .replace(LOOKALIKE_RE, (c) => LOOKALIKE[c] ?? c)
        .replace(NOT_WORD, "");
    }
    return this.#squashed;
  }

  /** Letters and digits of the raw text, case kept: for comparing against a known secret. */
  get rawSquashed(): string {
    if (this.#rawSquashed === null) this.#rawSquashed = this.raw.replace(NOT_WORD, "");
    return this.#rawSquashed;
  }

  form(name: TextForm): string {
    return name === "raw" ? this.raw : name === "norm" ? this.norm : this.squashed;
  }
}

/** Removes every occurrence of the allowed phrases from a form (replaced by a space). */
export function excise(text: string, allow: readonly RegExp[]): string {
  let out = text;
  for (const re of allow) out = out.replace(re, " ");
  return out;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** A regular expression that matches `phrase` literally, in the `norm` form. */
export function allowPattern(phrase: string): RegExp {
  const norm = foldKana(phrase.normalize("NFKC").toLowerCase());
  return new RegExp(norm.replace(REGEX_SPECIALS, "\\$&"), "gu");
}

/** Luhn check for card-like digit runs. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
