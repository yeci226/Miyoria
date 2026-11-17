// Polling file watcher for dev mode (no platform watcher dependency).

import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionManifest, MANIFEST_FILE } from "./manifest.js";

/** Directories never watched or copied. */
export const SKIP_DIRS: readonly string[] = ["node_modules", ".git", "target"];

/** Path → `"<mtimeMs>:<size>"` of every watched file, ordered by path. */
export type Snapshot = Map<string, string>;

/**
 * Paths whose changes restart an extension: the manifest, the config schema and the directory
 * holding the entry (recursively).
 */
export function watchRoots(dir: string, manifest: ExtensionManifest): string[] {
  const roots = [join(dir, MANIFEST_FILE)];
  if (manifest.config.schema !== null) roots.push(join(dir, manifest.config.schema));
  const parent = dirname(manifest.entry);
  roots.push(parent === "." || parent === "" ? dir : join(dir, parent));
  return roots;
}

export function snapshot(roots: readonly string[]): Snapshot {
  const out: Snapshot = new Map();
  for (const root of roots) walk(root, out, 0);
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Whether two snapshots are identical. */
export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.size !== b.size) return false;
  for (const [path, stamp] of a) if (b.get(path) !== stamp) return false;
  return true;
}

function walk(path: string, out: Snapshot, depth: number): void {
  let meta: ReturnType<typeof statSync>;
  try {
    meta = statSync(path);
  } catch {
    return;
  }
  if (meta.isFile()) {
    out.set(path, `${meta.mtimeMs}:${meta.size}`);
    return;
  }
  if (!meta.isDirectory() || depth > 16) return;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.includes(name)) continue;
    walk(join(path, name), out, depth + 1);
  }
}
