// `miyoria models pull | ls | gc`: the host's model folder, `<state>/models` (docs/design/v5-hostd.md
// §9). Hugging Face repositories are fetched with the service's own environment; `gc` lists what no
// enabled service names and deletes only after a confirmation.

import {
  type Catalog,
  gcModels,
  listModels,
  loadCatalog,
  type ModelEntry,
  type PullDeps,
  pullModels,
} from "@miyoria/hostd";
import { dim, fail, note, ok, println, section, warn } from "../ui.js";
import { catalogRoot, HostCommandError, type HostTarget, loadHost } from "./host.js";
import { progressPrinter, type ServiceDeps } from "./services.js";

/** `1.5 GB`, `320 MB`, `12 KB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function catalogOf(target: HostTarget): Catalog {
  return loadCatalog(catalogRoot(target.hostToml));
}

export interface PullOptions {
  services: string[];
}

/** What `pull` needs from outside beyond the installer's seams. */
export type ModelDeps = ServiceDeps & { pull?: Pick<PullDeps, "runner" | "platform" | "env"> };

/** Fetches the `install.models` of the named services, else of every enabled one. */
export async function pull(
  target: HostTarget,
  options: PullOptions,
  deps: ModelDeps = {},
): Promise<void> {
  const host = loadHost(target);
  const catalog = catalogOf(target);
  const names =
    options.services.length > 0
      ? options.services
      : Object.entries(host.config.services)
          .filter(([, s]) => s.enabled)
          .map(([name]) => name);
  let failures = 0;
  let pulled = 0;
  for (const name of names) {
    const entry = catalog.services.get(name);
    if (entry === undefined) {
      throw new HostCommandError(`目錄裡沒有叫 ${name} 的服務`);
    }
    if (host.config.services[name] === undefined) {
      throw new HostCommandError(`${name} 還不是這台的服務:先 \`miyoria add ${name}\``);
    }
    if (entry.descriptor.install.models.length === 0) continue;
    section(`${name}:下載模型`);
    const results = await pullModels(entry, host, {
      ...deps.pull,
      onLine: progressPrinter(),
    });
    for (const r of results) {
      if (r.state === "pulled") {
        pulled += 1;
        ok(`${r.repo}${r.revision !== undefined ? ` @ ${r.revision.slice(0, 8)}` : ""}`);
        if (r.unpinned) {
          warn(`${r.repo} 的 service.toml 沒有 revision:拿的是預設分支的最新版,沒有固定`);
        }
      } else {
        failures += 1;
        fail(`${r.repo}  ${r.detail ?? r.state}`);
      }
    }
  }
  if (pulled === 0 && failures === 0) note("沒有要下載的模型");
  if (failures > 0) throw new HostCommandError(`${failures} 個模型沒有下載`);
}

/** The model folder with sizes and the services that name each item. */
export function ls(target: HostTarget): void {
  const host = loadHost(target);
  const entries = listModels(catalogOf(target), host);
  section(`模型資料夾 ${host.state.models}`);
  if (entries.length === 0) {
    note("還沒有模型(`miyoria models pull`,或 `miyoria add <服務>` 下載小檔案)");
    return;
  }
  const width = Math.max(...entries.map((e) => e.id.length));
  for (const e of entries) {
    const users =
      e.usedBy.length === 0
        ? dim("沒有服務用到")
        : e.usedBy.map((n) => (e.enabledBy.includes(n) ? n : `${n}(停用)`)).join("、");
    println(
      `  ${e.id.padEnd(width)}  ${formatBytes(e.bytes).padStart(8)}  ${e.kind === "hf" ? "Hugging Face" : "檔案"}  ${users}`,
    );
  }
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  println(dim(`\n共 ${entries.length} 項,${formatBytes(total)}`));
}

export interface GcOptions {
  yes?: boolean;
}

/** Lists what no enabled service names; deletes it after a confirmation (`--yes` skips it). */
export async function gc(
  target: HostTarget,
  options: GcOptions,
  deps: ServiceDeps = {},
): Promise<void> {
  const host = loadHost(target);
  const catalog = catalogOf(target);
  const result = await gcModels(catalog, host, async (candidates: ModelEntry[]) => {
    section("沒有啟用中的服務用到的模型");
    for (const c of candidates) println(`  ${c.id}  ${formatBytes(c.bytes)}`);
    const total = candidates.reduce((sum, c) => sum + c.bytes, 0);
    if (options.yes === true) return true;
    if (deps.confirm === undefined) {
      note("沒有刪除任何東西(要刪請加 --yes,或在終端機裡執行)");
      return false;
    }
    return deps.confirm(`刪除以上 ${candidates.length} 項(${formatBytes(total)}),無法復原?`);
  });
  if (result.candidates.length === 0) {
    ok("每個模型都有啟用中的服務在用");
    return;
  }
  if (result.deleted.length > 0) {
    ok(`已刪除 ${result.deleted.length} 項,釋出 ${formatBytes(result.freedBytes)}`);
  }
}
