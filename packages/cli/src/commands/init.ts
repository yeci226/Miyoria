// `miyoria init`: guided setup. Safe to re-run: every question defaults to the current value,
// secrets are only replaced when typed, existing tokens are kept, missing files start from the
// bundled templates (and the bundled profile is copied), and nothing is written before the
// summary is confirmed.

import { resolve } from "node:path";
import { bundledProfilesDir, exampleConfig, exampleEnv } from "../assets.js";
import { type MachinePreset, machineStep, pasteTokens } from "../machine-step.js";
import type { Prompter } from "../prompt.js";
import * as settings from "../settings.js";
import { Workspace, type WorkspaceOptions } from "../workspace.js";
import { afterWrite, commit } from "./config.js";

export interface InitOptions {
  /** Skip the final confirmation. */
  yes?: boolean;
  /** Where bundled profiles come from (default: the package's). */
  bundledProfiles?: string | null;
  /** The real environment (tests). */
  processEnv?: ReadonlyMap<string, string>;
  /**
   * Ask which services this computer runs (`[machine]`). Absent: the question is skipped and the
   * config keeps whatever it has (old configs have no `[machine]` and behave as before).
   */
  machine?: MachinePreset & { ask: boolean };
  /** Runs `install` for this computer's services; offered after the files are written (interactive only). */
  offerInstall?: () => Promise<void>;
  /** Command prefix shown in the next steps (default `miyoria`, or `npx miyoria` under npx). */
  command?: string;
}

/** All questions, editing `ws` in memory. Returns the generated tokens. */
export async function flow(p: Prompter, ws: Workspace): Promise<string[]> {
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

function commandPrefix(): string {
  return process.env.npm_command === "exec" ? "npx miyoria" : "miyoria";
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
  p.intro("Miyoria 設定精靈");
  if (ws.tomlExists) {
    p.note("已讀取現有設定:每一題直接按 Enter 會保留目前的值;密碼類欄位不輸入就不會改。");
  } else {
    const where = resolve(ws.dir) === resolve(process.cwd()) ? "目前的資料夾" : ws.dir;
    p.note(`會在${where}建立 miyoria.toml、.env、角色和資料庫資料夾(確認後才寫入)。`);
  }
  if (!ws.tomlExists) ws.planGitignore();
  const scaffold = ws.planScaffold();
  if (scaffold.length > 0) p.note(`會複製內建角色:${scaffold.join("、")}`);

  let generated: string[];
  let hasCore = true;
  let picked = false;
  const machine = options.machine;
  if (machine && (machine.ask || machine.roles !== undefined)) {
    p.section("這台電腦");
    const chosen = await machineStep(p, ws, machine);
    picked = true;
    hasCore = chosen.services.includes("core");
    if (hasCore) generated = await flow(p, ws);
    else {
      // No core here: no LLM, Discord or database to set up, only the links to core.
      p.section("連到 core");
      generated = [];
      await pasteTokens(p, ws, chosen.services);
      if (chosen.services.includes("stage")) {
        p.section("Stage");
        for (const field of settings.STAGE.slice(2)) await settings.ask(p, ws, field);
      }
    }
  } else generated = await flow(p, ws);
  if (generated.length > 0) p.note(`會產生新的 token:${generated.join("、")}`);
  const changes = await commit(p, options.yes ?? false, ws);
  if (changes) await afterWrite(p, options.yes ?? false, ws, changes);
  if (hasCore && (changes !== null || ws.tomlExists)) {
    const key = settings.current(ws, settings.llmApiKeyField(ws)).value;
    if (key === "") {
      p.warn(
        "還沒有設定 LLM API key:之後用 `miyoria config` → LLM 填入(或重新執行 `miyoria init`)",
      );
    }
  }

  if (picked && options.offerInstall && (changes !== null || ws.tomlExists)) {
    if (await p.confirm("現在檢查這台電腦缺什麼,並安裝(會先列出清單和大小再問一次)?", true)) {
      await options.offerInstall();
    }
  }

  const cmd = options.command ?? commandPrefix();
  const width = `${cmd} config`.length + 2;
  const line = (c: string, what: string) => `  ${`${cmd} ${c}`.padEnd(width)} ${what}`;
  p.outro(
    (picked
      ? [
          "下一步:",
          line("install", "安裝這台電腦需要的東西(套件、venv、建置)"),
          line("doctor", "檢查缺什麼"),
          line("start", "在各自的分頁啟動這台電腦的服務"),
          line("config", "之後要改單一項目用這個"),
        ]
      : [
          "下一步:",
          line("doctor", "檢查連線"),
          line("chat", "在終端機跟她聊天"),
          line("core", "啟動 Discord bot"),
          line("config", "之後要改單一項目用這個"),
        ]
    ).join("\n"),
  );
}
