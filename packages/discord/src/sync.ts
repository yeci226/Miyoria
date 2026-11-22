// Keeps Discord's application commands in step with the `CommandRegistry`.
//
// What Discord shows is the registry's `slashSpecs()`: the whole command tree plus the panels
// (`/miyo`, `/song`, and `i` under a command that has subcommands: `/me i`, `/admin i`) and its
// context menu entries (`menus()`). Every
// sync is a bulk overwrite, so commands that left the registry disappear from Discord on the
// next sync. A sync never overwrites with an empty set (a registry that has not been filled
// yet would wipe the commands).
//
// Commands live in one scope at a time: globally when `command_guilds` is empty, otherwise in
// each listed guild (`["*"]`: every guild the bot is in, and each guild it joins as it joins).
// Whatever the global scope still holds (from an earlier run in the other mode) shows up as
// duplicates in Discord's command list, so the first sync of a run in guild mode clears it; in
// global mode the first sync clears the guild sets of every guild the bot is in. Guild mode
// never clears another guild's set: before phase 6 it did, and a second server had no commands.

import type { CommandRegistry } from "@miyoria/commands";
import { errorMessage, getLogger, sleep } from "@miyoria/runtime/kernel";
import { Routes } from "discord.js";
import {
  buildTree,
  type SlashCommandJson,
  toContextMenuCommands,
  toCreateCommands,
  validCommands,
} from "./slash.js";

const log = getLogger("discord.sync");

/** Batches bursts of command registrations into one sync. */
export const SYNC_DEBOUNCE_MS = 2_000;

/** The registry methods the syncer reads. */
export type CommandSource = Pick<CommandRegistry, "slashSpecs" | "groupInfo" | "menus" | "version">;

/** The slice of the REST client the syncer uses (`put` with a body). */
export interface SyncRest {
  put(route: `/${string}`, options?: { body?: unknown; signal?: AbortSignal }): Promise<unknown>;
}

/** The JSON bodies of the registry's current commands (invalid ones left out). */
export function currentCommands(registry: CommandSource): SlashCommandJson[] {
  const tree = buildTree(registry.slashSpecs(), (path) => registry.groupInfo(path) ?? null);
  return validCommands([...toCreateCommands(tree), ...toContextMenuCommands(registry.menus())]);
}

export interface SyncOptions {
  signal?: AbortSignal;
  /**
   * Clear the scope not in use, once per run: the global set in guild mode; in global mode the
   * guild sets of `guilds`.
   */
  cleanup?: { guilds: readonly string[] } | null;
  /**
   * `guilds`: the commands go to `commandGuilds` even when it is empty (`["*"]` while the bot is in
   * no guild yet). Default: global when `commandGuilds` is empty.
   */
  mode?: "global" | "guilds";
}

/** What a sync did: the scopes (`global`, guild ids) that got the current set. */
export interface SyncReport {
  synced: string[];
}

/**
 * Overwrites the application commands with the registry's current set: globally when
 * `commandGuilds` is empty, otherwise in each listed guild; then clears the other scope when
 * `cleanup` is given. Failures are logged, not thrown.
 */
export async function syncCommands(
  rest: SyncRest,
  applicationId: string,
  registry: CommandSource,
  commandGuilds: readonly string[],
  options: SyncOptions | AbortSignal = {},
): Promise<SyncReport> {
  const { signal, cleanup, mode } = options instanceof AbortSignal ? { signal: options } : options;
  const global = mode === undefined ? commandGuilds.length === 0 : mode === "global";
  const report: SyncReport = { synced: [] };
  const body = currentCommands(registry);
  const count = body.length;
  if (count === 0) {
    log.warn("no slash commands to register yet, the current set is left as it is");
  } else if (global) {
    try {
      await rest.put(Routes.applicationCommands(applicationId), { body, signal });
      log.info({ count }, "synced global slash commands");
      report.synced.push("global");
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot sync global slash commands");
    }
  } else {
    for (const guild of commandGuilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(applicationId, guild), { body, signal });
        log.info({ guild, count }, "synced guild slash commands");
        report.synced.push(guild);
      } catch (error) {
        log.warn({ guild, error: errorMessage(error) }, "cannot sync guild slash commands");
      }
    }
  }
  if (!cleanup) return report;
  if (!global) {
    await clear(rest, Routes.applicationCommands(applicationId), "global", signal);
    return report;
  }
  for (const guild of cleanup.guilds) {
    await clear(rest, Routes.applicationGuildCommands(applicationId, guild), guild, signal);
  }
  return report;
}

