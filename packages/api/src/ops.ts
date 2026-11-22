// Live operation: extensions, MCP servers, the request queue, the stage (VTube Studio / OBS) and
// the voice monitor, all on the route table (`@miyoria/contracts/api`). Scene, stream and say go
// through the actuator registry's gate (principal `panel`).

import type {
  ExtensionInfo,
  McpServerInfo,
  McpState,
  QueueState,
  SceneRolesState,
  StageLinkState,
  StageState,
  StreamAction,
  VoiceState,
} from "@miyoria/contracts/api";
import { ActuatorRegistryKey } from "@miyoria/gate/actions";
import { type ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import { type RequestQueue, RequestQueueKey } from "@miyoria/play/queue";
import {
  type CatalogEntry,
  ExtensionCatalogKey,
  extensionModuleId,
} from "@miyoria/plugin-host/ext-host";
import { type ServerStatus as McpServerStatus, McpStatusKey } from "@miyoria/plugin-host/mcp";
import { errorMessage, getLogger, type ModuleStatus, SupervisorKey } from "@miyoria/runtime/kernel";
import {
  defaultStageStatus,
  SceneRoleError,
  type SceneRoles,
  SceneRolesKey,
  type StageLink,
  StageLinkKey,
} from "@miyoria/stage";
import {
  type ContextKey,
  contextKeyString,
  type JsonObject,
  newId,
  PlacesKey,
  PlatformSinksKey,
  Principals,
  VoiceSinkKey,
} from "@miyoria/types";
import { os } from "./contract.js";
import { runModuleAction } from "./core.js";
import { ApiError } from "./errors.js";
import { isQueueNotFound, MCP_MODULE_ID } from "./services.js";
import { adminSpace } from "./space-param.js";
import { type ApiContext, type ApiState, actorOf, toJson } from "./state.js";

const log = getLogger("api.ops");

const MAX_SAY_CHARS = 500;

// ---- extensions -------------------------------------------------------------------------

function permissions(entry: CatalogEntry): string[] {
  const granted = entry.spec.granted;
  const out: string[] = [];
  if (granted.tools) out.push("tools");
  if (granted.commands) out.push("commands");
  for (const e of granted.events) out.push(`events:${e}`);
  for (const n of granted.network) out.push(`network:${n}`);
  for (const i of granted.input) out.push(`input:${i}`);
  return out;
}

function extensionInfo(entry: CatalogEntry, status: ModuleStatus | undefined): ExtensionInfo {
  const manifest = entry.spec.manifest;
  return {
    id: manifest.id,
    module: extensionModuleId(entry.spec),
    name: manifest.name ?? manifest.id,
    version: manifest.version,
    description: manifest.description ?? "",
    source: entry.spec.dir,
    enabled: status?.enabled ?? false,
    state: status?.state ?? "disabled",
    reason: status ? status.reason : "not registered with the supervisor",
    permissions: permissions(entry),
  };
}

function extensions(state: ApiState): ExtensionInfo[] {
  const catalog = state.service(ExtensionCatalogKey, "extension host");
  const sup = state.service(SupervisorKey, "supervisor");
  const modules = sup.list();
  return catalog.entries.map((e) => {
    const id = extensionModuleId(e.spec);
    return extensionInfo(
      e,
      modules.find((m) => m.id === id),
    );
  });
}

async function extensionAction(
  state: ApiState,
  c: ApiContext,
  id: string,
  action: string,
): Promise<ExtensionInfo> {
  const catalog = state.service(ExtensionCatalogKey, "extension host");
  const entry = catalog.entries.find(
    (e) => e.spec.manifest.id === id || extensionModuleId(e.spec) === id,
  );
  if (!entry) throw ApiError.notFound(`unknown extension \`${id}\``);
  const status = await runModuleAction(
    state,
    c,
    extensionModuleId(entry.spec),
    action,
    "extension",
  );
  return extensionInfo(entry, status);
}

// ---- MCP --------------------------------------------------------------------------------

function mcpInfo(s: McpServerStatus, tools: ToolRegistry | undefined): McpServerInfo {
  const states: Record<McpServerStatus["state"], McpState> = {
    disabled: "disabled",
    connecting: "connecting",
    connected: "ready",
    failed: "failed",
  };
  return {
    name: s.name,
    transport: s.transport,
    target: s.target ?? null,
    enabled: s.state !== "disabled",
    state: states[s.state],
    error: s.last_error,
    tools: s.tools.map((name) => ({
      name,
      description: tools?.get(name)?.spec.description ?? "",
    })),
    remote_tool_count: s.remote_tool_count,
    permission: s.permission,
    reconnects: s.reconnects,
  };
}

function mcpServers(state: ApiState): McpServerInfo[] {
  const status = state.service(McpStatusKey, "MCP module");
  const tools = state.optional(ToolRegistryKey);
  return status.servers().map((s) => mcpInfo(s, tools));
}

/**
 * Only `restart` is supported (it restarts the whole `mcp` module); turning single servers on
 * or off is configuration (`[mcp.servers.<name>] enabled`).
 */
async function mcpAction(
  state: ApiState,
  c: ApiContext,
  name: string,
  action: string,
): Promise<McpServerInfo> {
  const status = state.service(McpStatusKey, "MCP module");
  if (!status.server(name)) throw ApiError.notFound(`unknown MCP server \`${name}\``);
  if (action === "enable" || action === "disable") {
    throw ApiError.conflict(
      `MCP servers are turned on and off in miyoria.toml (\`[mcp.servers.${name}] enabled\`); only restart is available at runtime`,
    );
  }
  if (action !== "restart") {
    throw ApiError.notFound(`unknown action \`${action}\` (expected enable, disable or restart)`);
  }
  await runModuleAction(state, c, MCP_MODULE_ID, "restart", "mcp");
  // The restarted module provides a fresh status.
  const fresh = state.service(McpStatusKey, "MCP module");
  const server = fresh.server(name);
  if (!server) throw ApiError.unavailable(`MCP server \`${name}\` is restarting`);
  return mcpInfo(server, state.optional(ToolRegistryKey));
}

// ---- request queue ----------------------------------------------------------------------

/** One Space's queue (identity's id; `null`: the default, the primary's). */
function queueState(queue: RequestQueue, space: string | null): QueueState {
  return {
    paused: queue.isPaused(space),
    items: queue.list(space).map((i) => ({
      id: String(i.id),
      kind: i.kind,
      context: i.context,
      author: { account: i.requester, display_name: i.requester_name },
      text: i.text,
      priority: i.priority,
      enqueued_at: i.created_at,
      state: i.state,
      votes: i.votes,
    })),
  };
}

function queueError(error: unknown): ApiError {
  return isQueueNotFound(error)
    ? ApiError.notFound(errorMessage(error))
    : ApiError.conflict(errorMessage(error));
}

/** The Space `?space=` names (checked: `404` for one she is not in); `null`: the default. */
function queueSpace(state: ApiState, requested: string | undefined): string | null {
  if (state.optional(PlacesKey) === undefined) return null;
  return adminSpace(state, requested)?.id ?? null;
}

function queue(state: ApiState, requested: string | undefined): QueueState {
  const space = queueSpace(state, requested);
  return queueState(state.service(RequestQueueKey, "request queue"), space);
}

async function setPaused(
  state: ApiState,
  c: ApiContext,
  paused: boolean,
  requested: string | undefined,
): Promise<QueueState> {
  const q = state.service(RequestQueueKey, "request queue");
  const space = queueSpace(state, requested);
  if (paused) q.pause(space);
  else q.resume(space);
  const detail: JsonObject = space === null ? {} : { space };
  await state.audit(c, paused ? "queue.pause" : "queue.resume", "queue", detail, true);
  return queueState(q, space);
}

/** `POST /api/queue/{id}/skip` and `POST /api/queue/{id}/move` (to `position`). */
async function queueItemAction(
  state: ApiState,
  c: ApiContext,
  id: string,
  action: "skip" | "move",
  position: number,
): Promise<QueueState> {
  const q = state.service(RequestQueueKey, "request queue");
  const digits = id.trim().replace(/^#+/, "");
  if (!/^\+?\d+$/.test(digits)) throw ApiError.notFound(`no item #${id}`);
  const item = Number.parseInt(digits, 10);
  // The answer is the queue the item is in, whichever Space's.
  const space = q.get(item)?.space ?? null;
  let failure: unknown = null;
  let detail: Record<string, unknown>;
  if (action === "skip") {
    detail = {};
    try {
      q.skip(item);
    } catch (error) {
      failure = error;
    }
  } else {
    // The listing puts active items first; `moveItem` counts pending items only.
    const active = q.list(space).filter((i) => i.state === "active").length;
    detail = { position };
    try {
      q.moveItem(item, Math.max(position - active, 0));
    } catch (error) {
      failure = error;
    }
  }
  if (!(failure !== null && isQueueNotFound(failure))) {
    if (failure !== null) detail.error = errorMessage(failure);
    await state.audit(c, `queue.${action}`, String(item), toJson(detail), failure === null);
  }
  if (failure !== null) throw queueError(failure);
  return queueState(q, space);
}

// ---- stage ------------------------------------------------------------------------------

function stageState(state: ApiState, link: StageLink): StageState {
  const node = link.node()?.[0] ?? null;
  const status = link.status() ?? defaultStageStatus();
  const part = (connected: boolean, what: string): StageLinkState => ({
    connected: node !== null && connected,
    error:
      node === null
        ? "stage node not connected"
        : connected
          ? null
          : `${what} is not connected on the stage node`,
  });
  return {
    vts: part(status.vts, "VTube Studio"),
    obs: part(status.obs, "OBS"),
    scene: status.scene,
    // Empty (and `null`) from nodes older than these fields.
    scenes: node !== null && status.obs ? [...status.scenes] : [],
    expression: state.monitor.expression(),
    expressions: node !== null && status.vts ? [...status.hotkeys] : [],
    emotions: [...state.emotions],
    overlay_url: node !== null ? status.overlay_url : null,
    speaking: state.monitor.speaking(),
    node,
    streaming: status.streaming,
    obs_warning: node !== null && status.obs ? status.obs_warning : null,
  };
}

function stageLink(state: ApiState): StageLink {
  return state.service(StageLinkKey, "stage link");
}

function stage(state: ApiState): StageState {
  return stageState(state, stageLink(state));
}

function requireObs(state: ApiState, link: StageLink): void {
  const current = stageState(state, link);
  if (!current.obs.connected) {
    throw ApiError.conflict(current.obs.error ?? "OBS is not connected");
  }
}

async function stageScene(state: ApiState, c: ApiContext, name: string): Promise<StageState> {
  const scene = name.trim();
  if (scene === "") throw ApiError.badRequest("`scene` must not be empty");
  const link = stageLink(state);
  requireObs(state, link);
  const failure = await act(state, c, "stage.scene", { name: scene });
  await state.audit(c, "stage.scene", scene, {}, failure === null);
  if (failure !== null) throw failure;
  return stageState(state, link);
}

/**
 * Runs a capability through the gate as the panel (principal `panel`, the request's actor, in
 * `context` when given). Returns the capability's result text, or the error to answer with.
 */
export async function actAs(
  state: ApiState,
  c: ApiContext,
  capability: string,
  args: JsonObject,
  context: ContextKey | null = null,
): Promise<{ text: string; error: null } | { text: null; error: ApiError }> {
  const actuators = state.service(ActuatorRegistryKey, "actuator registry");
  const outcome = await actuators.invoke({
    principal: Principals.panel(actorOf(c), context),
    capability,
    args,
    why: "admin panel",
    turn: null,
  });
  switch (outcome.status) {
    case "done":
      return { text: outcome.result.text, error: null };
    case "denied":
      return {
        text: null,
        error:
          outcome.decision.stage === "args"
            ? ApiError.badRequest(outcome.decision.reason)
            : outcome.decision.stage === "unknown"
              ? ApiError.unavailable(`\`${capability}\` is not available`)
              : ApiError.conflict(`refused by the gate: ${outcome.decision.reason}`),
      };
    case "failed":
      return { text: null, error: ApiError.badGateway(outcome.cause) };
  }
}

/** `actAs` for routes that only need to know whether it ran: the error, or `null`. */
async function act(
  state: ApiState,
  c: ApiContext,
  capability: string,
  args: JsonObject,
): Promise<ApiError | null> {
  return (await actAs(state, c, capability, args)).error;
}

function sceneRoles(state: ApiState): SceneRoles {
  return state.service(SceneRolesKey, "stage link");
}

function scenesState(roles: SceneRoles): SceneRolesState {
  return roles.view();
}

/** The panel's choice of scene for a role (`scene: null` = back to the classification). */
async function setSceneRole(
  state: ApiState,
  c: ApiContext,
  request: { role: string; scene: string | null },
): Promise<SceneRolesState> {
  const roles = sceneRoles(state);
  const role = request.role.trim().toLowerCase();
  let failure: unknown = null;
  try {
    await roles.set(role, request.scene === null ? null : request.scene.trim());
  } catch (error) {
    failure = error;
  }
  await state.audit(c, "stage.scene_role", role, { scene: request.scene }, failure === null);
  if (failure instanceof SceneRoleError) throw ApiError.badRequest(failure.message);
  if (failure !== null) throw ApiError.badGateway(failure);
  return scenesState(roles);
}

async function classifyScenes(state: ApiState, c: ApiContext): Promise<SceneRolesState> {
  const roles = sceneRoles(state);
  let failure: unknown = null;
  try {
    await roles.classify();
  } catch (error) {
    failure = error;
  }
  await state.audit(c, "stage.scene_classify", "scenes", {}, failure === null);
  if (failure instanceof SceneRoleError) throw ApiError.conflict(failure.message);
  if (failure !== null) throw ApiError.badGateway(failure);
  return scenesState(roles);
}

async function stageStream(
  state: ApiState,
  c: ApiContext,
  action: StreamAction,
): Promise<StageState> {
  const link = stageLink(state);
  requireObs(state, link);
  const failure = await act(state, c, "stage.stream", { action });
  await state.audit(c, "stage.stream", action, {}, failure === null);
  if (failure !== null) throw failure;
  return stageState(state, link);
}

async function stageExpression(state: ApiState, c: ApiContext, asked: string): Promise<StageState> {
  const expression = asked.trim();
  if (expression === "") throw ApiError.badRequest("`expression` must not be empty");
  const link = stageLink(state);
  const current = stageState(state, link);
  if (!current.vts.connected) {
    throw ApiError.conflict(current.vts.error ?? "VTube Studio is not connected");
  }
  let failure: unknown = null;
  try {
    await link.hotkey(expression);
  } catch (error) {
    failure = error;
  }
  await state.audit(c, "stage.expression", expression, {}, failure === null);
  if (failure !== null) throw ApiError.badGateway(failure);
  state.monitor.setExpression(expression);
  return stageState(state, link);
}

/**
 * Speaks `text` through TTS in the voice channel she is in, without the LLM. Returns as soon as
 * speaking started; the turn id correlates the `voice.playback` events.
 */
async function stageSay(
  state: ApiState,
  c: ApiContext,
  request: { text: string; emotion?: string | null | undefined },
): Promise<{ turn: string }> {
  const text = request.text.trim();
  if (text === "") throw ApiError.badRequest("`text` must not be empty");
  if ([...text].length > MAX_SAY_CHARS) {
    throw ApiError.badRequest(`\`text\` is longer than ${MAX_SAY_CHARS} characters`);
  }
  const emotion = request.emotion?.trim().toLowerCase() || null;
  if (emotion !== null && state.emotions.length > 0 && !state.emotions.includes(emotion)) {
    throw ApiError.badRequest(
      `unknown emotion \`${emotion}\` (the avatar knows ${state.emotions.join(", ")})`,
    );
  }
  state.service(VoiceSinkKey, "voice module");
  const context = state.monitor.voiceContext();
  if (!context) throw ApiError.conflict("she is not in a voice channel");
  const turn = newId();
  // `speak` returns as soon as speaking was handed to the voice module.
  const failure = await act(state, c, "speak", {
    context: { ...context },
    text,
    emotion,
    turn,
  });
  await state.audit(
    c,
    "stage.say",
    contextKeyString(context),
    { text, emotion, turn },
    failure === null,
  );
  if (failure !== null) {
    log.warn({ error: failure.message }, "speaking from the API failed");
    throw failure;
  }
  return { turn };
}

// ---- voice ------------------------------------------------------------------------------

async function voice(state: ApiState): Promise<VoiceState> {
  const body = state.monitor.voice(state.now());
  const sinks = state.optional(PlatformSinksKey);
  await Promise.all(
    body.sessions.map(async (s) => {
      try {
        s.label = await state.labels.label(sinks, s.context);
      } catch {
        s.label = null;
      }
    }),
  );
  return body;
}

/** The ops routes on the route table (`@miyoria/contracts/api`). */
export const opsRpc = {
  extensions: {
    list: os.extensions.list.handler(({ context }) => extensions(context.state)),
    action: os.extensions.action.handler(({ input, context }) =>
      extensionAction(context.state, context.c, input.params.id, input.params.action),
    ),
  },
  mcp: {
    list: os.mcp.list.handler(({ context }) => mcpServers(context.state)),
    action: os.mcp.action.handler(({ input, context }) =>
      mcpAction(context.state, context.c, input.params.name, input.params.action),
    ),
  },
  queue: {
    list: os.queue.list.handler(({ input, context }) => queue(context.state, input?.query?.space)),
    pause: os.queue.pause.handler(({ input, context }) =>
      setPaused(context.state, context.c, true, input?.query?.space),
    ),
    resume: os.queue.resume.handler(({ input, context }) =>
      setPaused(context.state, context.c, false, input?.query?.space),
    ),
    skip: os.queue.skip.handler(({ input, context }) =>
      queueItemAction(context.state, context.c, input.params.id, "skip", 0),
    ),
    move: os.queue.move.handler(({ input, context }) =>
      queueItemAction(context.state, context.c, input.params.id, "move", input.body.position),
    ),
  },
  stage: {
    status: os.stage.status.handler(({ context }) => stage(context.state)),
    scene: os.stage.scene.handler(({ input, context }) =>
      stageScene(context.state, context.c, input.body.scene),
    ),
    scenes: os.stage.scenes.handler(({ context }) => scenesState(sceneRoles(context.state))),
    setSceneRole: os.stage.setSceneRole.handler(({ input, context }) =>
      setSceneRole(context.state, context.c, input.body),
    ),
    classify: os.stage.classify.handler(({ context }) => classifyScenes(context.state, context.c)),
    expression: os.stage.expression.handler(({ input, context }) =>
      stageExpression(context.state, context.c, input.body.expression),
    ),
    stream: os.stage.stream.handler(({ input, context }) =>
      stageStream(context.state, context.c, input.body.action),
    ),
    say: os.stage.say.handler(({ input, context }) =>
      stageSay(context.state, context.c, input.body),
    ),
  },
  /** The monitor; `control.ts` adds the controls. */
  voice: {
    state: os.voice.state.handler(({ context }) => voice(context.state)),
  },
};
