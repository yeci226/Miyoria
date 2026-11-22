// Commands that run a node in this process (`core`, `chat`, `stage`, `ext dev`) and the offline
// profile / extension tools. The full core is imported lazily so `init` / `config` start fast.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type CoreLogLevel,
  loadProfile,
  logFilter,
  logLevel,
  type MachineSource,
  machineSource,
  type ResolvedProfile,
} from "@miyoria/core/light";
import { Config, configureLogging, getLogger } from "@miyoria/runtime/kernel";
import { isJsonObject, RunningProfileKey } from "@miyoria/types";
import { PACKAGE_ROOT } from "../assets.js";
import { profileLine } from "../profile.js";
import { fail, ok, println, warn } from "../ui.js";

export class NodeCommandError extends Error {
  override readonly name = "NodeCommandError";
}

/** Loads `miyoria.toml` (after `.env` was loaded by `main`). */
export async function loadConfig(configPath: string): Promise<Config> {
  if (!existsSync(configPath)) {
    throw new NodeCommandError(`找不到 ${configPath}:先執行 \`miyoria init\` 建立設定`);
  }
  return Config.load(configPath);
}

function setLogLevel(config: Config, fallback?: CoreLogLevel): void {
  if (process.env.MIYORIA_LOG_LEVEL) return;
  configureLogging({ level: fallback ?? logLevel(logFilter(config)) });
}

/**
 * Points `MIYORIA_PANEL_DIR` at the panel bundled with the npm package (`dist/panel`) when
 * neither the variable nor `[modules.api] panel_dir` leads to a built panel.
 */
function preferBundledPanel(config: Config): void {
  if (process.env.MIYORIA_PANEL_DIR?.trim()) return;
  const section = config.module("api").config;
  const configured =
    isJsonObject(section) && typeof section.panel_dir === "string"
      ? section.panel_dir
      : "apps/panel/dist";
  if (configured.trim() === "" || existsSync(join(configured, "index.html"))) return;
  const bundled = join(PACKAGE_ROOT, "dist", "panel");
  if (existsSync(join(bundled, "index.html"))) process.env.MIYORIA_PANEL_DIR = bundled;
}

/**
 * Where a core for `profile` resolves its relative paths, whether the profile has its own data,
 * and for one that does, where the install's machines are (docs/design/v5-profiles.md); without a
 * profile, the config file's folder as always.
 */
function profileOptions(
  configPath: string,
  profile: ResolvedProfile | undefined,
): { baseDir: string; ownProfile: boolean; machines: MachineSource | null } {
  return {
    baseDir: profile?.baseDir ?? dirname(resolve(configPath)),
    ownProfile: profile?.own ?? false,
    machines: profile === undefined ? null : machineSource(profile, (name) => process.env[name]),
  };
}

export async function core(configPath: string, profile?: ResolvedProfile): Promise<void> {
  const config = await loadConfig(configPath);
  setLogLevel(config);
  preferBundledPanel(config);
  const { buildCore, runUntilSignal } = await import("@miyoria/core");
  const node = await buildCore(config, profileOptions(configPath, profile));
  if (profile !== undefined) {
    getLogger("cli").info(
      { profile: profile.id, own: profile.own, config: profile.configPath },
      `running ${profileLine(profile, node.services.get(RunningProfileKey)?.character ?? profile.id)}`,
    );
  }
  await runUntilSignal(node);
}

export async function chat(
  configPath: string,
  name: string,
  withDiscord: boolean,
  profile?: ResolvedProfile,
): Promise<void> {
  const config = await loadConfig(configPath);
  // Keep the terminal readable: only warnings unless MIYORIA_LOG_LEVEL says otherwise.
  setLogLevel(config, "warn");
  const { buildCore, runUntilSignal } = await import("@miyoria/core");
  const node = await buildCore(config, {
    ...profileOptions(configPath, profile),
    cliChatName: name,
    discord: withDiscord,
    api: false,
  });
  println(`和 ${node.profileDisplayName} 聊天中(Ctrl+C 結束)。`);
  await runUntilSignal(node);
}

