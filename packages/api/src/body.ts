// What she is doing and what stopped her, read-only (docs/design/v2-architecture.md §3.1, §3.2):
// `GET /api/activity` (presence, broadcast, activity, scene override: the `ActivityManager`
// snapshot), `GET /api/activity/tasks?limit=` (recent transition tasks, newest first),
// `GET /api/arbiter/ledger?context=&limit=` (what she did or tried, her limits and the topics
// nobody picked up) and `GET /api/arbiter/decisions?limit=&context=&verdict=` (the arbiter's
// recent verdicts with their reasons, since the `api` module started). Changes go through the
// gate (`/api/stage`, `/api/voice`, `/api/game`), not through these routes.

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
import { z } from "zod";
import { ApiError } from "./errors.js";
import { clampLimit, contextParam, readQuery, usizeParam } from "./extract.js";
import { json, type Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";
import type { ArbiterDecisionsView, ArbiterDecisionView } from "./types.js";

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

const TasksQuerySchema = z.object({ limit: usizeParam.optional() });

const LedgerQuerySchema = z.object({
  /** JSON-encoded `ContextKey`. */
  context: z.string().optional(),
  limit: usizeParam.optional(),
});

const DecisionsQuerySchema = z.object({
  limit: usizeParam.optional(),
  /** JSON-encoded `ContextKey`: only impulses the ledger knows were aimed there. */
  context: z.string().optional(),
  verdict: z.string().optional(),
});

function ledgerView(state: ApiState, c: ApiContext): LedgerView {
  const q = readQuery(c, LedgerQuerySchema);
  const arbiter = state.service(ArbiterKey, "arbiter");
  const view = arbiter.ledger(contextParam(q.context));
  const limit = clampLimit(q.limit, DEFAULT_LEDGER, MAX_LEDGER);
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

export function bodyRoutes(state: ApiState): Route[] {
  return [
    {
      method: "GET",
      path: "/api/activity",
      handler: () => json(state.service(ActivityManagerKey, "activity manager").snapshot()),
    },
    {
      method: "GET",
      path: "/api/activity/tasks",
      handler: (c) => {
        const q = readQuery(c, TasksQuerySchema);
        const manager = state.service(ActivityManagerKey, "activity manager");
        return json(manager.tasks(clampLimit(q.limit, DEFAULT_TASKS, MAX_TASKS)));
      },
    },
    { method: "GET", path: "/api/arbiter/ledger", handler: (c) => json(ledgerView(state, c)) },
    {
      method: "GET",
      path: "/api/arbiter/decisions",
      handler: (c) => {
        const q = readQuery(c, DecisionsQuerySchema);
        const verdict = q.verdict?.trim() ?? "";
        if (verdict !== "" && !(VERDICTS as readonly string[]).includes(verdict)) {
          throw ApiError.badRequest(`\`verdict\` must be one of ${VERDICTS.join(", ")}`);
        }
        const context: ContextKey | null = contextParam(q.context);
        // The ledger is optional here: without the arbiter there are no decisions either, but a
        // trail from before a restart of the module is still worth showing.
        const entries = state.optional(ArbiterKey)?.ledger(null).entries ?? [];
        let views = decisionViews(state.trail.recent(), entries);
        if (verdict !== "") views = views.filter((d) => d.verdict === verdict);
        if (context !== null) {
          views = views.filter((d) => d.context !== null && contextKeyEquals(d.context, context));
        }
        const limit = clampLimit(q.limit, DEFAULT_DECISIONS, MAX_DECISIONS);
        const body: ArbiterDecisionsView = { decisions: views.slice(0, limit) };
        return json(body);
      },
    },
  ];
}
