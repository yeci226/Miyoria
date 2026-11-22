// The original routes: health, modules, decisions, LLM usage and cost, persona, events (SSE).
// All on the route table (`healthRpc`, `personaRpc`, `coreRpc`, `eventsRpc`).

import { PersonaHandleKey } from "@miyoria/brain/agent";
import type {
  CostReport,
  DecisionRecord,
  PersonaOverride,
  PersonaSectionInfo,
  SetPersonaRequest,
  SetPersonaResponse,
  UsageMap,
} from "@miyoria/contracts/api";
import type { BusEnvelopeJson } from "@miyoria/contracts/events";
import { LlmRouterKey, MIYORIA_VERSION } from "@miyoria/llm/llm";
import {
  errorMessage,
  getLogger,
  type ModuleStatus,
  RequiredModuleError,
  SupervisorKey,
} from "@miyoria/runtime/kernel";
import { DecisionLogKey, PersonaOverrideStoreKey } from "@miyoria/store";
import {
  type BusEnvelope,
  CharacterKey,
  DEFAULT_CHARACTER,
  type JsonValue,
  type ModuleId,
  type RunningProfile,
  RunningProfileKey,
} from "@miyoria/types";
import { withEventMeta } from "@orpc/server";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { contextParam } from "./extract.js";
import { adminStillIn, RECHECK_MS } from "./recheck.js";
import { moduleCards } from "./settings.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";

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
    // Asked to disable a module that cannot be: nothing was stopped.
    if (error instanceof RequiredModuleError) throw ApiError.conflict(error.message);
    failure = error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  const detail: JsonValue = failure === null ? {} : { error: errorMessage(failure) };
  await state.audit(c, `${auditPrefix}.${action}`, id, detail, failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  return findModule(sup.list(), id);
}

/** `GET /api/decisions?limit=&context=`: `context` is a JSON-encoded `ContextKey`. */
async function decisions(
  state: ApiState,
  q: { limit?: number | undefined; context?: string | undefined },
): Promise<DecisionRecord[]> {
  const context = contextParam(q.context);
  const limit = Math.min(q.limit ?? DEFAULT_DECISIONS, MAX_DECISIONS);
  const decisionLog = state.service(DecisionLogKey, "decision log");
  const profile = state.profile();
  return decisionLog.recent(profile, context, limit);
}

function llmUsage(state: ApiState): UsageMap {
  const router = state.service(LlmRouterKey, "LLM router");
  const usage: UsageMap = {};
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
  return usage;
}

function llmCost(state: ApiState): CostReport {
  return state.service(LlmRouterKey, "LLM router").costReport();
}

function personaSections(state: ApiState): PersonaSectionInfo[] {
  const handle = state.service(PersonaHandleKey, "persona");
  return handle.sections().map((s) => ({ key: s.key, body: s.body }));
}

function checkSectionKey(key: string): void {
  if (key.length > 0 && key.length <= 64 && /^[A-Za-z0-9_-]+$/.test(key)) return;
  throw ApiError.badRequest(
    `invalid persona section key \`${key}\` (use letters, digits, \`-\` or \`_\`)`,
  );
}

async function setPersonaSection(
  state: ApiState,
  c: ApiContext,
  key: string,
  request: SetPersonaRequest,
): Promise<SetPersonaResponse> {
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
  return { key, version };
}

async function personaHistory(state: ApiState, key: string): Promise<PersonaOverride[]> {
  checkSectionKey(key);
  const overrides = state.service(PersonaOverrideStoreKey, "persona override store");
  const profile = state.profile();
  return overrides.history(profile, key);
}

/** `GET /api/health`. */
export const healthRpc = os.health.handler(() => ({ status: "ok", version: MIYORIA_VERSION }));

