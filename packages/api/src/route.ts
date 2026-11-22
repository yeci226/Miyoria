import type { ApiContext } from "./state.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Handler = (c: ApiContext) => Response | Promise<Response>;

/**
 * Which of the three route groups a route is in (v5-architecture §11.1), which decides the listener
 * it is served on: `admin` only on `[modules.api] bind` (this machine or the tailnet), `public`
 * (the public views and the member pages) on `bind` and on `public_bind` (the tunnel), `host`
 * (a machine joining the cluster) on `bind` only. hostd's control connection itself is the cluster
 * module's own listener (`[modules.cluster] bind`).
 */
export type RouteGroup = "admin" | "public" | "host";

/** Every group, as one listener without `public_bind` serves them. */
export const ALL_GROUPS: ReadonlySet<RouteGroup> = new Set(["admin", "public", "host"]);

/** The group of a route that does not name one: by who may call it. */
export function groupOf(route: Pick<Route, "public" | "member" | "group">): RouteGroup {
  return route.group ?? (route.public || route.member ? "public" : "admin");
}

/**
 * One route. A route is an admin route, which needs the bearer token or an admin session, unless
 * it says otherwise: `public` needs nothing, `member` needs a session of any tier and gets the
 * logged-in person as `c.get("member")`.
 */
export interface Route {
  method: Method;
  path: string;
  handler: Handler;
  public?: boolean;
  member?: boolean;
  /** Default: `public` for a public or member route, else `admin` (`groupOf`). */
  group?: RouteGroup;
}

/** A JSON response (`axum::Json`). */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `204 No Content`. */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** A path parameter (Hono decodes it). */
export function param(c: ApiContext, name: string): string {
  return c.req.param(name) ?? "";
}
