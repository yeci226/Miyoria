// The cluster routes (docs/design/v5-hostd.md §6, §7): the machines that joined, join codes, what
// a host runs, and where each capability can be used now. They read the `cluster` module through
// `ClusterKey`; while it is not running every route answers 503.
//
// * `GET /api/cluster/hosts`, `POST /api/cluster/hosts` `{ name, capabilities }` (shows the key
//   once), `POST /api/cluster/hosts/{name}/approve` `{ capabilities }`,
//   `DELETE /api/cluster/hosts/{name}`
// * `POST /api/cluster/invites` `{ name?, ttl_s? }` (shows the code once)
// * `GET /api/cluster/hosts/{name}/info`: `host.info` over the host's link, service tokens left out
// * `POST /api/cluster/hosts/{name}/services/{service}/{action}` `{ force? }`
// * `GET /api/cluster/endpoints`: the registry's candidates, never a header
// * `POST /api/cluster/join` `{ code, name, platform?, version? }`: no session, the code is the
//   credential; every bad code is the same 403 and an address gets 5 tries a minute
//
// A host's key and its hash never leave in an answer, except the key of the two routes that make
// one. A host's service tokens never leave at all.

import {
  ClusterError,
  ClusterKey,
  type ClusterService,
  type HostRecord,
  InviteError,
} from "@miyoria/cluster";
import {
  type ClusterCreatedHost,
  type ClusterEndpoints,
  type ClusterHostInfo,
  ClusterHostInfoSchema,
  type ClusterHostView,
  type ClusterInvite,
  type ClusterJoinResult,
  type ClusterServiceResult,
} from "@miyoria/contracts/api";
import {
  HOST_ERROR_CODE,
  HOST_LINK_PATH,
  HOST_METHOD,
  HostServiceControlResultSchema,
} from "@miyoria/contracts/host";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { toTimestamp } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { clientKey } from "./public.js";
import { type ApiContext, type ApiState, actorOf, toJson } from "./state.js";

const log = getLogger("api.cluster");

/** What a join with a bad code is told, whatever was wrong with the code. */
export const BAD_CODE = "this code does not work";

const ACTIONS = ["start", "stop", "restart"] as const;
type Action = (typeof ACTIONS)[number];

function isAction(action: string): action is Action {
  return (ACTIONS as readonly string[]).includes(action);
}

function clusterOf(state: ApiState): ClusterService {
  const cluster = state.optional(ClusterKey);
  if (cluster === undefined) throw ApiError.unavailable("the cluster module is not running");
  return cluster;
}

function hostView(host: HostRecord, cluster: ClusterService): ClusterHostView {
  const link = cluster.hosts.connected().find((c) => c.name === host.name);
  return {
    id: host.id,
    name: host.name,
    status: host.status,
    capabilities: host.capabilities,
    platform: host.platform,
    version: host.version,
    created_at: host.created_at,
    last_seen_at: host.last_seen_at,
    connected: link !== undefined,
    connected_since: link === undefined ? null : toTimestamp(link.since),
  };
}

function known(cluster: ClusterService, name: string): HostRecord {
  const host = cluster.hosts.list().find((h) => h.name === name);
  if (host === undefined) throw ApiError.notFound(`no host named \`${name}\``);
  return host;
}

function connectedHost(cluster: ClusterService, name: string): HostRecord {
  const host = known(cluster, name);
  if (!cluster.hosts.connected().some((c) => c.name === name)) {
    throw ApiError.conflict(`host \`${name}\` is not connected`);
  }
  return host;
}

/** What a failed `hosts.call` is to the caller: the host's own refusal, or a bad gateway. */
function callError(error: unknown, name: string): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ClusterError) return ApiError.conflict(error.message);
  // The SDK's `RpcError`, told apart by what it carries (the api package does not depend on it).
  if (error instanceof Error && error.name === "RpcError") {
    const code = (error as Error & { code?: unknown }).code;
    switch (code) {
      case HOST_ERROR_CODE.Guarded:
      case HOST_ERROR_CODE.Busy:
      case HOST_ERROR_CODE.NotInstalled:
        return ApiError.conflict(error.message);
      case HOST_ERROR_CODE.UnknownService:
        return ApiError.notFound(error.message);
      case HOST_ERROR_CODE.NotAllowed:
        return new ApiError(403, error.message);
    }
  }
  log.warn({ host: name, error: errorMessage(error) }, "a host call failed");
  return ApiError.badGateway(error);
}

