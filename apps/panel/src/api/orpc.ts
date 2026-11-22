// The route table's typed client (`@miyoria/contracts/api`) and its TanStack Query helpers. Every
// JSON route is called through this; `endpoints.ts` keeps the few that are not JSON.
//
// The types come from the contract; at run time the client needs only each route's method, path
// and metadata, so it loads the table without its schemas (`schema/api.routes.json`, written by
// `pnpm contracts:gen`) and zod stays out of the bundle. The panel does not check responses.
//
// oRPC's link builds each request from the table (method, path, query, JSON body) and decodes the
// answer (JSON, or an event stream as an async iterator of its events). The request itself goes
// through `ApiClient.send`, so it carries the same headers as every other call (the bearer token
// unless the route is open to non-admins, the CSRF header, same-origin credentials) and fails
// with the same `ApiError` kinds.

import type { ApiContract, ApiRpc, RouteMeta } from "@miyoria/contracts/api";
import routes from "@miyoria/contracts/schema/api.routes.json";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { ApiClient } from "./http";

/** The route table without its schemas: what the link reads of the contract. */
const table = routes.contract as unknown as ApiContract;

/** The link builds absolute URLs; only their path and query are used, under the configured base. */
const PLACEHOLDER = "http://core.invalid";

/** The metadata of the route at `path` (`["persona", "set"]`). */
function metaAt(path: readonly string[]): RouteMeta | undefined {
  let at: unknown = table;
  for (const key of path) at = (at as Record<string, unknown> | undefined)?.[key];
  return (at as { "~orpc"?: { meta: RouteMeta } } | undefined)?.["~orpc"]?.meta;
}

export function createRpc(client: ApiClient): ApiRpc {
  const link = new OpenAPILink(table, {
    url: PLACEHOLDER,
    fetch: async (request, _init, options, path) => {
      const url = new URL(request.url);
      const method = request.method;
      const json = method === "GET" || method === "HEAD" ? "" : await request.text();
      const isPublic = metaAt(path)?.audience !== "admin";
      // The one header a route declares in its input: a spend's key, one per click. An event
      // stream followed again says which event it saw last.
      const headers: Record<string, string> = {};
      const key = request.headers.get("idempotency-key");
      if (key) headers["Idempotency-Key"] = key;
      const lastEventId = request.headers.get("last-event-id");
      if (lastEventId) headers["Last-Event-ID"] = lastEventId;
      // A stream's watchdog hears every piece that arrives (`{ context: { onActivity } }`).
      const onChunk = (options.context as { onActivity?: () => void } | undefined)?.onActivity;
      const opts = { signal: request.signal, public: isPublic, headers, ...(onChunk ? { onChunk } : {}) };
      return client.send(method, url.pathname + url.search, opts, json === "" ? undefined : json);
    },
  });
  return createORPCClient(link);
}

/** `useQuery(q.persona.list.queryOptions())`, `useMutation(q.persona.set.mutationOptions())`. */
export function createQueries(rpc: ApiRpc) {
  return createTanstackQueryUtils(rpc);
}

export type RpcQueries = ReturnType<typeof createQueries>;
