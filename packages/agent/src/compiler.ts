// Prompt compiler (docs/design/v2-architecture.md §3.5): the one place a turn's prompt is put
// together.
//
//   [system] persona core · speaking style · rules · output format       fixed (prefix cache)
//   [user]   example dialogues (data)                                     fixed (prefix cache)
//   [history]
//   [user]   data blocks (untrusted, source-tagged) + the focus block     per turn
//   [system] situation (time, place, who addressed her) + her own state   per turn (trusted)
//
// The order keeps the provider's prefix cache warm (persona and history only grow at the end);
// the authority split is what §3.5 asks for: her own state (`SELF_BLOCK_KEYS`, rendered from
// the blackboard services in self-block.ts) is a system message she follows, everything else is
// a `⟦資料⟧` block. Contributor sections whose concept the compiler renders itself (`SUPERSEDED`:
// mood, emotion, self, social) are left out, so every concept has one renderer.
//
// Every block has a budget (characters of its body). Over it, a block is cut on its own: a
// `summarize` block keeps whole lines and says how many it left out, a `truncate` block is cut
// short with `…`. When the contributed blocks together exceed the data budget, it is shared
// fairly (`fairShares`: short blocks stay whole, long ones are cut to what is left), so the
// last ones in order do not simply drop.
//
// A compressed copy of the prompt as sent (`SavedPrompt`) is kept per turn (or every n-th turn)
// in `SavedPrompts` (`SavedPromptsKey`) and published as `agent.prompt`.

import type { ChatMessage } from "@miyoria/llm";
import {
  asPromptBlock,
  type CompiledBlock,
  type ContextKey,
  dataBlock,
  escapeData,
  type PromptBlock,
  type PromptSection,
  type ReasoningLevel,
  type SavedPrompt,
  SELF_BLOCK_KEYS,
  serviceKey,
  type TurnId,
} from "@miyoria/types";
import { charCount } from "./util.js";

/**
 * Contributor keys whose concept the compiler renders itself (mood, emotions and inner state,
 * the people present): their sections are ignored (docs/design/v2-implementation.md, item 18).
 * The core modules' contributors of these keys are gone; the list keeps an extension (or an
 * old module) that still contributes one from becoming a second renderer.
 */
export const SUPERSEDED: readonly string[] = ["mood", "emotion", "self", "social"];

/** A block body shorter than this after budgeting is dropped rather than shown as a stub. */
const MIN_BODY = 20;

export interface BudgetOptions {
  /** All blocks together, rendered (marks, labels and separators included). */
  total: number;
  /** Body budget per block key (a block's own `budget_chars` wins). */
  budgets: Readonly<Record<string, number>>;
  defaultBudget: number;
}

export interface Budgeted {
  /** The rendered data blocks, in order. */
  blocks: string[];
  compiled: CompiledBlock[];
}

/** Characters a data block adds around its body (marks, labels, newlines). */
function overhead(block: PromptBlock): number {
  return charCount(dataBlock(block.source, block.title, "x")) - 1;
}