export async function stage(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  setLogLevel(config);
  const { runStageNode, shutdownSignal } = await import("@miyoria/core");
  const controller = new AbortController();
  void shutdownSignal().then(() => controller.abort());
  const bundled = join(PACKAGE_ROOT, "dist", "overlay");
  await runStageNode(config, {
    baseDir: dirname(resolve(configPath)),
    signal: controller.signal,
    // The npm package ships the overlay; from the repo the default `apps/overlay/dist` applies.
    ...(!existsSync("apps/overlay/dist/index.html") && existsSync(join(bundled, "index.html"))
      ? { overlayDir: bundled }
      : {}),
  });
}

export interface StageObsSetupFlags {
  dryRun: boolean;
  relayout: boolean;
  /** `--here`: build in OBS's current scene collection. */
  here: boolean;
  /** `--no-profile`: keep OBS's current profile. */
  noProfile: boolean;
  /** `--profile-settings`: set the video size and replay buffer in an existing profile too. */
  profileSettings: boolean;
  /** `--collection` / `--profile` (`null` = `[stage.obs]`'s, else `Miyoria`). */
  collection: string | null;
  profile: string | null;
}

export async function stageObsSetup(configPath: string, flags: StageObsSetupFlags): Promise<void> {
  if (flags.here && flags.collection !== null) {
    throw new NodeCommandError("--here 和 --collection 只能選一個");
  }
  if (flags.noProfile && (flags.profile !== null || flags.profileSettings)) {
    throw new NodeCommandError("--no-profile 不能和 --profile、--profile-settings 一起用");
  }
  const config = await loadConfig(configPath);
  configureLogging({ level: "warn" });
  const { describeObsSetupStep: describeStep, setupStageObs } = await import("@miyoria/core");
  const { dryRun } = flags;
  const result = await setupStageObs(config, {
    baseDir: dirname(resolve(configPath)),
    dryRun,
    relayout: flags.relayout,
    collection: flags.here ? null : (flags.collection ?? undefined),
    profile: flags.noProfile ? null : (flags.profile ?? undefined),
    profileSettings: flags.profileSettings,
    onStep: (step) => println(`${dryRun ? "  會" : "  "}${describeStep(step)}`),
  });
  const { steps, place } = result;
  const changes = steps.filter((s) => s.op !== "write_mask" && s.op !== "filter");
  const where = `場景集合「${result.collection}」、設定檔「${result.profile}」`;
  if (result.layoutUnknown) {
    println(
      `  (場景集合「${result.collection}」已經有了,切過去才讀得到裡面有什麼;實際執行時只會補上缺的)`,
    );
  }
  if (dryRun) {
    const same = place.length === 0 && changes.length === 0 && !result.layoutUnknown;
    ok(
      `預覽完成:${same ? "OBS 已經是這個版面" : `${place.length + steps.length} 個步驟`},在${where}(沒有改 OBS)`,
    );
  } else {
    ok(
      place.length === 0 && changes.length === 0
        ? `OBS 已經是這個版面(${where}),只更新了遮罩`
        : `OBS 版面建好了,在${where}(${place.length + steps.length} 個步驟)`,
    );
  }
  for (const note of result.notes) warn(note);
  if (result.createdProfile) {
    warn(
      `新的設定檔「${result.profile}」是空白的:要從 OBS 推流的話,串流金鑰(設定 → 直播)和編碼器(設定 → 輸出)要在這個設定檔裡重新設一次`,
    );
  }
  warn(
    "VTube Studio 要用透明背景:背景選純色並勾「透明」,OBS 的「VTube Studio 透明」才會只看到她本人",
  );
  // The Stage checks OBS's collection with this: suggest it, the config file is the owner's.
  const lines: string[] = [];
  if (!flags.here && result.configured.collection !== result.collection) {
    lines.push(`collection = ${JSON.stringify(result.collection)}`);
  }
  if (!flags.noProfile && result.configured.profile !== result.profile) {
    lines.push(`profile = ${JSON.stringify(result.profile)}`);
  }
  if (lines.length > 0) {
    println();
    println(
      "在 miyoria.toml 的 [stage.obs] 加上這幾行,Stage 才會確認 OBS 在她的場景集合上(不在就不建任何東西,並在面板提醒):",
    );
    println("  [stage.obs]");
    for (const line of lines) println(`  ${line}`);
  }
  if (
    flags.here &&
    result.configured.collection !== null &&
    result.configured.collection !== result.collection
  ) {
    warn(
      `[stage.obs] collection 是「${result.configured.collection}」,但這次建在「${result.collection}」:OBS 停在這份集合時 Stage 不會建任何東西`,
    );
  }
}

