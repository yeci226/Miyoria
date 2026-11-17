// The local layer of output moderation: the rule list, the secrets, and nothing else. No I/O, no
// waiting; one `check` of a typical line takes microseconds (see test/perf.test.ts).

import { type ModerationCategory, maskSecrets } from "@miyoria/types";
import type { ModerationConfig } from "./config.js";
import { DEFAULT_RULES } from "./default-rules.js";
import { allowPattern, Forms } from "./normalize.js";
import { type CompiledRule, compileRule, type RuleDef, ruleMatches } from "./rules.js";

/** A value shorter than this is not protected (it would match half of everything). */
const MIN_SECRET_CHARS = 8;

export interface Hit {
  category: ModerationCategory;
  rule: string;
}

/** Built-in detector ids (they can be listed in `disabled_rules` like any rule). */
export const SECRET_FORMAT_RULE = "secrets.known-format";
export const SECRET_VALUE_RULE = "secrets.protected-value";
export const SECRET_LONG_RULE = "secrets.long-token";

/** Mixed-case letters and digits, 40 or more, no separators of a path or a URL. */
const LONG_TOKEN = /(?<![\w/.-])[A-Za-z0-9_-]{40,}(?![\w/.-])/gu;

function looksLikeToken(candidate: string): boolean {
  return /[a-z]/.test(candidate) && /[A-Z]/.test(candidate) && /\d/.test(candidate);
}

interface Protected {
  raw: string;
  squashed: string;
}

export class OutputGuard {
  readonly rules: readonly CompiledRule[];
  readonly #allow: RegExp[];
  readonly #disabled: ReadonlySet<string>;
  readonly #maxScan: number;
  readonly #secrets = new Set<Protected>();
  /** Rules of `rules` / defaults that could not be used, for the module to log. */
  readonly problems: string[] = [];

  constructor(config: ModerationConfig) {
    this.#disabled = new Set(config.disabled_rules);
    this.#maxScan = config.max_scan_chars;
    this.#allow = config.allow.map(allowPattern);
    this.rules = this.#compile(config);
    for (const value of config.secret_values) this.protect(value);
  }

  #compile(config: ModerationConfig): CompiledRule[] {
    const owned = new Map<string, RuleDef>();
    for (const rule of config.rules) owned.set(rule.id, rule);
    const defs: RuleDef[] = [];
    if (config.defaults) {
      const on = new Set(config.enabled_rules);
      for (const def of DEFAULT_RULES) {
        if (owned.has(def.id) || this.#disabled.has(def.id)) continue;
        if (def.enabled || on.has(def.id)) defs.push(def);
      }
    }
    for (const def of owned.values()) {
      if (def.enabled && !this.#disabled.has(def.id)) defs.push(def);
    }
    const out: CompiledRule[] = [];
    for (const def of defs) {
      try {
        out.push(compileRule(def));
      } catch (error) {
        this.problems.push(
          `rule ${def.id} skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        // An owner's rule that does not compile must not take the shipped one with it.
        const shipped = config.defaults ? DEFAULT_RULES.find((d) => d.id === def.id) : undefined;
        if (shipped && shipped !== def && shipped.enabled && !this.#disabled.has(shipped.id)) {
          out.push(compileRule(shipped));
        }
      }
    }
    return out;
  }

  /** A value that must never be said. Returns its remover. */
  protect(value: string): () => void {
    const raw = value.normalize("NFKC").trim();
    const squashed = raw.replace(/[^\p{L}\p{N}]/gu, "");
    if (squashed.length < MIN_SECRET_CHARS) return () => undefined;
    const entry = { raw, squashed };
    this.#secrets.add(entry);
    return () => {
      this.#secrets.delete(entry);
    };
  }

  /** The first rule `text` breaks, or `null`. */
  check(text: string): Hit | null {
    if (text.trim() === "") return null;
    const forms = new Forms(this.#clip(text), this.#allow);
    const secret = this.#secretHit(forms);
    if (secret !== null) return secret;
    for (const rule of this.rules) {
      if (ruleMatches(rule, forms)) return { category: rule.category, rule: rule.id };
    }
    return null;
  }

  #secretHit(forms: Forms): Hit | null {
    for (const s of this.#secrets) {
      if (forms.raw.includes(s.raw) || forms.rawSquashed.includes(s.squashed)) {
        return { category: "secrets", rule: SECRET_VALUE_RULE };
      }
    }
    if (!this.#disabled.has(SECRET_FORMAT_RULE) && maskSecrets(forms.raw) !== forms.raw) {
      return { category: "secrets", rule: SECRET_FORMAT_RULE };
    }
    if (!this.#disabled.has(SECRET_LONG_RULE)) {
      for (const m of forms.raw.matchAll(LONG_TOKEN)) {
        if (looksLikeToken(m[0])) return { category: "secrets", rule: SECRET_LONG_RULE };
      }
    }
    return null;
  }

  /** A text longer than the scan limit is scanned at both ends. */
  #clip(text: string): string {
    if (text.length <= this.#maxScan) return text;
    const half = Math.floor(this.#maxScan / 2);
    return `${text.slice(0, half)}\n${text.slice(-half)}`;
  }
}
