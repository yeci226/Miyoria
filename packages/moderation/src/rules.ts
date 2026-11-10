// A rule is a regular expression over one text form, with an optional exception. The default
// list (default-rules.ts) and the owner's own rules (`[[modules.moderation.rules]]`) share this
// shape; the owner's rule with the id of a default replaces it.

import { MODERATION_CATEGORIES, type ModerationCategory } from "@miyoria/types";
import { z } from "zod";
import type { Forms, TextForm } from "./normalize.js";

export const RuleSchema = z.object({
  /** Stable id; shown in the block log and used by `disabled_rules`. */
  id: z.string().min(1),
  category: z.enum(MODERATION_CATEGORIES).default("custom"),
  /** A JavaScript regular expression (`u` flag). */
  pattern: z.string().min(1),
  /** Extra flags (`i`, `s`, `m`). Case-insensitive only matters for `raw`; `norm` is lowercase. */
  flags: z
    .string()
    .regex(/^[ims]*$/)
    .default(""),
  /**
   * The text the pattern runs on: `norm` (lowercase, katakana folded to hiragana: write kana
   * in hiragana), `raw` (case kept: ids, addresses) or `squashed` (letters and digits only, look-alikes
   * folded: only for unambiguous words that get spelled out with spaces and symbols).
   */
  form: z.enum(["raw", "norm", "squashed"]).default("norm"),
  /** A match that also matches this is let through (`不能`, `don't`: a refusal is not a request). */
  unless: z.string().optional(),
  /** `false` ships the rule switched off; `enabled_rules` or an owner's copy turns it on. */
  enabled: z.boolean().default(true),
  /** What it is for (the owner reads this when editing). */
  note: z.string().default(""),
});

export type RuleInput = z.input<typeof RuleSchema>;
export type RuleDef = z.output<typeof RuleSchema> & {
  /** Built-in rules only: a match must also pass this (a card number must pass Luhn). */
  test?: (match: string) => boolean;
};

export interface CompiledRule {
  id: string;
  category: ModerationCategory;
  form: TextForm;
  re: RegExp;
  unless: RegExp | null;
  test: ((match: string) => boolean) | null;
}

/** Most matches of one rule examined (a card rule can match many digit runs that fail Luhn). */
const MAX_MATCHES = 24;

/** Characters before a match that the exception may also see (`不要讓小孩看…`). */
const UNLESS_LOOKBEHIND = 14;

export function compileRule(def: RuleDef): CompiledRule {
  const flags = `${[...new Set(`${def.flags}u`)].join("")}g`;
  return {
    id: def.id,
    category: def.category,
    form: def.form,
    re: new RegExp(def.pattern, flags),
    unless: def.unless === undefined ? null : new RegExp(def.unless, "u"),
    test: def.test ?? null,
  };
}

/** Whether `rule` matches `forms`. */
export function ruleMatches(rule: CompiledRule, forms: Forms): boolean {
  const text = forms.form(rule.form);
  rule.re.lastIndex = 0;
  let seen = 0;
  for (let m = rule.re.exec(text); m !== null; m = rule.re.exec(text)) {
    if (m[0] === "") {
      rule.re.lastIndex++;
      continue;
    }
    if (++seen > MAX_MATCHES) return false;
    if (
      rule.unless?.test(text.slice(Math.max(0, m.index - UNLESS_LOOKBEHIND), m.index + m[0].length))
    ) {
      continue;
    }
    if (rule.test && !rule.test(m[0])) continue;
    return true;
  }
  return false;
}
