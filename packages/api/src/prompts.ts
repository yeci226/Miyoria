// What she was told and how the turn ended, read-only (docs/design/v2-architecture.md §3.5):
// `GET /api/prompts?context=&limit=` (the saved, compressed prompts of recent turns without
// their text, newest first), `GET /api/prompts/{turn}` (one in full: blocks with what the
// budget did to each, and the messages as sent) and `GET
// /api/turns/outcomes?context=&outcome=&limit=` (how turns ended: sent, silence, cancelled and by
// whom, error; newest first). The panel puts these next to the decision trace of the same turn.

import { SavedPromptsKey } from "@miyoria/agent";
import { DecisionLogKey } from "@miyoria/store";
import type { SavedPrompt, TurnOutcomeRecord } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { clampLimit, contextParam, readQuery, usizeParam } from "./extract.js";
import { json, param, type Route } from "./route.js";
import type { ApiState } from "./state.js";
import type { PromptSummary, TurnOutcomeKind } from "./types.js";

const DEFAULT_PROMPTS = 30;
const MAX_PROMPTS = 200;
const DEFAULT_OUTCOMES = 50;
const MAX_OUTCOMES = 500;

const OUTCOME_KINDS: readonly TurnOutcomeKind[] = ["sent", "silence", "cancelled", "error"];

const PromptsQuerySchema = z.object({
  /** JSON-encoded `ContextKey`. */
  context: z.string().optional(),
  limit: usizeParam.optional(),
});

const OutcomesQuerySchema = z.object({
  context: z.string().optional(),
  /** `sent`, `silence`, `cancelled` or `error`. */
  outcome: z.string().optional(),
  limit: usizeParam.optional(),
});

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

export function promptRoutes(state: ApiState): Route[] {
  return [
    {
      method: "GET",
      path: "/api/prompts",
      handler: (c) => {
        const q = readQuery(c, PromptsQuerySchema);
        const saved = state.service(SavedPromptsKey, "prompt archive");
        const limit = clampLimit(q.limit, DEFAULT_PROMPTS, MAX_PROMPTS);
        return json(saved.recent(contextParam(q.context), limit).map(summarizePrompt));
      },
    },
    {
      method: "GET",
      path: "/api/prompts/:turn",
      handler: (c) => {
        const saved = state.service(SavedPromptsKey, "prompt archive");
        const prompt = saved.get(param(c, "turn"));
        if (!prompt) throw ApiError.notFound("no saved prompt for that turn (too old or not kept)");
        return json(prompt);
      },
    },
    {
      method: "GET",
      path: "/api/turns/outcomes",
      handler: async (c) => {
        const q = readQuery(c, OutcomesQuerySchema);
        const kind = q.outcome?.trim() ?? "";
        if (kind !== "" && !(OUTCOME_KINDS as readonly string[]).includes(kind)) {
          throw ApiError.badRequest(`\`outcome\` must be one of ${OUTCOME_KINDS.join(", ")}`);
        }
        const log = state.service(DecisionLogKey, "decision log");
        if (log.recentOutcomes === undefined) {
          throw ApiError.unavailable("this decision log does not keep turn outcomes");
        }
        const limit = clampLimit(q.limit, DEFAULT_OUTCOMES, MAX_OUTCOMES);
        const context = contextParam(q.context);
        // Filtering happens here, so ask for enough to still fill `limit` afterwards.
        const rows: TurnOutcomeRecord[] = await log.recentOutcomes(
          state.profile(),
          context,
          kind === "" ? limit : MAX_OUTCOMES,
        );
        const kept = kind === "" ? rows : rows.filter((r) => r.outcome.type === kind);
        return json(kept.slice(0, limit));
      },
    },
  ];
}
