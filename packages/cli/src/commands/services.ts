// `miyoria add | remove <service>`: what this machine runs (docs/design/v5-hostd.md §9, §10).
// `add` writes `[services.<name>]` into host.toml and installs the service (its uv environment, the
// files and the checks of `[install]`); `remove` stops it, deletes the environment hostd manages
// and takes the table out. The work runs inside a running hostd, which then plans the service
// again, or in this process when none runs; either way the output of uv reaches this terminal.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname } from "node:path";
import {
  HOST_ERROR_CODE,
  type HostServiceInstall,
  type HostServiceInstallResult,
  type HostServiceRemove,
  type HostServiceRemoveResult,
  type HostUpdate,
  type HostUpdateResult,
} from "@miyoria/contracts/host";
import {
  type Catalog,
  type CatalogEntry,
  checkServiceFiles,
  type FileStatus,
  formatBytes,
  HostdClient,
  HostRpcError,
  type InstallDeps,
  installService,
  type LoadedHostConfig,
  loadCatalog,
  removeService,
} from "@miyoria/hostd";
import { TomlDocument } from "../toml-patch.js";
import { bold, dim, fail, note, ok, println, section, warn } from "../ui.js";
import { catalogRoot, HostCommandError, type HostTarget, loadHost } from "./host.js";

/** What the commands need from outside; tests replace each of them. */
export interface ServiceDeps {
  /** The installer's seams: the runner, the downloads, PATH, the platform. */
  install?: Omit<InstallDeps, "root">;
  confirm?: (message: string) => Promise<boolean>;
  /** `--yes`: agree without asking. */
  yes?: boolean;
  /** A person is at a terminal to answer `confirm` (default: when there is a `confirm`). */
  interactive?: boolean;
}

// ---- the model files to download ---------------------------------------------------------------

/** A file of `[[install.files]]` that is missing or wrong, and its service. */
export interface FileNeed {
  service: string;
  status: FileStatus;
}

/** The files of these services to download: missing, or the wrong size or checksum. */
export async function filesToFetch(
  entries: readonly CatalogEntry[],
  host: LoadedHostConfig,
): Promise<FileNeed[]> {
  const out: FileNeed[] = [];
  for (const entry of entries) {
    for (const status of await checkServiceFiles(entry, host, "cached")) {
      if (status.state === "missing" || status.state === "wrong") {
        out.push({ service: entry.name, status });
      }
    }
  }
  return out;
}

/** What a file still costs to download: nothing for one adopted from where the machine has it. */
const remaining = (s: FileStatus) => (s.adopt !== null ? 0 : Math.max(s.size - s.partBytes, 0));

/** The list a person agrees to: each file with its size, licence and source, and the total. */
export function printFileNeeds(needs: readonly FileNeed[], models: string): void {
  section("要下載的模型檔");
  for (const { service, status: s } of needs) {
    if (s.adopt !== null) {
      println(
        `  ${bold(service)}  ${s.path}  ${formatBytes(s.size)}  沿用 ${s.adopt}(檢查碼相同,硬連結,不用下載)`,
      );
      println(dim(`      ${s.what}${s.optional ? "(沒有也能跑)" : ""}`));
      continue;
    }
    const resume = s.partBytes > 0 ? `(續傳,還要 ${formatBytes(remaining(s))})` : "";
    println(
      `  ${bold(service)}  ${s.path}  ${formatBytes(s.size)}${resume}  授權 ${s.licence}  來自 ${s.source}`,
    );
    const why = s.state === "wrong" ? `;現在的檔案不對(${s.detail ?? "檢查碼不符"}),會換掉` : "";
    println(dim(`      ${s.what}${s.optional ? "(沒有也能跑)" : ""}${why}`));
  }
  const total = needs.reduce((n, { status }) => n + remaining(status), 0);
  println(`  共 ${formatBytes(total)},放到 ${models}`);
}

/**
 * Lists the files and asks once whether to download them. `--yes` agrees; without a terminal and
 * without `--yes` it throws with the command to run (`again`).
 */
