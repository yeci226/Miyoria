// Serves the route table (`@miyoria/contracts/api`) with oRPC, as entries of the same Hono table the
// old routes are on, so both answer side by side and a request that matches neither still gets the
// JSON 404.
//
// Each route becomes one `Route` (`route.ts`): its audience decides the authentication, exactly as
// the `public` and `member` flags do for an old route, so the order is today's: authentication
// (with the CSRF check and `admin.panel.write` for a change by session), then 405 for another
// method on a known path, then the route's permission node, then the member's rate limit (a route
// with `limited`), then a JSON body's content type and syntax (415, 400), and only then oRPC: the input schema (422 for the body, 400 for the query),
// the handler, the response schema. What oRPC catches is handed back to the shell, which answers
// it the way it answers an old route (`{ "error": "..." }`, `WWW-Authenticate`, the member
// wrapper), so a client cannot tell the two kinds of route apart.
//
// A route whose output is an `eventIterator` is a Server-Sent Events stream: oRPC writes each
// event (`event: message`, `id:` when the handler set one, `data:`) and a comment after
// `KEEP_ALIVE_MS` without one; the shell answers its `HEAD` itself, without starting the stream,
// and marks the answer `no-cache`. Each event is checked like a response.
//
// Responses are checked against their schema (decision C3):
//
// * `public` and `member` routes: always validated and stripped to the schema; a mismatch is 500.
// * `admin` routes, mode `strict`: validated, and a field the schema does not name is a mismatch
//   too (500), so a test finds what the schema forgot.
// * `admin` routes, mode `production`: validated and logged, the answer goes out as the handler
//   built it, so a schema slip never blanks a panel page.
//
// The mode is `AppOptions.responseCheck`, else `MIYORIA_RESPONSE_CHECK` (`strict` or
// `production`), else `strict` while running from the TypeScript sources (tests, `pnpm dev`) and
// `production` from a build.

import { eventRouteSchemas, type RouteMeta } from "@miyoria/contracts/api";
import { getLogger } from "@miyoria/runtime/kernel";
import { type AccountRef, AuthorizerKey } from "@miyoria/types";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import {
  type AnyRouter,
  eventIterator,
  isProcedure,
  type Meta,
  ORPCError,
  Procedure,
  type ProcedureClientInterceptorOptions,
  type Schema,
  traverseContractProcedures,
  ValidationError,
} from "@orpc/server";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { z } from "zod";
import { affectRpc } from "./affect.js";
import { agencyRpc } from "./agency.js";
import { boardRpc } from "./board.js";
import { activityRpc, arbiterRpc } from "./body.js";
import { cardCheckRpc } from "./card.js";
import { cardsAdminRpc, cardsRpc } from "./cards-routes.js";
import { channelRpc } from "./channels.js";
import { clusterRpc } from "./cluster.js";
import { os, type RpcContext } from "./contract.js";
import { controlRpc } from "./control.js";
import { coreRpc, eventsRpc, healthRpc, KEEP_ALIVE_MS, personaRpc } from "./core.js";
import { dataRpc } from "./data.js";
import { directivesRpc } from "./directives.js";
import { economyRpc, personQuestsRpc } from "./economy.js";
import { ApiError, NO_SUCH_ENDPOINT } from "./errors.js";
import { evalRpc } from "./eval/route.js";
import { exchangeAdminRpc, exchangeRpc } from "./exchange-routes.js";
import { jsonRequest } from "./extract.js";
import { factsRpc } from "./facts.js";
import { filesAdminRpc, memberFilesRpc } from "./files/routes.js";
import { fortuneRpc } from "./fortune-routes.js";
import { giftsAdminRpc, giftsPublicRpc, giftsRpc } from "./gift-routes.js";
import { githubLinkRpc } from "./github-link.js";
import { selfRpc, worldRpc } from "./inner.js";
import { karaokeAdminRpc, karaokeRefusals, karaokeRoomsRpc, karaokeRpc } from "./karaoke-routes.js";
import { digestRpc, knowledgeRpc, reflectionRpc } from "./learning.js";
import { lifeRpc } from "./life.js";
import { livePatRpc } from "./live.js";
import { llmCallsRpc, thoughtRpc } from "./llmcalls.js";
import { marketAdminRpc, marketRpc } from "./market-routes.js";
import { memberRpc } from "./member.js";
import { memoryRpc } from "./memory.js";
import { turnMetricsRpc } from "./metrics-turns.js";
import { mindRpc } from "./mind.js";
import { notebookRpc, recentRpc } from "./notebook.js";
import { notesRpc } from "./notes.js";
import { authRpc } from "./oauth.js";
import { opsRpc } from "./ops.js";
import { partyRpc } from "./party.js";
import { peopleRpc } from "./people.js";
import { personWalletRpc } from "./people-wallet.js";
import { memberSpacesRpc, placesSpacesRpc } from "./places-routes.js";
import { planRpc } from "./plan.js";
import { walletPlayRpc } from "./play-routes.js";
import { outcomesRpc, promptsRpc } from "./prompts.js";
import { limitMember, publicRpc } from "./public.js";
import { pushRpc } from "./push/routes.js";
import { reportsRpc } from "./reports.js";
import { roleRpc } from "./roles.js";
import type { Method, Route, RouteGroup } from "./route.js";
import { sandboxRpc } from "./sandbox.js";
import { placesRpc, settingsRpc } from "./settings.js";
import type { ApiContext, ApiState } from "./state.js";
import { telemetryRpc } from "./telemetry.js";
import { walletRpc } from "./wallet.js";
import { skillsRpc, workspaceRpc } from "./workspace.js";

