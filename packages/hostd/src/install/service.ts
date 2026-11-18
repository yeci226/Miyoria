// Installing one service (docs/design/v5-hostd.md §9): the Python environment with `uv sync
// --frozen`, then a check of `install.system`, a download of `install.files`, a look at
// `install.manual` and at the models. Nothing here installs a system program, and nothing here
// touches a folder outside the state folder, except the catalog's own files it reads.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { HostInstallRuntimeState, HostServiceInstallResult } from "@miyoria/contracts/host";
import type { CatalogEntry } from "../catalog.js";
import type { LoadedHostConfig } from "../host-config.js";
import { pythonIn } from "../resolve.js";
import { downloadFile, type Fetch, formatBytes } from "./download.js";
import {
  adoptFile,
  bytesToFetch,
  type CheckMode,
  checkFiles,
  checkFilesQuick,
  type FileStatus,
  fileDestIn,
  hashAndRemember,
  spaceProblem,
  VerifiedCache,
  verifiedCacheFile,
} from "./files.js";
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
  /** Free bytes on the drive of a folder (tests); default the drive's own answer. */
  freeBytes?: (dir: string) => number | null;
  /** Shorter waits for the downloads (tests). */
  downloadTimings?: { idleTimeoutMs?: number; retryDelaysMs?: readonly number[] };
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

/**
 * Where a download of `install.files` goes: `<state>/models/<path>`, the state folder `host.toml`
 * names (`[paths] state`, relative to the workspace), so a packaged install keeps its models in the
 * user's folder and not in the package's. Throws when `path` escapes it.
 */