/** Which profile this Core runs; a Core built without the service reports its profile id alone. */
function runningProfile(state: ApiState): RunningProfile {
  const running = state.optional(RunningProfileKey);
  if (running) return { ...running };
  const persona = state.optional(PersonaHandleKey);
  return {
    id: state.profile(),
    own: false,
    character: (state.optional(CharacterKey) ?? DEFAULT_CHARACTER).name,
    persona: persona?.displayName() ?? "",
  };
}

/**
 * `GET /api/persona`, `PUT /api/persona/{key}`, `GET /api/persona/{key}/history`, and
 * `GET /api/profile`.
 */
export const personaRpc = {
  profile: os.persona.profile.handler(({ context }) => runningProfile(context.state)),
  list: os.persona.list.handler(({ context }) => personaSections(context.state)),
  set: os.persona.set.handler(({ input, context }) =>
    setPersonaSection(context.state, context.c, input.params.key, input.body),
  ),
  history: os.persona.history.handler(({ input, context }) =>
    personaHistory(context.state, input.params.key),
  ),
};

/** The module, decision and LLM usage routes on the route table. */
export const coreRpc = {
  modules: {
    // Each module with its icon, section and card (`settings.ts`).
    list: os.modules.list.handler(({ context }) => moduleCards(context.state)),
    action: os.modules.action.handler(({ input, context }) =>
      runModuleAction(context.state, context.c, input.params.id, input.params.action, "module"),
    ),
  },
  decisions: os.decisions.handler(({ input, context }) => decisions(context.state, input.query)),
  llm: {
    usage: os.llm.usage.handler(({ context }) => llmUsage(context.state)),
    cost: os.llm.cost.handler(({ context }) => llmCost(context.state)),
  },
};

/** The envelope's fields in the schema's order (the bus stamps them in another order). */
function wireEnvelope(env: BusEnvelope): BusEnvelope {
  return {
    id: env.id,
    at: env.at,
    type: env.type,
    v: env.v,
    parent: env.parent,
    turn: env.turn,
    session: env.session,
    space_id: env.space_id,
    room_id: env.room_id,
    person_id: env.person_id,
    account_id: env.account_id,
    key: env.key,
    scope: env.scope,
    source: env.source,
    data: env.data,
  };
}

/**
 * The bus envelopes matching `topics` (comma-separated patterns; none: everything), each with its
 * id as the SSE `id:`, until the client goes away or the module stops. An event that does not
 * serialize is skipped. The subscription is made when the stream starts and closed in `finally`;
 * the caller is checked again every `RECHECK_MS` and the stream ends when they no longer may.
 */
async function* busEvents(
  state: ApiState,
  c: ApiContext,
  topics: string | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<BusEnvelopeJson, void, unknown> {
  const patterns = (topics ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  // Closed when the module stops, which ends the stream.
  const sub = state.ctx.subscribe(patterns.length === 0 ? "*" : patterns);
  // A generator waiting for the next event cannot be returned from; closing the subscription
  // ends that wait.
  const close = () => sub.close();
  signal?.addEventListener("abort", close, { once: true });
  // The caller is asked about again while the stream is open: it ends with the session, when the
  // token stops matching, or when the address is locked out.
  const recheck = setInterval(() => {
    void adminStillIn(state, c).then((ok) => {
      if (!ok) close();
    }, close);
  }, RECHECK_MS);
  recheck.unref?.();
  try {
    for await (const env of sub) {
      let wire: BusEnvelopeJson;
      try {
        // As JSON reads it, so what the schema checks is what is sent.
        wire = JSON.parse(JSON.stringify(wireEnvelope(env))) as BusEnvelopeJson;
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "failed to serialize event for SSE");
        continue;
      }
      yield withEventMeta(wire, { id: env.id });
    }
  } finally {
    clearInterval(recheck);
    signal?.removeEventListener("abort", close);
    sub.close();
  }
}

/** `GET /api/events`: Server-Sent Events of bus envelopes (`HEAD` is answered by the shell). */
export const eventsRpc = os.events.handler(({ input, context, signal }) =>
  busEvents(context.state, context.c, input.query.topics, signal),
);
