// The original routes: health, modules, decisions, LLM usage and cost, persona, events (SSE).

import { PersonaHandleKey } from "@miyoria/agent";
import { errorMessage, getLogger, type ModuleStatus, SupervisorKey } from "@miyoria/kernel";
import { LlmRouterKey, MIYORIA_VERSION } from "@miyoria/llm";
import { DecisionLogKey, PersonaOverrideStoreKey } from "@miyoria/store";
import type { JsonValue, ModuleId } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { contextParam, readJson, readQuery, usizeParam } from "./extract.js";
import { json, param, type Route } from "./route.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";
import type { HealthInfo, PersonaSectionInfo, SetPersonaResponse, UsageInfo } from "./types.js";

const log = getLogger("api.server");

const DEFAULT_DECISIONS = 50;
const MAX_DECISIONS = 1000;
/** Keep-alive comment interval of the event stream (axum's default). */
export const KEEP_ALIVE_MS = 15_000;

export function findModule(list: ModuleStatus[], id: ModuleId): ModuleStatus {
  const found = list.find((m) => m.id === id);
  if (!found) throw ApiError.notFound(`unknown module \`${id}\``);
  return found;
}

/**
 * Enables, disables or restarts a module and returns its status afterwards. Refuses to stop
 * the `api` module itself. Recorded in the audit log as `<auditPrefix>.<action>`.
 */