const log = getLogger("api.rpc");

/** Every route of the table, implemented. */
export const router = os.router({
  health: healthRpc,
  auth: authRpc,
  persona: personaRpc,
  self: selfRpc,
  world: worldRpc,
  affect: affectRpc,
  prompts: promptsRpc,
  turns: { ...outcomesRpc, ...turnMetricsRpc },
  telemetry: telemetryRpc,
  party: partyRpc,
  facts: factsRpc,
  activity: activityRpc,
  arbiter: arbiterRpc,
  knowledge: knowledgeRpc,
  reflection: reflectionRpc,
  life: lifeRpc,
  sandbox: sandboxRpc,
  eval: evalRpc,
  workspace: workspaceRpc,
  skills: skillsRpc,
  public: { ...publicRpc, ...boardRpc, ...cardCheckRpc },
  push: pushRpc,
  member: { ...memberRpc, ...livePatRpc, ...memberSpacesRpc },
  cards: cardsRpc,
  cardsAdmin: cardsAdminRpc,
  wallet: { ...walletRpc, ...walletPlayRpc },
  agency: agencyRpc,
  fortune: fortuneRpc,
  market: marketRpc,
  marketAdmin: marketAdminRpc,
  exchange: exchangeRpc,
  exchangeAdmin: exchangeAdminRpc,
  gifts: giftsRpc,
  giftsAdmin: giftsAdminRpc,
  giftsPublic: giftsPublicRpc,
  karaoke: karaokeRpc,
  karaokeAdmin: karaokeAdminRpc,
  karaokeRooms: karaokeRoomsRpc,
  reports: reportsRpc,
  githubLink: githubLinkRpc,
  memberFiles: memberFilesRpc,
  filesAdmin: filesAdminRpc,
  people: { ...peopleRpc, ...personWalletRpc, ...personQuestsRpc },
  ...coreRpc,
  // The settings routes before `POST /api/modules/{id}/{action}` (see the contract).
  modules: { list: coreRpc.modules.list, ...settingsRpc, action: coreRpc.modules.action },
  places: { ...placesRpc, ...placesSpacesRpc },
  events: eventsRpc,
  llm: { ...coreRpc.llm, ...llmCallsRpc },
  economy: economyRpc,
  channels: channelRpc,
  cluster: clusterRpc,
  mind: { ...mindRpc, ...thoughtRpc, ...digestRpc, ...planRpc },
  roles: roleRpc,
  ...opsRpc,
  voice: { ...opsRpc.voice, ...controlRpc.voice },
  songs: controlRpc.songs,
  game: controlRpc.game,
  data: dataRpc,
  directives: directivesRpc,
  memory: memoryRpc,
  notebook: notebookRpc,
  notes: notesRpc,
  recent: recentRpc,
});

export type ResponseCheck = "strict" | "production";

/** Running from the TypeScript sources (tests, `pnpm dev`) rather than a build. */
const FROM_SOURCE = import.meta.url.endsWith(".ts");

/** How strictly admin responses are checked when the app does not say. */
export function defaultResponseCheck(env: NodeJS.ProcessEnv = process.env): ResponseCheck {
  const set = env.MIYORIA_RESPONSE_CHECK;
  if (set === "strict" || set === "production") return set;
  return FROM_SOURCE ? "strict" : "production";
}

/** The groups of the public side (`[modules.api.public]`): the public views and the member pages (the cards, the wallet, fortune, the market, karaoke and its rooms are member pages too). */
const PUBLIC_SIDE = new Set([
  "public",
  "push",
  "member",
  "cards",
  "wallet",
  "agency",
  "fortune",
  "market",
  "exchange",
  "gifts",
  "giftsPublic",
  "karaoke",
  "karaokeRooms",
  "githubLink",
  "memberFiles",
]);

/**
 * Routes of the `host` group (a machine joining the cluster): served with the admin routes on
 * `bind` (this machine or the tailnet), never on the public listener, although they need no session.
 */
const HOST_ROUTES = new Set(["cluster.join"]);

