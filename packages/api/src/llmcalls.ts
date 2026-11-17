// The LLM call inspector and her thoughts in full, read-only:
//
// * `GET /api/llm/calls?purpose=&model=&module=&status=&trouble=true&thought=&turn=&since=&until=&q=&limit=&before=`
//   → `{ items, next_cursor, matched, kept }` (newest first; `before` is the last id shown)
// * `GET /api/llm/calls/{id}` → `{ call, detail }` (`detail` `null` once the request and
//   response were dropped from the ring; secrets are redacted)
// * `GET /api/llm/thinking?kind=&reasoned=true&q=&since=&limit=&before=` → `{ items, next_cursor,
//   matched, by_kind, kept }`: calls with their chain of thought and answer, newest first, and
//   how many calls of each kind (`mind`, `chat`, `voice`, ...) match the rest of the filter
// * `GET /api/llm/stats?minutes=` → breakdowns per purpose, model, module and hour, the latency
//   distribution, error kinds, the most expensive and slowest calls, and the prices
// * `GET /api/mind/thoughts/{id}` → one thought with what it saw and its calls

import { LlmRouterKey } from "@miyoria/llm/llm";
import { MindKey } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { clampLimit, countOf } from "./extract.js";

const DEFAULT_CALLS = 100;
const MAX_CALLS_PAGE = 500;
const DEFAULT_THINKING = 30;
const MAX_THINKING_PAGE = 200;

/** `""` means "not given". */
const given = (s: string | undefined) =>
  s === undefined || s.trim() === "" ? undefined : s.trim();

/** The LLM call inspector's routes on the route table (`@miyoria/contracts/api`). */
export const llmCallsRpc = {
  calls: os.llm.calls.handler(({ input, context }) => {
    const q = input.query;
    const log = context.state.service(LlmRouterKey, "LLM router").calls;
    const page = log.list(
      {
        purpose: given(q.purpose),
        model: given(q.model),
        module: given(q.module),
        status: q.status,
        trouble: q.trouble === undefined ? undefined : q.trouble === "true",
        thought: given(q.thought),
        turn: given(q.turn),
        since: given(q.since),
        until: given(q.until),
        q: given(q.q),
      },
      clampLimit(countOf(q.limit), DEFAULT_CALLS, MAX_CALLS_PAGE),
      given(q.before),
    );
    return { ...page, kept: log.size };
  }),
  callDetail: os.llm.callDetail.handler(({ input, context }) => {
    const id = input.params.id;
    const log = context.state.service(LlmRouterKey, "LLM router").calls;
    const call = log.get(id);
    if (!call) throw ApiError.notFound(`no LLM call \`${id}\` (older calls are not kept)`);
    return { call, detail: log.detail(id) };
  }),
  thinking: os.llm.thinking.handler(({ input, context }) => {
    const q = input.query;
    const log = context.state.service(LlmRouterKey, "LLM router").calls;
    const page = log.thinking(
      {
        kind: q.kind,
        reasoned: q.reasoned === undefined ? undefined : q.reasoned === "true",
        since: given(q.since),
        q: given(q.q),
      },
      clampLimit(countOf(q.limit), DEFAULT_THINKING, MAX_THINKING_PAGE),
      given(q.before),
    );
    return { ...page, kept: log.size };
  }),
  stats: os.llm.stats.handler(({ input, context }) => {
    const q = input.query;
    const r = context.state.service(LlmRouterKey, "LLM router");
    const minutes = countOf(q.minutes);
    const since = minutes ? new Date(context.state.now() - minutes * 60_000).toISOString() : null;
    const stats = r.calls.stats(since, { purpose: given(q.purpose), model: given(q.model) });
    return { ...stats, prices: r.prices() };
  }),
};

/** `GET /api/mind/thoughts/{id}`. */
export const thoughtRpc = {
  thought: os.mind.thought.handler(({ input, context }) => {
    const mind = context.state.service(MindKey, "mind module");
    const id = input.params.id;
    const thought = mind.thought?.(id) ?? mind.thoughts(300).find((t) => t.id === id) ?? null;
    if (!thought) throw ApiError.notFound(`no thought \`${id}\` (older ones are condensed)`);
    return thought;
  }),
};
