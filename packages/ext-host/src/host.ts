// Discovery and the `extensions` host module.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GatedToolsKey } from "@miyoria/actions";
import {
  type Config,
  defineManifest,
  errorMessage,
  getLogger,
  type Module,
  type ModuleContext,
  type ModuleManifest,
  SupervisorKey,
  sleep,
} from "@miyoria/kernel";
import { ToolRegistry } from "@miyoria/tools";
import { type JsonValue, type ModuleId, serviceKey, TaskExecutorsKey } from "@miyoria/types";
import {
  extensionSettings,
  grantedPermissions,
  HostConfigSchema,
  hostConfigFromConfig,
  resolvedDirs,
} from "./config.js";
import {
  EXTENSIONS_MODULE_ID,
  ExtensionModule,
  type ExtensionSpec,
  extensionModuleId,
} from "./extension.js";
import { ExtensionManifest, MANIFEST_FILE, type McpServerSpec, runsOnCore } from "./manifest.js";
import { TaskExecutorRegistry } from "./tasks.js";
import { SKIP_DIRS, type Snapshot, sameSnapshot, snapshot, watchRoots } from "./watch.js";

const log = getLogger("ext_host");

/** A module for the app to register with the supervisor. */
export interface DiscoveredModule {
  module: Module;
  /** Config section to pass to `Supervisor.register`. */
  config: JsonValue | null;
  enabled: boolean;
}

/** An extension that was not loaded, with the reason. */
export interface SkippedExtension {
  dir: string;
  reason: string;
}

/**
 * Result of `discover`: the `extensions` host module first, then one `ext.<id>` module per
 * runnable extension.
 */
export interface Discovery {
  modules: DiscoveredModule[];
  /** Extensions that were skipped (invalid manifest, duplicate id, stage-only placement, ...). */
  skipped: SkippedExtension[];
}

/** One extension known to the host, part of `ExtensionCatalog`. */
export interface CatalogEntry {
  spec: ExtensionSpec;
  enabled: boolean;
}

/** A bundled MCP server of an enabled extension. */
export interface CatalogMcpServer {
  extension: string;
  dir: string;
  spec: McpServerSpec;
}

/**
 * Every extension the core runs. Provided as the `ExtensionCatalogKey` service by the
 * `extensions` module (e.g. for the MCP module to pick up bundled MCP servers, or the panel).
 */
export class ExtensionCatalog {
  constructor(readonly entries: CatalogEntry[] = []) {}

  /** Bundled MCP servers of enabled extensions. */
  mcpServers(): CatalogMcpServer[] {
    return this.entries
      .filter((e) => e.enabled)
      .flatMap((e) =>
        e.spec.manifest.mcp_servers.map((spec) => ({
          extension: e.spec.manifest.id,
          dir: e.spec.dir,
          spec,
        })),
      );
  }
}

export const ExtensionCatalogKey = serviceKey<ExtensionCatalog>("ExtensionCatalog");

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Sample extensions (`extensions/examples/*`) are not loaded when scanning a parent directory;
 * list such a directory in `dirs` to load them on purpose.
 */
export const EXAMPLE_DIRS: readonly string[] = ["examples"];

/**
 * Finds extension directories under `root`: `root` itself if it holds a manifest, otherwise
 * its subdirectories (up to three levels deep, skipping `examples`).
 */
export function findExtensionDirs(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (isFile(join(dir, MANIFEST_FILE))) {
      out.push(dir);
      return;
    }
    if (depth === 0) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const children = names
      .filter(
        (n) =>
          !n.startsWith(".") && !SKIP_DIRS.includes(n) && !EXAMPLE_DIRS.includes(n) && n !== "dist",
      )
      .map((n) => join(dir, n))
      .filter(isDir)
      .sort();
    for (const child of children) visit(child, depth - 1);
  };
  visit(root, 3);
  return out;
}

/**
 * Discovers extensions in `[modules.extensions] dirs`, resolving relative dirs against
 * `baseDir` (default: the working directory).
 */
