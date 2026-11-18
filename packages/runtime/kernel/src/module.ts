import type { JsonObject, JsonValue, ModuleId, Principal, Timestamp } from "@miyoria/types";
import type { z } from "zod";
import { configJsonSchema } from "./config-schema.js";
import type { ModuleContext } from "./context.js";

export interface ModuleManifest {
  /** Stable id (e.g. `"platform.discord.bot"`); also `[modules.<id>]`. */
  readonly id: ModuleId;
  readonly name: string;
  readonly description: string;
  /** Must be running for this module to start. Disabling one of these stops this module too. */
  readonly requires: readonly ModuleId[];
  /** Started first when present, but their absence only degrades this module. */
  readonly optional: readonly ModuleId[];
  /** Schema of `[modules.<id>]` (without `enabled`), for docs and the panel's settings form. */
  readonly configSchema?: z.ZodType;
  /**
   * The icon of the module's card on the panel: a lucide icon name in kebab case (`coins`,
   * `music`). The panel knows a set of them (`apps/panel/src/lib/module-icons.ts`) and draws a
   * default for any other or none.
   */
  readonly icon?: string;
  /** Where the panel's system page lists it (default `system`). */
  readonly category?: ModuleCategory;
}

/** The sections of the panel's system page: her mind, the platforms, play, the system itself. */
export const MODULE_CATEGORIES = ["her", "platform", "play", "system"] as const;
export type ModuleCategory = (typeof MODULE_CATEGORIES)[number];

export interface ManifestOptions {
  description?: string;
  requires?: readonly ModuleId[];
  optional?: readonly ModuleId[];
  configSchema?: z.ZodType;
  icon?: string;
  category?: ModuleCategory;
}

export function defineManifest(
  id: ModuleId,
  name: string,
  options: ManifestOptions = {},
): ModuleManifest {
  return {
    id,
    name,
    description: options.description ?? "",
    requires: options.requires ?? [],
    optional: options.optional ?? [],
    ...(options.configSchema ? { configSchema: options.configSchema } : {}),
    ...(options.icon ? { icon: options.icon } : {}),
    ...(options.category ? { category: options.category } : {}),
  };
}

/** JSON form of a manifest (`config_schema` is a JSON Schema of the config input). */
export interface ModuleManifestJson {
  id: ModuleId;
  name: string;
  description: string;
  requires: ModuleId[];
  optional: ModuleId[];
  config_schema: JsonValue | null;
  icon: string | null;
  category: ModuleCategory;
}

export function manifestJson(manifest: ModuleManifest): ModuleManifestJson {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    requires: [...manifest.requires],
    optional: [...manifest.optional],
    config_schema: manifest.configSchema ? configJsonSchema(manifest.configSchema) : null,
    icon: manifest.icon ?? null,
    category: manifest.category ?? "system",
  };
}

/** Serialized as `{ status, reason? }`. */
export type Health =
  | { status: "healthy" }
  | { status: "degraded"; reason: string }
  | { status: "unhealthy"; reason: string };

export const HEALTHY: Health = { status: "healthy" };

/** One fact on a module's card: a label over a short value (never a big number). */
export interface ModuleCardFact {
  label: string;
  value: string | number;
  unit?: string;
}

/**
 * A quick action on a module's card. With `capability` the API runs it through the actuator gate
 * as the panel (principal `panel`) with `args`; without, it calls the module's `act`.
 */
export interface ModuleCardAction {
  id: string;
  label: string;
  /** The question a confirm dialog asks first; none: it runs at once. */
  confirm?: string;
  capability?: string;
  args?: JsonObject;
}

/**
 * What a module tells the panel's system page about itself (docs/design/v5-settings.md §3). State,
 * reason and restarts come from the supervisor, not from here.
 */
export interface ModuleCard {
  /** At most four. */
  facts: ModuleCardFact[];
  /** The next scheduled thing. */
  next?: { label: string; at: Timestamp };
  last_error?: { at: Timestamp; message: string };
  /** At most two. */
  actions?: ModuleCardAction[];
}

/** The most facts and actions a card shows. */
export const CARD_MAX_FACTS = 4;
export const CARD_MAX_ACTIONS = 2;

/**
 * A subsystem managed by the supervisor.
 *
 * `start` must return quickly: long-running work goes into tasks started with `ctx.spawn`,
 * which the supervisor tracks and cancels (aborts their signal) on stop. A spawned task that
 * rejects marks the module as failed and triggers a restart with backoff; so does a rejected
 * `start`.
 *
 * Never call back into the `Supervisor` from inside `start` / `stop` (it serializes lifecycle
 * operations and would deadlock); doing so from spawned tasks is fine.
 */
export interface Module {
  readonly manifest: ModuleManifest;
  start(ctx: ModuleContext): Promise<void>;
  /** Called before the module's tasks are cancelled. */
  stop?(): Promise<void>;
  health?(): Promise<Health>;
  /** The card on the panel's system page; asked only while the module runs, with a deadline. */
  card?(): Promise<ModuleCard>;
  /** Runs a card action that has no `capability`. */
  act?(action: string, by: Principal): Promise<void>;
}