export async function confirmFiles(
  needs: readonly FileNeed[],
  host: LoadedHostConfig,
  deps: ServiceDeps,
  again: string,
): Promise<boolean> {
  if (needs.length === 0) return true;
  printFileNeeds(needs, host.state.models);
  // Only files already on this machine: nothing is downloaded, so there is nothing to agree to.
  if (needs.every((n) => n.status.adopt !== null)) return true;
  if (deps.yes === true) return true;
  const canAsk = deps.interactive ?? deps.confirm !== undefined;
  if (!canAsk || deps.confirm === undefined) {
    throw new HostCommandError(`沒有終端機可以確認要不要下載上面的檔案;同意的話執行 \`${again}\``);
  }
  const total = needs.reduce((n, { status }) => n + remaining(status), 0);
  const fetched = needs.filter((n) => n.status.adopt === null).length;
  return deps.confirm(`下載這 ${fetched} 個檔案(共 ${formatBytes(total)})?`);
}

/** The lines about `install.files` of one install result. Returns whether one failed. */
export function printFiles(result: HostServiceInstallResult): boolean {
  const name = bold(result.service);
  let failed = false;
  for (const f of result.files) {
    if (f.state === "downloaded") ok(`${name}  已下載並驗證 ${f.path}`);
    else if (f.state === "present" && f.detail !== undefined) ok(`${name}  ${f.path}:${f.detail}`);
    else if (f.state === "failed") {
      failed = true;
      fail(`${result.service}  ${f.path}:${f.detail ?? "下載失敗"}`);
    } else if (f.state === "missing") {
      warn(`${name}  還沒有 ${f.path}${f.detail !== undefined ? `(${f.detail})` : ""}`);
    }
  }
  return failed;
}

// ---- progress output ---------------------------------------------------------------------------

const PROGRESS = /(\d+(\.\d+)?\s*%)|(it\/s)|(\/s\])|(\bETA\b)/;

/** Prints the output of uv or of a download as dim lines; a progress bar at most twice a second. */
export function progressPrinter(): (line: string) => void {
  let last = 0;
  return (line) => {
    if (PROGRESS.test(line)) {
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
    }
    println(dim(`    ${line.length > 160 ? `${line.slice(0, 157)}...` : line}`));
  };
}

// ---- the installer, in the daemon or in this process --------------------------------------------

export interface Installer {
  readonly mode: "daemon" | "local";
  /** The running daemon, when there is one. */
  readonly client: HostdClient | null;
  install(
    params: HostServiceInstall,
    onLine: (line: string) => void,
  ): Promise<HostServiceInstallResult>;
  remove(params: HostServiceRemove): Promise<HostServiceRemoveResult>;
  update(params: HostUpdate, onLine: (line: string) => void): Promise<HostUpdateResult>;
}

/** Long enough for a CUDA torch sync on a slow line. */
const INSTALL_TIMEOUT_MS = 2 * 60 * 60_000;

/** What `add voice-node` says on an install that has no repository around it. */
export const VOICE_NODE_NEEDS_REPOSITORY =
  "語音節點目前還沒有跟著 miyoria 套件發行,要用它需要 repository:clone 專案後在裡面執行 `miyoria add voice-node`(之後的版本會把它放進套件)";

function entryOf(catalog: Catalog, name: string): CatalogEntry {
  const entry = catalog.services.get(name);
  if (entry === undefined) {
    // The voice node runs from source: the package's catalog does not list it.
    if (name === "voice-node") throw new HostCommandError(VOICE_NODE_NEEDS_REPOSITORY);
    throw new HostCommandError(unknownService(catalog, name));
  }
  return entry;
}