export async function runModuleAction(
  state: ApiState,
  c: ApiContext,
  id: ModuleId,
  action: string,
  auditPrefix: string,
): Promise<ModuleStatus> {
  const sup = state.service(SupervisorKey, "supervisor");
  if (action !== "enable" && action !== "disable" && action !== "restart") {
    throw ApiError.notFound(`unknown action \`${action}\` (expected enable, disable or restart)`);
  }
  const current = findModule(sup.list(), id);
  if (action !== "enable" && id === state.ctx.id) {
    throw ApiError.conflict(
      `refusing to ${action} \`${id}\` through itself: it would stop this server`,
    );
  }
  if (action === "restart" && !current.enabled) {
    throw ApiError.conflict(`module \`${id}\` is disabled; enable it instead`);
  }

  const op =
    action === "enable" ? sup.enable(id) : action === "disable" ? sup.disable(id) : sup.restart(id);
  // Don't hold up our own shutdown behind a slow lifecycle operation.
  const signal = state.ctx.signal;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<"stopped">((resolve) => {
    onAbort = () => resolve("stopped");
    if (signal.aborted) resolve("stopped");
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  let failure: unknown = null;
  try {
    const outcome = await Promise.race([op.then(() => "done" as const), stopped]);
    if (outcome === "stopped") {
      void op.catch(() => undefined);
      throw ApiError.unavailable("API is shutting down");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    failure = error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  const detail: JsonValue = failure === null ? {} : { error: errorMessage(failure) };
  await state.audit(c, `${auditPrefix}.${action}`, id, detail, failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  return findModule(sup.list(), id);
}

function health(): Response {
  const body: HealthInfo = { status: "ok", version: MIYORIA_VERSION };
  return json(body);
}

function listModules(state: ApiState): Response {
  return json(state.service(SupervisorKey, "supervisor").list());
}

async function moduleAction(state: ApiState, c: ApiContext): Promise<Response> {
  const status = await runModuleAction(state, c, param(c, "id"), param(c, "action"), "module");
  return json(status);
}

const DecisionsQuerySchema = z.object({
  limit: usizeParam.optional(),
  /** JSON-encoded `ContextKey`. */
  context: z.string().optional(),
});

async function decisions(state: ApiState, c: ApiContext): Promise<Response> {
  const q = readQuery(c, DecisionsQuerySchema);
  const context = contextParam(q.context);
  const limit = Math.min(q.limit ?? DEFAULT_DECISIONS, MAX_DECISIONS);
  const decisionLog = state.service(DecisionLogKey, "decision log");
  const profile = state.profile();
  return json(await decisionLog.recent(profile, context, limit));
}

function llmUsage(state: ApiState): Response {
  const router = state.service(LlmRouterKey, "LLM router");
  const usage: Record<string, UsageInfo> = {};
  for (const key of [...router.usage().keys()].sort()) {
    const u = router.usage().get(key);
    if (!u) continue;
    usage[key] = {
      calls: u.calls,
      prompt_tokens: u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      cached_prompt_tokens: u.cached_prompt_tokens,
    };
  }
  return json(usage);
}

function llmCost(state: ApiState): Response {
  return json(state.service(LlmRouterKey, "LLM router").costReport());
}

function persona(state: ApiState): Response {
  const handle = state.service(PersonaHandleKey, "persona");
  const sections: PersonaSectionInfo[] = handle
    .sections()
    .map((s) => ({ key: s.key, body: s.body }));
  return json(sections);
}

function checkSectionKey(key: string): void {
  if (key.length > 0 && key.length <= 64 && /^[A-Za-z0-9_-]+$/.test(key)) return;
  throw ApiError.badRequest(
    `invalid persona section key \`${key}\` (use letters, digits, \`-\` or \`_\`)`,
  );
}

const SetPersonaSchema = z.object({
  body: z.string(),
  edited_by: z.string().nullish(),
});

async function setPersonaSection(state: ApiState, c: ApiContext): Promise<Response> {
  const request = await readJson(c, SetPersonaSchema);
  const key = param(c, "key");
  checkSectionKey(key);
  const handle = state.service(PersonaHandleKey, "persona");
  const overrides = state.service(PersonaOverrideStoreKey, "persona override store");
  const profile = state.profile();
  const editedBy = request.edited_by?.trim() || actorOf(c);
  const text = request.body.trim();
  // Persist first, so a failed write never leaves an unrecorded live edit.
  let version: number | null = null;
  let failure: unknown = null;
  try {
    version = await overrides.set(profile, key, text, editedBy);
  } catch (error) {
    failure = error;
  }
  const detail: JsonValue =
    failure === null
      ? { version, edited_by: editedBy }
      : { edited_by: editedBy, error: errorMessage(failure) };
  await state.audit(c, "persona.set", key, detail, failure === null);
  if (failure !== null || version === null) throw ApiError.internal(failure);
  handle.setSection(key, text);
  const body: SetPersonaResponse = { key, version };
  return json(body);
}

async function personaHistory(state: ApiState, c: ApiContext): Promise<Response> {
  const key = param(c, "key");
  checkSectionKey(key);
  const overrides = state.service(PersonaOverrideStoreKey, "persona override store");
  const profile = state.profile();
  return json(await overrides.history(profile, key));
}

const EventsQuerySchema = z.object({
  /** Comma-separated topic patterns; empty means everything. */
  topics: z.string().optional(),
});

/** `GET /api/events?topics=platform.*,agent.*`: Server-Sent Events of bus envelopes. */
function events(state: ApiState, c: ApiContext): Response {
  const q = readQuery(c, EventsQuerySchema);
  const patterns = (q.topics ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const headers = { "content-type": "text/event-stream", "cache-control": "no-cache" };
  // A `HEAD` gets the headers only; don't leave a subscription behind for it.
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });
  // Closed when the module stops, which ends the stream.
  const sub = state.ctx.subscribe(patterns.length === 0 ? "*" : patterns);
  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const requestSignal = c.req.raw.signal;
  const onClientGone = () => sub.close();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          sub.close();
        }
      }, KEEP_ALIVE_MS);
      requestSignal.addEventListener("abort", onClientGone, { once: true });
    },
    async pull(controller) {
      for (;;) {
        const env = await sub.recv();
        if (env === null) {
          clearInterval(keepAlive);
          requestSignal.removeEventListener("abort", onClientGone);
          controller.close();
          return;
        }
        let data: string;
        try {
          data = JSON.stringify(env);
        } catch (error) {
          log.warn({ error: errorMessage(error) }, "failed to serialize event for SSE");
          continue;
        }
        controller.enqueue(encoder.encode(`id: ${env.id}\ndata: ${data}\n\n`));
        return;
      }
    },
    cancel() {
      clearInterval(keepAlive);
      requestSignal.removeEventListener("abort", onClientGone);
      sub.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

export function coreRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/health", handler: health, public: true },
    { method: "GET", path: "/api/modules", handler: () => listModules(state) },
    { method: "POST", path: "/api/modules/:id/:action", handler: (c) => moduleAction(state, c) },
    { method: "GET", path: "/api/decisions", handler: (c) => decisions(state, c) },
    { method: "GET", path: "/api/llm/usage", handler: () => llmUsage(state) },
    { method: "GET", path: "/api/llm/cost", handler: () => llmCost(state) },
    { method: "GET", path: "/api/persona", handler: () => persona(state) },
    { method: "PUT", path: "/api/persona/:key", handler: (c) => setPersonaSection(state, c) },
    { method: "GET", path: "/api/persona/:key/history", handler: (c) => personaHistory(state, c) },
    { method: "GET", path: "/api/events", handler: (c) => events(state, c) },
  ];
}
