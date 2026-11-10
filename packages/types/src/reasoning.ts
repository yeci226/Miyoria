// Reasoning levels (docs/design/v2-architecture.md §3.10): the model stays the same, what
// differs per purpose is whether it reasons and how deeply. Replaces the on/off
// `[llm.thinking]` with `[llm.reasoning]` (`purpose = "off" | "low" | "medium" | "high"`).
//
// Reasoning purposes are finer than the router's model purposes (`[llm.purposes]`): the
// `chat_*` purposes all use the `chat` model chain. Providers that only have an on/off switch
// map `low` / `medium` / `high` to "on" and cap the reasoning length with `max_tokens`.

export const REASONING_LEVELS = ["off", "low", "medium", "high"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

/** Whether the provider's reasoning switch is on at `level`. */
export function reasoningEnabled(level: ReasoningLevel): boolean {
  return level !== "off";
}

export const REASONING_PURPOSES = [
  /** Voice replies (real time). */
  "chat_voice",
  /** Ordinary text replies. */
  "chat_text",
  /** Turns she starts herself that may use tools. */
  "chat_intent",
  /** A call of the main line that reads what her tools brought back in the same turn (v4 §4.4). */
  "chat_tools",
  /** A text reply to someone who asked her something in earnest (v4 §4.4). */
  "chat_question",
  /** Gray-zone checks, translation. */
  "fast",
  "appraise",
  "plan",
  /** The first Plan of the day (her day plan). */
  "plan_daily",
  "reflect",
  /** Self-review of high-risk actions. */
  "review",
  /** Conversation folding, memory curation. */
  "summarizer",
  /** A task of the work lane: many steps with tools, off the Floor (v4 §4.3, §4.4). */
  "work",
] as const;

export type ReasoningPurpose = (typeof REASONING_PURPOSES)[number];

/** Defaults of `[llm.reasoning]` (§3.10). Unlisted purposes are `off`. */
export const DEFAULT_REASONING: Readonly<Record<ReasoningPurpose, ReasoningLevel>> = {
  chat_voice: "off",
  chat_text: "off",
  chat_intent: "low",
  chat_tools: "low",
  chat_question: "low",
  fast: "off",
  appraise: "low",
  plan: "medium",
  plan_daily: "high",
  reflect: "high",
  review: "medium",
  summarizer: "off",
  // §4.3: the same model, thinking hard; §4.4 puts the work lane at medium to high.
  work: "high",
};

/** The level for `purpose` from a `[llm.reasoning]` table, else the default, else `off`. */
export function reasoningFor(
  purpose: string,
  table: Readonly<Record<string, ReasoningLevel>> = {},
): ReasoningLevel {
  const set = table[purpose];
  if (set !== undefined) return set;
  return (DEFAULT_REASONING as Readonly<Record<string, ReasoningLevel>>)[purpose] ?? "off";
}
