// `miyoria init`: guided setup. The first question is what this machine is for (docs/design/
// v5-hostd.md §11): text chat only (Core, no GPU), text and voice (Core with the speech workers),
// or services for somebody else's Core. The first two write `miyoria.toml`, `.env`, the profile
// and a `host.toml` with the services of this machine; the third writes only `host.toml`. No
// address of a worker is written anywhere: Core finds the services through hostd.
//
// Safe to re-run: every question defaults to the current value, secrets are only replaced when
// typed, existing tokens are kept, missing files start from the bundled templates (and the bundled
// profile is copied), and nothing is written before the summary is confirmed.

import { join, relative, resolve } from "node:path";
import { type Catalog, HOST_CONFIG_FILE, loadCatalog } from "@miyoria/hostd";
import { bundledProfilesDir, exampleConfig, exampleEnv } from "../assets.js";
import { enabledServices, type HostTomlPlan, planHostToml, writeHostToml } from "../host-toml.js";
import type { Prompter } from "../prompt.js";
import * as settings from "../settings.js";
import { configSchema } from "../validate.js";
import { Workspace, type WorkspaceOptions } from "../workspace.js";
import { afterWrite, commit, type ExtraWrite } from "./config.js";
import { catalogRoot } from "./host.js";

/** What a machine is for: the answer of the first question. */
export type InitMode = "text" | "voice" | "service";

export const INIT_MODES: readonly InitMode[] = ["text", "voice", "service"];

const MODE_LABELS: Record<InitMode, string> = {
  text: "文字聊天:只跑她本人,不需要顯卡",
  voice: "文字加語音:這台也跑語音辨識、語音合成(需要 NVIDIA 顯卡)",
  service: "這台只提供服務給別台的 Core(例如把顯卡借出來跑翻唱)",
};

/** The services `voice` adds besides Core (the voice node and singing come later). */
export const VOICE_SERVICES: readonly string[] = ["asr", "tts", "turn"];

/** Services that are not offered to somebody else's Core: Core and Stage run with the owner. */
const NOT_OFFERED: ReadonlySet<string> = new Set(["core", "stage", "voice-node"]);

export interface InitOptions {
  /** Skip the final confirmation. */
  yes?: boolean;
  /** Where bundled profiles come from (default: the package's). */
  bundledProfiles?: string | null;
  /** The real environment (tests). */
  processEnv?: ReadonlyMap<string, string>;
  /** Command prefix shown in the next steps (default: `commandPrefix()`, from how it was started). */
  command?: string;
  /** What this machine is for; absent: the first question asks. */
  mode?: InitMode;
  /** For `service`: the services this machine offers; absent: the question asks. */
  services?: string[];
  /** The `host.toml` to write (default: next to the config file). */
  hostToml?: string;
  /** Where the service descriptors are (default: where `miyoria add` looks). */
  catalogRoot?: string;
}

/** All questions of a machine that runs Core, editing `ws` in memory. Returns the generated tokens. */
export async function flow(p: Prompter, ws: Workspace): Promise<string[]> {
  // The answers are checked by the root schema, which loads every module package: start now.
  void configSchema();
  p.section("角色");
  await settings.profileStep(p, ws);

  p.section("LLM");
  await settings.llmStep(p, ws, false);

  p.section("Discord");
  await settings.ask(p, ws, settings.DISCORD_TOKEN);
  await settings.ask(p, ws, settings.OWNER);

  p.section("資料庫");
  await settings.databaseStep(p, ws);

  p.section("管理面板");
  await settings.oauthStep(p, ws, true);

  return settings.ensureTokens(ws);
}

/** The workspace `init` edits: existing files, or the bundled templates. */
export function openForInit(configPath: string, options: WorkspaceOptions = {}): Workspace {
  return Workspace.openOrCreate(configPath, exampleConfig(), exampleEnv(), options);
}

/**
 * How the user reaches this CLI again, from what the package manager that started it left in the
 * environment: `pnpm exec` and `npx` set `npm_command` to `exec`; `pnpm dlx` sets only the user
 * agent. Anything else (a global install, a script of the repository) is plain `miyoria`.
 */