/** The route group of the table's route at `path` with `meta`. */
function tableGroup(path: readonly string[], meta: RouteMeta): RouteGroup {
  if (HOST_ROUTES.has(path.join("."))) return "host";
  return meta.audience === "admin" ? "admin" : "public";
}

/** Whether a route is served at all: the public side's routes go away with its switch. */
function served(state: ApiState, path: readonly string[]): boolean {
  return !PUBLIC_SIDE.has(path[0] ?? "") || state.publicSide.config.enabled;
}

// ---- response policy -----------------------------------------------------------------------

type Issue = { message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> };

function pathText(path: Issue["path"]): string {
  return (path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".");
}

function issueText(issue: Issue | undefined): string {
  if (!issue) return "invalid value";
  const at = pathText(issue.path);
  return at ? `${at}: ${issue.message}` : issue.message;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Paths of the fields `raw` has and `parsed` (the same value, stripped) does not. */
export function extraKeys(raw: unknown, parsed: unknown, at: PropertyKey[] = []): PropertyKey[][] {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    return raw.flatMap((v, i) => extraKeys(v, parsed[i], [...at, i]));
  }
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return [];
  return Object.keys(raw).flatMap((key) => {
    if (raw[key] === undefined) return [];
    if (!(key in parsed)) return [[...at, key]];
    return extraKeys(raw[key], parsed[key], [...at, key]);
  });
}

/** An admin route's response schema under `check` (public and member keep theirs as it is). */
function adminOutput(schema: Schema<unknown, unknown>, check: ResponseCheck, name: string) {
  const checked: Schema<unknown, unknown> = {
    "~standard": {
      version: 1,
      vendor: "miyoria",
      validate: async (value) => {
        const result = await schema["~standard"].validate(value);
        const extra = result.issues ? [] : extraKeys(value, result.value);
        if (check === "strict") {
          if (result.issues || extra.length === 0) return result;
          return { issues: extra.map((path) => ({ message: "not in the response schema", path })) };
        }
        if (result.issues || extra.length > 0) {
          const issues = (result.issues ?? []).slice(0, 5).map(issueText);
          const fields = extra.slice(0, 5).map((p) => p.map(String).join("."));
          log.warn({ route: name, issues, fields }, "a response does not match its schema");
        }
        return { value };
      },
    },
  };
  return checked;
}

/**
 * An admin route's output schema under `check`. An event stream's schema checks each event as it
 * is sent, so the policy goes on its events (a mismatch in `strict` ends the stream with an
 * `event: error`; in `production` it is logged and the event goes out).
 */
function checkedOutput(schema: Schema<unknown, unknown>, check: ResponseCheck, path: string[]) {
  const name = path.join(".");
  const stream = eventRouteSchemas(schema);
  if (stream === undefined) return adminOutput(schema, check, name);
  const { yields, returns } = stream;
  return eventIterator(
    adminOutput(yields, check, name),
    returns === undefined ? undefined : adminOutput(returns, check, name),
  );
}

/** `router` with each admin route's response schema set for `check`. */
function withResponseCheck<T extends object>(table: T, check: ResponseCheck, at: string[] = []): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table)) {
    const path = [...at, key];
    if (isProcedure(value)) {
      const def = value["~orpc"];
      const meta = def.meta as RouteMeta;
      out[key] =
        meta.audience === "admin" && def.outputSchema
          ? new Procedure({ ...def, outputSchema: checkedOutput(def.outputSchema, check, path) })
          : value;
    } else {
      out[key] = withResponseCheck(value as object, check, path);
    }
  }
  return out as T;
}

// ---- errors ----------------------------------------------------------------------------------

/** What a failed call answers: today's error for the input, the response, or what was thrown. */
function failureOf(error: unknown, name: string): unknown {
  if (!(error instanceof ORPCError) || !(error.cause instanceof ValidationError)) return error;
  const issue = error.cause.issues[0] as Issue | undefined;
  if (error.code !== "BAD_REQUEST") {
    log.warn({ route: name, issue: issueText(issue) }, "a response does not match its schema");
    return ApiError.internal(
      new Error(`the response does not match its schema: ${issueText(issue)}`),
    );
  }
  const [part, ...rest] = issue?.path ?? [];
  const text = issueText(issue ? { message: issue.message, path: rest } : undefined);
  switch (typeof part === "object" ? part.key : part) {
    case "body":
      return new ApiError(422, `Failed to deserialize the JSON body into the target type: ${text}`);
    case "query":
      return ApiError.badRequest(`Failed to deserialize query string: ${text}`);
    case "params":
      return ApiError.badRequest(`Invalid URL: ${text}`);
    default:
      return ApiError.badRequest(text);
  }
}

