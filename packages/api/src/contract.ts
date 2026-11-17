// The route table (`@miyoria/contracts/api`), ready to be implemented: a route group's file writes
// `os.<group>.<route>.handler(({ input, context }) => value)` next to the code it calls, and
// `rpc.ts` puts the groups together and serves them.

import { contract } from "@miyoria/contracts/api";
import { implement } from "@orpc/server";
import type { ResponseHeadersPluginContext } from "@orpc/server/plugins";
import type { ApiContext, ApiState } from "./state.js";

/** What a handler gets besides its input. */
export interface RpcContext extends ResponseHeadersPluginContext {
  /** The Hono request: the principal or member is already on it. */
  c: ApiContext;
  state: ApiState;
  /** What the call threw, kept so the shell answers with the error path the old routes use. */
  failure: { error?: unknown };
  /** A handler that answers with another status than the route's `successStatus` says so here. */
  reply: { status?: number };
}

export const os = implement(contract).$context<RpcContext>();
