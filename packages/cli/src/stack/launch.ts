// Opens a service in its own visible console: a Windows Terminal tab (all tabs in one window named
// `miyoria`), or a plain console window when Windows Terminal is not installed. The service is
// started by a small `.cmd` script so its environment is set inside the tab: a tab added to an
// existing Windows Terminal window gets that window's environment, not ours.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServiceSpec } from "../commands/up.js";
import type { Runner } from "./system.js";

export const WT_WINDOW = "miyoria";

export interface Tab {
  title: string;
  script: string;
  cwd: string;
}

export interface LaunchDeps {
  platform: NodeJS.Platform;
  run: Runner;
  writeScript: (path: string, text: string) => void;
  /** Starts a program that outlives this process; resolves false when it could not be started. */
  spawnDetached: (command: string, args: string[]) => Promise<boolean>;
}

export function defaultLaunchDeps(run: Runner): LaunchDeps {
  return {
    platform: process.platform,
    run,
    writeScript: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, "utf8");
    },
    spawnDetached: (command, args) =>
      new Promise((resolve) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.once("error", () => resolve(false));
        child.once("spawn", () => {
          child.unref();
          resolve(true);
        });
      }),
  };
}

/** One argument for a `.cmd` file. */
export function cmdArg(arg: string): string {
  const escaped = arg.replace(/%/g, "%%");
  return /[\s&()^|<>"]/.test(escaped) ? `"${escaped.replace(/"/g, '""')}"` : escaped;
}

export function scriptPath(logsDir: string, name: string): string {
  return join(dirname(logsDir), "launch", `${name}.cmd`);
}

/**
 * The tab's script: environment set for this service only (the keys in `envKeys`; core, stage and
 * the voice node take the rest from the window), then the command, then a pause so a crash can be
 * read before the tab closes.
 */
export function scriptText(spec: ServiceSpec): string {
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    `title Miyoria ${spec.name}`,
    `cd /d ${cmdArg(spec.cwd)}`,
  ];
  for (const key of spec.envKeys) {
    const value = spec.env[key];
    if (value !== undefined) lines.push(`set "${key}=${value.replace(/%/g, "%%")}"`);
  }
  lines.push(`call ${[spec.command, ...spec.args].map(cmdArg).join(" ")}`);
  lines.push("echo.");
  lines.push(`echo [${spec.name}] 已結束(代碼 %errorlevel%)。看完訊息後按任意鍵關閉這個分頁`);
  lines.push("pause >nul");
  return `${lines.join("\r\n")}\r\n`;
}

/** Whether a console running this script is still open (its `cmd.exe` has the script in its command line). */
export async function tabRunning(run: Runner, script: string): Promise<boolean> {
  const quoted = script.replace(/'/g, "''");
  const result = await run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `@(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${quoted}') }).Count`,
    ],
    { timeoutMs: 15_000 },
  );
  if (result.missing || result.code !== 0) return false;
  return Number.parseInt(result.stdout.trim(), 10) > 0;
}

/**
 * Whether a node or cmd process has `folder` in its command line, whoever started it (a tab of
 * ours, `pnpm start` typed by hand, a shortcut). Slashes and case are ignored. `unknown` when the
 * process list could not be read: the caller must treat that as "maybe running".
 */
export async function runningFrom(run: Runner, folder: string): Promise<"yes" | "no" | "unknown"> {
  const needle = folder.replace(/\//g, "\\").toLowerCase().replace(/'/g, "''");
  const result = await run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `@(Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='cmd.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '').ToLower().Contains('${needle}') }).Count`,
    ],
    { timeoutMs: 15_000 },
  );
  if (result.missing || result.code !== 0) return "unknown";
  const count = Number.parseInt(result.stdout.trim(), 10);
  if (Number.isNaN(count)) return "unknown";
  return count > 0 ? "yes" : "no";
}

export async function hasWindowsTerminal(run: Runner): Promise<boolean> {
  const r = await run("where", ["wt"], { timeoutMs: 5000 });
  return !r.missing && r.code === 0;
}

/** Arguments for `wt.exe` that add one tab to the `miyoria` window. */
export function wtArgs(tab: Tab): string[] {
  return [
    "-w",
    WT_WINDOW,
    "new-tab",
    "--title",
    tab.title,
    "--suppressApplicationTitle",
    "-d",
    tab.cwd,
    "cmd",
    "/c",
    tab.script,
  ];
}

/** Writes the script and opens the tab. Throws when nothing could be opened. */
export async function openTab(spec: ServiceSpec, script: string, deps: LaunchDeps): Promise<void> {
  if (deps.platform !== "win32") {
    throw new Error("分頁只支援 Windows;其他系統請用 `miyoria up`(背景執行,日誌寫檔)");
  }
  deps.writeScript(script, scriptText(spec));
  const tab: Tab = { title: `Miyoria ${spec.name}`, script, cwd: spec.cwd };
  if (await hasWindowsTerminal(deps.run)) {
    if (await deps.spawnDetached("wt", wtArgs(tab))) return;
  }
  const started = await deps.spawnDetached("cmd", ["/c", "start", tab.title, "cmd", "/c", script]);
  if (!started) throw new Error(`開不了 ${spec.name} 的視窗(wt 和 cmd 都失敗)`);
}
