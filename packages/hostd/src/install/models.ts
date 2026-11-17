// The host's model folder, `<state>/models`: what is in it, which services name each thing, how
// to fetch the Hugging Face repositories of `install.models`, and what no enabled service needs.
// `gc` never deletes on its own: the caller confirms the list it was given.

import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Catalog, CatalogEntry } from "../catalog.js";
import { mergeEnv, workerBaseEnv } from "../env.js";
import type { LoadedHostConfig } from "../host-config.js";
import { pythonIn } from "../resolve.js";
import { hfCacheName, hfDir, hfRepoOf, hfRevisions } from "./hf.js";
import { type CommandRunner, execaRunner } from "./run.js";
import { envDirOf } from "./service.js";
import { tempDir } from "./uv.js";

export interface ModelEntry {
  /** A repository id (`Qwen/Qwen3-ASR-0.6B`) or a path under the model folder (`smart-turn/x.onnx`). */
  id: string;
  kind: "hf" | "file";
  /** The folder or file, absolute. */
  path: string;
  bytes: number;
  /** For a repository: the revisions in the cache. */
  revisions: string[];
  /** The services in `host.toml` (enabled or not) whose descriptors name it. */
  usedBy: string[];
  /** The enabled ones among them. */
  enabledBy: string[];
}

/** Bytes of regular files below a path; links are not followed. */
export function sizeOf(path: string): number {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const child of readdirSync(path)) total += sizeOf(join(path, child));
  return total;
}

/** Files below a folder, as paths relative to it with `/`. */
function filesBelow(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isDirectory()) out.push(...filesBelow(root, full));
    else out.push(relative(root, full).replaceAll("\\", "/"));
  }
  return out;
}

/** The services of `host.toml` that the catalog knows, with their entries. */
function installed(catalog: Catalog, host: LoadedHostConfig): CatalogEntry[] {
  return Object.keys(host.config.services).flatMap((name) => {
    const entry = catalog.services.get(name);
    return entry === undefined ? [] : [entry];
  });
}

