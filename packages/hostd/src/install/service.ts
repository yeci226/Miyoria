// Installing one service (docs/design/v5-hostd.md §9): the Python environment with `uv sync
// --frozen`, then a check of `install.system`, a download of `install.files`, a look at
// `install.manual` and at the models. Nothing here installs a system program, and nothing here
// touches a folder outside the state folder, except the catalog's own files it reads.

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { HostInstallRuntimeState, HostServiceInstallResult } from "@miyoria/contracts/host";
import type { CatalogEntry } from "../catalog.js";
import type { LoadedHostConfig } from "../host-config.js";
import { pythonIn } from "../resolve.js";
import { downloadFile, type Fetch } from "./download.js";
import { hfCacheHasIn, hfDir } from "./hf.js";
import {
  type EnvironmentState,
  environmentState,
  installSectionHash,
  lockHash,
  writeInstallRecord,
} from "./record.js";
import { type CommandRunner, execaRunner } from "./run.js";
import { onPath, systemHint, tempDir, uvEnv, uvInstallHint, uvSyncArgs } from "./uv.js";

/** What installing and checking need from the outside; tests replace each of them. */
export interface InstallDeps {
  /** The folder holding the catalog roots: `install.manual` paths are relative to it. */
  root: string;
  runner?: CommandRunner;
  fetchImpl?: Fetch;
  platform?: NodeJS.Platform;
  /** The environment programs run with and PATH is searched in (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** The uv program (default `uv`). */
  uv?: string;
  /** Replaces the host allowlist of `install.files` (tests). */
  allowedHosts?: readonly string[];
  now?: () => Date;
}

export interface InstallOptions {
  /** Replaces the extras of the descriptor and of `host.toml`. */
  extras?: readonly string[];
  /** Sync only when the install record differs. */
  onlyStale?: boolean;
  /** Do not download `install.files`. */
  noFiles?: boolean;
  /** Each line of uv's output as it comes. */
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

// ---- where things are --------------------------------------------------------------------------

/** The environment folder hostd manages for a service. */
export function managedEnvDir(host: LoadedHostConfig, service: string): string {
  return join(host.state.envs, service);
}

/** The environment folder `host.toml` says the user manages (`python = ...`), or `null`. */
export function userEnvDir(host: LoadedHostConfig, service: string): string | null {
  const configured = host.config.services[service]?.python;
  return configured === undefined ? null : resolve(host.workspace, configured);
}

/** The environment folder a service runs from: the user's, else the managed one. */
export function envDirOf(host: LoadedHostConfig, service: string): string {
  return userEnvDir(host, service) ?? managedEnvDir(host, service);
}

/** The extras to sync: `host.toml`'s, else the descriptor's. */
export function extrasOf(entry: CatalogEntry, host: LoadedHostConfig): string[] {
  return [...(host.config.services[entry.name]?.extras ?? entry.descriptor.install.extras)];
}

/** Where a download of `install.files` goes: `<state>/models/<path>`. Throws when `path` escapes it. */
export function fileDest(host: LoadedHostConfig, path: string): string {
  const dest = resolve(host.state.models, path);
  const inside = relative(host.state.models, dest);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`${path} is not a path inside the model folder`);
  }
  return dest;
}

/**
 * Where an `install.manual` item is: relative to the catalog root (the checkout), with `{voice}`
 * the service's `TTS_DEFAULT_VOICE`, and `{state}`, `{models}`, `{workspace}` and `{service}`.
 */
export function manualPath(
  entry: CatalogEntry,
  host: LoadedHostConfig,
  root: string,
  path: string,
): string {
  const voice =
    host.config.services[entry.name]?.env.TTS_DEFAULT_VOICE ??
    entry.descriptor.run?.env.TTS_DEFAULT_VOICE ??
    "deepseek-chan";
  const text = path
    .replaceAll("{voice}", voice)
    .replaceAll("{state}", host.state.root)
    .replaceAll("{models}", host.state.models)
    .replaceAll("{workspace}", host.workspace)
    .replaceAll("{service}", entry.dir);
  return resolve(root, text);
}

// ---- inspecting --------------------------------------------------------------------------------

export interface Inspection {
  /** False when the descriptor does not list this platform. */
  platformOk: boolean;
  runtime: {
    kind: "none" | "user-managed" | "managed";
    /** The environment folder. */
    dir?: string;
    /** The project folder holding `pyproject.toml` and `uv.lock`. */
    project?: string;
    extras: string[];
    /** For a managed environment: whether it is there and current. */
    state?: EnvironmentState;
    /** The user-managed interpreter exists. */
    pythonExists?: boolean;
  };
  system: HostServiceInstallResult["system"];
  files: HostServiceInstallResult["files"];
  manual: HostServiceInstallResult["manual"];
  models: HostServiceInstallResult["models"];
}

