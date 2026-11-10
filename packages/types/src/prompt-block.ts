// Prompt compiler contracts (docs/design/v2-architecture.md §3.5): one place builds the prompt,
// one renderer per concept, and the trust boundary drawn the right way:
//
//   [system] persona core · hard rules · output format        fixed (prefix cache)
//   [system] her own state (trusted): mood line, what she is   rendered from the blackboard
//            doing, her policy, relevant goals, Arbiter limits  (Affect / Activity / Ledger)
//   [user]   data block (untrusted, with source labels)        memories, card contents,
//                                                              game chat, web, image captions
//   [history]
//
// Contributors keep implementing `PromptContributor` (prompt.ts). A section they return may be
// a `PromptBlock` (a `PromptSection` with an authority, source and budget); a plain
// `PromptSection` is treated as `data` with the default budget. Only the agent's compiler may
// produce `self` blocks from contributors it trusts (`SELF_BLOCK_KEYS`); anything else that
// claims `self` is demoted to `data`.

import type { TurnId } from "./ids.js";
import type { ContextKey } from "./platform.js";
import type { PromptSection } from "./prompt.js";
import type { ReasoningLevel } from "./reasoning.js";
import type { Timestamp } from "./time.js";

/**
 * `self`: her own state, rendered into the trusted system block (instructions she follows);
 * `data`: anything derived from other people or the outside, rendered inside the untrusted
 * data block with its source label.
 */
export type PromptAuthority = "self" | "data";

/** Section keys the compiler renders as her trusted self-state (one renderer each). */
export const SELF_BLOCK_KEYS = [
  /** Mood line and strongest emotions (`AffectSnapshot.mood_line`, `top`). */
  "self.mood",
  /** What she is doing (`ActivitySnapshot`) and her timed scene override. */
  "self.activity",
  /** Her talkativeness / initiative policy. */
  "self.policy",
  /** Goals relevant here (`GoalAgenda`). */
  "self.goals",
  /** What she did lately and the limits that apply (`LedgerView`). */
  "self.ledger",
  /** Notices waiting for her (task outcomes). */
  "self.notices",
] as const;

export type SelfBlockKey = (typeof SELF_BLOCK_KEYS)[number];

export interface PromptBlock extends PromptSection {
  authority: PromptAuthority;
  /** Provenance shown in the data block (`記憶`, `人物卡`, `遊戲聊天`, `網頁`). */
  source: string;
  /** Characters this section may take (`null`: the compiler's default for its key). */
  budget_chars: number | null;
  /** Over budget: `summarize` (compiler asks for a shorter version) or `truncate`. */
  overflow: "summarize" | "truncate";
}

/** True when `section` carries the v2 block fields. */
export function isPromptBlock(section: PromptSection): section is PromptBlock {
  const s = section as Partial<PromptBlock>;
  return (s.authority === "self" || s.authority === "data") && typeof s.source === "string";
}

/** `section` as a block: plain sections become untrusted `data` with the default budget. */
export function asPromptBlock(section: PromptSection): PromptBlock {
  if (isPromptBlock(section)) return section;
  return {
    ...section,
    authority: "data",
    source: section.key,
    budget_chars: null,
    overflow: "truncate",
  };
}

/** What the compiler did with one block (for the saved prompt and the panel). */
export interface CompiledBlock {
  key: string;
  authority: PromptAuthority;
  source: string;
  /** Characters before and after budgeting. */
  chars_in: number;
  chars_out: number;
  budget_chars: number;
  /** `kept`, `summarized`, `truncated` or `dropped`. */
  fate: "kept" | "summarized" | "truncated" | "dropped";
}

/** A compressed copy of the prompt one turn actually sent (every turn, or sampled). */
export interface SavedPrompt {
  turn: TurnId;
  context: ContextKey;
  at: Timestamp;
  /** The LLM purpose (`chat`) and the reasoning level used. */
  purpose: string;
  reasoning: ReasoningLevel;
  blocks: CompiledBlock[];
  /** The messages as sent, role + text, possibly compressed (long history elided). */
  messages: { role: "system" | "user" | "assistant"; text: string }[];
  /** Prompt tokens as reported by the provider (`null`: not reported). */
  prompt_tokens: number | null;
}
