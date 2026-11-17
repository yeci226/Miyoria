// Reasoning levels (docs/design/v2-architecture.md §3.10): the model stays the same, what
// differs per purpose is whether it reasons and how deeply
// (`[llm.reasoning]`: `purpose = "off" | "low" | "medium" | "high"`).
//
// Reasoning purposes are finer than the router's model purposes (`[llm.purposes]`): the
// `chat_*` purposes all use the `chat` model chain. Providers that only have an on/off switch
// map `low` / `medium` / `high` to "on" and cap the reasoning length with `max_tokens`.

export const REASONING_LEVELS = ["off", "low", "medium", "high"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Whether the provider's reasoning switch is on at `level`. */
export function reasoningEnabled(level: ReasoningLevel): boolean {
  return level !== "off";
}

export const REASONING_PURPOSES = [
  /** Voice replies (real time). */
  "chat_voice",
  /** Ordinary text replies. */
  "chat_text",
  /** Gray-zone checks, translation. */
  "fast",
  /** Her reflections: the daily one and the one on each person. */
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
  fast: "off",
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
