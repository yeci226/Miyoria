// Health and the panel login: what the Core is, how one may log in, and who the caller is.

import { z } from "zod";
import { route } from "./route.js";

/** `GET /api/health`. */
export const HealthInfoSchema = z
  .object({ status: z.string(), version: z.string() })
  .meta({ id: "ApiHealthInfo" });
export type HealthInfo = z.output<typeof HealthInfoSchema>;

/** `GET /api/auth/methods`: which panel logins this Core offers. */
export const AuthMethodsSchema = z
  .object({
    /** The static bearer token always works. */
    token: z.boolean(),
    /** Discord OAuth2 (`[modules.api.discord_oauth]` is configured). */
    discord: z.boolean(),
  })
  .meta({ id: "ApiAuthMethods" });
export type AuthMethods = z.output<typeof AuthMethodsSchema>;

export const SessionUserSchema = z
  .object({
    /** Discord user id. */
    id: z.string(),
    name: z.string(),
    avatar_url: z.string().nullable(),
  })
  .meta({ id: "ApiSessionUser" });
export type SessionUser = z.output<typeof SessionUserSchema>;

export const SessionPermissionsSchema = z
  .object({
    /** May use changing routes (`admin.panel.write`; always for the token). */
    write: z.boolean(),
  })
  .meta({ id: "ApiSessionPermissions" });
export type SessionPermissions = z.output<typeof SessionPermissionsSchema>;

/** `GET /api/auth/session`: who the caller is. */
export const SessionInfoSchema = z
  .object({
    method: z.enum(["token", "discord"]),
    /** The Discord user; `null` for the bearer token. */
    user: SessionUserSchema.nullable(),
    permissions: SessionPermissionsSchema,
  })
  .meta({ id: "ApiSessionInfo" });
export type SessionInfo = z.output<typeof SessionInfoSchema>;

export const health = route
  .meta({ audience: "public", permission: null })
  .route({ method: "GET", path: "/api/health" })
  .output(HealthInfoSchema);

export const auth = {
  methods: route
    .meta({ audience: "public", permission: null })
    .route({ method: "GET", path: "/api/auth/methods" })
    .output(AuthMethodsSchema),
  session: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/auth/session" })
    .output(SessionInfoSchema),
};
