// `/api/auth/*`: roles, role assignments and platform role mappings. Changes go through the
// `auth` module's `AuthService` (which keeps its cache in sync and writes the audit log); reads
// fall back to the store.

import { type AuthService, AuthServiceKey } from "@miyoria/auth";
import type { RemoveMappingRequest, UpsertRoleRequest } from "@miyoria/contracts/api";
import {
  type AuthScope,
  AuthStoreKey,
  type RoleAssignment,
  type RoleDefinition,
  type RoleMapping,
} from "@miyoria/store";
import type { AccountRef } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { scopeEquals } from "./schemas.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";

/** An assignment as the handler gets it: the scope's context has its `scope` (a DM: `null`). */
interface Assignment {
  account: AccountRef;
  role: string;
  scope: AuthScope;
}

function auth(state: ApiState): AuthService {
  return state.service(AuthServiceKey, "auth module");
}

function unknownRole(name: string): ApiError {
  return ApiError.notFound(`unknown role \`${name}\``);
}

/** Highest rank first. */
async function allRoles(state: ApiState): Promise<RoleDefinition[]> {
  const service = state.optional(AuthServiceKey);
  if (service) return service.roles();
  const store = state.service(AuthStoreKey, "auth store");
  const roles = await store.roles();
  return roles.sort((a, b) => b.rank - a.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function role(state: ApiState, name: string): Promise<RoleDefinition> {
  const found = (await allRoles(state)).find((r) => r.name === name);
  if (!found) throw unknownRole(name);
  return found;
}

async function upsertRole(
  state: ApiState,
  c: ApiContext,
  name: string,
  request: Required<UpsertRoleRequest>,
): Promise<RoleDefinition> {
  const service = auth(state);
  const definition: RoleDefinition = {
    name,
    rank: request.rank,
    grants: request.grants,
    denies: request.denies,
    builtin: false,
  };
  try {
    await service.upsertRole(actorOf(c), definition);
  } catch (error) {
    throw new ApiError(400, ApiError.internal(error).message);
  }
  const stored = service.role(name);
  if (!stored) throw unknownRole(name);
  return stored;
}

async function deleteRole(state: ApiState, c: ApiContext, name: string): Promise<void> {
  const service = auth(state);
  if (!service.role(name)) throw unknownRole(name);
  let deleted: boolean;
  try {
    deleted = await service.deleteRole(actorOf(c), name);
  } catch (error) {
    throw ApiError.conflict(ApiError.internal(error).message);
  }
  if (!deleted) throw unknownRole(name);
}

async function assignments(state: ApiState): Promise<RoleAssignment[]> {
  const store = state.service(AuthStoreKey, "auth store");
  const all = await store.allAssignments();
  all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return all;
}

async function findAssignment(
  state: ApiState,
  request: Assignment,
): Promise<RoleAssignment | undefined> {
  const store = state.service(AuthStoreKey, "auth store");
  const all = await store.assignmentsFor(request.account);
  return all.find((a) => a.role === request.role && scopeEquals(a.scope, request.scope));
}

async function assign(
  state: ApiState,
  c: ApiContext,
  request: Assignment,
): Promise<RoleAssignment> {
  const service = auth(state);
  if (!service.role(request.role)) throw unknownRole(request.role);
  if (await findAssignment(state, request)) {
    throw ApiError.conflict(
      `\`${request.account.platform}:${request.account.id}\` already has role \`${request.role}\` in that scope`,
    );
  }
  try {
    await service.assign(actorOf(c), request.account, request.role, request.scope);
  } catch (error) {
    throw ApiError.internal(error);
  }
  const stored = await findAssignment(state, request);
  if (!stored) throw new ApiError(500, "the assignment was not stored");
  return stored;
}

async function revoke(state: ApiState, c: ApiContext, request: Assignment): Promise<void> {
  const service = auth(state);
  let removed: boolean;
  try {
    removed = await service.revoke(actorOf(c), request.account, request.role, request.scope);
  } catch (error) {
    throw ApiError.internal(error);
  }
  if (!removed) throw ApiError.notFound("no such role assignment");
}

async function mappings(
  state: ApiState,
  q: { platform: string; guild: string },
): Promise<RoleMapping[]> {
  const platform = q.platform.trim();
  const guild = q.guild.trim();
  const service = state.optional(AuthServiceKey);
  if (service) return service.mappings(platform, guild);
  const store = state.service(AuthStoreKey, "auth store");
  return store.mappings(platform, guild);
}

async function setMapping(
  state: ApiState,
  c: ApiContext,
  mapping: RoleMapping,
): Promise<RoleMapping> {
  if (mapping.guild.trim() === "" || mapping.platform_role.trim() === "") {
    throw ApiError.badRequest("`guild` and `platform_role` must not be empty");
  }
  const service = auth(state);
  if (!service.role(mapping.role)) throw unknownRole(mapping.role);
  try {
    await service.mapRole(actorOf(c), { ...mapping });
  } catch (error) {
    throw ApiError.internal(error);
  }
  return mapping;
}

async function removeMapping(
  state: ApiState,
  c: ApiContext,
  request: RemoveMappingRequest,
): Promise<void> {
  const service = auth(state);
  let removed: boolean;
  try {
    removed = await service.unmapRole(
      actorOf(c),
      request.platform,
      request.guild,
      request.platform_role,
    );
  } catch (error) {
    throw ApiError.internal(error);
  }
  if (!removed) throw ApiError.notFound("no such role mapping");
}

/** The role routes on the route table (`@miyoria/contracts/api`). */
export const roleRpc = {
  list: os.roles.list.handler(({ context }) => allRoles(context.state)),
  get: os.roles.get.handler(({ input, context }) => role(context.state, input.params.name)),
  upsert: os.roles.upsert.handler(({ input, context }) =>
    recheck(context.state, upsertRole(context.state, context.c, input.params.name, input.body)),
  ),
  remove: os.roles.remove.handler(({ input, context }) =>
    recheck(context.state, deleteRole(context.state, context.c, input.params.name)),
  ),
  assignments: os.roles.assignments.handler(({ context }) => assignments(context.state)),
  assign: os.roles.assign.handler(({ input, context }) =>
    recheck(context.state, assign(context.state, context.c, input.body)),
  ),
  revoke: os.roles.revoke.handler(({ input, context }) =>
    recheck(context.state, revoke(context.state, context.c, input.body)),
  ),
  mappings: os.roles.mappings.handler(({ input, context }) => mappings(context.state, input.query)),
  setMapping: os.roles.setMapping.handler(({ input, context }) =>
    recheck(context.state, setMapping(context.state, context.c, input.body)),
  ),
  removeMapping: os.roles.removeMapping.handler(({ input, context }) =>
    recheck(context.state, removeMapping(context.state, context.c, input.body)),
  ),
};

/**
 * After a change to who holds what: every panel session is checked again on its next request, so
 * one whose tier no longer fits (a member granted panel access, an admin who lost it) ends then.
 */
async function recheck<T>(state: ApiState, change: Promise<T>): Promise<T> {
  const result = await change;
  state.auth.sessions.recheckAll();
  return result;
}
