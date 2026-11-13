// The LLM call inspector and her thoughts in full, read-only:
//
// * `GET /api/llm/calls?purpose=&model=&module=&status=&trouble=1&thought=&turn=&since=&until=&q=&limit=&before=`
//   → `{ items, next_cursor, matched, kept }` (newest first; `before` is the last id shown)
// * `GET /api/llm/calls/{id}` → `{ call, detail }` (`detail` `null` once the request and
//   response were dropped from the ring; secrets are redacted)
// * `GET /api/llm/thinking?kind=&reasoned=1&q=&since=&limit=&before=` → `{ items, next_cursor,
//   matched, by_kind, kept }`: calls with their chain of thought and answer, newest first, and
//   how many calls of each kind (`mind`, `chat`, `voice`, ...) match the rest of the filter
// * `GET /api/llm/stats?minutes=` → breakdowns per purpose, model, module and hour, the latency
//   distribution, error kinds, the most expensive and slowest calls, and the prices
// * `GET /api/mind/thoughts/{id}` → one thought with what it saw and its calls

import { CALL_KINDS, LlmRouterKey } from "@miyoria/llm";
import { MindKey } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { boolParam, readQuery, usizeParam } from "./extract.js";
import { json, param, type Route } from "./route.js";
import type { ApiState } from "./state.js";

const DEFAULT_CALLS = 100;
const MAX_CALLS_PAGE = 500;

const CallsQuerySchema = z.object({
  purpose: z.string().optional(),
  model: z.string().optional(),
  module: z.string().optional(),
  status: z.enum(["streaming", "ok", "error", "aborted"]).optional(),
  trouble: boolParam.optional(),
  thought: z.string().optional(),
  turn: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  q: z.string().optional(),
  limit: usizeParam.optional(),
  before: z.string().optional(),
});

const ThinkingQuerySchema = z.object({
  kind: z.enum(CALL_KINDS).optional(),
  reasoned: boolParam.optional(),
  since: z.string().optional(),
  q: z.string().optional(),
  limit: usizeParam.optional(),
  before: z.string().optional(),
});

const DEFAULT_THINKING = 30;
const MAX_THINKING_PAGE = 200;

const StatsQuerySchema = z.object({
  minutes: usizeParam.optional(),
  purpose: z.string().optional(),
  model: z.string().optional(),
});

/** `""` means "not given". */
const given = (s: string | undefined) =>
  s === undefined || s.trim() === "" ? undefined : s.trim();

export function llmCallRoutes(state: ApiState): Route[] {
  const router = () => state.service(LlmRouterKey, "LLM router");
  return [
    {
      method: "GET",
      path: "/api/llm/calls",
      handler: (c) => {
        const q = readQuery(c, CallsQuerySchema);
        const log = router().calls;
        const page = log.list(
          {
            purpose: given(q.purpose),
            model: given(q.model),
            module: given(q.module),
            status: q.status,
            trouble: q.trouble,
            thought: given(q.thought),
            turn: given(q.turn),
            since: given(q.since),
            until: given(q.until),
            q: given(q.q),
          },
          Math.min(Math.max(q.limit ?? DEFAULT_CALLS, 1), MAX_CALLS_PAGE),
          given(q.before),
        );
        return json({ ...page, kept: log.size });
      },
    },
    {
      method: "GET",
      path: "/api/llm/calls/:id",
      handler: (c) => {
        const id = param(c, "id");
        const log = router().calls;
        const call = log.get(id);
        if (!call) throw ApiError.notFound(`no LLM call \`${id}\` (older calls are not kept)`);
        return json({ call, detail: log.detail(id) });
      },
    },
    {
      method: "GET",
      path: "/api/llm/thinking",
      handler: (c) => {
        const q = readQuery(c, ThinkingQuerySchema);
        const log = router().calls;
        const page = log.thinking(
          { kind: q.kind, reasoned: q.reasoned, since: given(q.since), q: given(q.q) },
          Math.min(Math.max(q.limit ?? DEFAULT_THINKING, 1), MAX_THINKING_PAGE),
          given(q.before),
        );
        return json({ ...page, kept: log.size });
      },
    },
    {
      method: "GET",
      path: "/api/llm/stats",
      handler: (c) => {
        const q = readQuery(c, StatsQuerySchema);
        const r = router();
        const since = q.minutes ? new Date(state.now() - q.minutes * 60_000).toISOString() : null;
        const stats = r.calls.stats(since, { purpose: given(q.purpose), model: given(q.model) });
        return json({ ...stats, prices: r.prices() });
      },
    },
    {
      method: "GET",
      path: "/api/mind/thoughts/:id",
      handler: (c) => {
        const mind = state.service(MindKey, "mind module");
        const id = param(c, "id");
        const thought = mind.thought?.(id) ?? mind.thoughts(300).find((t) => t.id === id) ?? null;
        if (!thought) throw ApiError.notFound(`no thought \`${id}\` (older ones are condensed)`);
        return json(thought);
      },
    },
  ];
}