/** Talks to the daemon when one answers for this workspace, else works in this process. */
export async function openInstaller(
  target: HostTarget,
  host: LoadedHostConfig,
  deps: ServiceDeps = {},
): Promise<Installer> {
  const client = await HostdClient.connect(host.state.root);
  if (client !== null) {
    return {
      mode: "daemon",
      client,
      install: (params, onLine) =>
        client.call<HostServiceInstallResult>("service.install", params, {
          onLine,
          timeoutMs: INSTALL_TIMEOUT_MS,
        }),
      remove: (params) =>
        client.call<HostServiceRemoveResult>("service.remove", params, { timeoutMs: 120_000 }),
      update: (params, onLine) =>
        client.call<HostUpdateResult>("host.update", params, {
          onLine,
          timeoutMs: INSTALL_TIMEOUT_MS,
        }),
    };
  }
  const root = catalogRoot(target.hostToml);
  const installDeps: InstallDeps = { ...deps.install, root };
  const fresh = () => loadHost(target);
  return {
    mode: "local",
    client: null,
    install: async (params, onLine) => {
      const catalog = loadCatalog(root);
      return installService(entryOf(catalog, params.service), fresh(), installDeps, {
        ...(params.extras !== undefined ? { extras: params.extras } : {}),
        ...(params.only_stale !== undefined ? { onlyStale: params.only_stale } : {}),
        ...(params.no_files !== undefined ? { noFiles: params.no_files } : {}),
        onLine,
      });
    },
    remove: async (params) => {
      const removed = removeService(fresh(), params.service, {
        ...(params.keep_env !== undefined ? { keepEnv: params.keep_env } : {}),
      });
      return {
        service: params.service,
        stopped: false,
        ...(removed.deletedEnv !== undefined ? { deleted_env: removed.deletedEnv } : {}),
      };
    },
    update: async (params, onLine) => {
      const catalog = loadCatalog(root);
      const loaded = fresh();
      const names = (params.services ?? Object.keys(loaded.config.services)).filter(
        (name) => loaded.config.services[name]?.enabled !== false,
      );
      const services: HostServiceInstallResult[] = [];
      for (const name of names) {
        const entry = catalog.services.get(name);
        if (entry === undefined || entry.descriptor.install.runtime !== "python") continue;
        services.push(
          await installService(entry, loaded, installDeps, {
            onlyStale: params.force !== true,
            // As the daemon's `host.update`: files only after the person agreed.
            noFiles: true,
            onLine,
          }),
        );
      }
      return { services };
    },
  };
}

// ---- host.toml ---------------------------------------------------------------------------------

/** `host.toml` is created with the machine's name when there is none. */
function ensureHostToml(hostToml: string): TomlDocument {
  if (!existsSync(hostToml)) {
    mkdirSync(dirname(hostToml), { recursive: true });
    const name = osHostname().toLowerCase() || "main";
    writeFileSync(hostToml, `name = ${JSON.stringify(name)}\n`, "utf8");
    note(`建立 ${hostToml}(name = "${name}")`);
  }
  return TomlDocument.parse(readFileSync(hostToml, "utf8"));
}

/** Adds `[services.<name>]` with `enabled = true` (and `extras` when given); comments stay. */
export function addHostService(hostToml: string, name: string, extras?: readonly string[]): void {
  const doc = ensureHostToml(hostToml);
  if (doc.get(["services", name, "enabled"]) !== true) doc.set(["services", name, "enabled"], true);
  if (extras !== undefined) doc.set(["services", name, "extras"], [...extras]);
  writeFileSync(hostToml, doc.toString(), "utf8");
}

/** Takes `[services.<name>]` out of host.toml. Returns whether there was one. */
export function removeHostService(hostToml: string, name: string): boolean {
  const doc = TomlDocument.parse(readFileSync(hostToml, "utf8"));
  const removed = doc.unset(["services", name]);
  if (removed) writeFileSync(hostToml, doc.toString(), "utf8");
  return removed;
}

// ---- add ---------------------------------------------------------------------------------------

function unknownService(catalog: Catalog, name: string): string {
  const known = [...catalog.services.values()]
    .map((e) => `  ${e.name.padEnd(12)} ${e.descriptor.summary}`)
    .join("\n");
  return `沒有叫 ${name} 的服務。目錄裡有:\n${known}`;
}

export interface AddOptions {
  services: string[];
  /** Only edit host.toml. */
  noInstall?: boolean;
  /** Replaces the extras of the descriptor; written to `[services.<name>] extras`. */
  extras?: string[];
}

