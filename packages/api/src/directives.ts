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
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";

/** Who the request speaks for. */
function by(c: ApiContext): DirectiveActor {
  const principal = c.get("principal");
  if (principal.kind === "token") return { type: "console", actor: actorOf(c) };
  return { type: "account", subject: accountSubject(principal.record.account) };
}

/**
 * The answer of a change. A question is not an error: nothing happened, and it says why (`200`,
 * where a rule added is `201`).
 */
function answer(change: DirectiveChange, reply: { status?: number }) {
  if (change.status === "question") reply.status = 200;
  if (change.status !== "refused") return change;
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

const rules = (state: ApiState) => state.service(DirectivesKey, "directives");

/** The directive routes on the route table (`@miyoria/contracts/api`). */
export const directivesRpc = {
  list: os.directives.list.handler(async ({ input, context }) => {
    const service = rules(context.state);
    const history = input.query.history === "1";
    return { healthy: service.healthy, directives: await service.list({ history }) };
  }),
  add: os.directives.add.handler(async ({ input, context }) => {
    const { body } = input;
    const scope = Object.fromEntries(
      Object.entries(body.scope).filter(([, value]) => value !== undefined),
    );
    const change = await rules(context.state).add({
      by: by(context.c),
      text: body.text,
      effect: body.effect,
      scope,
      minutes: body.minutes,
      source_event: `panel:${actorOf(context.c)}`,
    });
    return answer(change, context.reply);
  }),
  remove: os.directives.remove.handler(async ({ input, context }) => {
    const change = await rules(context.state).remove({
      by: by(context.c),
      id: input.params.id,
      source_event: `panel:${actorOf(context.c)}`,
    });
    return answer(change, context.reply);
  }),
};
