// Wires config, store, profile and modules into a running core node (legacy `boot.rs`).
//
// The module packages are reached only through a `ModuleCatalog` (see `modules.ts`), so this
// file stays testable with fake modules and an in-memory store.

import { ActionsModule, ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/actions";
import { DirectiveModule, DirectiveService } from "@miyoria/directive";
import {
  type Config,
  EventBus,
  errorMessage,
  getLogger,
  type Module,
  ServiceRegistry,
  Supervisor,
  SupervisorKey,
} from "@miyoria/kernel";
import type { Profile } from "@miyoria/profile";
import { ReplayRecorderModule } from "@miyoria/replay";
import {
  AuditLogKey,
  AuthStoreKey,
  BountyStoreKey,
  CoinLedgerStoreKey,
  DealStoreKey,
  DecisionLogKey,
  FortuneStoreKey,
  GoalStoreKey,
  IdentityStoreKey,
  MemberCardStoreKey,
  MemoryRecordStoreKey,
  MessageLogKey,
  ModuleStateStoreKey,
  PeopleStoreKey,
  PersonaOverrideStoreKey,
  ProfileDataStoreKey,
  RelationshipStoreKey,
  SettingsStoreKey,
  type Store,
  StoredHandleDirectory,
  StoreKey,
} from "@miyoria/store";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  ActuatorExecutorKey,
  customEvent,
  DirectivesKey,
  HandleDirectoryKey,
  type JsonValue,
  KERNEL_MODULE,
  PipelineKey,
  PlatformHistories,
  PlatformHistoriesKey,
  PlatformSinks,
  PlatformSinksKey,
  type ProfileId,
  ProfileIdKey,
  PromptContributors,
  PromptContributorsKey,
  SYSTEM_SHUTDOWN_TOPIC,
} from "@miyoria/types";
import { CliPlatform, type CliPlatformOptions } from "./cli-platform.js";
import { moduleEnabled, NEEDS_TOKEN } from "./module-ids.js";
import { RecorderModule } from "./recorder.js";
import { databaseUrl, loadProfile, pipeline, resolveDatabaseUrl } from "./settings.js";

const log = getLogger("core.boot");

/** Source of the gate's `gate.decision` events. */
const ACTIONS_MODULE = ActionsModule.ID;
const DIRECTIVE_MODULE = DirectiveModule.ID;

/** What the module factories get. */
export interface ModuleDeps {
  config: Config;
  profile: Profile;
  profileId: ProfileId;
  store: Store;
  /** Directory of `miyoria.toml`; relative paths in the config resolve against it. */
  baseDir: string;
}

export interface DiscoveredExtension {
  module: Module;
  config: JsonValue | null;
  enabled: boolean;
}

export interface ExtensionDiscovery {
  skipped: Array<{ dir: string; reason: string }>;
  /** The `extensions` host module first, then one `ext.<id>` module per extension. */
  modules: DiscoveredExtension[];
}

/** How the core reaches the module packages. `modules.ts` has the real one. */
export interface ModuleCatalog {
  openStore(url: string): Promise<Store>;
  /** `llm` ... `stage.link` in legacy boot order (without `recorder`, Discord, API). */
  coreModules(deps: ModuleDeps): Promise<Module[]>;
  discord(deps: ModuleDeps): Module;
  api(deps: ModuleDeps): Module;
  discoverExtensions(config: Config, baseDir: string): Promise<ExtensionDiscovery>;
  /**
   * Extra kernel-owned services under keys a module package declares itself (e.g. the API's
   * `ActiveProfileKey`), provided right before the modules are built.
   */
  provideServices?(services: ServiceRegistry, deps: ModuleDeps): void;
  /**
   * One-time repairs of stored data that belong to module packages (idempotent), run after the
   * store is open and before any module starts.
   */
  migrateStoredData?(
    store: Store,
    profile: ProfileId,
    handles: StoredHandleDirectory | null,
  ): Promise<void>;
}

export interface CoreOptions {
  /** Run the terminal chat platform with this display name (`miyoria chat`). */
  cliChatName?: string | null;
  /** Connect the Discord bot. Default `true`. */
  discord?: boolean;
  /** Serve the Admin API. Default `true`. */
  api?: boolean;
  /** Directory of `miyoria.toml`. Default `process.cwd()`. */
  baseDir?: string;
  /** Streams of the terminal chat (tests). */
  cli?: CliPlatformOptions;
  /** Uses this store instead of opening `core.database_url` (tests). */
  store?: Store;
}

/** A built (not yet started) core node. */
export class Core {
  readonly #persist = new AbortController();
  #persistTask: Promise<void> | undefined;

  constructor(
    readonly supervisor: Supervisor,
    readonly store: Store,
    readonly profileDisplayName: string,
    readonly profileId: ProfileId,
  ) {}

  get bus(): EventBus {
    return this.supervisor.bus;
  }