function resolved(deps: InstallDeps) {
  return {
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
  };
}

/** What a service has and lacks. Reads files and PATH only; changes nothing. */
export function inspectService(
  entry: CatalogEntry,
  host: LoadedHostConfig,
  deps: InstallDeps,
  extrasOverride?: readonly string[],
): Inspection {
  const { platform, env } = resolved(deps);
  const install = entry.descriptor.install;
  const extras = [...(extrasOverride ?? extrasOf(entry, host))];
  const runtime: Inspection["runtime"] = { kind: "none", extras: [] };
  if (install.runtime === "python" && install.project !== undefined) {
    const project = resolve(entry.dir, install.project);
    const user = userEnvDir(host, entry.name);
    if (user !== null) {
      runtime.kind = "user-managed";
      runtime.dir = user;
      runtime.pythonExists = existsSync(pythonIn(user, platform));
    } else {
      const dir = managedEnvDir(host, entry.name);
      runtime.kind = "managed";
      runtime.dir = dir;
      runtime.extras = extras;
      runtime.state = environmentState({
        envDir: dir,
        projectDir: project,
        extras,
        install,
        platform,
      });
    }
    runtime.project = project;
  }
  return {
    platformOk: entry.descriptor.platforms.includes(platform),
    runtime,
    system: install.system.map((program) => {
      const found = onPath(program, env, platform);
      const hint = found ? undefined : systemHint(program, platform);
      return { program, found, ...(hint !== undefined ? { hint } : {}) };
    }),
    files: install.files.map((file) => ({
      path: file.path,
      state: existsSync(fileDest(host, file.path)) ? ("present" as const) : ("missing" as const),
    })),
    manual: install.manual.map((item) => ({
      path: manualPath(entry, host, deps.root, item.path),
      what: item.what,
      present: existsSync(manualPath(entry, host, deps.root, item.path)),
    })),
    models: install.models.map((model) => ({
      repo: model.repo,
      ...(model.revision !== undefined ? { revision: model.revision } : {}),
      present: hfCacheHasIn(hfCacheOf(entry, host), model.repo, model.revision),
    })),
  };
}

/**
 * The Hugging Face cache a service reads: its own `HF_HUB_CACHE` when `host.toml` or the
 * descriptor sets one (relative to the workspace), else the host's.
 */
export function hfCacheOf(entry: CatalogEntry, host: LoadedHostConfig): string {
  const own =
    host.config.services[entry.name]?.env.HF_HUB_CACHE ?? entry.descriptor.run?.env.HF_HUB_CACHE;
  if (own === undefined || own === "" || own.includes("{")) return hfDir(host.state.models);
  return resolve(host.workspace, own);
}

// ---- installing --------------------------------------------------------------------------------

function runtimeResult(
  state: HostInstallRuntimeState,
  extra: { dir?: string; extras?: string[]; detail?: string } = {},
): HostServiceInstallResult["runtime"] {
  return { state, ...extra };
}

/**
 * Builds the environment of one service and reports the rest of `[install]`. A failed `uv sync`
 * is a result (`ok: false`), not an exception; so are a missing uv and a failed download.
 */
export async function installService(
  entry: CatalogEntry,
  host: LoadedHostConfig,
  deps: InstallDeps,
  options: InstallOptions = {},
): Promise<HostServiceInstallResult> {
  const { platform } = resolved(deps);
  const name = entry.name;
  const before = inspectService(entry, host, deps, options.extras);
  if (!before.platformOk) {
    return {
      service: name,
      ok: false,
      runtime: runtimeResult("unsupported", {
        detail: `${entry.descriptor.platforms.join(", ")} only; this is ${platform}`,
      }),
      system: [],
      files: [],
      manual: [],
      models: [],
    };
  }

  let runtime: HostServiceInstallResult["runtime"];
  const rt = before.runtime;
  if (rt.kind === "none") {
    runtime = runtimeResult("none");
  } else if (rt.kind === "user-managed") {
    runtime = runtimeResult("user-managed", {
      ...(rt.dir !== undefined ? { dir: rt.dir } : {}),
      detail:
        rt.pythonExists === true
          ? "host.toml names this environment; it is left as it is"
          : `host.toml names this environment, but ${pythonIn(rt.dir ?? "", platform)} does not exist`,
    });
  } else if (options.onlyStale === true && rt.state?.state === "ready") {
    runtime = runtimeResult("current", { dir: rt.dir ?? "", extras: rt.extras });
  } else {
    runtime = await syncEnvironment(entry, host, deps, rt, options);
  }

  const failedRuntime = runtime.state === "uv-missing" || runtime.state === "failed";
  const files = await fetchFiles(entry, host, deps, options, before.files, failedRuntime);
  // The environment may have appeared: look at the models again.
  const after = inspectService(entry, host, deps, options.extras);
  return {
    service: name,
    ok: !failedRuntime && files.every((f) => f.state !== "failed"),
    runtime,
    system: after.system,
    files,
    manual: after.manual,
    models: after.models,
  };
}

