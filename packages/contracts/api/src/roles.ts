// Roles, who holds them, and how a platform's roles map to hers (`/api/auth/roles`,
// `/api/auth/assignments`, `/api/auth/mappings`). The changes go through the auth module, which
// keeps its cache in sync and writes the audit log.

import { z } from "zod";
import { AccountRefSchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { ContextKeyInSchema } from "./shared.js";

/** A role and the permission nodes it grants. */
export const RoleDefinitionSchema = z
  .object({
    name: z.string(),
    /** Higher outranks lower (owner 100, admin 80, moderator 60, trusted 40, user 20, ...). */
    rank: z.number(),
    /** Node patterns; one may end in `.*` or be `*`. */
    grants: z.array(z.string()),
    denies: z.array(z.string()),
    /** A built-in role can be edited but not deleted. */
    builtin: z.boolean(),
  })
  .meta({ id: "ApiRoleDefinition" });
export type RoleDefinition = z.output<typeof RoleDefinitionSchema>;

/** Where a role applies. */
export const AuthScopeSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("global") }),
    z.object({ type: z.literal("guild"), platform: z.string(), guild: z.string() }),
    z.object({ type: z.literal("channel"), context: ContextKeyInSchema }),
  ])
  .meta({ id: "ApiAuthScope" });
export type AuthScope = z.output<typeof AuthScopeSchema>;

/** One account holding one role in one scope. */
export const RoleAssignmentSchema = z
  .object({
    account: AccountRefSchema,
    role: z.string(),
    scope: AuthScopeSchema,
    /** Who gave it: `discord:123`, `config`, ... */
    granted_by: z.string(),
    at: TimestampSchema,
  })
  .meta({ id: "ApiRoleAssignment" });
export type RoleAssignment = z.output<typeof RoleAssignmentSchema>;

/** Body of `POST` and `DELETE /api/auth/assignments`. */
export const AssignRoleRequestSchema = z
  .object({ account: AccountRefSchema, role: z.string(), scope: AuthScopeSchema })
  .meta({ id: "ApiAssignRoleRequest" });
export type AssignRoleRequest = z.input<typeof AssignRoleRequestSchema>;

/** Body of `PUT /api/auth/roles/{name}`: a role that is not built in, created or replaced. */
export const UpsertRoleRequestSchema = z
  .object({
    rank: z.number().int(),
    grants: z.array(z.string()).default([]),
    denies: z.array(z.string()).default([]),
  })
  .meta({ id: "ApiUpsertRoleRequest" });
export type UpsertRoleRequest = z.input<typeof UpsertRoleRequestSchema>;

/** A platform role (a Discord role id) and the role of hers it stands for, per guild. */
export const RoleMappingSchema = z
  .object({
    platform: z.string(),
    guild: z.string(),
    platform_role: z.string(),
    role: z.string(),
  })
  .meta({ id: "ApiRoleMapping" });
export type RoleMapping = z.output<typeof RoleMappingSchema>;

/** Body of `DELETE /api/auth/mappings`. */
export const RemoveMappingRequestSchema = z
  .object({ platform: z.string(), guild: z.string(), platform_role: z.string() })
  .meta({ id: "ApiRemoveMappingRequest" });
export type RemoveMappingRequest = z.input<typeof RemoveMappingRequestSchema>;

const RoleParams = z.object({ name: z.string() });

export const roles = {
  /** Every role, highest rank first. */
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/auth/roles" })
    .output(z.array(RoleDefinitionSchema)),
  get: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/auth/roles/{name}" })
    .input(z.object({ params: RoleParams }))
    .output(RoleDefinitionSchema),
  /** `400` when the auth module refuses the role (a node that is not a pattern). */
  upsert: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "PUT", path: "/api/auth/roles/{name}" })
    .input(z.object({ params: RoleParams, body: UpsertRoleRequestSchema }))
    .output(RoleDefinitionSchema),
  /** No content. `409` for a built-in role. */
  remove: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "DELETE", path: "/api/auth/roles/{name}", successStatus: 204 })
    .input(z.object({ params: RoleParams })),
  /** Newest first. */
  assignments: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/auth/assignments" })
    .output(z.array(RoleAssignmentSchema)),
  /** `409` when the account already holds the role in that scope. */
  assign: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/auth/assignments" })
    .input(z.object({ body: AssignRoleRequestSchema }))
    .output(RoleAssignmentSchema),
  /** No content. */
  revoke: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "DELETE", path: "/api/auth/assignments", successStatus: 204 })
    .input(z.object({ body: AssignRoleRequestSchema })),
  /** The mappings of one guild. */
  mappings: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/auth/mappings" })
    .input(
      z.object({
        query: z.object({
          platform: z.string({ error: "missing field `platform`" }),
          guild: z.string({ error: "missing field `guild`" }),
        }),
      }),
    )
    .output(z.array(RoleMappingSchema)),
  setMapping: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "PUT", path: "/api/auth/mappings" })
    .input(z.object({ body: RoleMappingSchema }))
    .output(RoleMappingSchema),
  /** No content. */
  removeMapping: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "DELETE", path: "/api/auth/mappings", successStatus: 204 })
    .input(z.object({ body: RemoveMappingRequestSchema })),
};
