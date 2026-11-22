// Which profile runs, and where its config and data are (docs/design/v5-profiles.md).
//
// A profile is `profiles/<id>/`: the persona files it always had and, when it is a character of
// its own, a `miyoria.toml` (with `.env` and `data/` beside it). One runs at a time. It is picked
// by `MIYORIA_PROFILE`, else the install config's `core.profile`, else `deepseek-chan`. A profile
// without a `miyoria.toml` of its own runs on the install's config and data, which is how the
// install that existed before profiles keeps running exactly as it did. Machines (`host.toml`,
// the pairing) are the install's whatever profile runs.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { Config, type EnvLookup } from "@miyoria/runtime/kernel";
import type { JsonValue } from "@miyoria/types";
import {
  DEFAULT_DATABASE_URL,
  DEFAULT_PROFILE,
  DEFAULT_PROFILES_DIR,
  databaseUrl,
  resolveDatabaseUrl,
  sqlitePath,
} from "./settings.js";

/** The cluster module's id (`[modules.cluster]`), without loading its package. */
const CLUSTER_MODULE = "cluster";

/** Picks the profile over the install config's `core.profile`. */
export const PROFILE_ENV = "MIYORIA_PROFILE";
/** A profile's own config file, in its folder. */
export const PROFILE_CONFIG_FILE = "miyoria.toml";

export type ProfileSource = "env" | "config" | "default";

export interface ResolvedProfile {
  /** The folder name under the profiles directory (the store's profile id). */
  id: string;
  /** `<profiles_dir>/<id>`. */
  dir: string;
  /** It has a `miyoria.toml` of its own: its own config, `.env` and data. */
  own: boolean;
  /** The config file the character runs on: the profile's own, else the install's. */
  configPath: string;
  /** What that config's relative paths (the database, `data/`) resolve against. */
  baseDir: string;
  /** The install's config: `host.toml` and the machines stay beside it. */
  installPath: string;
  source: ProfileSource;
}

export class ProfileSelectError extends Error {
  override readonly name = "ProfileSelectError";
}

/** A folder name that stays inside the profiles directory. */
export function isProfileFolderName(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && !/[\\/]/.test(id);
}

/** `.env` beside `configPath` as a map; empty when there is none. */
export function readDotenv(configPath: string): Map<string, string> {
  let text: string;
  try {
    text = readFileSync(join(dirname(configPath), ".env"), "utf8");
  } catch {
    return new Map();
  }
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(parseEnv(text))) if (typeof v === "string") out.set(k, v);
  return out;
}

/**
 * A config file read only for what it says about profiles: references expand from `env`, then
 * `dotenv`, and to `""` when neither has them, so this never fails on a missing variable (the
 * command that loads the file for real reports that). `null`: no file, or not TOML.
 */
export function peekConfig(
  path: string,
  env: EnvLookup,
  dotenv: ReadonlyMap<string, string> = readDotenv(path),
): Config | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return Config.fromToml(text, (name) => env(name) ?? dotenv.get(name) ?? "");
  } catch {
    return null;
  }
}