async function syncEnvironment(
  entry: CatalogEntry,
  host: LoadedHostConfig,
  deps: InstallDeps,
  rt: Inspection["runtime"],
  options: InstallOptions,
): Promise<HostServiceInstallResult["runtime"]> {
  const { platform, env } = resolved(deps);
  const dir = rt.dir ?? managedEnvDir(host, entry.name);
  const project = rt.project ?? entry.dir;
  const extras = rt.extras;
  if (!existsSync(join(project, "pyproject.toml")) || lockHash(project) === null) {
    return runtimeResult("failed", {
      dir,
      detail: `${project} needs a pyproject.toml and a uv.lock`,
    });
  }
  mkdirSync(host.state.envs, { recursive: true });
  mkdirSync(tempDir(host), { recursive: true });
  const runner = deps.runner ?? execaRunner;
  const outcome = await runner(
    {
      file: deps.uv ?? "uv",
      args: uvSyncArgs(extras),
      cwd: project,
      env: uvEnv(host, dir, platform, env),
    },
    {
      ...(options.onLine !== undefined ? { onLine: options.onLine } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );
  if (outcome.missing) {
    return runtimeResult("uv-missing", {
      dir,
      detail: `uv is not installed. Install it with: ${uvInstallHint(platform)}`,
    });
  }
  if (outcome.code !== 0) {
    return runtimeResult("failed", {
      dir,
      detail: `uv sync exited with ${outcome.code ?? "no code"}${
        outcome.tail.length > 0 ? `:\n${outcome.tail.join("\n")}` : ""
      }`,
    });
  }
  if (!existsSync(pythonIn(dir, platform))) {
    return runtimeResult("failed", {
      dir,
      detail: `uv sync finished but ${pythonIn(dir, platform)} does not exist`,
    });
  }
  writeInstallRecord(dir, {
    lock_sha256: lockHash(project) ?? "",
    extras: [...extras].sort(),
    install_sha256: installSectionHash(entry.descriptor.install),
    installed_at: (deps.now?.() ?? new Date()).toISOString(),
  });
  return runtimeResult("synced", { dir, extras });
}

async function fetchFiles(
  entry: CatalogEntry,
  host: LoadedHostConfig,
  deps: InstallDeps,
  options: InstallOptions,
  present: HostServiceInstallResult["files"],
  skip: boolean,
): Promise<HostServiceInstallResult["files"]> {
  const out: HostServiceInstallResult["files"] = [];
  for (const file of entry.descriptor.install.files) {
    if (present.find((p) => p.path === file.path)?.state === "present") {
      // An existing file is kept; a checksum in the descriptor is checked against it.
      try {
        if (file.sha256 !== undefined) {
          await downloadFile(file.url, fileDest(host, file.path), { sha256: file.sha256 });
        }
        out.push({ path: file.path, state: "present" });
      } catch (error) {
        out.push({ path: file.path, state: "failed", detail: message(error) });
      }
      continue;
    }
    if (options.noFiles === true || skip) {
      out.push({ path: file.path, state: "missing" });
      continue;
    }
    try {
      await downloadFile(file.url, fileDest(host, file.path), {
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(file.sha256 !== undefined ? { sha256: file.sha256 } : {}),
        ...(deps.allowedHosts !== undefined ? { allowedHosts: deps.allowedHosts } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      out.push({ path: file.path, state: "downloaded" });
    } catch (error) {
      out.push({ path: file.path, state: "failed", detail: message(error) });
    }
  }
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- removing ----------------------------------------------------------------------------------

export interface RemoveResult {
  /** The environment folder that was deleted. */
  deletedEnv?: string;
  /** Why nothing was deleted, when there was an environment folder or a reason to say. */
  note?: string;
}

/**
 * Deletes the environment hostd manages for a service. An environment `host.toml` names is the
 * user's and stays; so do the models and everything outside `<state>/envs`.
 */
export function removeService(
  host: LoadedHostConfig,
  service: string,
  options: { keepEnv?: boolean } = {},
): RemoveResult {
  if (userEnvDir(host, service) !== null) {
    return { note: "the environment is the one host.toml names; it was left as it is" };
  }
  const dir = managedEnvDir(host, service);
  if (options.keepEnv === true) {
    return existsSync(dir) ? { note: `kept ${dir}` } : {};
  }
  const inside = relative(host.state.envs, dir);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`${dir} is not inside ${host.state.envs}`);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return {};
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return { deletedEnv: dir };
}
