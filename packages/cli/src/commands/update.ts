// `miyoria update`: pull, install, and rebuild what changed (SDK, extension `dist`, panel, overlay,
// Minecraft mod jar). Rebuilds are decided by file times, so an unchanged tree does nothing.
// Replacing the installed mod jar backs the old one up first and asks (`--yes` skips the question).

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
import type { Config } from "@miyoria/kernel";
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
import { legacyConfigNotes } from "../stack/checks.js";
import { repoRoot } from "../stack/config.js";
import { defaultRunner, type Runner, tailLines } from "../stack/system.js";
import { dim, fail, note, ok, println, section, warn } from "../ui.js";
import { loadConfig } from "./node.js";

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
}

export interface UpdateDeps {
  run: Runner;
  /** Asked before replacing the installed mod jar. */
  confirm: (message: string) => Promise<boolean>;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  now: () => Date;
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

async function pull(root: string, deps: UpdateDeps, dryRun: boolean): Promise<boolean> {
  if (!existsSync(join(root, ".git"))) {
    note("不是 git 資料夾,略過 pull");
    return false;
  }
  if (dryRun) {
    note("會執行:git pull --ff-only(工作目錄有未提交的變更就略過)");
    return false;
  }
  const status = await deps.run("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 30_000 });
  if (status.missing) {
    warn("找不到 git,略過 pull");
    return false;
  }
  if (status.stdout.trim() !== "") {
    warn("工作目錄有未提交的變更,略過 git pull(用 --no-pull 可不顯示這則)");
    return false;
  }
  const head = () => deps.run("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 15_000 });
  const before = (await head()).stdout.trim();
  const result = await deps.run("git", ["pull", "--ff-only"], { cwd: root, timeoutMs: 120_000 });
  if (result.code !== 0) {
    fail("git pull --ff-only 失敗(分支分岔或沒有網路?)");
    for (const l of failureTail(result.stdout, result.stderr)) println(l);
    throw new UpdateError("pull 失敗,沒有改動任何建置");
  }
  const changed = (await head()).stdout.trim() !== before;
  ok(changed ? "已更新到最新的提交" : "已經是最新");
  return changed;
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

export async function run(
  configPath: string,
  options: UpdateOptions,
  deps: UpdateDeps,
): Promise<void> {
  const root = repoRoot(configPath);
  if (!root) {
    throw new UpdateError(
      "`update` 要在 Miyoria 的原始碼資料夾裡用;用 npm 安裝的請改用 `npm update -g miyoria`",
    );
  }
  const config = await loadConfig(configPath);
  const configDir = dirname(resolve(configPath));
  if (options.dryRun) section("更新計畫(dry-run,不會改任何東西)");

  let failures = 0;
  if (!options.noPull) await pull(root, deps, options.dryRun === true);
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

  const notes = legacyConfigNotes(config);
  if (notes.length > 0) {
    section("設定裡 V2 留下的舊值(沒有自動改寫)");
    for (const n of notes) warn(n);
  }

  if (failures > 0) throw new UpdateError(`${failures} 項沒有完成,見上面的訊息`);
  if (!options.dryRun) {
    println("\n完成。已經在執行的 core / worker 要重啟才會用新版(`miyoria up`)。");
  }
}