/** What is in the model folder, with sizes and the services that name each item. */
export function listModels(catalog: Catalog, host: LoadedHostConfig): ModelEntry[] {
  const models = host.state.models;
  const entries: ModelEntry[] = [];
  const services = installed(catalog, host);
  const enabled = (name: string) => host.config.services[name]?.enabled !== false;

  const users = (match: (entry: CatalogEntry) => boolean) => {
    const usedBy = services.filter(match).map((e) => e.name);
    return { usedBy, enabledBy: usedBy.filter(enabled) };
  };

  const hf = hfDir(models);
  if (existsSync(hf)) {
    for (const d of readdirSync(hf, { withFileTypes: true })) {
      const repo = d.isDirectory() ? hfRepoOf(d.name) : null;
      if (repo === null) continue;
      entries.push({
        id: repo,
        kind: "hf",
        path: join(hf, d.name),
        bytes: sizeOf(join(hf, d.name)),
        revisions: hfRevisions(models, repo),
        ...users((e) => e.descriptor.install.models.some((m) => m.repo === repo)),
      });
    }
  }
  if (existsSync(models)) {
    for (const file of filesBelow(models)) {
      if (file.startsWith("hf/")) continue;
      const path = join(models, file);
      entries.push({
        id: file,
        kind: "file",
        path,
        bytes: sizeOf(path),
        revisions: [],
        ...users((e) => e.descriptor.install.files.some((f) => f.path === file)),
      });
    }
  }
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- pull --------------------------------------------------------------------------------------

export interface ModelPullResult {
  service: string;
  repo: string;
  revision?: string;
  state: "pulled" | "failed" | "no-environment";
  /** The snapshot folder, when pulled. */
  path?: string;
  /** No `revision` in the descriptor: the default branch was pulled. */
  unpinned: boolean;
  detail?: string;
}

export interface PullDeps {
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

/** Run by the service environment's Python; `huggingface_hub` is in it as a dependency of the models. */
const PULL_SCRIPT = [
  "import sys",
  "from huggingface_hub import snapshot_download",
  "print(snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2] or None))",
].join("\n");

/**
 * Fetches the `install.models` of a service into `<state>/models/hf` with the service's own
 * environment. A service without an environment yet reports that `add` comes first.
 */
export async function pullModels(
  entry: CatalogEntry,
  host: LoadedHostConfig,
  deps: PullDeps = {},
): Promise<ModelPullResult[]> {
  const platform = deps.platform ?? process.platform;
  const source = deps.env ?? process.env;
  const results: ModelPullResult[] = [];
  const python = pythonIn(envDirOf(host, entry.name), platform);
  for (const model of entry.descriptor.install.models) {
    const base = {
      service: entry.name,
      repo: model.repo,
      ...(model.revision !== undefined ? { revision: model.revision } : {}),
      unpinned: model.revision === undefined,
    };
    if (!existsSync(python)) {
      results.push({
        ...base,
        state: "no-environment",
        detail: `${entry.name} has no environment yet: run \`miyoria add ${entry.name}\` first`,
      });
      continue;
    }
    const ca = host.config.paths.ca_bundle;
    const added: Record<string, string> = {
      HF_HUB_CACHE: hfDir(host.state.models),
      TMP: tempDir(host),
      TEMP: tempDir(host),
      TMPDIR: tempDir(host),
      ...(ca !== undefined
        ? { SSL_CERT_FILE: join(host.workspace, ca), REQUESTS_CA_BUNDLE: join(host.workspace, ca) }
        : {}),
    };
    const outcome = await (deps.runner ?? execaRunner)(
      {
        file: python,
        args: ["-c", PULL_SCRIPT, model.repo, model.revision ?? ""],
        env: mergeEnv([workerBaseEnv(source), added], platform),
      },
      {
        ...(deps.onLine !== undefined ? { onLine: deps.onLine } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      },
    );
    if (outcome.code !== 0) {
      results.push({
        ...base,
        state: "failed",
        detail: `${outcome.missing ? "the environment's Python could not run" : `exit ${outcome.code ?? "none"}`}${
          outcome.tail.length > 0 ? `:\n${outcome.tail.join("\n")}` : ""
        }`,
      });
      continue;
    }
    const path = [...outcome.tail].reverse().find((line) => line.trim() !== "");
    results.push({
      ...base,
      state: "pulled",
      ...(path !== undefined ? { path: path.trim() } : {}),
    });
  }
  return results;
}

// ---- gc ----------------------------------------------------------------------------------------

export interface GcResult {
  /** What no enabled service names. */
  candidates: ModelEntry[];
  /** What was deleted (the confirmed part of `candidates`). */
  deleted: ModelEntry[];
  freedBytes: number;
}

/** Removes empty folders from a deleted file's parent up to (not including) `stop`. */
function pruneEmpty(dir: string, stop: string): void {
  let current = dir;
  while (
    current !== stop &&
    relative(stop, current) !== "" &&
    !relative(stop, current).startsWith("..")
  ) {
    try {
      rmdirSync(current);
    } catch {
      return; // not empty
    }
    current = dirname(current);
  }
}

/**
 * Lists what no enabled service names. With `confirm`, deletes the entries it returns (all of
 * the candidates when it returns `true`). Without it nothing is deleted.
 */
export async function gcModels(
  catalog: Catalog,
  host: LoadedHostConfig,
  confirm?: (candidates: ModelEntry[]) => Promise<ModelEntry[] | boolean> | ModelEntry[] | boolean,
): Promise<GcResult> {
  const candidates = listModels(catalog, host).filter((m) => m.enabledBy.length === 0);
  const result: GcResult = { candidates, deleted: [], freedBytes: 0 };
  if (confirm === undefined || candidates.length === 0) return result;
  const answer = await confirm(candidates);
  const chosen = answer === true ? candidates : answer === false ? [] : answer;
  const allowed = new Set(candidates.map((c) => c.path));
  for (const model of chosen) {
    if (!allowed.has(model.path)) continue; // only what was offered
    rmSync(model.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (model.kind === "hf") {
      rmSync(join(hfDir(host.state.models), ".locks", hfCacheName(model.id)), {
        recursive: true,
        force: true,
      });
    } else {
      pruneEmpty(dirname(model.path), host.state.models);
    }
    result.deleted.push(model);
    result.freedBytes += model.bytes;
  }
  return result;
}
