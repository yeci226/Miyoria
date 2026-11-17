// What she is doing and what stopped her, read-only (docs/design/v2-architecture.md §3.1, §3.2):
// `GET /api/activity` (presence, broadcast, activity, scene override: the `ActivityManager`
// snapshot), `GET /api/activity/tasks?limit=` (recent transition tasks, newest first),
// `GET /api/arbiter/ledger?context=&limit=` (what she did or tried, her limits and the topics
// nobody picked up) and `GET /api/arbiter/decisions?limit=&context=&verdict=` (the arbiter's
// recent verdicts with their reasons, since the `api` module started). Changes go through the
// gate (`/api/stage`, `/api/voice`, `/api/game`), not through these routes. On the route table
// (`@miyoria/contracts/api`): `activityRpc` and `arbiterRpc`.

import type { ArbiterDecisionsView, ArbiterDecisionView } from "@miyoria/contracts/api";
import {
  ActivityManagerKey,
  type ArbiterDecision,
  ArbiterKey,
  type ArbiterVerdict,
  type ContextKey,
  contextKeyEquals,
  type LedgerEntry,
  type LedgerView,
} from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { clampLimit, contextParam, countOf } from "./extract.js";
import type { ApiState } from "./state.js";

const DEFAULT_TASKS = 20;
const MAX_TASKS = 200;
const DEFAULT_LEDGER = 50;
const MAX_LEDGER = 300;
const DEFAULT_DECISIONS = 50;
const MAX_DECISIONS = 500;

const VERDICTS: readonly ArbiterVerdict[] = [
  "accepted",
  "merged",
  "deferred",
  "rejected",
  "preempted",
  "expired",
];

function ledgerView(
  state: ApiState,
  query: { context?: string | undefined; limit?: string | undefined },
): LedgerView {
  const arbiter = state.service(ArbiterKey, "arbiter");
  const view = arbiter.ledger(contextParam(query.context));
  const limit = clampLimit(countOf(query.limit), DEFAULT_LEDGER, MAX_LEDGER);
  return { ...view, entries: view.entries.slice(0, limit) };
}

/** Joins each decision with the ledger entry of its impulse (context and summary). */
function decisionViews(
  decisions: readonly ArbiterDecision[],
  entries: readonly LedgerEntry[],
): ArbiterDecisionView[] {
  const byImpulse = new Map<string, LedgerEntry>();
  for (const e of entries)
    if (e.impulse !== null && !byImpulse.has(e.impulse)) byImpulse.set(e.impulse, e);
  return decisions.map((d) => {
    const entry = byImpulse.get(d.impulse);
    return { ...d, context: entry?.context ?? null, summary: entry?.summary ?? null };
  });
}

/** `GET /api/activity` and `GET /api/activity/tasks`. */
export const activityRpc = {
  snapshot: os.activity.snapshot.handler(({ context }) =>
    context.state.service(ActivityManagerKey, "activity manager").snapshot(),
  ),
  tasks: os.activity.tasks.handler(({ input, context }) => {
    const manager = context.state.service(ActivityManagerKey, "activity manager");
    return manager.tasks(clampLimit(countOf(input.query.limit), DEFAULT_TASKS, MAX_TASKS));
  }),
};

/** `GET /api/arbiter/ledger` and `GET /api/arbiter/decisions`. */
export const arbiterRpc = {
  ledger: os.arbiter.ledger.handler(({ input, context }) => ledgerView(context.state, input.query)),
  decisions: os.arbiter.decisions.handler(({ input, context }): ArbiterDecisionsView => {
    const { state } = context;
    const q = input.query;
    const verdict = q.verdict?.trim() ?? "";
    if (verdict !== "" && !(VERDICTS as readonly string[]).includes(verdict)) {
      throw ApiError.badRequest(`\`verdict\` must be one of ${VERDICTS.join(", ")}`);
    }
    const where: ContextKey | null = contextParam(q.context);
    // The ledger is optional here: without the arbiter there are no decisions either, but a
    // trail from before a restart of the module is still worth showing.
    const entries = state.optional(ArbiterKey)?.ledger(null).entries ?? [];
    let views = decisionViews(state.trail.recent(), entries);
    if (verdict !== "") views = views.filter((d) => d.verdict === verdict);
    if (where !== null) {
      views = views.filter((d) => d.context !== null && contextKeyEquals(d.context, where));
    }
    const limit = clampLimit(countOf(q.limit), DEFAULT_DECISIONS, MAX_DECISIONS);
    return { decisions: views.slice(0, limit) };
  }),
};
