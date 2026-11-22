// Router, authentication and the fallback. The route groups live in sibling modules.

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import { AuthorizerKey } from "@miyoria/types";
import { Hono } from "hono";
import { dataRoutes } from "./data.js";
import { ApiError, NO_SUCH_ENDPOINT } from "./errors.js";
import { filesPassRoute } from "./files/routes.js";
import { githubLinkRoutes } from "./github-link.js";
import { karaokeRoutes } from "./karaoke-routes.js";
import { landingRoutes } from "./landing.js";
import { liveRoutes } from "./live.js";
import { memberRoutes } from "./member.js";
import { metricsRoutes } from "./metrics.js";
import * as oauth from "./oauth.js";
import { ogRoutes, rewriteHtml } from "./og.js";
import { servePanel, staticAccess } from "./panel.js";
import { tooMany } from "./public.js";
import { ALL_GROUPS, groupOf, type Route, type RouteGroup } from "./route.js";
import { type ResponseCheck, rpcRoutes } from "./rpc.js";
import {
  CSRF_HEADER,
  cookieToken,
  hasCsrfHeader,
  isSafeMethod,
  PANEL_WRITE,
  type Principal,
  type SessionRecord,
  tokenMatches,
} from "./session.js";
import type { ApiContext, ApiEnv, ApiState } from "./state.js";

const log = getLogger("api.server");

function unauthorized(message: string): ApiError {
  return new ApiError(401, message);
}

/**
 * Accepts the bearer token or (with Discord login configured) a session cookie. An
 * `Authorization` header, when present, must be the token; cookies are not consulted then.
 */
async function authenticate(state: ApiState, c: ApiContext): Promise<Principal> {
  const auth = state.auth;
  const header = c.req.header("authorization");
  if (header !== undefined) {
    // Wrong tokens are counted per address; a locked-out address is not even checked.
    const limiter = auth.limiter;
    const client = limiter === undefined ? "" : state.publicSide.client(c);
    const now = state.now();
    const wait = limiter?.blocked(client, now) ?? null;
    if (wait !== null) throw ApiError.tooMany(wait);
    const ok = header.startsWith("Bearer ") && tokenMatches(auth.token, header.slice(7));
    if (!ok) {
      const locked = limiter?.failed(client, now) ?? null;
      if (locked !== null) {
        log.warn({ client }, "too many wrong admin tokens: this address is locked out for a while");
        throw ApiError.tooMany(locked);
      }
      throw unauthorized("missing or invalid bearer token");
    }
    limiter?.succeeded(client);
    return { kind: "token" };
  }
  const token = auth.oauth ? cookieToken(oauth.requestCookies(c)) : null;
  if (token === null) throw unauthorized("missing or invalid bearer token");
  // Sessions only count while Discord login is configured.
  const found = await auth.sessions.lookup(
    state.optional(SettingsStoreKey),
    state.optional(AuthorizerKey),
    token,
  );
  if (!found) throw unauthorized("session expired or invalid");
  // Both have to hold: the session was opened as admin, and the account still has the permission.
  if (found.record.tier !== "admin" || !found.access.panel) {
    throw unauthorized("this account no longer has panel access");
  }
  if (!isSafeMethod(c.req.method)) {
    if (!hasCsrfHeader(c.req.header(CSRF_HEADER))) {
      throw new ApiError(403, `cookie-authenticated changes need the \`${CSRF_HEADER}: 1\` header`);
    }
    if (!found.access.write) {
      throw new ApiError(403, `this account may only look (changes need \`${PANEL_WRITE}\`)`);
    }
  }
  return { kind: "session", record: found.record, write: found.access.write };
}

/**
 * A member route's caller: any live session, by cookie only. The bearer token is nobody, so it
 * opens nothing here. Who the session belongs to is all a member route ever learns.
 */
async function authenticateMember(state: ApiState, c: ApiContext): Promise<SessionRecord> {
  const auth = state.auth;
  const token = auth.oauth ? cookieToken(oauth.requestCookies(c)) : null;
  if (token === null) throw unauthorized("not logged in");
  const found = await auth.sessions.lookup(
    state.optional(SettingsStoreKey),
    state.optional(AuthorizerKey),
    token,
  );
  if (!found) throw unauthorized("session expired or invalid");
  if (!isSafeMethod(c.req.method) && !hasCsrfHeader(c.req.header(CSRF_HEADER))) {
    throw new ApiError(403, `cookie-authenticated changes need the \`${CSRF_HEADER}: 1\` header`);
  }
  return found.record;
}

/**
 * The live session behind a request's cookie, of any tier, or `null`: for a route that answers
 * someone not logged in itself (a redirect to the login), and for the owner's pictures.
 */
export async function sessionOf(state: ApiState, c: ApiContext): Promise<SessionRecord | null> {
  const auth = state.auth;
  const token = auth.oauth ? cookieToken(oauth.requestCookies(c)) : null;
  if (token === null) return null;
  const found = await auth.sessions.lookup(
    state.optional(SettingsStoreKey),
    state.optional(AuthorizerKey),
    token,
  );
  return found ? found.record : null;
}

/**
 * Whether a request came through the public side: the tunnel-facing listener, or the one listener
 * of an install without `public_bind` when the proxy on this machine named a visitor
 * (`client_ip_header`, `CF-Connecting-IP` for Cloudflare). A visitor cannot remove that header
 * (the proxy sets it), and adding it only ever narrows what they get.
 */
