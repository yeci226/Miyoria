// Module `auth`: role-based permissions.

import {
  AuthorizerPreloadKey,
  CommandRegistryKey,
  CommandsModule,
  parseAccount as parseCommandsAccount,
} from "@miyoria/commands";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
  type ModuleManifest,
  withTimeout,
} from "@miyoria/runtime/kernel";
import { AuditLogKey, AuthStoreKey } from "@miyoria/store";
import { type AccountRef, AuthorizerKey, Events, is, serviceKey } from "@miyoria/types";
import { z } from "zod";
import { USER } from "./builtin.js";
import { AuthCommands } from "./commands.js";
import { accountKey } from "./resolve.js";
import { AuthService } from "./service.js";

/** How long the initial seed and load may take. */
export const LOAD_TIMEOUT_MS = 15_000;

/**
 * `[modules.auth]` config section.
 *
 * ```toml
 * [modules.auth]
 * owners = ["discord:123456789012345678"]
 * default_role = "user"
 * refresh_secs = 300
 * ```
 */
export const AuthConfigSchema = z.object({
  /**
   * Accounts that are always `owner`, as `"platform:id"`. Owners listed in
   * `[modules.commands] owners` count too.
   */
  owners: z.array(z.string()).default([]),
  /** Role of accounts nothing else applies to. */
  default_role: z.string().default(USER),
  /** Re-read the store this often to pick up changes made elsewhere; 0 turns it off. */
  refresh_secs: z.number().int().nonnegative().default(300),
});

/** The `AuthService` (cached roles, assignments, overrides and management API). */
export const AuthServiceKey = serviceKey<AuthService>("AuthService");

/** Parses `"platform:id"` into an `AccountRef`. */
export function parseAccount(s: string): AccountRef {
  try {
    return parseCommandsAccount(s);
  } catch {
    throw new Error(`invalid account \`${s}\`, expected \`platform:id\``);
  }
}

/**
 * Module `auth`: role-based permissions.
 *
 * Requires the `AuthStore` service and uses `AuditLog` when present. Provides `AuthService` and
 * `Authorizer` (replacing the `commands` module's fallback), `AuthorizerPreload` and the
 * `admin role` / `admin perm` commands.
 */
export class AuthModule implements Module {
  static readonly ID = "auth";

  readonly manifest: ModuleManifest = defineManifest(AuthModule.ID, "Permissions", {
    icon: "key-round",
    category: "system",
    description: "Roles, permission nodes and platform role mappings",
    // Started after `commands` so its authorizer replaces the fallback.
    optional: [CommandsModule.ID],
    configSchema: AuthConfigSchema,
  });

  readonly #commands = new AuthCommands();

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(AuthConfigSchema);
    const configOwners = config.owners.map(parseAccount);
    const store = ctx.services.require(AuthStoreKey);
    const audit = ctx.services.get(AuditLogKey) ?? null;
    if (audit === null) {
      ctx.log.warn("AuditLog service missing; permission changes are not audited");
    }
    const service = await withTimeout(
      AuthService.load(store, audit, allOwners(ctx, configOwners), config.default_role, {
        clock: ctx.clock,
      }),
      LOAD_TIMEOUT_MS,
    );
    if (service === undefined) throw new Error("loading permissions timed out");

    ctx.provide(AuthServiceKey, service);
    ctx.provide(AuthorizerKey, service);
    ctx.provide(AuthorizerPreloadKey, service);
    this.#commands.install(ctx.services, service);

    const events = ctx.subscribe(Events.SystemModuleState.type);
    ctx.spawn("events", async () => {
      for await (const env of events) {
        if (
          is(Events.SystemModuleState, env) &&
          env.data.module === CommandsModule.ID &&
          env.data.state === "running"
        ) {
          service.setOwners(allOwners(ctx, configOwners));
          this.#commands.install(ctx.services, service);
        }
      }
    });

    if (config.refresh_secs > 0) {
      ctx.spawn("refresh", async (signal) => {
        for await (const _ of interval(config.refresh_secs * 1000, signal)) {
          service.setOwners(allOwners(ctx, configOwners));
          try {
            await service.reload();
          } catch (error) {
            ctx.log.warn({ error: errorMessage(error) }, "cannot refresh permissions");
          }
        }
      });
    }
  }

  async stop(): Promise<void> {
    this.#commands.uninstall();
  }
}

/** Config owners plus `[modules.commands] owners`, if that module runs. */
function allOwners(ctx: ModuleContext, configOwners: readonly AccountRef[]): AccountRef[] {
  const owners = new Map<string, AccountRef>();
  for (const owner of configOwners) owners.set(accountKey(owner), owner);
  const registry = ctx.services.get(CommandRegistryKey);
  if (registry) {
    for (const owner of registry.permissions().owners()) owners.set(accountKey(owner), owner);
  }
  return [...owners.values()];
}