async function clear(
  rest: SyncRest,
  route: `/${string}`,
  scope: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await rest.put(route, { body: [], signal });
    log.info({ scope }, "cleared stale slash commands");
    return true;
  } catch (error) {
    log.warn({ scope, error: errorMessage(error) }, "cannot clear slash commands");
    return false;
  }
}

/** Result of `resetCommands`. */
export interface ResetReport {
  cleared: string[];
  failed: { scope: string; error: string }[];
}

/**
 * Deletes every application command of the bot: the global set and the set of each guild in
 * `guilds`. The next `miyoria core` start registers the current set again.
 */
export async function resetCommands(
  rest: SyncRest,
  applicationId: string,
  guilds: readonly string[],
  signal?: AbortSignal,
): Promise<ResetReport> {
  const report: ResetReport = { cleared: [], failed: [] };
  const scopes: [string, `/${string}`][] = [
    ["global", Routes.applicationCommands(applicationId)],
    ...guilds.map((g): [string, `/${string}`] => [
      g,
      Routes.applicationGuildCommands(applicationId, g),
    ]),
  ];
  for (const [scope, route] of scopes) {
    try {
      await rest.put(route, { body: [], signal });
      report.cleared.push(scope);
    } catch (error) {
      report.failed.push({ scope, error: errorMessage(error) });
    }
  }
  return report;
}

export interface SyncRunnerOptions {
  rest: SyncRest;
  applicationId: string;
  registry: CommandSource;
  /** `command_guilds`: guild ids, `["*"]` (every guild the bot is in), or empty (global). */
  commandGuilds: readonly string[];
  /**
   * Guilds the bot is in: the targets of `["*"]`, read at every sync, and the guilds whose sets
   * the first sync in global mode clears.
   */
  guilds: () => readonly string[];
  signal?: AbortSignal;
}

/**
 * The `sync` of `runSyncLoop`, and of a guild she joined (`["*"]`). Modules register commands all
 * the time and a bulk overwrite is rate limited, so a scope that already has the slash set sent
 * last is skipped: a sync after a join reaches only the new guild. The first sync of a run always
 * goes out everywhere and clears the scope not in use. Syncs run one at a time.
 */
export function syncRunner(options: SyncRunnerOptions): (first: boolean) => Promise<void> {
  const every = options.commandGuilds.includes("*");
  const listed = options.commandGuilds.filter((g) => g !== "*");
  let sent: string | null = null;
  /** Scopes that have `sent`. */
  const done = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  const once = async (first: boolean) => {
    const now = JSON.stringify(currentCommands(options.registry));
    if (first || now !== sent) {
      sent = now;
      done.clear();
    }
    const targets = every ? [...new Set([...listed, ...options.guilds()])] : listed;
    const global = !every && targets.length === 0;
    const todo = global
      ? done.has("global")
        ? []
        : ["global"]
      : targets.filter((g) => !done.has(g));
    if (!first && todo.length === 0) return;
    const report = await syncCommands(
      options.rest,
      options.applicationId,
      options.registry,
      global ? [] : todo,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        mode: global ? "global" : "guilds",
        cleanup: first ? { guilds: [...options.guilds()] } : null,
      },
    );
    for (const scope of report.synced) done.add(scope);
  };
  return (first) => {
    const next = queue.then(() => once(first));
    queue = next.catch(() => undefined);
    return next;
  };
}

export interface SyncLoopOptions {
  registry: Pick<CommandRegistry, "subscribe" | "version">;
  /**
   * Runs one sync. Called once at the start (with `first = true`, the time to clean up the
   * other scope) and after each (debounced) registry change.
   */
  sync(first: boolean): Promise<void>;
  debounceMs?: number;
  signal: AbortSignal;
}

/**
 * Syncs once, then again after the registry changed and stayed quiet for `debounceMs`. Returns
 * when `signal` aborts.
 */
export async function runSyncLoop(options: SyncLoopOptions): Promise<void> {
  const { registry, sync, signal } = options;
  const debounceMs = options.debounceMs ?? SYNC_DEBOUNCE_MS;
  const changes = registry.subscribe(signal);
  try {
    let synced = registry.version();
    await sync(true);
    for (;;) {
      if ((await changes.changed()) === null) return;
      try {
        await sleep(debounceMs, signal);
      } catch {
        return; // aborted
      }
      // Changes during the sleep are covered by reading the version now.
      if (registry.version() === synced) continue;
      synced = registry.version();
      await sync(false);
    }
  } finally {
    changes.close();
  }
}