// ---- hosts ------------------------------------------------------------------------------

function hosts(state: ApiState): ClusterHostView[] {
  const cluster = clusterOf(state);
  return cluster.hosts.list().map((h) => hostView(h, cluster));
}

async function invite(
  state: ApiState,
  c: ApiContext,
  body: { name?: string | undefined; ttl_s?: number | undefined },
): Promise<ClusterInvite> {
  const cluster = clusterOf(state);
  let made: ReturnType<ClusterService["hosts"]["invite"]>;
  try {
    made = cluster.hosts.invite({ name: body.name ?? null, by: actorOf(c), ttl_s: body.ttl_s });
  } catch (error) {
    if (error instanceof ClusterError) throw ApiError.badRequest(error.message);
    throw ApiError.internal(error);
  }
  await state.audit(
    c,
    "cluster.invite",
    made.name ?? "-",
    toJson({ expires_at: made.expires_at }),
    true,
  );
  return { code: made.code, expires_at: made.expires_at };
}

async function createHost(
  state: ApiState,
  c: ApiContext,
  body: { name: string; capabilities: string[] },
): Promise<ClusterCreatedHost> {
  const cluster = clusterOf(state);
  const name = body.name.trim();
  if (cluster.hosts.list().some((h) => h.name === name)) {
    throw ApiError.conflict(`a host named \`${name}\` exists`);
  }
  let made: ReturnType<ClusterService["hosts"]["create"]>;
  try {
    made = cluster.hosts.create({ name, approved: true, capabilities: body.capabilities });
  } catch (error) {
    if (error instanceof ClusterError) throw ApiError.badRequest(error.message);
    throw ApiError.internal(error);
  }
  await state.audit(
    c,
    "cluster.host.create",
    made.host.name,
    toJson({ capabilities: made.host.capabilities }),
    true,
  );
  return { id: made.host.id, name: made.host.name, key: made.key };
}

async function approve(
  state: ApiState,
  c: ApiContext,
  name: string,
  capabilities: string[],
): Promise<ClusterHostView> {
  const cluster = clusterOf(state);
  const host = known(cluster, name);
  if (host.status === "revoked") {
    throw ApiError.conflict(`host \`${name}\` was revoked: it has to join again`);
  }
  let approved: HostRecord;
  try {
    approved = cluster.hosts.approve(name, capabilities);
  } catch (error) {
    if (error instanceof ClusterError) throw ApiError.conflict(error.message);
    throw ApiError.internal(error);
  }
  await state.audit(c, "cluster.host.approve", name, toJson({ capabilities }), true);
  return hostView(approved, cluster);
}

async function remove(state: ApiState, c: ApiContext, name: string): Promise<void> {
  const cluster = clusterOf(state);
  const removed = cluster.hosts.remove(name);
  if (removed === null) throw ApiError.notFound(`no host named \`${name}\``);
  await state.audit(c, "cluster.host.remove", name, {}, true);
}

// ---- what a host says and does ---------------------------------------------------------

async function info(state: ApiState, name: string): Promise<ClusterHostInfo> {
  const cluster = clusterOf(state);
  connectedHost(cluster, name);
  let answer: unknown;
  try {
    answer = await cluster.hosts.call(name, HOST_METHOD.Info, null);
  } catch (error) {
    throw callError(error, name);
  }
  // The schema has no `token`, so parsing strips the service tokens a report may carry.
  const parsed = ClusterHostInfoSchema.safeParse(answer);
  if (!parsed.success) {
    throw ApiError.badGateway(
      new Error(`host \`${name}\` answered host.info with something unreadable`),
    );
  }
  return parsed.data;
}

