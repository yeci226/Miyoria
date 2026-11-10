// The owner's rules (docs/design/v3-architecture.md §9): `GET /api/directives` (the rules in force;
// `?history=1` adds the ended ones), `POST /api/directives` and `DELETE /api/directives/{id}`.
//
// The panel only says who is asking: a session is its account, resolved like anyone else's, and the
// bearer token has every right. What that person may do is the service's decision, so a moderator
// on the panel can do exactly what a moderator on Discord can.

import {
  accountSubject,
  type DirectiveActor,
  type DirectiveChange,
  DirectivesKey,
} from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { readJson } from "./extract.js";
import { json, param, type Route } from "./route.js";
import { ContextKeySchema } from "./schemas.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";

const AddSchema = z.object({
  text: z.string().min(1),
  effect: z.enum(["deny", "require_approval", "avoid", "prefer"]),
  scope: z
    .object({
      capability: z.string().optional(),
      activity: z.string().optional(),
      context: ContextKeySchema.optional(),
      person: z.string().optional(),
    })
    .prefault({}),
  /** Left out: until revoked for the owner; a moderator has to say. */
  minutes: z.number().int().positive().nullable().default(null),
});

/** Who the request speaks for. */
function by(c: ApiContext): DirectiveActor {
  const principal = c.get("principal");
  if (principal.kind === "token") return { type: "console", actor: actorOf(c) };
  return { type: "account", subject: accountSubject(principal.record.account) };
}

/** The HTTP answer of a change. A question is not an error: nothing happened, and it says why. */
function answer(change: DirectiveChange, status: number): Response {
  if (change.status !== "refused") return json(change, change.status === "question" ? 200 : status);
  switch (change.reason) {
    case "authority":
      throw new ApiError(403, change.detail);
    case "not_found":
      throw ApiError.notFound(change.detail);
    case "store":
      throw ApiError.unavailable(change.detail);
    default:
      throw new ApiError(400, change.detail);
  }
}

export function directiveRoutes(state: ApiState): Route[] {
  const rules = () => state.service(DirectivesKey, "directives");
  return [
    {
      method: "GET",
      path: "/api/directives",
      handler: async (c) => {
        const service = rules();
        const history = c.req.query("history") === "1";
        return json({ healthy: service.healthy, directives: await service.list({ history }) });
      },
    },
    {
      method: "POST",
      path: "/api/directives",
      handler: async (c) => {
        const body = await readJson(c, AddSchema);
        const scope = Object.fromEntries(
          Object.entries(body.scope).filter(([, value]) => value !== undefined),
        );
        const change = await rules().add({
          by: by(c),
          text: body.text,
          effect: body.effect,
          scope,
          minutes: body.minutes,
          source_event: `panel:${actorOf(c)}`,
        });
        return answer(change, 201);
      },
    },
    {
      method: "DELETE",
      path: "/api/directives/:id",
      handler: async (c) => {
        const change = await rules().remove({
          by: by(c),
          id: param(c, "id"),
          source_event: `panel:${actorOf(c)}`,
        });
        return answer(change, 200);
      },
    },
  ];
}