  get services(): ServiceRegistry {
    return this.supervisor.services;
  }

  /**
   * @internal Started by `buildCore` before any module runs. `wanted` says whether the config
   * file enables a module: only those can be disabled at runtime.
   */
  persistModuleState(wanted: (module: string) => boolean = () => true): void {
    this.#persistTask = persistModuleState(this.bus, this.store, wanted, this.#persist.signal);
  }

  /** Starts every enabled module and logs those that are not running. */
  async start(): Promise<void> {
    await this.supervisor.startAll();
    for (const status of this.supervisor.list()) {
      if (status.reason !== null) {
        log.warn(
          { module: status.id, state: status.state, reason: status.reason },
          "module not running",
        );
      }
    }
  }

  /** Stops every module and closes the store. */
  async stop(): Promise<void> {
    // What modules say from here on is the core going down, not something that happened.
    this.bus.publish(KERNEL_MODULE, customEvent(SYSTEM_SHUTDOWN_TOPIC, {}));
    await this.supervisor.stopAll();
    this.#persist.abort();
    await this.#persistTask;
    await this.store.close();
  }
}

/** Builds the core with the given module catalog (see `buildCore` for the real one). */
export { ProfileIdKey };

export async function buildCoreWith(
  catalog: ModuleCatalog,
  config: Config,
  options: CoreOptions = {},
): Promise<Core> {
  const baseDir = options.baseDir ?? process.cwd();
  const bus = new EventBus();
  const services = new ServiceRegistry();
  const supervisor = new Supervisor({ bus, services });

  let store = options.store;
  if (!store) {
    const url = resolveDatabaseUrl(databaseUrl(config), baseDir);
    try {
      store = await catalog.openStore(url);
    } catch (error) {
      throw new Error(`connecting to the database: ${errorMessage(error)}`, { cause: error });
    }
  }

  const k = KERNEL_MODULE;
  services.provide(k, PipelineKey, { pipeline: pipeline(config) });
  services.provide(k, PlatformSinksKey, new PlatformSinks());
  services.provide(k, PlatformHistoriesKey, new PlatformHistories());
  services.provide(k, SupervisorKey, supervisor);
  services.provide(k, StoreKey, store);
  services.provide(k, SettingsStoreKey, store.settings);
  services.provide(k, DecisionLogKey, store.decisions);
  services.provide(k, PersonaOverrideStoreKey, store.personaOverrides);
  services.provide(k, MessageLogKey, store.messages);
  services.provide(k, MemberCardStoreKey, store.cards);
  services.provide(k, CoinLedgerStoreKey, store.coins);
  services.provide(k, DealStoreKey, store.deals);
  services.provide(k, FortuneStoreKey, store.fortunes);
  services.provide(k, GoalStoreKey, store.goals);
  services.provide(k, BountyStoreKey, store.bounties);
  services.provide(k, PeopleStoreKey, store.people);
  services.provide(k, MemoryRecordStoreKey, store.memories);
  services.provide(k, RelationshipStoreKey, store.relationships);
  services.provide(k, IdentityStoreKey, store.identity);
  services.provide(k, AuthStoreKey, store.auth);
  services.provide(k, AuditLogKey, store.audit);
  services.provide(k, ModuleStateStoreKey, store.moduleState);
  services.provide(k, ProfileDataStoreKey, store.profileData);
  // Her stable names for people (`Owen`, `Owen#2`): never per-call codes (`u1`).
  let handles: StoredHandleDirectory | null = null;
  try {
    handles = await StoredHandleDirectory.open(store.settings);
    handles.syncPeople(await store.people.all());
    services.provide(k, HandleDirectoryKey, handles);
  } catch (error) {
    log.warn({ err: errorMessage(error) }, "cannot load the handle table; names stay per module");
  }
  // Registries other modules add to, independent of any one module's lifetime.
  const tools = new ToolRegistry();
  services.provide(k, ToolRegistryKey, tools);
  services.provide(k, PromptContributorsKey, new PromptContributors());
  // Every action she takes goes through this registry's gate; the scheduler runs queued ones.
  const actuators = new ActuatorRegistry({
    services,
    tools,
    publish: (event) => bus.publish(ACTIONS_MODULE, event),
  });
  services.provide(k, ActuatorRegistryKey, actuators);
  services.provide(k, ActuatorExecutorKey, actuators);

  const profile = await loadProfile(config, baseDir);
  for (const [key, body] of await store.personaOverrides.current(profile.id)) {
    profile.setSection(key, body);
  }
  const profileDisplayName = profile.displayName;
  const profileId = profile.id;
  services.provide(k, ProfileIdKey, profileId);
  // Lessons, recaps and agenda text written with per-call codes before handles were stable are
  // repaired before any module caches them (idempotent; resolves what the record itself says,
  // drops the rest).
  try {
    await catalog.migrateStoredData?.(store, profileId, handles);
  } catch (error) {
    log.warn({ err: errorMessage(error) }, "cannot repair per-call codes in stored text");
  }

  // The rules hold from before the first module starts, and with the `directive` module off.
  const directives = new DirectiveService({
    services,
    store: store.directives,
    profile: profileId,
    publish: (event) => bus.publish(DIRECTIVE_MODULE, event),
  });
  await directives.refresh();
  services.provide(k, DirectivesKey, directives);

  const deps: ModuleDeps = { config, profile, profileId, store, baseDir };
  catalog.provideServices?.(services, deps);

  const modules: Module[] = [
    ...(await catalog.coreModules(deps)),
    new RecorderModule(store, profileId),
    // Opt-in (`[modules.replay] record = true`): what she perceives, for `pnpm replay`.
    new ReplayRecorderModule({ baseDir }),
  ];
  if (options.discord ?? true) modules.push(catalog.discord(deps));
  if (options.api ?? true) modules.push(catalog.api(deps));
  if (options.cliChatName != null) {
    modules.push(new CliPlatform(options.cliChatName, profileDisplayName, options.cli));
  }

  for (const module of modules) {
    const id = module.manifest.id;
    const section = config.module(id);
    let enabled = moduleEnabled(config, id);
    // A module disabled at runtime (command / panel) stays disabled.
    const saved = await store.moduleState.get(id);
    if (saved !== null) enabled = enabled && saved;
    if (NEEDS_TOKEN.includes(id) && tokenMissing(section.config)) {
      log.warn({ module: id }, "token is empty; module disabled");
      enabled = false;
    }
    await supervisor.register(module, section.config, enabled);
  }

  // Each extension is a module of its own (`ext.<id>`), after the host.
  try {
    const found = await catalog.discoverExtensions(config, baseDir);
    for (const { dir, reason } of found.skipped) {
      log.warn({ dir, reason }, "extension skipped");
    }
    for (const m of found.modules) {
      let enabled = m.enabled;
      const saved = await store.moduleState.get(m.module.manifest.id);
      if (saved !== null) enabled = enabled && saved;
      await supervisor.register(m.module, m.config, enabled);
    }
  } catch (error) {
    log.warn({ err: errorMessage(error) }, "extension discovery failed");
  }

  const core = new Core(supervisor, store, profileDisplayName, profileId);
  core.persistModuleState((id) => moduleEnabled(config, id));
  return core;
}

