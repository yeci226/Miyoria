// Router, authentication and the fallback. The route groups live in sibling modules.

import { errorMessage, getLogger } from "@miyoria/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import { AuthorizerKey } from "@miyoria/types";
import { Hono } from "hono";
import { affectRoutes } from "./affect.js";
import { agencyRoutes } from "./agency.js";
import { boardRoutes } from "./board.js";
import { bodyRoutes } from "./body.js";
import { cardCheckRoutes } from "./card.js";
import { channelRoutes } from "./channels.js";
import { controlRoutes } from "./control.js";
import { coreRoutes } from "./core.js";
import { dataRoutes } from "./data.js";
import { directiveRoutes } from "./directives.js";
import { ApiError, NO_SUCH_ENDPOINT } from "./errors.js";
import { factRoutes } from "./facts.js";
import { fortuneRoutes } from "./fortune-routes.js";
import { goalAdminRoutes } from "./goals-admin.js";
import { innerRoutes } from "./inner.js";
import { learningRoutes } from "./learning.js";
import { liveRoutes } from "./live.js";
import { llmCallRoutes } from "./llmcalls.js";
import { memberRoutes } from "./member.js";
import { memoryRoutes } from "./memory.js";
import { metricsRoutes } from "./metrics.js";
import { turnMetricsRoutes } from "./metrics-turns.js";
import { mindRoutes } from "./mind.js";
import * as oauth from "./oauth.js";
import { ogRoutes, rewriteHtml } from "./og.js";
import { opsRoutes } from "./ops.js";
import { servePanel } from "./panel.js";
import { peopleRoutes } from "./people.js";
import { personWalletRoutes } from "./people-wallet.js";
import { planRoutes } from "./plan.js";
import { promptRoutes } from "./prompts.js";
import { clientKey, publicViewRoutes, tooMany } from "./public.js";
import { roleRoutes } from "./roles.js";
import { json, type Route } from "./route.js";
import { sandboxRoutes } from "./sandbox.js";
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
import { telemetryRoutes } from "./telemetry.js";
import { v4Routes } from "./v4-routes.js";
import { walletRoutes } from "./wallet.js";

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
    const ok = header.startsWith("Bearer ") && tokenMatches(auth.token, header.slice(7));
    if (!ok) throw unauthorized("missing or invalid bearer token");
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

function publicRoutes(state: ApiState): Route[] {
  const routes: Route[] = [
    { method: "GET", path: "/api/auth/methods", handler: () => json(oauth.methods(state)) },
    {
      method: "GET",
      path: "/api/auth/oauth/login",
      handler: (c) => {
        const wait = state.publicSide.admitLogin(clientKey(c));
        return wait !== null ? tooMany(wait) : oauth.login(state, c);
      },
    },
    { method: "GET", path: "/api/auth/oauth/callback", handler: (c) => oauth.callback(state, c) },
    { method: "POST", path: "/api/auth/logout", handler: (c) => oauth.logout(state, c) },
  ];
  return routes.map((r) => ({ ...r, public: true }));
}

function sessionRoutes(): Route[] {
  return [{ method: "GET", path: "/api/auth/session", handler: (c) => json(oauth.session(c)) }];
}

export interface AppOptions {
  /** Serve `GET /metrics` without authentication (`metrics_public`). Default `false`. */
  metricsPublic?: boolean;
}

/** Every route of the API. */
export function routes(state: ApiState, options: AppOptions = {}): Route[] {
  return [
    ...coreRoutes(state),
    ...publicRoutes(state),
    ...publicViewRoutes(state),
    ...cardCheckRoutes(state),
    ...ogRoutes(state),
    ...boardRoutes(state),
    ...memberRoutes(state),
    ...walletRoutes(state),
    ...fortuneRoutes(state),
    ...agencyRoutes(state),
    ...sessionRoutes(),
    ...peopleRoutes(state),
    ...personWalletRoutes(state),
    ...goalAdminRoutes(state),
    ...memoryRoutes(state),
    ...roleRoutes(state),
    ...opsRoutes(state),
    ...innerRoutes(state),
    ...factRoutes(state),
    ...channelRoutes(state),
    ...dataRoutes(state),
    ...sandboxRoutes(state),
    ...mindRoutes(state),
    ...directiveRoutes(state),
    ...planRoutes(state),
    ...bodyRoutes(state),
    ...affectRoutes(state),
    ...promptRoutes(state),
    ...turnMetricsRoutes(state),
    ...learningRoutes(state),
    ...controlRoutes(state),
    ...llmCallRoutes(state),
    ...telemetryRoutes(state),
    ...liveRoutes(state),
    ...v4Routes(state),

    ...metricsRoutes(state, { public: options.metricsPublic ?? false }),
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
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

/** Builds the API app for a running `api` module. */
export function createApp(state: ApiState, options: AppOptions = {}): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const all = routes(state, options);
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
  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    const isApi = path === "/api" || path.startsWith("/api/");
    if (state.panelDir !== null && !isApi) {
      return servePanel(state.panelDir, c.req.raw, (html, request) =>
        rewriteHtml(state, html, request),
      );
    }
    return ApiError.notFound(NO_SUCH_ENDPOINT).toResponse();
  });
  app.onError((error) => toResponse(error));
  return app;
}