/** Lowest `order` first, ties by key. */
export function ordered<T extends PromptSection>(sections: readonly T[]): T[] {
  return [...sections].sort(
    (a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/**
 * `body` fitted into `budget` characters: whole lines with a count of what was left out
 * (`summarize`) or cut short with `…` (`truncate`).
 */
export function fitBody(
  body: string,
  budget: number,
  overflow: PromptBlock["overflow"],
): { text: string; fate: CompiledBlock["fate"] } {
  const chars = [...body];
  if (chars.length <= budget) return { text: body, fate: "kept" };
  if (budget < MIN_BODY) return { text: "", fate: "dropped" };
  if (overflow === "summarize") {
    const lines = body.split("\n");
    const kept: string[] = [];
    let used = 0;
    for (const [i, line] of lines.entries()) {
      const note = `…(還有 ${lines.length - i - 1} 行略過)`;
      const next = used + charCount(line) + (kept.length > 0 ? 1 : 0);
      if (next + 1 + charCount(note) > budget) break;
      kept.push(line);
      used = next;
    }
    if (kept.length > 0) {
      const left = lines.length - kept.length;
      return { text: `${kept.join("\n")}\n…(還有 ${left} 行略過)`, fate: "summarized" };
    }
  }
  return { text: `${chars.slice(0, budget - 1).join("")}…`, fate: "truncated" };
}

/**
 * Max-min fair shares of `pool` for `wants`: nobody gets more than they want, and what the
 * smaller ones leave is split among the bigger ones (short sections stay whole).
 */
export function fairShares(wants: readonly number[], pool: number): number[] {
  const out = wants.map(() => 0);
  const order = wants.map((_, i) => i).sort((a, b) => (wants[a] as number) - (wants[b] as number));
  let left = Math.max(pool, 0);
  order.forEach((i, n) => {
    const share = Math.floor(left / (order.length - n));
    const give = Math.min(wants[i] as number, share);
    out[i] = give;
    left -= give;
  });
  return out;
}

/**
 * Renders `sections` as data blocks within their budgets (see the file comment). Empty bodies
 * are skipped; the order is `order`, then key.
 */
export function budgetBlocks(sections: readonly PromptSection[], options: BudgetOptions): Budgeted {
  const blocks = ordered(sections.map(asPromptBlock).filter((b) => b.body.trim() !== ""));
  const bodies = blocks.map((b) => escapeData(b.body).trim());
  const wants = blocks.map((b, i) => {
    const budget = b.budget_chars ?? options.budgets[b.key] ?? options.defaultBudget;
    return Math.min(charCount(bodies[i] as string), budget);
  });
  const fixed = blocks.reduce((n, b, i) => n + overhead(b) + (i === 0 ? 0 : 2), 0);
  const pool = Math.max(options.total - fixed, 0);
  const shares = fairShares(wants, pool);
  const out: Budgeted = { blocks: [], compiled: [] };
  blocks.forEach((block, i) => {
    const body = bodies[i] as string;
    const budget = shares[i] as number;
    const fitted = fitBody(body, budget, block.overflow);
    out.compiled.push({
      key: block.key,
      authority: "data",
      source: block.source,
      chars_in: charCount(body),
      chars_out: charCount(fitted.text),
      budget_chars: budget,
      fate: fitted.fate,
    });
    if (fitted.fate !== "dropped") {
      out.blocks.push(dataBlock(block.source, block.title, fitted.text));
    }
  });
  return out;
}

/**
 * Contributed sections as data blocks within `maxChars` in total (`budgetBlocks` with one
 * shared budget); `null` when nothing remains.
 */
export function renderSections(
  sections: readonly PromptSection[],
  maxChars: number,
  budgets: Readonly<Record<string, number>> = {},
  defaultBudget = maxChars,
): string | null {
  const { blocks } = budgetBlocks(sections, { total: maxChars, budgets, defaultBudget });
  return blocks.length === 0 ? null : blocks.join("\n\n");
}

/** One block of her own state (`SELF_BLOCK_KEYS`), rendered by self-block.ts. */
export interface SelfBlock {
  key: (typeof SELF_BLOCK_KEYS)[number];
  body: string;
}

/**
 * Her own state within `maxChars`: every block gets a fair share (`fairShares`) and is cut to
 * whole lines. Returns the bodies in `SELF_BLOCK_KEYS` order.
 */
export function budgetSelf(
  blocks: readonly SelfBlock[],
  maxChars: number,
): { notes: string[]; compiled: CompiledBlock[] } {
  const sorted = [...blocks]
    .filter((b) => b.body.trim() !== "")
    .sort((a, b) => SELF_BLOCK_KEYS.indexOf(a.key) - SELF_BLOCK_KEYS.indexOf(b.key));
  const shares = fairShares(
    sorted.map((b) => charCount(b.body.trim())),
    maxChars,
  );
  const notes: string[] = [];
  const compiled: CompiledBlock[] = [];
  for (const [i, block] of sorted.entries()) {
    const body = block.body.trim();
    const budget = shares[i] as number;
    const fitted = fitBody(body, budget, "summarize");
    compiled.push({
      key: block.key,
      authority: "self",
      source: "self",
      chars_in: charCount(body),
      chars_out: charCount(fitted.text),
      budget_chars: budget,
      fate: fitted.fate,
    });
    if (fitted.fate !== "dropped") notes.push(fitted.text);
  }
  return { notes, compiled };
}

/**
 * Splits contributed sections into the ones the compiler shows (as untrusted data, whatever
 * authority they claim) and the keys it ignores because it renders the concept itself.
 */
export function contributedData(sections: readonly PromptSection[]): {
  data: PromptBlock[];
  superseded: string[];
} {
  const data: PromptBlock[] = [];
  const superseded = new Set<string>();
  for (const section of sections) {
    if (SUPERSEDED.includes(section.key)) {
      superseded.add(section.key);
      continue;
    }
    // Only the compiler renders her own state: a contributor claiming `self` becomes data.
    data.push({ ...asPromptBlock(section), authority: "data" });
  }
  return { data, superseded: [...superseded].sort() };
}

// ---- saved prompts ---------------------------------------------------------------------------

/** `text` shortened to `max` characters, keeping the head and the tail. */
export function squeeze(text: string, max: number): string {
  const chars = [...text];
  if (max <= 0 || chars.length <= max) return text;
  const head = Math.ceil((max * 2) / 3);
  const tail = Math.max(max - head, 0);
  const left = chars.length - head - tail;
  return `${chars.slice(0, head).join("")}\n…(略 ${left} 字)…\n${chars.slice(chars.length - tail).join("")}`;
}

/** The messages as sent, role + text, each squeezed to `maxChars` (images noted). */
export function savedMessages(
  messages: readonly ChatMessage[],
  maxChars: number,
): SavedPrompt["messages"] {
  const out: SavedPrompt["messages"] = [];
  for (const m of messages) {
    if (m.role === "tool") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) => (p.type === "text" ? p.text : "[圖片]")).join("\n");
    out.push({ role: m.role, text: squeeze(text, maxChars) });
  }
  return out;
}

/** The saved prompts of recent turns (in memory, newest last). */
export class SavedPrompts {
  readonly #items: SavedPrompt[] = [];

  constructor(readonly capacity: number) {}

  push(prompt: SavedPrompt): void {
    if (this.capacity <= 0) return;
    this.#items.push(prompt);
    while (this.#items.length > this.capacity) this.#items.shift();
  }

  /** The prompt of `turn` (its last model call), if kept. */
  get(turn: TurnId): SavedPrompt | null {
    const found = this.#items.findLast((p) => p.turn === turn);
    return found ? structuredClone(found) : null;
  }

  /** Newest first, optionally only `context`'s. */
  recent(context: ContextKey | null = null, limit = 20): SavedPrompt[] {
    const out: SavedPrompt[] = [];
    for (let i = this.#items.length - 1; i >= 0 && out.length < limit; i--) {
      const p = this.#items[i] as SavedPrompt;
      if (context === null || sameContext(p.context, context)) out.push(structuredClone(p));
    }
    return out;
  }
}

function sameContext(a: ContextKey, b: ContextKey): boolean {
  return (
    a.platform === b.platform && a.scope === b.scope && a.channel === b.channel && a.kind === b.kind
  );
}

/** Provided by the agent: the compressed prompts of recent turns, for the panel. */
export const SavedPromptsKey = serviceKey<SavedPrompts>("SavedPrompts");

/** Topic of the `custom` event carrying each saved prompt (payload: `SavedPrompt`). */
export const PROMPT_TOPIC = "agent.prompt";

/** A `SavedPrompt` for `turn`. */
export function savedPrompt(init: {
  turn: TurnId;
  context: ContextKey;
  at: string;
  reasoning: ReasoningLevel;
  blocks: CompiledBlock[];
  messages: readonly ChatMessage[];
  maxChars: number;
}): SavedPrompt {
  return {
    turn: init.turn,
    context: { ...init.context },
    at: init.at,
    purpose: "chat",
    reasoning: init.reasoning,
    blocks: init.blocks.map((b) => ({ ...b })),
    messages: savedMessages(init.messages, init.maxChars),
    prompt_tokens: null,
  };
}