function tokenMissing(section: JsonValue | null): boolean {
  if (section === null || typeof section !== "object" || Array.isArray(section)) return true;
  const token = section.token;
  return typeof token !== "string" || token === "";
}

/**
 * Remembers runtime enable / disable so it survives restarts. A module the config file leaves
 * off is not remembered as disabled: that would keep it off after the config turns it on.
 */
async function persistModuleState(
  bus: EventBus,
  store: Store,
  wanted: (module: string) => boolean,
  signal: AbortSignal,
): Promise<void> {
  const sub = bus.subscribe("system.module.state", { signal });
  for await (const env of sub) {
    if (env.event.type !== "module_state_changed") continue;
    const { module, state } = env.event.data;
    let enabled: boolean;
    if (state === "disabled") {
      if (!wanted(module)) continue;
      enabled = false;
    } else if (state === "running") enabled = true;
    else continue;
    try {
      await store.moduleState.set(module, enabled);
    } catch (error) {
      log.warn({ module, err: errorMessage(error) }, "failed to persist module state");
    }
  }
}

// SIGBREAK is Ctrl+Break and SIGHUP is closing the console window on Windows (Node emulates
// both there; Windows kills the process about 10 s after SIGHUP).
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"];

/** How long `runUntilSignal` waits for modules to stop before forcing the exit. */
const STOP_TIMEOUT_MS = 15_000;

/**
 * Resolves on SIGINT (Ctrl+C), SIGTERM (e.g. `docker stop`), SIGBREAK / SIGHUP (Windows), or
 * when `signal` aborts. The handlers are removed once it resolves, so a second Ctrl+C falls
 * back to Node's default and exits at once.
 */
export function shutdownSignal(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      for (const s of SHUTDOWN_SIGNALS) process.off(s, done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    for (const s of SHUTDOWN_SIGNALS) process.once(s, done);
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

/** Starts the core, waits for Ctrl+C / SIGTERM (or `signal`), then stops it. */
export async function runUntilSignal(core: Core, signal?: AbortSignal): Promise<void> {
  const stop = shutdownSignal(signal);
  await core.start();
  await stop;
  log.info("shutting down (Ctrl+C again to force)");
  const force = setTimeout(() => {
    log.error({ timeout_ms: STOP_TIMEOUT_MS }, "modules did not stop in time; exiting");
    process.exit(1);
  }, STOP_TIMEOUT_MS);
  force.unref();
  try {
    await core.stop();
    log.info("core stopped");
  } finally {
    clearTimeout(force);
  }
}
