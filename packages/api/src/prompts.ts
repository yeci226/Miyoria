// What she was told and how the turn ended, read-only (docs/design/v2-architecture.md §3.5):
// `GET /api/prompts?context=&limit=` (the saved, compressed prompts of recent turns without
// their text, newest first), `GET /api/prompts/{turn}` (one in full: blocks with what the
// budget did to each, and the messages as sent) and `GET
// /api/turns/outcomes?context=&outcome=&limit=` (how turns ended: sent, silence, cancelled and by
// whom, error; newest first). The panel puts these next to the decision trace of the same turn.

import { SavedPromptsKey } from "@miyoria/brain/agent";
import type { PromptSummary, TurnOutcomeKind } from "@miyoria/contracts/api";
import { DecisionLogKey } from "@miyoria/store";
import type { SavedPrompt, TurnOutcomeRecord } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { clampLimit, contextParam, countOf } from "./extract.js";

const DEFAULT_PROMPTS = 30;
const MAX_PROMPTS = 200;
const DEFAULT_OUTCOMES = 50;
const MAX_OUTCOMES = 500;

const OUTCOME_KINDS: readonly TurnOutcomeKind[] = ["sent", "silence", "cancelled", "error"];

/** A saved prompt without its blocks and message texts. */
export function summarizePrompt(p: SavedPrompt): PromptSummary {
  return {
    turn: p.turn,
    context: p.context,
    at: p.at,
    purpose: p.purpose,
    reasoning: p.reasoning,
    prompt_tokens: p.prompt_tokens,
    blocks: p.blocks.length,
    messages: p.messages.length,
    chars: p.messages.reduce((n, m) => n + m.text.length, 0),
  };
}

/** The saved prompts on the route table. */
export const promptsRpc = {
  list: os.prompts.list.handler(({ input, context }) => {
    const q = input.query;
    const saved = context.state.service(SavedPromptsKey, "prompt archive");
    const limit = clampLimit(countOf(q.limit), DEFAULT_PROMPTS, MAX_PROMPTS);
    return saved.recent(contextParam(q.context), limit).map(summarizePrompt);
  }),
  get: os.prompts.get.handler(({ input, context }) => {
    const saved = context.state.service(SavedPromptsKey, "prompt archive");
    const prompt = saved.get(input.params.turn);
    if (!prompt) throw ApiError.notFound("no saved prompt for that turn (too old or not kept)");
    return prompt;
  }),
};

/** `GET /api/turns/outcomes`, on the route table (it joins the `turns` group). */
export const outcomesRpc = {
  outcomes: os.turns.outcomes.handler(async ({ input, context }) => {
    const { state } = context;
    const q = input.query;
    const kind = q.outcome?.trim() ?? "";
    if (kind !== "" && !(OUTCOME_KINDS as readonly string[]).includes(kind)) {
      throw ApiError.badRequest(`\`outcome\` must be one of ${OUTCOME_KINDS.join(", ")}`);
    }
    const log = state.service(DecisionLogKey, "decision log");
    if (log.recentOutcomes === undefined) {
      throw ApiError.unavailable("this decision log does not keep turn outcomes");
    }
    const limit = clampLimit(countOf(q.limit), DEFAULT_OUTCOMES, MAX_OUTCOMES);
    const where = contextParam(q.context);
    // Filtering happens here, so ask for enough to still fill `limit` afterwards.
    const rows: TurnOutcomeRecord[] = await log.recentOutcomes(
      state.profile(),
      where,
      kind === "" ? limit : MAX_OUTCOMES,
    );
    const kept = kind === "" ? rows : rows.filter((r) => r.outcome.type === kind);
    return kept.slice(0, limit);
  }),
};
