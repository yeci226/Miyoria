// Her mind loop and autonomy: `GET /api/mind` (status and call counts), `GET
// /api/mind/thoughts` (her thought journal, newest first), `GET /api/mind/approvals` (high-risk
// actions waiting for an owner), `POST /api/mind/approvals/{id}/approve|deny` and `POST
// /api/mind/pause|resume` (the emergency stop: `emergency` says how each of its steps went).
// Changes need the owner-level node `owner.autonomy.approve` (the bearer token has every right).

import type { MindView, PendingApproval, ThoughtSummary } from "@miyoria/contracts/api";
import { ActuatorRegistryKey } from "@miyoria/gate/actions";
import { MindKey } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { type ApiContext, type ApiState, actorOf, toJson } from "./state.js";

const DEFAULT_THOUGHTS = 50;
const MAX_THOUGHTS = 300;

function mindView(state: ApiState): MindView {
  const registry = state.optional(ActuatorRegistryKey);
  const mind = state.optional(MindKey);
  return {
    paused: registry?.paused ?? false,
    running: mind !== undefined,
    stats: mind?.stats() ?? null,
    pending_approvals: registry?.escalations.pending().length ?? 0,
    emergency: registry?.emergency.last ?? null,
  };
}

/** Needs the owner-level node (the route's permission). */
async function answer(
  state: ApiState,
  c: ApiContext,
  id: string,
  approved: boolean,
): Promise<PendingApproval[]> {
  const registry = state.service(ActuatorRegistryKey, "actuator registry");
  const known = registry.escalations.resolve(id, approved, `panel:${actorOf(c)}`);
  await state.audit(c, approved ? "autonomy.approve" : "autonomy.deny", id, {}, known);
  if (!known) throw ApiError.notFound("no such pending approval (answered or expired)");
  return registry.escalations.pending();
}

/** Needs the owner-level node (the route's permission). */
async function setPaused(state: ApiState, c: ApiContext, paused: boolean): Promise<MindView> {
  const registry = state.service(ActuatorRegistryKey, "actuator registry");
  const actor = actorOf(c);
  const report = paused
    ? await registry.emergency.stop(actor, actor)
    : await registry.emergency.resume(actor);
  const ok = report.steps.every((s) => s.ok);
  await state.audit(
    c,
    paused ? "autonomy.pause" : "autonomy.resume",
    "autonomy",
    toJson(report),
    ok,
  );
  return mindView(state);
}

/** `GET /api/mind/thoughts?limit=`: newest first, without what each saw and its reasoning. */
function thoughts(state: ApiState, limitText: string | number | undefined): ThoughtSummary[] {
  const mind = state.service(MindKey, "mind module");
  const raw = Number(limitText ?? DEFAULT_THOUGHTS);
  const limit = Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), 1), MAX_THOUGHTS)
    : DEFAULT_THOUGHTS;
  // What each thought saw and the reasoning are large: `GET /api/mind/thoughts/{id}`.
  return mind.thoughts(limit).map(({ input, reasoning, ...t }) => ({
    ...t,
    has_input: input != null,
    has_reasoning: reasoning != null && reasoning !== "",
  }));
}

/** The mind routes on the route table (`@miyoria/contracts/api`). */
export const mindRpc = {
  status: os.mind.status.handler(({ context }) => mindView(context.state)),
  thoughts: os.mind.thoughts.handler(({ input, context }) =>
    thoughts(context.state, input.query.limit),
  ),
  approvals: os.mind.approvals.handler(({ context }) =>
    context.state.service(ActuatorRegistryKey, "actuator registry").escalations.pending(),
  ),
  approve: os.mind.approve.handler(({ input, context }) =>
    answer(context.state, context.c, input.params.id, true),
  ),
  deny: os.mind.deny.handler(({ input, context }) =>
    answer(context.state, context.c, input.params.id, false),
  ),
  pause: os.mind.pause.handler(({ context }) => setPaused(context.state, context.c, true)),
  resume: os.mind.resume.handler(({ context }) => setPaused(context.state, context.c, false)),
};