export function commandPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const pnpm = (env.npm_config_user_agent ?? "").startsWith("pnpm/");
  if (env.npm_command === "exec") return pnpm ? "pnpm exec miyoria" : "npx miyoria";
  if (pnpm && env.npm_command === undefined) return "pnpm dlx miyoria";
  return "miyoria";
}

/** The catalog's services a machine can offer to a Core elsewhere, with what each costs. */
function offered(catalog: Catalog): Array<{ name: string; label: string }> {
  return [...catalog.services.values()]
    .filter((e) => !NOT_OFFERED.has(e.name) && e.descriptor.kind !== "external")
    .map((e) => {
      const gpu = e.descriptor.gpu;
      const mb = gpu?.vram_mb?.peak;
      const card =
        gpu === undefined || gpu.policy === "reserve"
          ? ""
          : `  [需要顯卡${mb !== undefined && mb > 0 ? `,約 ${mb} MB` : ""}]`;
      return { name: e.name, label: `${e.name}  ${e.descriptor.summary}${card}` };
    });
}

/** Which services this machine offers: the flag, or a multiple choice from the catalog. */
async function pickServices(
  p: Prompter,
  catalog: Catalog,
  given: readonly string[] | undefined,
  already: readonly string[],
): Promise<string[]> {
  const choices = offered(catalog);
  if (given !== undefined) {
    const unknown = given.filter((name) => !choices.some((c) => c.name === name));
    if (unknown.length > 0) {
      throw new Error(
        `沒有可以提供的服務 ${unknown.join("、")}。可選:${choices.map((c) => c.name).join("、")}`,
      );
    }
    return [...given];
  }
  const initial = choices.flatMap((c, i) => (already.includes(c.name) ? [i] : []));
  const picked = await p.multiSelect(
    "這台要提供哪些服務?(之後用 `miyoria add` 和 `miyoria remove` 增減)",
    choices.map((c) => c.label),
    initial,
  );
  return picked.map((i) => (choices[i] as { name: string }).name);
}

function hostExtra(plan: HostTomlPlan, shown: string): ExtraWrite {
  const lines =
    !plan.exists || plan.added.length > 0
      ? [
          `${plan.exists ? "更新" : "建立"} ${shown}:${plan.exists ? "加入" : "服務"} ${plan.added.join("、") || "(沒有)"}`,
        ]
      : [];
  return {
    lines,
    save: () => (lines.length > 0 && writeHostToml(plan) ? [shown] : []),
  };
}

/** What the first question starts on: what an existing `host.toml` already says. */
function defaultMode(hostToml: string): InitMode {
  const have = enabledServices(hostToml);
  if (have.length > 0 && !have.includes("core")) return "service";
  return have.some((s) => VOICE_SERVICES.includes(s)) ? "voice" : "text";
}

/** A path as shown to the user: relative to the current folder when that is shorter. */
function shownPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel !== "" && !rel.startsWith("..") && rel.length < path.length ? rel : path;
}

