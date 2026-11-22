// `miyoria update`: pull, install, and rebuild what changed (SDK, extension `dist`, panel, overlay,
// Minecraft mod jar). Rebuilds are decided by file times, so an unchanged tree does nothing.
// Replacing the installed mod jar backs the old one up first and asks (`--yes` skips the question).
// Then the services (docs/design/v5-hostd.md §9): every enabled Python service whose install record
// differs from the lock, the extras or the descriptor is synced again, and every running service
// that was synced or whose folder changed in the pull is restarted, one at a time through the
// guard. A guarded service that is busy is reported and left running. Last, the model files of
// `[[install.files]]` that are missing or wrong are listed with sizes and licences and, after one
// question (`--yes` skips it), downloaded.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { HOST_ERROR_CODE, type HostServiceList } from "@miyoria/contracts/host";
import {
  type CatalogEntry,
  HostdClient,
  HostRpcError,
  inspectService,
  loadCatalog,
  servicesChangedBy,
} from "@miyoria/hostd";
import type { Config } from "@miyoria/runtime/kernel";
import {
  type BuildTarget,
  buildTargets,
  checkTarget,
  findJdk21,
  installedModJars,
  minecraftModsDir,
  modFreshness,
  modInfo,
} from "../stack/builds.js";
import { repoRoot } from "../stack/config.js";
import { defaultRunner, type Runner, tailLines } from "../stack/system.js";
import { bold, dim, fail, note, ok, println, section, warn } from "../ui.js";
import {
  catalogRoot,
  HostCommandError,
  hostTarget,
  loadHost,
  rpcText,
  watchStarts,
} from "./host.js";
import { loadConfig } from "./node.js";
import {
  confirmFiles,
  filesToFetch,
  openInstaller,
  printFileNeeds,
  printFiles,
  printInstall,
  progressPrinter,
  type ServiceDeps,
} from "./services.js";

export class UpdateError extends Error {
  override readonly name = "UpdateError";
}

export interface UpdateOptions {
  /** Do not `git pull`. */
  noPull?: boolean;
  /** Rebuild everything, fresh or not. */
  force?: boolean;
  /** Only say what would run. */
  dryRun?: boolean;
  /** Do not build or install the Minecraft mod. */
  skipMod?: boolean;
  /** Sync the environments, but restart nothing. */
  noRestart?: boolean;
  /** `--host-config`: the host.toml of this machine (default: next to the config file). */
  hostConfig?: string;
}

export interface UpdateDeps {
  run: Runner;
  /** Asked before replacing the installed mod jar. */
  confirm: (message: string) => Promise<boolean>;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  now: () => Date;
  /** The installer's seams for the services part (tests), and the download question. */
  services?: ServiceDeps;
}

export function defaultUpdateDeps(confirm: UpdateDeps["confirm"]): UpdateDeps {
  return {
    run: defaultRunner,
    confirm,
    env: process.env,
    platform: process.platform,
    now: () => new Date(),
  };
}

const BUILD_TIMEOUT_MS = 15 * 60_000;

function failureTail(stdout: string, stderr: string): string[] {
  return tailLines(`${stderr}\n${stdout}`, 12).map((l) => dim(`    | ${l}`));
}

/** `pnpm install` is due when the lockfile is newer than what the last install recorded. */
export function installNeeded(root: string): boolean {
  const record = join(root, "node_modules", ".modules.yaml");
  if (!existsSync(record)) return true;
  try {
    return statSync(join(root, "pnpm-lock.yaml")).mtimeMs > statSync(record).mtimeMs + 1000;
  } catch {
    return false;
  }
}

/** What a pull changed: the commit before and after. `null` when nothing was pulled. */
export interface PullResult {
  before: string;
  after: string;
}

