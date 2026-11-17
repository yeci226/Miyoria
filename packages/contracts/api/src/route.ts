// What every route declaration starts from: the oRPC contract builder with the metadata the
// server's shell reads (who may call the route, which permission it needs) and the "detailed"
// input structure, so a handler gets `{ params, query, body }` apart instead of one merged object.

import {
  type AnySchema,
  type EventIteratorSchemaDetails,
  getEventIteratorSchemaDetails,
  isContractProcedure,
  oc,
} from "@orpc/contract";
import { z } from "zod";

/**
 * Who may call a route.
 *
 * * `admin`: the bearer token, or an admin session by cookie. A change (anything but `GET`) by
 *   session also needs the `X-Miyoria-Request: 1` header and `admin.panel.write`.
 * * `member`: a session of any tier, by cookie only; the bearer token opens nothing here. The
 *   answer is never cached and never carries internal error text.
 * * `public`: anyone.
 */
export type Audience = "admin" | "member" | "public";

export interface RouteMeta {
  audience: Audience;
  /** A node the session's account must also hold (`null`: none). The bearer token holds all. */
  permission: string | null;
  /** What a session without the permission is told, in place of `this needs <node>`. */
  refusal?: string;
  /**
   * A member route that counts against the member's rate limit (`429` when they ask too much). The
   * server's shell applies it before the body is read, so a request with a bad body counts too.
   */
  limited?: boolean;
}

/**
 * The start of every declaration. Each route still states its own metadata with `.meta()`; the
 * default here only decides what a route that forgot is: an admin route (closed).
 */
export const route = oc
  .$meta<RouteMeta>({ audience: "admin", permission: null })
  .$route({ inputStructure: "detailed" });

/** The metadata of the route at `path` in `router` (`["persona", "set"]`), `null` for none. */
export function routeMeta(router: object, path: readonly string[]): RouteMeta | null {
  let at: unknown = router;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return null;
    at = (at as Record<string, unknown>)[key];
  }
  return isContractProcedure(at) ? (at["~orpc"].meta as RouteMeta) : null;
}

/**
 * The schemas of an event stream route's output (`eventIterator(yields, returns)`): what each
 * event is, and what the stream ends with. `undefined` for a route that answers once.
 */
export function eventRouteSchemas(
  output: AnySchema | undefined,
): EventIteratorSchemaDetails | undefined {
  return getEventIteratorSchemaDetails(output);
}

/**
 * The `Idempotency-Key` header of a member route that spends: the same key answers what it
 * answered first. Only the header is declared; its length and characters are checked by the
 * handler, which answers 400 `invalid Idempotency-Key` as it always has. Without one the server
 * makes a fresh key (no retry protection).
 */
export const IdempotencyHeaders = z.object({ "idempotency-key": z.string().optional() });
