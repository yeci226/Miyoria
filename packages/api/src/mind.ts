// Her mind loop and autonomy: `GET /api/mind` (status and call counts), `GET
// /api/mind/thoughts` (her thought journal, newest first), `GET /api/mind/approvals` (high-risk
// actions waiting for an owner), `POST /api/mind/approvals/{id}/approve|deny` and `POST
// /api/mind/pause|resume` (the emergency stop: `emergency` says how each of its steps went).
// Changes need the owner-level node `owner.autonomy.approve` (the bearer token has every right).

import { ActuatorRegistryKey, NODE_APPROVE } from "@miyoria/actions";
import { AuthorizerKey, MindKey } from "@miyoria/types";
import { ApiError } from "./errors.js";
import { json, param, type Route } from "./route.js";
import { type ApiContext, type ApiState, actorOf, toJson } from "./state.js";
import type { MindView } from "./types.js";

const DEFAULT_THOUGHTS = 50;
const MAX_THOUGHTS = 300;

/** The request's account must hold the owner-level node (the token always may). */
function requireOwner(state: ApiState, c: ApiContext): void {
  const principal = c.get("principal");
  if (principal.kind === "token") return;
  const authorizer = state.optional(AuthorizerKey);
  if (!authorizer?.allows(principal.record.account, NODE_APPROVE)) {
    throw new ApiError(403, `this needs \`${NODE_APPROVE}\``);
  }
}

function mindView(state: ApiState): MindView {
  const registry = state.optional(ActuatorRegistryKey);
  const mind = state.optional(MindKey);
  return {
    paused: registry?.paused ?? false,
    running: mind !== undefined,
    accepting: mind?.accepting ?? false,
    stats: mind?.stats() ?? null,
    pending_approvals: registry?.escalations.pending().length ?? 0,
    emergency: registry?.emergency.last ?? null,
  };
}

async function answer(state: ApiState, c: ApiContext, approved: boolean): Promise<Response> {
  requireOwner(state, c);
  const registry = state.service(ActuatorRegistryKey, "actuator registry");
  const id = param(c, "id");
  const known = registry.escalations.resolve(id, approved, `panel:${actorOf(c)}`);
  await state.audit(c, approved ? "autonomy.approve" : "autonomy.deny", id, {}, known);
  if (!known) throw ApiError.notFound("no such pending approval (answered or expired)");
  return json(registry.escalations.pending());
}

async function setPaused(state: ApiState, c: ApiContext, paused: boolean): Promise<Response> {
  requireOwner(state, c);
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
  return json(mindView(state));
}

export function mindRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/mind", handler: () => json(mindView(state)) },
    {
      method: "GET",
      path: "/api/mind/thoughts",
      handler: (c) => {
        const mind = state.service(MindKey, "mind module");
        const raw = Number(c.req.query("limit") ?? DEFAULT_THOUGHTS);
        const limit = Number.isFinite(raw)
          ? Math.min(Math.max(Math.trunc(raw), 1), MAX_THOUGHTS)
          : DEFAULT_THOUGHTS;
        // What each thought saw and the reasoning are large: `GET /api/mind/thoughts/{id}`.
        return json(
          mind.thoughts(limit).map(({ input: _input, reasoning, ...t }) => ({
            ...t,
            has_input: _input != null,
            has_reasoning: reasoning != null && reasoning !== "",
          })),
        );
      },
    },
    {
      method: "GET",
      path: "/api/mind/approvals",
      handler: () =>
        json(state.service(ActuatorRegistryKey, "actuator registry").escalations.pending()),
    },
    {
      method: "POST",
      path: "/api/mind/approvals/:id/approve",
      handler: (c) => answer(state, c, true),
    },
    {
      method: "POST",
      path: "/api/mind/approvals/:id/deny",
      handler: (c) => answer(state, c, false),
    },
    { method: "POST", path: "/api/mind/pause", handler: (c) => setPaused(state, c, true) },
    { method: "POST", path: "/api/mind/resume", handler: (c) => setPaused(state, c, false) },
  ];
}