export function fileDest(host: LoadedHostConfig, path: string): string {
  return fileDestIn(host.state.models, path);
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
  /** `install.files`, looked at without reading them (`checkServiceFiles` hashes). */
  files: FileStatus[];
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
    files: checkFilesQuick(install.files, host.state.models, host.state.root),
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
 * The `install.files` of a service, hashed as `mode` says (`cached`: only what changed since it was
 * last hashed; `deep`: everything). Hashes are remembered for the next check.
 */
export function checkServiceFiles(
  entry: CatalogEntry,
  host: LoadedHostConfig,
  mode: CheckMode,
): Promise<FileStatus[]> {
  return checkFiles(
    entry.descriptor.install.files,
    host.state.models,
    host.state.root,
    mode,
    host.workspace,
  );
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
  const files = await fetchFiles(entry, host, deps, options, failedRuntime);
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

/**
 * The `install.files` step: a file that is there and matches stays; a missing one, or one whose
 * size or checksum is wrong, is downloaded (one at a time) unless `noFiles` or `skip` says not to,
 * after a check that the drive has room for all of them. Without downloading, a missing or wrong
 * file is reported as `missing`; it does not make the install fail.
 */
async function fetchFiles(
  entry: CatalogEntry,
  host: LoadedHostConfig,
  deps: InstallDeps,
  options: InstallOptions,
  skip: boolean,
): Promise<HostServiceInstallResult["files"]> {
  const declared = entry.descriptor.install.files;
  if (declared.length === 0) return [];
  const download = options.noFiles !== true && !skip;
  const statuses = await checkFiles(
    declared,
    host.state.models,
    host.state.root,
    download ? "cached" : "quick",
    host.workspace,
  );
  const out = new Map<string, HostServiceInstallResult["files"][number]>();
  const todo: FileStatus[] = [];
  for (const s of statuses) {
    if (s.state === "verified" || s.state === "present") {
      out.set(s.path, { path: s.path, state: "present" });
    } else if (!download) {
      out.set(s.path, {
        path: s.path,
        state: "missing",
        ...(s.detail !== undefined ? { detail: s.detail } : {}),
      });
    } else {
      todo.push(s);
    }
  }
  const room =
    todo.length === 0 ? null : spaceProblem(host.state.models, bytesToFetch(todo), deps.freeBytes);
  const cache = new VerifiedCache(verifiedCacheFile(host.state.root));
  for (const s of todo) {
    if (room !== null) {
      out.set(s.path, { path: s.path, state: "failed", detail: room });
      continue;
    }
    if (options.signal?.aborted) {
      out.set(s.path, { path: s.path, state: "failed", detail: "已取消" });
      continue;
    }
    if (s.adopt !== null) {
      try {
        const how = adoptFile(s.adopt, s.dest);
        const stat = statSync(s.dest);
        cache.set(s.path, stat.size, stat.mtimeMs, s.sha256);
        cache.save();
        const label = how === "linked" ? "硬連結" : "複製";
        options.onLine?.(`沿用 ${s.adopt}(檢查碼相同,${label}到 ${s.dest},不用下載)`);
        out.set(s.path, { path: s.path, state: "present", detail: `沿用舊位置的檔案(${label})` });
      } catch (error) {
        out.set(s.path, { path: s.path, state: "failed", detail: message(error) });
      }
      continue;
    }
    options.onLine?.(`下載 ${s.path}(${formatBytes(s.size)},來自 ${s.source},授權 ${s.licence})`);
    try {
      const done = await downloadFile(s.url, s.dest, {
        sha256: s.sha256,
        size: s.size,
        label: s.path,
        ...(options.onLine !== undefined ? { onProgress: options.onLine } : {}),
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.allowedHosts !== undefined ? { allowedHosts: deps.allowedHosts } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(deps.downloadTimings?.idleTimeoutMs !== undefined
          ? { idleTimeoutMs: deps.downloadTimings.idleTimeoutMs }
          : {}),
        ...(deps.downloadTimings?.retryDelaysMs !== undefined
          ? { retryDelaysMs: deps.downloadTimings.retryDelaysMs }
          : {}),
      });
      const stat = statSync(s.dest);
      cache.set(s.path, stat.size, stat.mtimeMs, done.sha256);
      cache.save();
      out.set(s.path, { path: s.path, state: "downloaded" });
    } catch (error) {
      out.set(s.path, { path: s.path, state: "failed", detail: message(error) });
    }
  }
  return statuses.map((s) => out.get(s.path) ?? { path: s.path, state: "missing" });
}

// ---- the hashes of what is here ----------------------------------------------------------------

export interface PresentFile {
  /** Where it was found: `install.files`, or the `install.manual` path it is in. */
  from: string;
  /** The file, absolute. */
  file: string;
  /** A `path` for `[[install.files]]`: relative to the model folder. */
  path: string;
  sha256: string;
  size: number;
}

/** A folder with more files than this is source code or a cache, not model files. */
const MAX_FOLDER_FILES = 50;

function filesIn(dir: string): string[] | null {
  const out: string[] = [];
  const walk = (current: string): boolean => {
    for (const d of readdirSync(current, { withFileTypes: true })) {
      if (d.name === ".git") return false;
      const full = join(current, d.name);
      if (d.isDirectory()) {
        if (!walk(full)) return false;
      } else if (d.isFile()) {
        out.push(full);
        if (out.length > MAX_FOLDER_FILES) return false;
      }
    }
    return true;
  };
  return walk(dir) ? out.sort() : null;
}

/**
 * The SHA-256 and size of the files of a service that are on this machine: its `install.files`,
 * and what its `install.manual` items hold, so a file placed by hand can become an
 * `[[install.files]]` entry (`miyoria doctor --print-hashes`). Hashes are remembered.
 */
export async function presentFileHashes(
  entry: CatalogEntry,
  host: LoadedHostConfig,
  root: string,
): Promise<{ files: PresentFile[]; skipped: Array<{ path: string; why: string }> }> {
  const models = host.state.models;
  const cache = new VerifiedCache(verifiedCacheFile(host.state.root));
  const files: PresentFile[] = [];
  const skipped: Array<{ path: string; why: string }> = [];
  const add = async (from: string, file: string, path: string) => {
    const insideModels = relative(models, file);
    const key =
      insideModels.startsWith("..") || isAbsolute(insideModels)
        ? file
        : insideModels.replaceAll("\\", "/");
    const sha = await hashAndRemember(cache, key, file);
    files.push({ from, file, path, sha256: sha, size: statSync(file).size });
  };
  for (const declared of entry.descriptor.install.files) {
    const dest = fileDest(host, declared.path);
    if (existsSync(dest) && statSync(dest).isFile())
      await add("install.files", dest, declared.path);
    else skipped.push({ path: dest, why: "不在這台" });
  }
  for (const item of entry.descriptor.install.manual) {
    const where = manualPath(entry, host, root, item.path);
    if (!existsSync(where)) {
      skipped.push({ path: where, why: "不在這台" });
      continue;
    }
    const inside = (file: string): string => {
      const r = relative(models, file);
      if (!r.startsWith("..") && !isAbsolute(r)) return r.replaceAll("\\", "/");
      return [basename(where), relative(where, file)]
        .filter((p) => p !== "")
        .join("/")
        .replaceAll("\\", "/");
    };
    if (statSync(where).isFile()) {
      await add(item.path, where, inside(where));
      continue;
    }
    const below = filesIn(where);
    if (below === null) {
      skipped.push({
        path: where,
        why: `資料夾裡有 .git 或超過 ${MAX_FOLDER_FILES} 個檔案(原始碼?),不適合 install.files`,
      });
      continue;
    }
    for (const file of below) await add(item.path, file, inside(file));
  }
  cache.save();
  return { files, skipped };
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
