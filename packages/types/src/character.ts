// Who she is in this profile (docs/design/v5-profiles.md): her name, the short names people call
// her, the pronoun texts use for her, and the themed words of her world. `[character]` in the
// profile's `miyoria.toml`; every field defaults to what the first character, Miyoria, has always
// used, so an install without the section reads exactly as before.
//
// Pure data and helpers: the zod schema that reads the section is the kernel's
// (`CharacterSectionSchema`), the value is a kernel service (`CharacterKey`) Core provides at boot.

import { serviceKey } from "./service-key.js";

export interface Character {
  /** Her own name (`Miyoria`). */
  readonly name: string;
  /** The short name most people use (`Miyo`); `""`: none. */
  readonly short_name: string;
  /** Other spellings of the short name (`米優`, `みよ`). */
  readonly other_names: readonly string[];
  /** How texts refer to her (`她`). */
  readonly pronoun: string;
  /** The name of her stock exchange (`深海交易所`). */
  readonly exchange_name: string;
  /**
   * What she is, in a word, where a text means her nature (`鯨魚`: the 「鯨魚的小毛病」 her card
   * words may have); `""`: nothing in particular.
   */
  readonly creature: string;
}

/** Miyoria's values: the defaults of every field. */
export const DEFAULT_CHARACTER: Character = Object.freeze({
  name: "Miyoria",
  short_name: "Miyo",
  other_names: Object.freeze(["米優", "みよ"]),
  pronoun: "她",
  exchange_name: "深海交易所",
  creature: "鯨魚",
});

/**
 * The coins' name when the profile names none: the default of `[modules.economy] currency`, the one
 * place the name is configured (docs/design/v5-profiles.md).
 */
export const DEFAULT_CURRENCY = "魚幣";

/**
 * The running profile's coin name (`[modules.economy] currency`), provided by Core at boot like
 * `CharacterKey`; absent in a bare test registry (use `DEFAULT_CURRENCY`).
 */
export const CurrencyKey = serviceKey<string>("Currency");

/** The running profile's character; absent in a bare test registry (use `DEFAULT_CHARACTER`). */
export const CharacterKey = serviceKey<Character>("Character");

/** Which profile this Core runs, for the CLI and the panel's one-line indicator. */
export interface RunningProfile {
  /** The profile's folder name (the store's profile id). */
  readonly id: string;
  /** It has its own config and data; `false`: it runs on the install's (the first character). */
  readonly own: boolean;
  /** `[character] name`. */
  readonly character: string;
  /** The persona's display name (`profile.toml`). */
  readonly persona: string;
}

export const RunningProfileKey = serviceKey<RunningProfile>("RunningProfile");

/** Every name that counts as calling her: name, short name, its other spellings (no blanks). */
export function characterNames(c: Character): string[] {
  const out: string[] = [];
  for (const n of [c.name, c.short_name, ...c.other_names]) {
    const name = n.trim();
    if (name !== "" && !out.includes(name)) out.push(name);
  }
  return out;
}

/** `A`, `A 或 B`, `A、B 或 C`. */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join("、")} 或 ${items.at(-1)}`;
}