async function pull(root: string, deps: UpdateDeps, dryRun: boolean): Promise<PullResult | null> {
  if (!existsSync(join(root, ".git"))) {
    note("不是 git 資料夾,略過 pull");
    return null;
  }
  if (dryRun) {
    note("會執行:git pull --ff-only(工作目錄有未提交的變更就略過)");
    return null;
  }
  const status = await deps.run("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 30_000 });
  if (status.missing) {
    warn("找不到 git,略過 pull");
    return null;
  }
  if (status.stdout.trim() !== "") {
    warn("工作目錄有未提交的變更,略過 git pull(用 --no-pull 可不顯示這則)");
    return null;
  }
  const head = () => deps.run("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 15_000 });
  const before = (await head()).stdout.trim();
  const result = await deps.run("git", ["pull", "--ff-only"], { cwd: root, timeoutMs: 120_000 });
  if (result.code !== 0) {
    fail("git pull --ff-only 失敗(分支分岔或沒有網路?)");
    for (const l of failureTail(result.stdout, result.stderr)) println(l);
    throw new UpdateError("pull 失敗,沒有改動任何建置");
  }
  const after = (await head()).stdout.trim();
  const changed = after !== before;
  ok(changed ? "已更新到最新的提交" : "已經是最新");
  return changed ? { before, after } : null;
}

/** The files a pull changed, from `git diff --name-only`; `null` when git cannot say. */
async function changedFiles(
  root: string,
  pulled: PullResult,
  deps: UpdateDeps,
): Promise<string[] | null> {
  const r = await deps.run("git", ["diff", "--name-only", `${pulled.before}..${pulled.after}`], {
    cwd: root,
    timeoutMs: 30_000,
  });
  if (r.missing || r.code !== 0) return null;
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * The services a change set touches: those whose folder holds a changed file, and every Python
 * service when a file directly under `workers/` changed. hostd's, which a remote update uses too.
 */
export { servicesChangedBy };

export interface ServicePlanInput {
  /** Enabled services in start order, with what is true of each. */
  services: ReadonlyArray<{ name: string; stale: boolean; running: boolean; changed: boolean }>;
}

export interface ServiceUpdatePlan {
  /** Synced while it is not running. */
  syncStopped: string[];
  /** Running and stale: stopped (through the guard), synced, started. */
  syncAndRestart: string[];
  /** Running and only its folder changed: restarted. */
  restart: string[];
}

/** What `update` does to the services, before it does it. */
export function planServiceUpdate(input: ServicePlanInput): ServiceUpdatePlan {
  const plan: ServiceUpdatePlan = { syncStopped: [], syncAndRestart: [], restart: [] };
  for (const s of input.services) {
    if (s.stale && !s.running) plan.syncStopped.push(s.name);
    else if (s.stale) plan.syncAndRestart.push(s.name);
    else if (s.running && s.changed) plan.restart.push(s.name);
  }
  return plan;
}

async function install(root: string, deps: UpdateDeps, force: boolean, dryRun: boolean) {
  if (!force && !installNeeded(root)) {
    ok("相依套件  與 pnpm-lock.yaml 一致");
    return;
  }
  if (dryRun) {
    note("會執行:pnpm install");
    return;
  }
  note("安裝相依套件(pnpm install)…");
  const r = await deps.run("pnpm", ["install"], { cwd: root, timeoutMs: BUILD_TIMEOUT_MS });
  if (r.code !== 0) {
    fail("pnpm install 失敗");
    for (const l of failureTail(r.stdout, r.stderr)) println(l);
    throw new UpdateError("相依套件裝不起來,後面的建置沒有執行");
  }
  ok("相依套件  已安裝");
}

/** Builds one target; a Vite build goes to `<dist>.next` and replaces `dist` only on success. */
export async function buildTarget(t: BuildTarget, deps: UpdateDeps): Promise<boolean> {
  const next = t.swapDir ? `${t.swapDir}.next` : null;
  const withOut = (a: string[]) => (next ? [...a, "--outDir", basename(next), "--emptyOutDir"] : a);
  note(`建置 ${t.label}…`);
  let r = await deps.run(t.command, withOut(t.args), { cwd: t.cwd, timeoutMs: BUILD_TIMEOUT_MS });
  if (r.code !== 0 && t.fallbackArgs) {
    // Antivirus holding esbuild's temp file is the usual cause; the retry skips the minifier.
    warn(`${t.label} 建置失敗;改用不壓縮的建置再試一次(防毒軟體鎖住 esbuild 暫存檔時常見)`);
    r = await deps.run(t.command, withOut(t.fallbackArgs), {
      cwd: t.cwd,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
  }
  if (r.code !== 0) {
    fail(`${t.label} 建置失敗${r.timedOut ? "(逾時)" : ""};輸出沒有被動到`);
    for (const l of failureTail(r.stdout, r.stderr)) println(l);
    if (next) rmSync(next, { recursive: true, force: true });
    return false;
  }
  if (next && t.swapDir) {
    if (!existsSync(join(next, "index.html"))) {
      fail(`${t.label} 建置完成但沒有 index.html;保留原本的 dist`);
      rmSync(next, { recursive: true, force: true });
      return false;
    }
    const previous = `${t.swapDir}.prev`;
    try {
      rmSync(previous, { recursive: true, force: true });
      if (existsSync(t.swapDir)) renameSync(t.swapDir, previous);
      renameSync(next, t.swapDir);
      rmSync(previous, { recursive: true, force: true });
    } catch (error) {
      fail(`${t.label} 建好了,但換進 dist 失敗:${(error as Error).message}`);
      note(`新的輸出在 ${next};關掉佔用 dist 的程式後手動改名即可`);
      return false;
    }
  }
  ok(`${t.label}  已建置`);
  return true;
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sameFile(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

async function updateMod(
  root: string,
  config: Config,
  deps: UpdateDeps,
  options: UpdateOptions,
): Promise<boolean> {
  const mod = modInfo(root);
  if (!mod) return true;
  let good = true;
  const state = modFreshness(mod);
  if (options.force || state.state !== "fresh") {
    if (options.dryRun) {
      note("會用 JDK 21 執行 gradlew build(mod 比原始碼舊或還沒建置)");
    } else {
      const jdk = await findJdk21(deps.run, deps.env, deps.platform);
      if (!jdk.jdk21?.home) {
        fail(`找不到 JDK 21${jdk.onPath ? `(PATH 上的 java 是 ${jdk.onPath})` : ""},mod 沒有重建`);
        println(
          dim("    修正:winget install EclipseAdoptium.Temurin.21.JDK,或把 JAVA_HOME 指到 JDK 21"),
        );
        return false;
      }
      note(`建置 Minecraft mod(JDK ${jdk.jdk21.home})…`);
      const gradle = deps.platform === "win32" ? "gradlew.bat" : "./gradlew";
      const r = await deps.run(gradle, ["build"], {
        cwd: mod.dir,
        env: { ...deps.env, JAVA_HOME: jdk.jdk21.home },
        timeoutMs: 20 * 60_000,
      });
      if (r.code !== 0 || !existsSync(mod.jar)) {
        fail("mod 建置失敗");
        for (const l of failureTail(r.stdout, r.stderr)) println(l);
        return false;
      }
      ok("Minecraft mod  已建置");
    }
  } else {
    ok("Minecraft mod  jar 與原始碼一致");
  }

  const mods = minecraftModsDir(config);
  if (!mods) return good;
  if (options.dryRun) {
    note(`會比對 ${mods} 裡的 miyoria-bridge jar,不同時先備份再複製(要確認)`);
    return good;
  }
  if (!existsSync(mod.jar)) return good;
  const installed = installedModJars(mods);
  if (installed.length === 1 && sameFile(installed[0] as string, mod.jar)) {
    ok("遊戲裡的 mod  和建置出來的相同");
    return good;
  }
  const backupDir = join(dirname(mods), "miyoria-backup", timestamp(deps.now()));
  const what =
    installed.length === 0
      ? `把 ${basename(mod.jar)} 複製到 ${mods}?`
      : `用 ${basename(mod.jar)} 取代 ${mods} 裡的 ${installed.map((p) => basename(p)).join("、")}?舊檔會先備份到 ${backupDir}(請先關掉遊戲)`;
  if (!(await deps.confirm(what))) {
    warn("沒有更新遊戲裡的 mod(沒有確認;自動化請加 --yes)");
    return good;
  }
  try {
    if (installed.length > 0) {
      mkdirSync(backupDir, { recursive: true });
      for (const p of installed) copyFileSync(p, join(backupDir, basename(p)));
    }
    copyFileSync(mod.jar, join(mods, basename(mod.jar)));
    // Two bridge jars would both claim the mod id; the old ones are in the backup.
    for (const p of installed) {
      if (basename(p) !== basename(mod.jar)) unlinkSync(p);
    }
    ok(`遊戲裡的 mod  已更新${installed.length > 0 ? `,舊檔備份在 ${backupDir}` : ""}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    fail(
      `複製 mod 失敗(${code ?? (error as Error).message});${code === "EBUSY" || code === "EPERM" ? "遊戲或啟動器還開著嗎?關掉後重跑" : "檢查資料夾權限"}`,
    );
    good = false;
  }
  return good;
}

/** The packaged install has no git checkout: the package manager upgrades it. */
export const UPGRADE_HINT =
  "用 npm 安裝的:`npm update -g miyoria`(pnpm:`pnpm update -g miyoria`)升級套件,再重新執行 `miyoria update`";

/**
 * The services part: sync the stale environments, then restart what changed, one at a time. Returns
 * the number of failures. Does nothing without a host.toml.
 */
export async function updateServices(
  configPath: string,
  options: UpdateOptions,
  deps: UpdateDeps,
  pulled: { root: string; files: string[] | null } | null,
): Promise<number> {
  const target = hostTarget(configPath, options.hostConfig);
  if (!existsSync(target.hostToml)) {
    note("沒有 host.toml,略過服務的同步與重啟(`miyoria add <服務>` 會建立它)");
    return 0;
  }
  const host = loadHost(target);
  const root = catalogRoot(target.hostToml);
  const catalog = loadCatalog(root);
  const installDeps = { ...deps.services?.install, root };
  const enabled = Object.entries(host.config.services)
    .filter(([name, s]) => s.enabled && catalog.services.has(name))
    .map(([name]) => catalog.services.get(name) as CatalogEntry);

  const client = await HostdClient.connect(host.state.root);
  const listed: HostServiceList["services"] =
    client === null ? [] : (await client.call<HostServiceList>("service.list")).services;
  const running = new Set(
    listed.filter((s) => s.state === "running" || s.state === "starting").map((s) => s.name),
  );
  // Start order: the daemon's list when there is one, else host.toml's.
  const order = listed.length > 0 ? listed.map((s) => s.name) : enabled.map((e) => e.name);
  const changed =
    pulled?.files != null
      ? servicesChangedBy(pulled.files, enabled, pulled.root)
      : new Set<string>();

  const stale = new Set<string>();
  for (const entry of enabled) {
    const inspected = inspectService(entry, host, installDeps);
    if (inspected.runtime.kind !== "managed") continue;
    if (options.force || inspected.runtime.state?.state !== "ready") stale.add(entry.name);
  }
  // The model files of `[[install.files]]` that are missing or wrong: asked about after the
  // environments, once for all of them.
  const needs = await filesToFetch(enabled, host);
  const plan = planServiceUpdate({
    services: order
      .filter((name) => enabled.some((e) => e.name === name))
      .map((name) => ({
        name,
        stale: stale.has(name),
        running: running.has(name),
        changed: changed.has(name),
      })),
  });

  section("服務");
  const nothing = plan.syncStopped.length + plan.syncAndRestart.length + plan.restart.length === 0;
  if (nothing && client === null && needs.length === 0) {
    ok("環境都與 uv.lock、extras 和 service.toml 一致");
    return 0;
  }
  if (options.dryRun) {
    if (plan.syncStopped.length > 0) note(`會同步環境:${plan.syncStopped.join("、")}`);
    if (plan.syncAndRestart.length > 0) {
      note(`會停止、同步、再啟動(經過保護):${plan.syncAndRestart.join("、")}`);
    }
    if (plan.restart.length > 0) note(`會重啟(經過保護):${plan.restart.join("、")}`);
    if (nothing) ok("環境都與 uv.lock、extras 和 service.toml 一致");
    if (needs.length > 0) {
      printFileNeeds(needs, host.state.models);
      note("會先問一次再下載(--yes 不問)");
    }
    return 0;
  }

  const installer = await openInstaller(target, host, deps.services);
  let failures = 0;
  const later: string[] = [];

  // Stopped services: one call; a running daemon also reads the descriptors again for them.
  const stopped = enabled.map((e) => e.name).filter((name) => !running.has(name));
  if (stopped.length > 0 && (plan.syncStopped.length > 0 || client !== null)) {
    try {
      const done = await installer.update(
        { services: stopped, ...(options.force ? { force: true } : {}) },
        progressPrinter(),
      );
      for (const r of done.services) {
        if (r.runtime.state === "current") continue;
        if (printInstall(r, { brief: true })) failures += 1;
      }
    } catch (error) {
      failures += 1;
      fail(rpcText(error));
    }
  }

  const syncOne = async (name: string): Promise<boolean> => {
    try {
      const result = await installer.install(
        { service: name, only_stale: !options.force, no_files: true },
        progressPrinter(),
      );
      return !printInstall(result, { brief: true });
    } catch (error) {
      fail(`${name}  ${rpcText(error)}`);
      return false;
    }
  };

  const logs = host.state.logs;
  const restartOne = async (name: string, how: "restart" | "stop-sync-start"): Promise<void> => {
    if (client === null) return;
    try {
      if (how === "restart") {
        await client.call(
          "service.restart",
          { service: name, force: false },
          { timeoutMs: 120_000 },
        );
      } else {
        // A running Python cannot be overwritten on Windows: stop it first, through the guard.
        await client.call("service.stop", { service: name, force: false }, { timeoutMs: 120_000 });
        if (!(await syncOne(name))) failures += 1;
        await client.call("service.start", { service: name });
      }
    } catch (error) {
      if (error instanceof HostRpcError && error.code === HOST_ERROR_CODE.Guarded) {
        warn(`${bold(name)}  她正在唱歌或直播,沒有動它:${error.message}`);
        later.push(name);
        return;
      }
      failures += 1;
      fail(`${name}  ${rpcText(error)}`);
      return;
    }
    const watched = await watchStarts(client, [name], logs, 10 * 60_000);
    if (watched.failed.length > 0) failures += 1;
  };

  for (const name of [...plan.syncAndRestart, ...plan.restart]) {
    if (options.noRestart) {
      if (plan.syncAndRestart.includes(name) && !(await syncOne(name))) failures += 1;
      later.push(name);
      continue;
    }
    await restartOne(name, plan.syncAndRestart.includes(name) ? "stop-sync-start" : "restart");
  }

  // The model files, after the environments: a service left busy above is left for later.
  const fileNeeds = needs.filter((n) => !later.includes(n.service));
  if (fileNeeds.length > 0) {
    let agreed = false;
    let refused = false;
    try {
      agreed = await confirmFiles(fileNeeds, host, deps.services ?? {}, "miyoria update --yes");
    } catch (error) {
      if (!(error instanceof HostCommandError)) throw error;
      fail(error.message);
      failures += 1;
      refused = true;
    }
    if (agreed) {
      for (const name of [...new Set(fileNeeds.map((n) => n.service))]) {
        try {
          const result = await installer.install(
            { service: name, only_stale: true },
            progressPrinter(),
          );
          const bad = printInstall(result, { brief: true });
          printFiles(result);
          if (bad) failures += 1;
        } catch (error) {
          failures += 1;
          fail(`${name}  ${rpcText(error)}`);
        }
      }
    } else if (!refused) {
      note("沒有下載模型檔;之後 `miyoria doctor --fix` 可以補(缺必要檔案的服務 hostd 不會啟動)");
    }
  }

  if (later.length > 0) {
    warn(
      options.noRestart
        ? `沒有重啟(--no-restart):${later.join("、")}。要用新版時:${later.map((n) => `\`miyoria restart ${n}\``).join("、")}`
        : `還在忙所以沒有重啟:${later.join("、")}。等她不忙再執行 ${later.map((n) => `\`miyoria restart ${n}\``).join("、")}(要先同步環境的,重新執行 \`miyoria update\`)`,
    );
  }
  if (nothing) ok("環境都與 uv.lock、extras 和 service.toml 一致");
  return failures;
}

export async function run(
  configPath: string,
  options: UpdateOptions,
  deps: UpdateDeps,
): Promise<void> {
  const root = repoRoot(configPath);
  if (!root) {
    // A packaged install: the package manager upgrades the code; the services part still runs.
    note(UPGRADE_HINT);
    const failures = await updateServices(configPath, options, deps, null);
    if (failures > 0) throw new UpdateError(`${failures} 項沒有完成,見上面的訊息`);
    return;
  }
  const config = await loadConfig(configPath);
  const configDir = dirname(resolve(configPath));
  if (options.dryRun) section("更新計畫(dry-run,不會改任何東西)");

  let failures = 0;
  const pulled = options.noPull ? null : await pull(root, deps, options.dryRun === true);
  const files = pulled === null ? null : await changedFiles(root, pulled, deps);
  await install(root, deps, options.force === true, options.dryRun === true);

  for (const t of buildTargets(root, configDir, config)) {
    const f = checkTarget(t);
    const skip = !options.force && f.state === "missing" && t.configured === false;
    if (!options.force && (f.state === "fresh" || skip)) {
      ok(`${t.label}  ${skip ? "沒有用到,略過" : f.detail}`);
      continue;
    }
    if (options.dryRun) {
      note(
        `會建置 ${t.label}(${f.state === "stale" ? f.detail : "還沒建置"}):${t.command} ${t.args.join(" ")}`,
      );
      continue;
    }
    if (!(await buildTarget(t, deps))) failures++;
  }

  if (!options.skipMod && !(await updateMod(root, config, deps, options))) failures++;

  failures += await updateServices(
    configPath,
    options,
    deps,
    pulled === null ? null : { root, files },
  );

  if (failures > 0) throw new UpdateError(`${failures} 項沒有完成,見上面的訊息`);
  if (!options.dryRun) {
    println(
      options.noRestart
        ? "\n完成。已經在執行的服務沒有重啟(--no-restart);要用新版時 `miyoria restart <服務>`。"
        : "\n完成。",
    );
  }
}
