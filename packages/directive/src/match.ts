// Whether a rule covers an action. Pure, and shared by all three layers, so what `inject` says,
// what `filterTools` removes and what `check` refuses can not drift apart.
//
// A word of `scope.activity` is compared as text with everything the action is about: its
// arguments (after any patch), what the capability maps them to, and what she is doing now. So a
// rule on `diamond` catches a steer whose patch says `diamond_ore`. It is lexical: a rule written
// `鑽石` does not catch `diamond`; the main line writes the word the capability uses.

import { capabilityMatches } from "@miyoria/actions";
import type { ContextKey, DirectiveScope } from "@miyoria/types";

/** The shortest word a rule may name: shorter ones would match almost anything. */
export const MIN_TERM = 2;

/** Argument keys that explain an action and say nothing about what it does. */
const NOT_THE_ACTION = new Set(["why", "cause", "id", "task", "by", "turn"]);

/**
 * What ends something. A rule never gets in the way of stopping, unless it names the capability
 * exactly: 「不要玩 Minecraft」 has to leave `game.stop` open, and `*` must not freeze her in place.
 */
const STOPPING = /\.(?:stop|leave|cancel|leave_room)$/;

export function isStopping(capability: string): boolean {
  return STOPPING.test(capability);
}

/** Case, width, spaces, punctuation and invisible characters do not make a word another word. */
export function normalizeTerm(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\p{C}]+/gu, "");
}

/** The words of `value`: every string in it, and the keys of what it holds. */
export function subjectsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    const term = normalizeTerm(value);
    if (term !== "") out.push(term);
  } else if (Array.isArray(value)) {
    for (const item of value) subjectsOf(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (NOT_THE_ACTION.has(key)) continue;
      subjectsOf(key, out);
      subjectsOf(item, out);
    }
  }
  return out;
}

/** One action as the rules see it. */
export interface RuleAction {
  /** The capability and tool it goes by; empty when nothing runs (a proposal that only talks). */
  names: readonly string[];
  /** Normalized words of what it is about. */
  subjects: readonly string[];
  context: ContextKey | null;
  /** Who it concerns: their handle and account string. */
  people: readonly string[];
  stopping: boolean;
}

function samePlace(a: ContextKey, b: ContextKey): boolean {
  return a.platform === b.platform && a.scope === b.scope && a.channel === b.channel;
}

/** Whether a rule of `scope` applies to `action`. Every field the rule sets has to match. */
export function covers(scope: DirectiveScope, action: RuleAction): boolean {
  const named = scope.capability;
  if (action.stopping && !action.names.includes(named ?? "")) return false;
  if (named !== undefined && !action.names.some((name) => capabilityMatches(named, name))) {
    return false;
  }
  if (scope.activity !== undefined) {
    const term = normalizeTerm(scope.activity);
    if (term === "" || !action.subjects.some((s) => s.includes(term))) return false;
  }
  // An action nobody can place may be anywhere, so it is inside.
  if (scope.context !== undefined && action.context !== null) {
    if (!samePlace(scope.context, action.context)) return false;
  }
  if (scope.person !== undefined) {
    const person = normalizeTerm(scope.person);
    if (!action.people.some((p) => normalizeTerm(p) === person)) return false;
  }
  return true;
}

/** Whether a line of a rule belongs in `context` (`null`: only rules for everywhere). */
export function appliesIn(scope: DirectiveScope, context: ContextKey | null): boolean {
  if (scope.context === undefined) return true;
  return context !== null && samePlace(scope.context, context);
}
