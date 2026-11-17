// What `uv` needs and what the installer tells a person when it is missing. uv is never
// installed by hostd or the CLI on their own: the documented command is printed instead.

import { existsSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { mergeEnv, passEnv, workerBaseEnv } from "../env.js";
import type { LoadedHostConfig } from "../host-config.js";

/** The command that installs uv, as uv's documentation gives it. */
export function uvInstallHint(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "winget install --id=astral-sh.uv -e"
    : "curl -LsSf https://astral.sh/uv/install.sh | sh";
}

/** `uv sync --frozen`, with `--extra X` for each extra: the lock is used as it is, never refreshed. */
export function uvSyncArgs(extras: readonly string[]): string[] {
  return ["sync", "--frozen", ...extras.flatMap((extra) => ["--extra", extra])];
}

/** The folder installers and downloads use for temporary files. */
export function tempDir(host: LoadedHostConfig): string {
  return join(host.state.root, "tmp");
}

/**
 * The environment of a uv run: the system basics and proxies, uv's own variables, the CA bundle of
 * `host.toml`, a writable temporary folder under the state folder (antivirus often blocks the
 * system one), the project environment, and native TLS (which works behind TLS inspection).
 */
export function uvEnv(
  host: LoadedHostConfig,
  envDir: string,
  platform: NodeJS.Platform,
  source: Record<string, string | undefined>,
): Record<string, string> {
  const added: Record<string, string> = {
    UV_PROJECT_ENVIRONMENT: envDir,
    UV_NATIVE_TLS: "1",
    TMP: tempDir(host),
    TEMP: tempDir(host),
    TMPDIR: tempDir(host),
  };
  const ca = host.config.paths.ca_bundle;
  if (ca !== undefined) {
    const bundle = resolve(host.workspace, ca);
    added.SSL_CERT_FILE = bundle;
    added.REQUESTS_CA_BUNDLE = bundle;
  }
  return mergeEnv([workerBaseEnv(source), passEnv(["UV_*"], source, platform), added], platform);
}

/** Programs `install.system` may name, with the command that installs each one. */
const SYSTEM_PROGRAMS: Record<string, { win32: string; darwin: string; linux: string }> = {
  ffmpeg: {
    win32: "winget install --id=Gyan.FFmpeg -e",
    darwin: "brew install ffmpeg",
    linux: "sudo apt install ffmpeg    (Fedora: sudo dnf install ffmpeg)",
  },
};

/** How to install a program of `install.system` here, or `undefined` when nothing is documented. */
export function systemHint(program: string, platform: NodeJS.Platform): string | undefined {
  const entry = SYSTEM_PROGRAMS[program];
  if (entry === undefined) return undefined;
  return platform === "win32" ? entry.win32 : platform === "darwin" ? entry.darwin : entry.linux;
}

/** Whether a program is on PATH (with the extensions of PATHEXT on Windows). */
export function onPath(
  program: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): boolean {
  const pathValue =
    platform === "win32"
      ? (Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "")
      : (env.PATH ?? "");
  const extensions =
    platform === "win32"
      ? [
          "",
          ...(
            Object.entries(env).find(([k]) => k.toUpperCase() === "PATHEXT")?.[1] ??
            ".COM;.EXE;.BAT;.CMD"
          )
            .split(";")
            .filter(Boolean),
        ]
      : [""];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const file = join(dir, program + ext);
      try {
        if (existsSync(file) && statSync(file).isFile()) return true;
      } catch {
        // unreadable folder on PATH
      }
    }
  }
  return false;
}
