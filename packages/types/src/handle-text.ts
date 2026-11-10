// Keeping per-call reference codes (`u1`, `p2`, `g3`) out of persisted text
// (docs/design/v2-architecture.md §1.6, phase 0 item 13). Writers of lessons, recaps, notes,
// agenda text and memories run their text through `repairHandleText` before storing it; the
// one-time migration of already stored text uses the same function.

import type { Handle } from "./handle.js";
import { ephemeralHandlesIn } from "./handle.js";
import type { JsonValue } from "./json.js";

const CODE = "[upg][0-9]{1,4}";
/** Left of a code: not part of a word (CJK counts as a boundary). */
const LEFT = "(?<![A-Za-z0-9_])";
const RIGHT = "(?![A-Za-z0-9_])";

/** `u1=御坂`: a definition written next to the text that uses the code. */
const DEFINITION = new RegExp(
  `${LEFT}(u[0-9]{1,4})\\s*[=＝]\\s*([^\\s,，、;；。.()（）「」『』\\[\\]=＝]{1,32})`,
  "g",
);
/** `御坂(u1)`: a name followed by its code. */
const NAMED = new RegExp(
  `([^\\s()（）,，、;；。.「」『』\\[\\]]{1,32})\\s*[(（]\\s*(${CODE})\\s*[)）]`,
  "g",
);
const ANY_CODE = new RegExp(`${LEFT}${CODE}${RIGHT}`, "g");
const WHOLE_CODE = new RegExp(`^${CODE}$`);
/** Sentence ends, kept with the sentence they close. */
const SENTENCE_END = /(?<=[。!?！？;；\n])|(?<=\.)(?=\s)/;

export interface RepairOptions {
  /**
   * The handle to put in the one code the text still has after its own definitions were used,
   * when the record is known to be about that person (a lesson's `person`). Without it a code
   * that cannot be resolved from the text is never guessed.
   */
  sole?: Handle | null;
}

/**
 * `text` without per-call codes: `u1=御坂` and `御坂(u1)` become `御坂`, other uses of a code
 * defined in the same text become that name, a single leftover code becomes `options.sole`
 * when given, and sentences with a code that cannot be resolved are dropped. Text without codes
 * is returned unchanged. `null` when nothing is left (the caller drops the record or refuses
 * the write).
 */
export function repairHandleText(text: string, options: RepairOptions = {}): string | null {
  if (ephemeralHandlesIn(text).length === 0) return text;
  const known = new Map<string, Handle>();
  let out = text.replace(DEFINITION, (whole, code: string, name: string) => {
    if (WHOLE_CODE.test(name)) return whole;
    known.set(code, name);
    return name;
  });
  out = out.replace(NAMED, (whole, name: string, code: string) => {
    if (WHOLE_CODE.test(name)) return whole;
    if (code.startsWith("u")) known.set(code, name);
    return name;
  });
  const left = ephemeralHandlesIn(out);
  const first = left[0] ?? "";
  const only = left.length === 1 && first.startsWith("u") && !known.has(first);
  const sole = only && options.sole ? options.sole : null;
  out = out.replace(ANY_CODE, (code) => known.get(code) ?? sole ?? code);
  if (ephemeralHandlesIn(out).length > 0) {
    out = out
      .split(SENTENCE_END)
      .filter((sentence) => ephemeralHandlesIn(sentence).length === 0)
      .join("");
  }
  out = out.trim();
  return out === "" ? null : out;
}

/**
 * `value` with every string repaired by `repairHandleText`: a string that cannot be repaired
 * is dropped from its array / object, an object key that holds a code is dropped with its
 * value. `undefined` when nothing is left of the value itself.
 */
export function repairHandleJson(
  value: JsonValue,
  options: RepairOptions = {},
): JsonValue | undefined {
  if (typeof value === "string") return repairHandleText(value, options) ?? undefined;
  if (Array.isArray(value)) {
    return value.flatMap((v) => {
      const r = repairHandleJson(v, options);
      return r === undefined ? [] : [r];
    });
  }
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, v] of Object.entries(value)) {
      if (ephemeralHandlesIn(key).length > 0) continue;
      const r = repairHandleJson(v as JsonValue, options);
      if (r !== undefined) out[key] = r;
    }
    return out;
  }
  return value;
}

/** True when any string (or key) inside `value` has a per-call code. */
export function hasEphemeralHandle(value: JsonValue): boolean {
  if (typeof value === "string") return ephemeralHandlesIn(value).length > 0;
  if (Array.isArray(value)) return value.some(hasEphemeralHandle);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([k, v]) => ephemeralHandlesIn(k).length > 0 || hasEphemeralHandle(v as JsonValue),
    );
  }
  return false;
}
