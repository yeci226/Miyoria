// `host.toml`: what this machine runs (docs/design/v5-hostd.md §3), and the state folder it names.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type HostConfig, HostConfigSchema } from "@miyoria/contracts/host";
import { parse as parseToml } from "smol-toml";

/** The file name of the per-machine file, in the workspace folder. */
export const HOST_CONFIG_FILE = "host.toml";

export class HostConfigError extends Error {
  override name = "HostConfigError";
  readonly file: string;

  constructor(file: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.file = file;
  }
}

/** The state folder and its parts, absolute. */
export interface StateLayout {
  root: string;
  /** `envs/<service>`: environments hostd manages (H6). */
  envs: string;
  /** `models/`, with `hf/` as the Hugging Face cache. */
  models: string;
  /** `logs/<service>.log` and `hostd.log`. */
  logs: string;
  /** `run/hostd.json`. */
  run: string;
}

export interface LoadedHostConfig {
  /** The file, absolute. */
  file: string;
  /** The folder relative paths in the file start from: the file's own folder. */
  workspace: string;
  config: HostConfig;
  state: StateLayout;
}

/** The layout of a state folder. */
export function stateLayout(root: string): StateLayout {
  const abs = resolve(root);
  return {
    root: abs,
    envs: join(abs, "envs"),
    models: join(abs, "models"),
    logs: join(abs, "logs"),
    run: join(abs, "run"),
  };
}

/** Parses and checks the text of a `host.toml`. Throws `HostConfigError` with every problem. */
export function parseHostConfig(file: string, text: string): HostConfig {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new HostConfigError(
      file,
      `${file}: not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = HostConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    });
    throw new HostConfigError(file, `${file}: ${issues.join("; ")}`);
  }
  return parsed.data;
}

/** Loads `host.toml`; the workspace is its folder. Throws `HostConfigError`. */
export function loadHostConfig(file: string): LoadedHostConfig {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new HostConfigError(abs, `${abs} does not exist`);
  const config = parseHostConfig(abs, readFileSync(abs, "utf8"));
  const workspace = dirname(abs);
  return {
    file: abs,
    workspace,
    config,
    state: stateLayout(resolve(workspace, config.paths.state)),
  };
}
