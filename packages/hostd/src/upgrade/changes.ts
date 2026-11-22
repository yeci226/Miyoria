// What a set of changed files means for the services of a host: which ones run changed code, and
// what an update cannot do by itself (docs/design/v5-hostd.md §9, §14). `miyoria update` uses
// `servicesChangedBy` too.

import { relative } from "node:path";
import type { CatalogEntry } from "../catalog.js";

export interface ChangedByOptions {
  /**
   * A `node` service runs TypeScript from the whole repository (tsx), so any change under
   * `packages/` or `apps/`, or of the root's package files, counts for it. Off for
   * `miyoria update`, which has always looked at the service's own folder only.
   */
  nodeWide?: boolean;
}

/** The files a Node service may load besides its own folder. */
function touchesNode(file: string): boolean {
  return (
    file.startsWith("packages/") ||
    file.startsWith("apps/") ||
    file === "package.json" ||
    file === "pnpm-lock.yaml" ||
    file === "pnpm-workspace.yaml"
  );
}

/**
 * The services a change set touches: those whose folder holds a changed file, and every Python
 * service when a file directly under `workers/` (the modules the workers share) changed.
 */
export function servicesChangedBy(
  files: readonly string[],
  entries: readonly CatalogEntry[],
  root: string,
  options: ChangedByOptions = {},
): Set<string> {
  const shared = files.some((f) => /^workers\/[^/]+\.py$/.test(f));
  const node = options.nodeWide === true && files.some(touchesNode);
  const out = new Set<string>();
  for (const entry of entries) {
    const folder = relative(root, entry.dir).replaceAll("\\", "/");
    const runtime = entry.descriptor.install.runtime;
    if (files.some((f) => f === folder || f.startsWith(`${folder}/`))) out.add(entry.name);
    else if (shared && runtime === "python") out.add(entry.name);
    else if (node && runtime === "node") out.add(entry.name);
  }
  return out;
}

/** A Node dependency changed: `pnpm install` is due. */
export function needsPnpmInstall(files: readonly string[]): boolean {
  return files.some(
    (f) => f === "pnpm-lock.yaml" || f === "pnpm-workspace.yaml" || /(^|\/)package\.json$/.test(f),
  );
}

/** The code hostd itself runs from source (it keeps the old one until it restarts). */
const HOSTD_CODE = ["packages/hostd/", "packages/contracts/", "packages/sdk/", "packages/cli/"];
/** What `miyoria update` builds and a remote update does not. */
const BUILT = ["apps/panel/", "apps/overlay/", "packages/sdk/", "extensions/"];

/** What the host's owner should hear about after a change set (zh-TW, for the panel). */
export function upgradeNotes(files: readonly string[]): string[] {
  const notes: string[] = [];
  if (files.some((f) => HOSTD_CODE.some((p) => f.startsWith(p)))) {
    notes.push(
      "hostd 本身還在跑更新前的程式;要換成新版,在這台執行 `miyoria down` 再 `miyoria up`(服務會跟著重啟)",
    );
  }
  if (files.some((f) => BUILT.some((p) => f.startsWith(p)))) {
    notes.push(
      "這次的變更有要建置的部分(面板、overlay、SDK 或擴充);遠端更新不會建置,這台用得到的話在這台執行 `miyoria update`",
    );
  }
  return notes;
}