export function discover(config: Config, baseDir: string = process.cwd()): Discovery {
  const host = hostConfigFromConfig(config);
  const hostSection = config.module(EXTENSIONS_MODULE_ID);
  const skipped: SkippedExtension[] = [];
  const catalog: CatalogEntry[] = [];
  const modules: DiscoveredModule[] = [];

  for (const root of resolvedDirs(host, baseDir)) {
    for (const dir of findExtensionDirs(root)) {
      let manifest: ExtensionManifest;
      try {
        manifest = ExtensionManifest.load(dir);
      } catch (error) {
        skipped.push({ dir, reason: errorMessage(error) });
        continue;
      }
      const errors = manifest.errors();
      if (errors.length > 0) {
        skipped.push({ dir, reason: errors.join("; ") });
        continue;
      }
      if (!runsOnCore(manifest.placement)) {
        skipped.push({ dir, reason: "placement `stage`: runs on the stage node" });
        continue;
      }
      if (catalog.some((e) => e.spec.manifest.id === manifest.id)) {
        skipped.push({ dir, reason: `duplicate extension id \`${manifest.id}\`` });
        continue;
      }
      const game = manifest.gameId();
      if (game !== null && catalog.some((e) => e.spec.manifest.gameId() === game)) {
        skipped.push({ dir, reason: `another extension already adapts game \`${game}\`` });
        continue;
      }
      const settings = extensionSettings(config, manifest.id);
      let schema: JsonValue | null = null;
      if (manifest.config.schema !== null) {
        const path = join(dir, manifest.config.schema);
        try {
          schema = JSON.parse(readFileSync(path, "utf8")) as JsonValue;
        } catch (error) {
          log.warn({ path, error: errorMessage(error) }, "unreadable config schema");
        }
      }
      const enabled = settings.enabled ?? true;
      const spec: ExtensionSpec = {
        granted: grantedPermissions(settings, manifest.permissions),
        manifest,
        dir,
        env: { pass: settings.envPass ?? manifest.env.pass, set: settings.env },
      };
      catalog.push({ spec, enabled });
      modules.push({
        module: new ExtensionModule(spec, host, schema),
        config: settings.config,
        enabled,
      });
    }
  }

  modules.unshift({
    module: new ExtensionsModule(new ExtensionCatalog(catalog)),
    config: hostSection.config,
    enabled: hostSection.enabled,
  });
  return { modules, skipped };
}

/**
 * Module `extensions`: provides `ExtensionCatalog` and, with `dev = true`, restarts `ext.<id>`
 * modules whose files changed.
 */
export class ExtensionsModule implements Module {
  static readonly ID = EXTENSIONS_MODULE_ID;
  readonly manifest: ModuleManifest = defineManifest(ExtensionsModule.ID, "Extensions", {
    description: "Runs out-of-process extensions over JSON-RPC",
    configSchema: HostConfigSchema,
  });
  readonly catalog: ExtensionCatalog;

  constructor(catalog: ExtensionCatalog = new ExtensionCatalog()) {
    this.catalog = catalog;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const host = ctx.config(HostConfigSchema);
    ctx.provide(ExtensionCatalogKey, this.catalog);
    // Game adapters' raw tools: the game director's capabilities use them, chat turns never.
    ctx.provide(GatedToolsKey, new ToolRegistry());
    // Task executors of activity-type extensions (game adapters): the core starts goals as tasks
    // through them and learns how they ended from their task events (v2 §3.8).
    ctx.provide(TaskExecutorsKey, new TaskExecutorRegistry());
    if (host.dev) {
      const targets = this.catalog.entries.map((e) => ({
        id: extensionModuleId(e.spec),
        roots: watchRoots(e.spec.dir, e.spec.manifest),
      }));
      ctx.log.info({ extensions: targets.length }, "dev mode: watching extension files");
      const poll = Math.max(host.watch_poll_ms, 50);
      ctx.spawn("watch", (signal) => watchLoop(ctx, targets, poll, signal));
    }
  }
}

interface WatchTarget {
  id: ModuleId;
  roots: string[];
}

async function watchLoop(
  ctx: ModuleContext,
  targets: WatchTarget[],
  pollMs: number,
  signal: AbortSignal,
): Promise<void> {
  const snaps: Snapshot[] = targets.map((t) => snapshot(t.roots));
  const dirty = targets.map(() => false);
  while (!signal.aborted) {
    try {
      await sleep(pollMs, signal);
    } catch {
      return;
    }
    for (const [i, target] of targets.entries()) {
      const now = snapshot(target.roots);
      if (!sameSnapshot(now, snaps[i] as Snapshot)) {
        // Wait for one quiet poll so a build finishes writing.
        snaps[i] = now;
        dirty[i] = true;
      } else if (dirty[i]) {
        dirty[i] = false;
        await restart(ctx, target.id);
      }
    }
  }
}

async function restart(ctx: ModuleContext, id: ModuleId): Promise<void> {
  const sup = ctx.services.get(SupervisorKey);
  if (!sup) {
    ctx.log.warn({ module: id }, "files changed but no supervisor handle is available");
    return;
  }
  if (!sup.list().some((s) => s.id === id && s.enabled)) return;
  ctx.log.info({ module: id }, "extension files changed; restarting");
  try {
    await sup.restart(id);
  } catch (error) {
    ctx.log.warn({ module: id, error: errorMessage(error) }, "restart after file change failed");
  }
}
