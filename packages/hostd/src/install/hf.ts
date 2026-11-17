// The Hugging Face cache hostd gives every Python service (`HF_HUB_CACHE=<state>/models/hf`):
// where a repository lives in it, and whether a revision is there.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The cache folder of a repository id: `Org/Name` → `models--Org--Name`. */
export function hfCacheName(repo: string): string {
  return `models--${repo.replaceAll("/", "--")}`;
}

/** The repository id of a cache folder name; `null` when it is not a model repository. */
export function hfRepoOf(folder: string): string | null {
  if (!folder.startsWith("models--")) return null;
  return folder.slice("models--".length).replaceAll("--", "/");
}

/** `<models>/hf`. */
export function hfDir(modelsDir: string): string {
  return join(modelsDir, "hf");
}

/** The snapshot revisions a repository has in the cache. */
export function hfRevisions(modelsDir: string, repo: string): string[] {
  const snapshots = join(hfDir(modelsDir), hfCacheName(repo), "snapshots");
  if (!existsSync(snapshots)) return [];
  return readdirSync(snapshots, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Whether the cache has the repository, at `revision` when one is given. */
export function hfCacheHas(modelsDir: string, repo: string, revision?: string): boolean {
  return hfCacheHasIn(hfDir(modelsDir), repo, revision);
}

/**
 * The same for a cache folder given as it is: a service whose environment sets its own
 * `HF_HUB_CACHE` (a machine that kept its models where they were) reads that one, not the host's.
 */
export function hfCacheHasIn(cacheDir: string, repo: string, revision?: string): boolean {
  const base = join(cacheDir, hfCacheName(repo));
  const snapshots = join(base, "snapshots");
  const revisions = existsSync(snapshots)
    ? readdirSync(snapshots, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  if (revision === undefined) return revisions.length > 0;
  // A commit is a snapshot folder; a branch or tag is a file in refs/ that names the commit.
  return revisions.includes(revision) || existsSync(join(base, "refs", ...revision.split("/")));
}