export async function profileValidate(
  configPath: string,
  running?: ResolvedProfile,
): Promise<void> {
  const config = await loadConfig(configPath);
  const profile = await loadProfile(config, profileOptions(configPath, running).baseDir);
  ok(
    `${profile.character.name} · ${profile.displayName}(${profile.id}):${profile.sections.length} 個人格段落、${profile.examples.length} 個範例對話,聲音設定 ${profile.voice ? "有" : "無"},模型設定 ${profile.avatar ? "有" : "無"}`,
  );
}

// ---- extensions --------------------------------------------------------------------------

export async function extNew(name: string, dir: string): Promise<void> {
  const { extensionsCli } = await import("@miyoria/core");
  // Inside the monorepo link the local SDK; elsewhere use the published one.
  const sdk = existsSync(join(process.cwd(), "packages/sdk/package.json"))
    ? "workspace:*"
    : "^0.2.0";
  const path = await extensionsCli.newExtension(dir, name, { sdk, id: null });
  ok(`已建立 ${path}`);
}

export async function extList(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  const { extensionsCli } = await import("@miyoria/core");
  for (const e of await extensionsCli.list(config, process.cwd())) {
    const id = e.manifest?.id ?? "?";
    const version = e.manifest?.version ?? "?";
    const mark = e.problems.length > 0 ? "✗" : e.enabled && e.runs_on_core ? "●" : "○";
    println(`${mark} ${id} ${version}  ${e.dir}`);
    for (const p of e.problems) println(`    ${p}`);
  }
}

export async function extInstall(configPath: string, source: string): Promise<void> {
  const config = await loadConfig(configPath);
  const { extensionsCli } = await import("@miyoria/core");
  const installed = await extensionsCli.install(config, process.cwd(), source);
  ok(`已安裝 ${installed.id} 到 ${installed.dir}`);
  for (const w of installed.warnings) warn(w);
}

export async function extValidate(dir: string): Promise<void> {
  const { extensionsCli } = await import("@miyoria/core");
  const v = await extensionsCli.validate(dir);
  for (const w of v.warnings) warn(w);
  for (const e of v.errors) fail(e);
  if (v.errors.length > 0) throw new NodeCommandError(`${v.errors.length} 個錯誤`);
  ok("manifest 正常");
}

export async function extDev(configPath: string): Promise<void> {
  const loaded = await loadConfig(configPath);
  const raw = structuredClone(loaded.raw);
  if (isJsonObject(raw)) {
    const modules = isJsonObject(raw.modules) ? raw.modules : {};
    const extensions = isJsonObject(modules.extensions) ? modules.extensions : {};
    extensions.dev = true;
    modules.extensions = extensions;
    raw.modules = modules;
  }
  const config = Config.fromValue(raw);
  setLogLevel(config);
  const { buildCore, runUntilSignal } = await import("@miyoria/core");
  const node = await buildCore(config, { baseDir: dirname(resolve(configPath)) });
  await runUntilSignal(node);
}

/** Reads `file`, or stdin for `-`. */
export async function readInput(file: string): Promise<string> {
  if (file !== "-") return readFileSync(file, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}
