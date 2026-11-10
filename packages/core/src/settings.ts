// Core-level settings read from `[core]`.

import { isAbsolute, resolve } from "node:path";
import type { Config } from "@miyoria/kernel";
import { Profile } from "@miyoria/profile";
import { DEFAULT_PIPELINE, isPipeline, PIPELINES, type Pipeline } from "@miyoria/types";

/** Used when `core.database_url` is missing or empty. */
export const DEFAULT_DATABASE_URL = "sqlite:data/miyoria.db";
export const DEFAULT_PROFILE = "deepseek-chan";
export const DEFAULT_PROFILES_DIR = "profiles";

function str(config: Config, path: string): string | undefined {
  const value = config.section(path);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `core.database_url`, defaulting to SQLite under `data/`. */
export function databaseUrl(config: Config): string {
  return str(config, "core.database_url") ?? DEFAULT_DATABASE_URL;
}

/**
 * Makes a relative SQLite path absolute against `baseDir` (the directory of `miyoria.toml`), so
 * `miyoria core -c some/dir/miyoria.toml` uses `some/dir/data/miyoria.db`. Other URLs are
 * returned unchanged.
 */
export function resolveDatabaseUrl(url: string, baseDir: string): string {
  const path = sqlitePath(url);
  if (path === null || path === ":memory:" || isAbsolute(path)) return url;
  return `sqlite:${resolve(baseDir, path)}`;
}

/** File path of a `sqlite:` / `sqlite://` URL, `null` for other schemes. */
export function sqlitePath(url: string): string | null {
  if (url.startsWith("sqlite://")) return url.slice("sqlite://".length);
  if (url.startsWith("sqlite:")) return url.slice("sqlite:".length);
  return null;
}

/** `core.profile` (default `deepseek-chan`). */
export function profileId(config: Config): string {
  return str(config, "core.profile") ?? DEFAULT_PROFILE;
}

/** `core.profiles_dir` resolved against `baseDir` (default `profiles`). */
export function profilesDir(config: Config, baseDir: string): string {
  return resolve(baseDir, str(config, "core.profiles_dir") ?? DEFAULT_PROFILES_DIR);
}

export class ProfileLoadError extends Error {
  override readonly name = "ProfileLoadError";
}

/** Loads the active profile (`core.profiles_dir` / `core.profile`). */
export async function loadProfile(config: Config, baseDir = process.cwd()): Promise<Profile> {
  const dir = str(config, "core.profiles_dir") ?? DEFAULT_PROFILES_DIR;
  const id = profileId(config);
  try {
    return await Profile.load(resolve(baseDir, dir), id);
  } catch (error) {
    throw new ProfileLoadError(
      `loading profile \`${id}\` from \`${dir}\`: ${(error as Error).message}`,
      {
        cause: error,
      },
    );
  }
}

/** `core.pipeline`: `v3` (the default) or `v2`, one setting to roll back. */
export function pipeline(config: Config): Pipeline {
  const value = config.section("core.pipeline");
  if (value === undefined || value === null) return DEFAULT_PIPELINE;
  if (isPipeline(value)) return value;
  throw new Error(`core.pipeline must be one of ${PIPELINES.join(", ")}, not ${String(value)}`);
}

/** `core.log` (default `info`). Legacy values are tracing filters (`info,miyoria=debug`). */
export function logFilter(config: Config): string {
  return str(config, "core.log") ?? "info";
}

const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type CoreLogLevel = (typeof LEVELS)[number];

/** The pino level of a tracing-style filter: its first bare level, else `fallback`. */
export function logLevel(filter: string, fallback: CoreLogLevel = "info"): CoreLogLevel {
  for (const part of filter.split(",")) {
    const level = part.trim().toLowerCase();
    if ((LEVELS as readonly string[]).includes(level)) return level as CoreLogLevel;
  }
  return fallback;
}