export function fromPublicSide(state: ApiState, c: ApiContext, side: Side): boolean {
  if (side === "public") return true;
  const header = state.publicSide.config.client_ip_header.trim().toLowerCase();
  return header !== "" && c.req.header(header) !== undefined;
}

function publicRoutes(state: ApiState): Route[] {
  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/auth/oauth/login",
      handler: (c) => {
        const wait = state.publicSide.admitLogin(state.publicSide.client(c));
        return wait !== null ? tooMany(wait) : oauth.login(state, c);
      },
    },
    { method: "GET", path: "/api/auth/oauth/callback", handler: (c) => oauth.callback(state, c) },
    { method: "POST", path: "/api/auth/logout", handler: (c) => oauth.logout(state, c) },
  ];
  return routes.map((r) => ({ ...r, public: true }));
}

/** Which listener an app is for: `admin` (`bind`, everything) or `public` (`public_bind`). */
export type Side = "admin" | "public";

export interface AppOptions {
  /**
   * The listener: `admin` serves every group, `public` only the public and member routes. Default
   * `admin`, which is also what one listener without `public_bind` is.
   */
  side?: Side;
  /** Serve `GET /metrics` without authentication (`metrics_public`). Default `false`. */
  metricsPublic?: boolean;
  /** How strictly admin responses are checked against their schema (see `rpc.ts`). */
  responseCheck?: ResponseCheck;
}

/** Every route of the API. */
export function routes(state: ApiState, options: AppOptions = {}): Route[] {
  return [
    ...publicRoutes(state),
    ...ogRoutes(state),
    ...landingRoutes(state),
    ...memberRoutes(state),
    ...karaokeRoutes(state),
    ...dataRoutes(state),
    ...liveRoutes(state),
    ...githubLinkRoutes(state),
    ...(state.publicSide.config.enabled
      ? [filesPassRoute(state, { session: (c) => sessionOf(state, c) })]
      : []),

    ...metricsRoutes(state, { public: options.metricsPublic ?? false }),

    // The route table: the groups that have moved to `@miyoria/contracts/api`.
    ...rpcRoutes(state, options.responseCheck ? { responseCheck: options.responseCheck } : {}),
  ];
}

function toResponse(error: unknown): Response {
  if (error instanceof ApiError) return error.toResponse();
  log.warn({ error: errorMessage(error) }, "request failed");
  return ApiError.internal(error).toResponse();
}

/** A member route's answer: never kept by a cache, and no internal error text in it. */
async function memberResponse(run: () => Promise<Response>): Promise<Response> {
  let response: Response;
  try {
    response = await run();
  } catch (error) {
    if (error instanceof ApiError) response = error.toResponse();
    else {
      log.warn({ error: errorMessage(error) }, "member request failed");
      response = new ApiError(500, "something went wrong").toResponse();
    }
  }
  const headers = new Headers(response.headers);
  // A member's event stream is not kept either, and says `no-cache` like every stream.
  const stream = headers.get("content-type")?.startsWith("text/event-stream") === true;
  headers.set("cache-control", stream ? "no-cache, no-store" : "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

/** Builds the API app for a running `api` module. */
export function createApp(state: ApiState, options: AppOptions = {}): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const side = options.side ?? "admin";
  // The public listener never has an admin or a host route: they are not there at all (404).
  const groups: ReadonlySet<RouteGroup> = side === "public" ? new Set(["public"]) : ALL_GROUPS;
  const all = routes(state, options).filter((route) => groups.has(groupOf(route)));
  const byPath = new Map<string, Route[]>();
  for (const route of all) {
    const list = byPath.get(route.path) ?? [];
    list.push(route);
    byPath.set(route.path, list);
  }
  for (const [path, list] of byPath) {
    for (const route of list) {
      app.on(route.method, path, async (c) => {
        if (route.member) {
          return memberResponse(async () => {
            c.set("member", await authenticateMember(state, c));
            return route.handler(c);
          });
        }
        try {
          if (!route.public) c.set("principal", await authenticate(state, c));
          return await route.handler(c);
        } catch (error) {
          return toResponse(error);
        }
      });
    }
    // A known path with another method: 405, after authentication like the route itself.
    const allow = [
      ...new Set(list.flatMap((r) => (r.method === "GET" ? ["GET", "HEAD"] : [r.method]))),
    ];
    const isPublic = list.every((r) => r.public);
    const isMember = list.every((r) => r.member);
    app.all(path, async (c) => {
      try {
        if (isMember) await authenticateMember(state, c);
        else if (!isPublic) await authenticate(state, c);
      } catch (error) {
        return toResponse(error);
      }
      return new Response(null, { status: 405, headers: { allow: allow.join(",") } });
    });
  }

  // Unknown `/api/*` routes get the JSON 404 the panel checks for; anything else is a panel file
  // when a panel directory is configured.
  app.notFound(async (c) => {
    const path = new URL(c.req.url).pathname;
    const isApi = path === "/api" || path.startsWith("/api/");
    if (state.panelDir !== null && !isApi) {
      // From the public side only the allow-list goes out, the owner's pictures only to a session.
      if (fromPublicSide(state, c, side)) {
        const access = staticAccess(path);
        if (access === "deny") return new Response(null, { status: 404 });
        if (access === "private" && (await sessionOf(state, c)) === null) {
          return new Response(null, { status: 404 });
        }
      }
      return servePanel(state.panelDir, c.req.raw, (html, request) =>
        rewriteHtml(state, html, request),
      );
    }
    return ApiError.notFound(NO_SUCH_ENDPOINT).toResponse();
  });
  app.onError((error) => toResponse(error));
  return app;
}