/** Keeps what a call threw for the shell; oRPC's own answer to it is dropped. */
async function remember(
  options: ProcedureClientInterceptorOptions<RpcContext, Record<never, never>, Meta> & {
    next: () => Promise<unknown>;
  },
): Promise<unknown> {
  try {
    return await options.next();
  } catch (error) {
    options.context.failure.error = failureOf(error, options.path.join("."));
    throw error;
  }
}

// ---- the shell -------------------------------------------------------------------------------

/** The account behind the request: the member, or the admin session; `null` for the token. */
function holder(c: ApiContext): AccountRef | null {
  const member = c.get("member");
  if (member) return member.account;
  const principal = c.get("principal");
  return principal?.kind === "session" ? principal.record.account : null;
}

/**
 * The route's permission node, held by the session's account (the token holds every node). A route
 * may word its own refusal.
 */
function requirePermission(state: ApiState, c: ApiContext, node: string, refusal?: string): void {
  const account = holder(c);
  if (account === null) return;
  if (!state.optional(AuthorizerKey)?.allows(account, node)) {
    throw new ApiError(403, refusal ?? `this needs \`${node}\``);
  }
}

type Handler = OpenAPIHandler<RpcContext>;

async function serve(handler: Handler, state: ApiState, c: ApiContext, body: boolean) {
  let request = c.req.raw;
  // Hono answers HEAD with the GET route; oRPC only knows the GET.
  if (request.method === "HEAD") request = new Request(request, { method: "GET" });
  if (body) request = await jsonRequest(request);
  const context: RpcContext = { c, state, failure: {}, reply: {} };
  const { matched, response } = await handler.handle(request, { context });
  if (context.failure.error !== undefined) throw context.failure.error;
  if (!matched || !response) throw ApiError.notFound(NO_SUCH_ENDPOINT);
  const status = context.reply.status;
  if (status === undefined || status === response.status) return response;
  return new Response(response.body, { status, headers: response.headers });
}

/**
 * What an event stream route answers with besides its body: never cached, and never buffered by a
 * proxy on the way (nginx and the like hold a response back unless told not to).
 */
const STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
};

/** The `{name}` of an OpenAPI path as Hono's `:name`. */
const honoPath = (path: string) => path.replace(/\{([^}]+)\}/g, ":$1");

export interface RpcOptions {
  responseCheck?: ResponseCheck;
}

/** The routes of the table as entries of the Hono table, in the table's order. */
export function rpcRoutes(state: ApiState, options: RpcOptions = {}): Route[] {
  return tableRoutes(state, router, options);
}

/** `rpcRoutes` for any implemented table (`os.router(...)` of a contract built from `route`). */
export function tableRoutes(state: ApiState, table: AnyRouter, options: RpcOptions = {}): Route[] {
  const check = options.responseCheck ?? defaultResponseCheck();
  const handler: Handler = new OpenAPIHandler(withResponseCheck(table, check), {
    plugins: [new ResponseHeadersPlugin()],
    clientInterceptors: [remember],
    // An event stream says nothing until its first event, then a comment after each quiet spell.
    eventIteratorInitialCommentEnabled: false,
    eventIteratorKeepAliveInterval: KEEP_ALIVE_MS,
  });
  const routes: Route[] = [];
  traverseContractProcedures({ router: table, path: [] }, ({ contract: procedure, path }) => {
    if (!served(state, path)) return;
    const def = procedure["~orpc"];
    const meta = def.meta as RouteMeta;
    const input = def.inputSchema;
    const body = input instanceof z.ZodObject && "body" in input.shape;
    const stream = eventRouteSchemas(def.outputSchema) !== undefined;
    // Karaoke's own warn log of a refused result (the rate limit and the input check included).
    const refused = karaokeRefusals(path);
    routes.push({
      method: (def.route.method ?? "POST") as Method,
      path: honoPath(def.route.path ?? ""),
      public: meta.audience === "public",
      member: meta.audience === "member",
      group: tableGroup(path, meta),
      handler: async (c) => {
        if (refused !== null) {
          try {
            if (meta.permission !== null)
              requirePermission(state, c, meta.permission, meta.refusal);
            if (meta.limited) limitMember(state, c);
            return await serve(handler, state, c, body);
          } catch (error) {
            refused(c, error);
            throw error;
          }
        }
        if (meta.permission !== null) requirePermission(state, c, meta.permission, meta.refusal);
        if (meta.limited) limitMember(state, c);
        if (!stream) return serve(handler, state, c, body);
        // A HEAD gets the headers only: no subscription is left behind for it.
        if (c.req.method === "HEAD") {
          return new Response(null, { status: 200, headers: STREAM_HEADERS });
        }
        const response = await serve(handler, state, c, body);
        response.headers.set("cache-control", STREAM_HEADERS["cache-control"]);
        response.headers.set("x-accel-buffering", STREAM_HEADERS["x-accel-buffering"]);
        return response;
      },
    });
  });
  return routes;
}