/** The catalog as a table: name, summary, what it provides, whether host.toml has it. */
export function listCatalog(catalog: Catalog, host: LoadedHostConfig | null): void {
  section("可以加進這台電腦的服務");
  const rows = [...catalog.services.values()].map((e) => {
    const added = host?.config.services[e.name];
    return [
      e.name,
      e.descriptor.summary,
      e.descriptor.provides.join("、") || "-",
      added === undefined ? "-" : added.enabled ? "已加入" : "已加入(停用)",
    ];
  });
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => displayWidth(r[i] as string))));
  for (const row of rows) {
    const cells = [0, 1, 2].map(
      (i) => (row[i] as string) + " ".repeat((widths[i] ?? 0) - displayWidth(row[i] as string)),
    );
    println(`  ${cells.join("  ")}  ${row[3]}`);
  }
  for (const p of catalog.problems) warn(`${p.file}:${p.message}`);
  println(dim("\n`miyoria add <服務>...` 加入並安裝;`miyoria doctor` 檢查還缺什麼。"));
}

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
  return width;
}

/** What one install result says, in the terminal. Returns whether it counts as a failure. */
export function printInstall(
  result: HostServiceInstallResult,
  options: { brief?: boolean } = {},
): boolean {
  const name = bold(result.service);
  const rt = result.runtime;
  switch (rt.state) {
    case "synced":
      ok(
        `${name}  環境已建好${rt.extras && rt.extras.length > 0 ? `(extras:${rt.extras.join("、")})` : ""}  ${dim(rt.dir ?? "")}`,
      );
      break;
    case "current":
      ok(`${name}  環境已是最新`);
      break;
    case "user-managed":
      (rt.detail?.includes("does not exist") ? warn : note)(
        `${name}  ${rt.detail ?? "用你自己的環境,不會動它"}`,
      );
      break;
    case "none":
      break;
    case "unsupported":
      fail(`${result.service}  這個平台不支援:${rt.detail ?? ""}`);
      break;
    case "uv-missing":
      fail(`${result.service}  找不到 uv:${rt.detail ?? ""}`);
      println(dim("    uv 不會被自動安裝;裝好後重新執行同一個指令"));
      break;
    case "failed":
      fail(`${result.service}  環境沒有建好:${rt.detail ?? ""}`);
      break;
  }
  if (options.brief) return !result.ok;
  for (const s of result.system) {
    if (s.found) continue;
    warn(
      `${name}  PATH 上找不到 ${s.program}(不會替你安裝)${s.hint !== undefined ? `:${s.hint}` : ""}`,
    );
  }
  printFiles(result);
  for (const m of result.manual) {
    if (!m.present) warn(`${name}  要你自己放:${m.what}(${m.path})`);
  }
  const unpulled = result.models.filter((m) => !m.present);
  if (unpulled.length > 0) {
    note(
      `${result.service}  模型還沒下載:${unpulled.map((m) => m.repo).join("、")}(\`miyoria models pull ${result.service}\`)`,
    );
  }
  return !result.ok;
}

