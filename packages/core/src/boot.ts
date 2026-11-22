// Wires config, store, profile and modules into a running core node.
//
// The module packages are reached only through a `ModuleCatalog` (see `modules.ts`), so this
// file stays testable with fake modules and an in-memory store.

import { authTables } from "@miyoria/auth";
import { DirectiveModule, DirectiveService, directiveTables } from "@miyoria/brain/directive";
import { reportTables } from "@miyoria/brain/report";
import { initiativeTables } from "@miyoria/brain/selfhost";
import { ClusterModule, type ClusterTables, clusterTables } from "@miyoria/cluster";
import {
  BountyStoreKey,
  CoinLedgerStoreKey,
  EconomyDocsKey,
  economyTables,
  FortuneStoreKey,
  giftTables,
  LedgerStatsKey,
} from "@miyoria/economy";
import { ActionsModule, ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { heartTables } from "@miyoria/heart/person";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import { memoryTables } from "@miyoria/memory/memory";
import { notesTables } from "@miyoria/memory/notes";
import { transcriptTables } from "@miyoria/memory/transcript";
import { cardsTables } from "@miyoria/play/cards";
import { exchangeTables } from "@miyoria/play/exchange";
import { karaokeTables } from "@miyoria/play/karaoke";
import { marketTables } from "@miyoria/play/market";
import {
  type Config,
  ConfigError,
  currencyOf,
  EventBus,
  errorMessage,
  getLogger,
  type Module,
  ModuleSettingsKey,
  ServiceRegistry,
  Supervisor,
  SupervisorKey,
} from "@miyoria/runtime/kernel";
import { loadLanding, type Profile } from "@miyoria/runtime/profile";
import { ReplayRecorderModule } from "@miyoria/runtime/replay-log";
import {
  ArtifactAttachments,
  ArtifactStoreKey,
  AuditLogKey,
  AuthStoreKey,
  DecisionLogKey,
  IdentityStoreKey,
  MemberCardStoreKey,
  MemoryRecordStoreKey,
  MessageLogKey,
  PeopleStoreKey,
  PersonaOverrideStoreKey,
  type PersonHandleDirectory,
  ProfileDataStoreKey,
  SettingsStoreKey,
  type Store,
  StoredHandleDirectory,
  StoreKey,
  type StorePlugin,
} from "@miyoria/store";
import {
  ActuatorExecutorKey,
  AttachmentSourceKey,
  CharacterKey,
  CurrencyKey,
  DirectivesKey,
  Events,
  HandleDirectoryKey,
  is,
  type JsonValue,
  KERNEL_MODULE,
  PlaceConfigKey,
  PlaceDirectoryKey,
  type Places,
  PlacesKey,
  PlatformHistories,
  PlatformHistoriesKey,
  PlatformSinks,
  PlatformSinksKey,
  type ProfileId,
  ProfileIdKey,
  ProfileLandingKey,
  PromptContributors,
  PromptContributorsKey,
  RunningProfileKey,
  type SpaceRef,
} from "@miyoria/types";
import { CliPlatform, type CliPlatformOptions } from "./cli-platform.js";
import { CLUSTER_GUARDS } from "./cluster-guards.js";
import { type Machines, openMachines } from "./machines.js";
import {
  moduleEnabled,
  NEEDS_TOKEN,
  REQUIRED_MODULE_REASONS,
  REQUIRED_MODULES,
} from "./module-ids.js";
import { ModuleSettings } from "./module-settings.js";
import { PlaceConfigs } from "./place-config.js";
import type { MachineSource } from "./profiles.js";
import { databaseUrl, loadProfile, resolveDatabaseUrl } from "./settings.js";

const log = getLogger("core.boot");

/** Source of the gate's `gate.decision` events. */
const ACTIONS_MODULE = ActionsModule.ID;
const DIRECTIVE_MODULE = DirectiveModule.ID;

/**
 * The plugins whose tables live in the store (docs/design/v5-data.md §3): the catalog opens the
 * store with them, so their migrations run at start whether the module is on or off.
 */
export const STORE_PLUGINS: readonly StorePlugin<unknown>[] = [
  authTables,
  cardsTables,
  clusterTables,
  directiveTables,
  economyTables,
  exchangeTables,
  giftTables,
  heartTables,
  initiativeTables,
  karaokeTables,
  marketTables,
  memoryTables,
  notesTables,
  reportTables,
  transcriptTables,
];

/** What the module factories get. */
export interface ModuleDeps {
  config: Config;
  profile: Profile;
  profileId: ProfileId;
  store: Store;
  /** Directory of `miyoria.toml`; relative paths in the config resolve against it. */
  baseDir: string;
  /**
   * The machines' tables (`cluster_*`), shared by every profile: the store's, or for a profile
   * with a database of its own the install's database's (docs/design/v5-profiles.md §7). Absent
   * (deps made by hand): the store's.
   */
  machines?: ClusterTables;
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
  /** `llm` ... `stage.link` in legacy boot order (without Discord, API). */
  coreModules(deps: ModuleDeps): Promise<Module[]>;
  discord(deps: ModuleDeps): Module;
  api(deps: ModuleDeps): Module;
  discoverExtensions(config: Config, baseDir: string): Promise<ExtensionDiscovery>;
  /**
   * Extra kernel-owned services under keys a module package declares itself (e.g. the API's
   * `ActiveProfileKey`), provided right before the modules are built.
   */
  provideServices?(services: ServiceRegistry, deps: ModuleDeps): void;
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
  /**
   * The profile has a config and data of its own (docs/design/v5-profiles.md); `false` (default):
   * it runs on the install's, as the first character always has. Only shown, never acted on.
   */
  ownProfile?: boolean;
  /**
   * For a profile with a database of its own (`machineSource`): the install's database, which
   * holds the machines, and the install's `[modules.cluster]`, which the cluster module runs with
   * instead of the profile's. Absent: the store's tables and the config's own section, as before
   * profiles.
   */
  machines?: MachineSource | null;
}

/** A built (not yet started) core node. */
export class Core {
  readonly #persist = new AbortController();
  #persistTask: Promise<void> | undefined;
  #membersTask: Promise<void> | undefined;

  constructor(
    readonly supervisor: Supervisor,
    readonly store: Store,
    readonly profileDisplayName: string,
    readonly profileId: ProfileId,
    /** The panel's settings layer; `null` in a core built without one. */
    readonly settings: ModuleSettings | null = null,
    /** The machine database, when it is not the store's: closed after the store. */
    readonly machines: Pick<Machines, "close"> | null = null,
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

  /** @internal Started by `buildCore`: a member who leaves a server is marked left there. */
  followMembers(places: Places): void {
    this.#membersTask = followMembers(this.bus, places, this.#persist.signal);
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
    this.bus.publish(KERNEL_MODULE, Events.SystemShutdown, {});
    this.settings?.close();
    await this.supervisor.stopAll();
    this.#persist.abort();
    await this.#persistTask;
    await this.#membersTask;
    await this.store.close();
    this.machines?.close();
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
  for (const id of REQUIRED_MODULES) {
    if (moduleEnabled(config, id)) continue;
    throw new ConfigError(
      "invalid",
      `invalid config at \`modules.${id}.enabled\`: the \`${id}\` module cannot be disabled; ${REQUIRED_MODULE_REASONS[id]}`,
      `modules.${id}.enabled`,
    );
  }
  const bus = new EventBus();
  const services = new ServiceRegistry();
  const supervisor = new Supervisor({ bus, services });

  let store = options.store;
  let storeUrl: string | null = null;
  if (!store) {
    const url = resolveDatabaseUrl(databaseUrl(config), baseDir);
    storeUrl = url;
    try {
      store = await catalog.openStore(url);
    } catch (error) {
      throw new Error(`connecting to the database: ${errorMessage(error)}`, { cause: error });
    }
  }
  let machines: Machines;
  try {
    machines = openMachines(store, options.machines, { storeUrl });
  } catch (error) {
    throw new Error(`opening the machines' database: ${errorMessage(error)}`, { cause: error });
  }

  const k = KERNEL_MODULE;
  services.provide(k, PlatformSinksKey, new PlatformSinks());
  services.provide(k, PlatformHistoriesKey, new PlatformHistories());
  services.provide(k, SupervisorKey, supervisor);
  // What the panel changes of a module's config, laid over the file (docs/design/v5-settings.md).
  const settings = new ModuleSettings({
    config,
    revisions: store.moduleState.revisions,
    supervisor,
    guard: () => {
      for (const guard of CLUSTER_GUARDS) {
        const state = guard(services);
        if (typeof state === "string") return state;
      }
      return null;
    },
    // A module's own values per Space and Room (docs/design/v5-places.md).
    ...(store.places && store.config
      ? {
          places: {
            places: store.places,
            settings: store.config.places,
            ...(store.events ? { events: store.events } : {}),
            directory: () => services.get(PlaceDirectoryKey),
            ...roomMaker(store),
          },
        }
      : {}),
  });
  services.provide(k, ModuleSettingsKey, settings);
  services.provide(k, StoreKey, store);
  services.provide(k, SettingsStoreKey, store.settings);
  services.provide(k, DecisionLogKey, store.decisions);
  services.provide(k, PersonaOverrideStoreKey, store.personaOverrides);
  services.provide(k, MessageLogKey, store.messages);
  services.provide(k, MemberCardStoreKey, store.cards);
  // The economy plugin's tables (`@miyoria/economy` `tables.ts`).
  const economy = store.plugin(economyTables);
  services.provide(k, CoinLedgerStoreKey, economy.ledger);
  services.provide(k, LedgerStatsKey, economy.ledger);
  services.provide(k, EconomyDocsKey, economy.docs);
  services.provide(k, FortuneStoreKey, economy.fortunes);
  services.provide(k, BountyStoreKey, economy.bounties);
  services.provide(k, PeopleStoreKey, store.people);
  // The memory plugin's tables (`@miyoria/memory/memory` `tables.ts`).
  services.provide(k, MemoryRecordStoreKey, store.plugin(memoryTables));
  services.provide(k, IdentityStoreKey, store.identity);
  services.provide(k, AuthStoreKey, store.plugin(authTables).store);
  services.provide(k, AuditLogKey, store.audit);
  if (store.artifacts) {
    services.provide(k, ArtifactStoreKey, store.artifacts);
    services.provide(k, AttachmentSourceKey, new ArtifactAttachments(store.artifacts));
  }
  services.provide(k, ProfileDataStoreKey, store.profileData);
  // Spaces, Rooms and members, and each module's config per place (docs/design/v5-places.md).
  if (store.places) {
    services.provide(k, PlacesKey, store.places);
    if (store.config) {
      const placeConfigs = new PlaceConfigs({
        places: store.places,
        settings: store.config.places,
        directory: () => services.get(PlaceDirectoryKey),
      });
      services.provide(k, PlaceConfigKey, placeConfigs);
    }
  }
  // Her stable names for people (`Owen`, `Owen#2`): never per-call codes (`u1`).
  let handles: PersonHandleDirectory | null = null;
  try {
    handles = store.handles ?? (await StoredHandleDirectory.open(store.settings));
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
    publish: bus.publisher(ACTIONS_MODULE),
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
  // Who she is in this profile, for the texts that name her (`[character]`).
  services.provide(k, CharacterKey, profile.character);
  // The coins' name, for every text that names them (`[modules.economy] currency`).
  services.provide(k, CurrencyKey, currencyOf(config.section("modules.economy")));
  // Her front page (`profiles/<id>/landing/`): a file that does not read is reported, never fatal.
  const front = await loadLanding(profile.dir);
  for (const problem of front.problems)
    log.warn({ problem }, "front page: part of the profile's landing is left out");
  services.provide(k, ProfileLandingKey, front.landing);
  services.provide(k, RunningProfileKey, {
    id: profileId,
    own: options.ownProfile ?? false,
    character: profile.character.name,
    persona: profileDisplayName,
  });
  // One database belongs to one character: a memory looked up by id reports this profile.
  store.plugin(memoryTables).forProfile(profileId);

  // The rules hold from before the first module starts, and with the `directive` module off.
  const directives = new DirectiveService({
    services,
    store: store.plugin(directiveTables),
    profile: profileId,
    publish: bus.publisher(DIRECTIVE_MODULE),
  });
  await directives.refresh();
  services.provide(k, DirectivesKey, directives);

  const deps: ModuleDeps = {
    config,
    profile,
    profileId,
    store,
    baseDir,
    machines: machines.tables,
  };
  catalog.provideServices?.(services, deps);

  const modules: Module[] = [
    ...(await catalog.coreModules(deps)),
    // Opt-in (`[modules.replay] record = true`): what she perceives, for `pnpm replay`.
    new ReplayRecorderModule({ baseDir }),
  ];
  if (options.discord ?? true) modules.push(catalog.discord(deps));
  if (options.api ?? true) modules.push(catalog.api(deps));
  if (options.cliChatName != null) {
    modules.push(new CliPlatform(options.cliChatName, profileDisplayName, options.cli));
  }

  // The machines' settings are the install's whichever profile runs: the hosts dial its listener.
  const machineSection = options.machines?.cluster;
  for (const module of modules) {
    const id = module.manifest.id;
    const machine = id === ClusterModule.ID ? machineSection : undefined;
    const section = machine ?? config.module(id);
    let enabled = machine?.enabled ?? moduleEnabled(config, id);
    const required = REQUIRED_MODULES.includes(id);
    // A module disabled at runtime (command / panel) stays disabled. A required one cannot be
    // disabled, so whatever an older build remembered about it is not followed.
    const saved = required ? null : await store.moduleState.get(id);
    if (saved !== null) enabled = enabled && saved;
    if (NEEDS_TOKEN.includes(id) && tokenMissing(section.config)) {
      log.warn({ module: id }, "token is empty; module disabled");
      enabled = false;
    }
    const effective = settings.boot(id, section.config, module.manifest.configSchema);
    await supervisor.register(module, effective, enabled, { required });
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

  const core = new Core(
    supervisor,
    store,
    profileDisplayName,
    profileId,
    settings,
    machines.path === null ? null : machines,
  );
  core.persistModuleState((id) => moduleEnabled(config, id));
  if (store.places) core.followMembers(store.places);
  return core;
}

/** `platform.member` with `left`: the account's membership of that server is marked left. */
async function followMembers(bus: EventBus, places: Places, signal: AbortSignal): Promise<void> {
  const sub = bus.subscribe(Events.PlatformMember.type, { signal });
  for await (const env of sub) {
    if (!is(Events.PlatformMember, env) || !env.data.left) continue;
    const { platform, guild, account } = env.data;
    try {
      const space = places.ofGuild(platform, guild);
      if (space !== null) places.memberLeft(space.id, account);
    } catch (error) {
      log.warn({ guild, err: errorMessage(error) }, "failed to record a member leaving");
    }
  }
}

/**
 * Creating a Space's room for a setting before anyone spoke there, when the store's identity can
 * (the SQLite store's `persons`); test doubles without it only set rooms she has seen.
 */
function roomMaker(store: Store): { ensureRoom?: (space: SpaceRef, channel: string) => string } {
  const persons = (store as { persons?: unknown }).persons as
    | { ensureRoom?: (p: string, s: string, c: string, k: "text" | "voice") => { id: string } }
    | undefined;
  const ensure = persons?.ensureRoom;
  if (typeof ensure !== "function") return {};
  return {
    ensureRoom: (space, channel) =>
      ensure.call(persons, space.platform, space.external_id, channel, "text").id,
  };
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
  const sub = bus.subscribe(Events.SystemModuleState.type, { signal });
  for await (const env of sub) {
    if (!is(Events.SystemModuleState, env)) continue;
    const { module, state } = env.data;
    let enabled: boolean;
    if (state === "disabled") {
      if (!wanted(module)) continue;
      enabled = false;
    } else if (state === "running") enabled = true;
    else continue;
    try {
      // A module that runs with nothing remembered about it follows the config file already:
      // there is nothing to record, and recording it would write one config revision per module
      // at every first start.
      if (enabled && (await store.moduleState.get(module)) !== false) continue;
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
