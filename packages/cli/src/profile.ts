// Which profile a command works on (docs/design/v5-profiles.md), and the environment it gets.
//
// The install's `miyoria.toml` (`--config`) says which profile runs (`core.profile`, or
// `MIYORIA_PROFILE`). A profile with a `miyoria.toml` of its own is a character of its own: the
// commands about her (`core`, `config`, `db` ...) use that file, its `.env` and its data. Commands
// about this machine (`hostd`, `up`, `add`, `host`, `update`, `init`) always use the install's
// files, so switching profile never touches the machines or their pairing.

import { dirname, join, resolve } from "node:path";
import {
  PROFILE_ENV,
  peekConfig,
  type ResolvedProfile,
  readDotenv,
  resolveProfile,
} from "@miyoria/core/light";
import { HOST_CONFIG_FILE } from "@miyoria/hostd";
import { loadDotenv } from "@miyoria/runtime/kernel";

/** The profile `installPath` runs (see `resolveProfile`); `MIYORIA_PROFILE` from `env` only. */
export function selectProfile(
  installPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedProfile {
  const lookup = (name: string) => env[name];
  return resolveProfile(installPath, peekConfig(installPath, lookup), lookup);
}

/** `host.toml` beside the install's config: the machine's, whatever profile runs. */
export function installHostToml(profile: ResolvedProfile): string {
  return join(dirname(resolve(profile.installPath)), HOST_CONFIG_FILE);
}

/**
 * Loads the `.env` a profile's commands run with. A profile on the install's config loads the
 * install's `.env`, exactly as before profiles. A profile of its own loads only its own: none of
 * the install's secrets (another character's Discord token) may reach it. A value equal to the
 * install's `.env` is taken as inherited from it (hostd loaded that file and passes its
 * environment on): it is dropped, or replaced by the profile's own value. Any other value already
 * in the environment wins, as `.env` values always have.
 */
export function loadProfileEnv(
  profile: ResolvedProfile,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!profile.own) {
    loadDotenv(profile.installPath, env);
    return;
  }
  const install = readDotenv(profile.installPath);
  const own = readDotenv(profile.configPath);
  for (const [name, value] of install) {
    if (name === PROFILE_ENV) continue;
    if (env[name] === value && !own.has(name)) delete env[name];
  }
  for (const [name, value] of own) {
    const current = env[name];
    if (current === undefined || current === install.get(name)) env[name] = value;
  }
}

/** One line naming the profile, for `miyoria core` and `miyoria profile show`. */
export function profileLine(profile: ResolvedProfile, character: string): string {
  const where = profile.own ? "自己的設定和資料" : "安裝資料夾的設定和資料";
  return `${character}(profile ${profile.id},${where})`;
}