/** `miyoria add`: lists the catalog without names; otherwise adds and installs each service. */
export async function add(
  target: HostTarget,
  options: AddOptions,
  deps: ServiceDeps = {},
): Promise<void> {
  const catalog = loadCatalog(catalogRoot(target.hostToml));
  if (options.services.length === 0) {
    listCatalog(catalog, existsSync(target.hostToml) ? loadHost(target) : null);
    return;
  }
  const entries = options.services.map((name) => entryOf(catalog, name));
  if (options.extras !== undefined && entries.length !== 1) {
    throw new HostCommandError("--extra 只能用在一個服務上(每個服務的 extras 名稱不同)");
  }
  const platform = deps.install?.platform ?? process.platform;
  const unsupported = entries.filter((e) => !e.descriptor.platforms.includes(platform));
  if (unsupported.length > 0) {
    throw new HostCommandError(
      unsupported
        .map((e) => `${e.name} 只支援 ${e.descriptor.platforms.join("、")},這台是 ${platform}`)
        .join(";"),
    );
  }

  for (const entry of entries) addHostService(target.hostToml, entry.name, options.extras);
  ok(`${target.hostToml}:加入 ${entries.map((e) => e.name).join("、")}`);
  if (options.noInstall) {
    note("沒有安裝(--no-install);`miyoria add <服務>` 或 `miyoria doctor --fix` 之後補裝");
    return;
  }

  const host = loadHost(target);
  // The model files: listed with sizes and licences, one question for all of them.
  const needs = await filesToFetch(entries, host);
  const download = await confirmFiles(
    needs,
    host,
    deps,
    `miyoria add ${entries.map((e) => e.name).join(" ")} --yes`,
  );
  if (needs.length > 0 && !download) {
    note("不下載模型檔;之後 `miyoria doctor --fix` 可以補(缺必要檔案的服務 hostd 不會啟動)");
  }
  const installer = await openInstaller(target, host, deps);
  note(installer.mode === "daemon" ? "交給執行中的 hostd 安裝" : "hostd 沒有在執行,在這裡安裝");
  const printed: HostServiceInstallResult[] = [];
  let failures = 0;
  for (const entry of entries) {
    section(`安裝 ${entry.name}`);
    let result: HostServiceInstallResult;
    try {
      result = await installer.install(
        {
          service: entry.name,
          ...(options.extras !== undefined ? { extras: options.extras } : {}),
          ...(download ? {} : { no_files: true }),
        },
        progressPrinter(),
      );
    } catch (error) {
      failures += 1;
      fail(`${entry.name}  ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    printed.push(result);
    if (printInstall(result)) failures += 1;
  }
  if (failures > 0) {
    throw new HostCommandError(
      `${failures} 個服務沒有裝好,見上面的訊息;修好後重新執行(已完成的會跳過)`,
    );
  }
  const todo = printed.filter(
    (r) =>
      r.manual.some((m) => !m.present) ||
      r.files.some((f) => f.state === "missing") ||
      r.system.some((s) => !s.found) ||
      r.models.some((m) => !m.present),
  );
  println(
    `\n${bold("完成")}${todo.length > 0 ? ",上面標 ! 的還要處理" : ""}。下一步:\`miyoria up ${entries.map((e) => e.name).join(" ")}\`(\`miyoria doctor\` 檢查缺什麼)`,
  );
}

// ---- remove ------------------------------------------------------------------------------------

export interface RemoveOptions {
  services: string[];
  /** Keep the environment folder. */
  keepEnv?: boolean;
  /** Stop a running service although she is singing or live. */
  force?: boolean;
}

/** `miyoria remove`: stops each service, deletes its managed environment, removes its table. */
export async function remove(
  target: HostTarget,
  options: RemoveOptions,
  deps: ServiceDeps = {},
): Promise<void> {
  const host = loadHost(target);
  const installer = await openInstaller(target, host, deps);
  let errors = 0;
  for (const name of options.services) {
    if (host.config.services[name] === undefined) {
      warn(`${target.hostToml} 沒有 [services.${name}],略過`);
      continue;
    }
    try {
      const result = await installer.remove({
        service: name,
        force: options.force === true,
        keep_env: options.keepEnv === true,
      });
      if (result.stopped) println(`■ ${name}  已停止`);
      if (result.deleted_env !== undefined) ok(`${name}  已刪除環境 ${result.deleted_env}`);
      else if (host.config.services[name]?.python !== undefined) {
        note(`${name}  環境是你在 host.toml 指定的,沒有動它`);
      } else if (options.keepEnv) note(`${name}  環境保留(--keep-env)`);
    } catch (error) {
      errors += 1;
      if (error instanceof HostRpcError && error.code === HOST_ERROR_CODE.Guarded) {
        fail(`${name}  ${error.message}`);
      } else fail(`${name}  ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    removeHostService(target.hostToml, name);
    ok(`${target.hostToml}:移除 [services.${name}]`);
  }
  note("模型沒有動;`miyoria models gc` 會列出沒有服務用到的");
  if (errors > 0) throw new HostCommandError(`${errors} 個服務沒有移除`);
}