function coreString(config: Config | null, key: string): string | undefined {
  const value = config?.section(`core.${key}`);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The profile to run for the install config at `installPath` (`install`: that file as
 * `peekConfig` read it, `null` when there is none). Throws `ProfileSelectError` when the profile
 * has a config of its own that names another profile or another profiles directory, so its
 * persona and its data could not be told apart.
 */
export function resolveProfile(
  installPath: string,
  install: Config | null,
  env: EnvLookup,
): ResolvedProfile {
  const absInstall = resolve(installPath);
  const installDir = dirname(absInstall);
  const fromEnv = env(PROFILE_ENV)?.trim() ?? "";
  const fromConfig = coreString(install, "profile");
  const id = fromEnv !== "" ? fromEnv : (fromConfig ?? DEFAULT_PROFILE);
  const source: ProfileSource = fromEnv !== "" ? "env" : fromConfig ? "config" : "default";
  const profilesDir = resolve(
    installDir,
    coreString(install, "profiles_dir") ?? DEFAULT_PROFILES_DIR,
  );
  const dir = join(profilesDir, id);
  const own = isProfileFolderName(id) && existsSync(join(dir, PROFILE_CONFIG_FILE));
  const base = { id, dir, installPath: absInstall, source };
  if (!own) {
    // The install's config names its persona itself; the variable cannot pick another one for it.
    if (source === "env" && id !== (fromConfig ?? DEFAULT_PROFILE)) {
      throw new ProfileSelectError(
        isProfileFolderName(id)
          ? `${PROFILE_ENV}=${id}:${dir} 沒有自己的 ${PROFILE_CONFIG_FILE}(用 \`miyoria profile new ${id}\` 建一個)`
          : `${PROFILE_ENV}=${id} 不是資料夾名稱`,
      );
    }
    return { ...base, own: false, configPath: absInstall, baseDir: installDir };
  }
  const configPath = join(dir, PROFILE_CONFIG_FILE);
  if (configPath !== absInstall) {
    const mine = peekConfig(configPath, env);
    const named = coreString(mine, "profile");
    if (named !== undefined && named !== id) {
      throw new ProfileSelectError(
        `${configPath} 的 core.profile 是「${named}」,要和它的資料夾名稱「${id}」一樣`,
      );
    }
    const itsDir = resolve(dir, coreString(mine, "profiles_dir") ?? DEFAULT_PROFILES_DIR);
    if (mine !== null && itsDir !== profilesDir) {
      throw new ProfileSelectError(
        `${configPath} 的 core.profiles_dir 要指向 ${profilesDir}(通常寫 ".."),不然讀不到它自己的人格`,
      );
    }
  }
  return { ...base, own: true, configPath, baseDir: dir };
}

/** One profile on disk, for `miyoria profile list`. */
export interface ProfileFolder {
  id: string;
  /** Has a `miyoria.toml` of its own. */
  own: boolean;
}

/** The folders under `profilesDir` with a `profile.toml`, sorted. */
export function listProfileFolders(profilesDir: string): ProfileFolder[] {
  if (!existsSync(profilesDir)) return [];
  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(profilesDir, e.name, "profile.toml")))
    .map((e) => ({ id: e.name, own: existsSync(join(profilesDir, e.name, PROFILE_CONFIG_FILE)) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Where the machines are for a profile of its own (docs/design/v5-profiles.md §7): the install's
 * database and its `[modules.cluster]`, which every profile shares.
 */
export interface MachineSource {
  /**
   * The install's database (`core.database_url` of the install's config, resolved against its
   * folder), whose `cluster_*` tables hold the machines; `null` when it is not a file
   * (`memory://`), and then the profile's own store keeps them.
   */
  databaseUrl: string | null;
  /** `[modules.cluster]` of the install's config: the listener, the static services, routing. */
  cluster: { enabled: boolean; config: JsonValue | null };
}

/**
 * The machines of a profile of its own; `null` for a profile on the install's config, whose
 * store is the install's database already. `env` is the profile's environment (its own `.env`
 * loaded, the install's taken out, as `loadProfileEnv` leaves it): the install's config is read as
 * the install sees it, its references expanding from the real environment first, then the
 * install's `.env`, never from the profile's own `.env`.
 */
export function machineSource(profile: ResolvedProfile, env: EnvLookup): MachineSource | null {
  if (!profile.own) return null;
  const install = readDotenv(profile.installPath);
  const own = readDotenv(profile.configPath);
  const lookup: EnvLookup = (name) => {
    const value = env(name);
    if (value !== undefined && value !== own.get(name)) return value;
    return install.get(name);
  };
  const config = peekConfig(profile.installPath, lookup, new Map());
  const url = resolveDatabaseUrl(
    config === null ? DEFAULT_DATABASE_URL : databaseUrl(config),
    dirname(profile.installPath),
  );
  const path = sqlitePath(url);
  const section = config?.module(CLUSTER_MODULE) ?? { enabled: true, config: null };
  return {
    databaseUrl: path === null || path === ":memory:" ? null : url,
    cluster: { enabled: section.enabled, config: section.config },
  };
}

/** The folder of a `sqlite:` database URL resolved against `baseDir`; `null` for other stores. */
export function databaseDir(url: string, baseDir: string): string | null {
  const path = sqlitePath(resolveDatabaseUrl(url, baseDir));
  if (path === null || path === ":memory:") return null;
  return dirname(path);
}