export async function run(
  configPath: string,
  p: Prompter,
  options: InitOptions = {},
): Promise<void> {
  const bundled =
    options.bundledProfiles === undefined ? bundledProfilesDir() : options.bundledProfiles;
  const ws = openForInit(configPath, {
    bundledProfiles: bundled,
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });
  const hostToml = options.hostToml ?? join(ws.dir, HOST_CONFIG_FILE);
  p.intro("Miyoria 設定精靈");

  let mode: InitMode;
  if (options.mode !== undefined) mode = options.mode;
  else {
    const picked = await p.select(
      "這台電腦要做什麼?(之後可以重新執行 init 改)",
      INIT_MODES.map((m) => MODE_LABELS[m]),
      INIT_MODES.indexOf(defaultMode(hostToml)),
    );
    mode = INIT_MODES[picked] ?? "text";
  }

  const cmd = options.command ?? commandPrefix();
  const width = `${cmd} config`.length + 2;
  const line = (c: string, what: string) => `  ${`${cmd} ${c}`.padEnd(width)} ${what}`;

  if (mode === "service") {
    await runService(p, options, { hostToml, cmd, line });
    return;
  }

  if (ws.tomlExists) {
    p.note("已讀取現有設定:每一題直接按 Enter 會保留目前的值;密碼類欄位不輸入就不會改。");
  } else {
    const where = resolve(ws.dir) === resolve(process.cwd()) ? "目前的資料夾" : ws.dir;
    p.note(`會在${where}建立 miyoria.toml、.env、host.toml、角色和資料庫資料夾(確認後才寫入)。`);
  }
  const fresh = !ws.tomlExists;
  if (fresh) ws.planGitignore();
  const scaffold = ws.planScaffold();
  if (scaffold.length > 0) p.note(`會複製內建角色:${scaffold.join("、")}`);

  const generated = await flow(p, ws);
  if (generated.length > 0) p.note(`會產生新的 token:${generated.join("、")}`);

  const services = ["core", ...(mode === "voice" ? VOICE_SERVICES : [])];
  const plan = planHostToml(hostToml, services);
  const changes = await commit(p, options.yes ?? false, ws, hostExtra(plan, shownPath(hostToml)));
  // A config made now has not been read by any Core: nothing could be running on it.
  if (changes && !fresh) await afterWrite(p, options.yes ?? false, ws, changes);
  if (changes !== null || ws.tomlExists) {
    const key = settings.current(ws, settings.llmApiKeyField(ws)).value;
    if (key === "") {
      p.warn(
        "還沒有設定 LLM API key:之後用 `miyoria config` → LLM 填入(或重新執行 `miyoria init`)",
      );
    }
  }

  const panel = `http://${ws.effective("modules.api.bind") ?? "127.0.0.1:7878"}/`;
  const next =
    mode === "voice"
      ? [
          line(
            `add ${VOICE_SERVICES.join(" ")}`,
            "裝語音辨識、語音合成和斷句的環境(要 NVIDIA 顯卡;模型第一次要下載幾 GB)",
          ),
          line("up", "啟動 Core 和這些服務"),
        ]
      : [line("up", "啟動她(Core)")];
  p.outro(
    [
      "下一步:",
      ...next,
      `  管理面板 ${panel},Discord 裡直接跟她說話`,
      ...(mode === "voice"
        ? [
            "  語音節點(進 Discord 語音頻道的那一個)和翻唱之後再加,做法在 docs/SETUP.md 的「加上語音」「加上翻唱」",
          ]
        : []),
      line("doctor", "檢查缺什麼"),
      line("config", "之後要改單一項目用這個"),
    ].join("\n"),
  );
}

/** The third path: only `host.toml`, for a machine that serves somebody else's Core. */
async function runService(
  p: Prompter,
  options: InitOptions,
  ui: { hostToml: string; cmd: string; line: (command: string, what: string) => string },
): Promise<void> {
  const { hostToml, cmd, line } = ui;
  p.note(`只會寫 ${hostToml}:這台不跑 Core,所以不問 LLM、Discord 和資料庫。`);
  const catalog = loadCatalog(options.catalogRoot ?? catalogRoot(hostToml));
  if (catalog.services.size === 0) {
    throw new Error("找不到服務目錄(沒有任何 service.toml):套件不完整,或這不是 miyoria 的安裝");
  }
  p.section("服務");
  const services = await pickServices(p, catalog, options.services, enabledServices(hostToml));
  if (services.length === 0) {
    throw new Error("沒有選任何服務(非互動時用 --services asr,tts,... 指定)");
  }
  const plan = planHostToml(hostToml, services);
  const changes = await commit(p, options.yes ?? false, null, hostExtra(plan, shownPath(hostToml)));
  if (changes === null && !plan.exists) return;
  p.outro(
    [
      "下一步:",
      line(`add ${services.join(" ")}`, "把這些服務裝進這台(uv 建環境、下載缺的檔案)"),
      "  請 Core 的主人在 Core 那台執行 `miyoria host invite`,他會拿到一行指令,在這裡執行它:",
      `    ${cmd} host join <位址> --code <代碼>`,
      `  Core 的主人再 \`miyoria host approve ${plan.name}\` 核准這台;核准之後它的服務才會被用`,
      line("up", "啟動這些服務"),
    ].join("\n"),
  );
}