async function serviceAction(
  state: ApiState,
  c: ApiContext,
  name: string,
  service: string,
  action: string,
  force: boolean | undefined,
): Promise<ClusterServiceResult> {
  if (!isAction(action)) {
    throw ApiError.notFound(`unknown action \`${action}\` (expected start, stop or restart)`);
  }
  const cluster = clusterOf(state);
  connectedHost(cluster, name);
  const params = force === undefined ? { service } : { service, force };
  const target = `${name}/${service}`;
  let answer: unknown;
  try {
    answer = await cluster.hosts.call(name, `service.${action}`, params);
  } catch (error) {
    const failure = callError(error, name);
    await state.audit(
      c,
      `cluster.service.${action}`,
      target,
      toJson({ force, error: failure.message }),
      false,
    );
    throw failure;
  }
  const parsed = HostServiceControlResultSchema.safeParse(answer);
  if (!parsed.success) {
    await state.audit(
      c,
      `cluster.service.${action}`,
      target,
      toJson({ force, error: "unreadable answer" }),
      false,
    );
    throw ApiError.badGateway(
      new Error(`host \`${name}\` answered service.${action} with something unreadable`),
    );
  }
  await state.audit(c, `cluster.service.${action}`, target, toJson({ force }), true);
  return parsed.data;
}

function endpoints(state: ApiState): ClusterEndpoints {
  const { registry } = clusterOf(state);
  return {
    capabilities: registry.capabilities().map((capability) => ({
      capability,
      // Never `headers`: they hold the services' tokens. A `link` endpoint's url is an address on
      // the host itself, so only a direct one is shown.
      candidates: registry.candidates(capability).map((e) => ({
        host: e.host,
        service: e.service,
        via: e.via,
        healthy: e.healthy,
        version: e.version,
        ...(e.via === "direct" ? { url: e.url } : {}),
      })),
    })),
  };
}

// ---- joining ------------------------------------------------------------------------------

/** The address a joining machine should dial: `public_url`, else the host it reached Core by. */
function linkUrl(cluster: ClusterService, c: ApiContext): string {
  if (cluster.publicUrl !== null) return cluster.publicUrl;
  let hostname: string | null = null;
  const header = c.req.header("host");
  if (header !== undefined && /^[A-Za-z0-9.:[\]-]+$/.test(header)) {
    try {
      hostname = new URL(`http://${header}`).hostname;
    } catch {
      hostname = null;
    }
  }
  if (hostname === null || hostname === "") {
    const bound = cluster.address.address;
    hostname = bound === "0.0.0.0" || bound === "::" ? "127.0.0.1" : bound;
  }
  if (hostname.includes(":") && !hostname.startsWith("[")) hostname = `[${hostname}]`;
  return `ws://${hostname}:${cluster.address.port}${HOST_LINK_PATH}`;
}

async function join(
  state: ApiState,
  c: ApiContext,
  body: { code: string; name: string },
): Promise<ClusterJoinResult> {
  // First, before anything else: an address over its limit gets nothing but the 429.
  const wait = state.publicSide.admitJoin(clientKey(c));
  if (wait !== null) throw ApiError.tooMany(wait);
  const cluster = clusterOf(state);
  let made: ReturnType<ClusterService["hosts"]["redeem"]>;
  try {
    made = cluster.hosts.redeem(body.code, body.name);
  } catch (error) {
    if (error instanceof InviteError) throw new ApiError(403, BAD_CODE);
    // A good code with a name that cannot be used: only a holder of a code gets to say.
    if (error instanceof ClusterError) throw ApiError.conflict(error.message);
    throw ApiError.internal(error);
  }
  await state.auditAs(`host:${made.host.name}`, "cluster.join", made.host.name, {}, true);
  return { host_id: made.host.id, key: made.key, link_url: linkUrl(cluster, c) };
}

/** The cluster routes on the route table (`@miyoria/contracts/api`). */
export const clusterRpc = {
  hosts: os.cluster.hosts.handler(({ context }) => hosts(context.state)),
  invite: os.cluster.invite.handler(({ input, context }) =>
    invite(context.state, context.c, input.body),
  ),
  create: os.cluster.create.handler(({ input, context }) =>
    createHost(context.state, context.c, input.body),
  ),
  approve: os.cluster.approve.handler(({ input, context }) =>
    approve(context.state, context.c, input.params.name, input.body.capabilities),
  ),
  remove: os.cluster.remove.handler(({ input, context }) =>
    remove(context.state, context.c, input.params.name),
  ),
  info: os.cluster.info.handler(({ input, context }) => info(context.state, input.params.name)),
  service: os.cluster.service.handler(({ input, context }) =>
    serviceAction(
      context.state,
      context.c,
      input.params.name,
      input.params.service,
      input.params.action,
      input.body.force,
    ),
  ),
  endpoints: os.cluster.endpoints.handler(({ context }) => endpoints(context.state)),
  join: os.cluster.join.handler(({ input, context }) => join(context.state, context.c, input.body)),
};
