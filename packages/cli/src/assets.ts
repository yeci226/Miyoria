// Files shipped with the CLI so `pnpm dlx miyoria init` works in an empty folder: the config
// templates (`templates/`) and the bundled profiles (`assets/profiles/`, copied from the repo's
// `profiles/` at build time; from source the repo directory is used directly).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root: this file is `src/assets.ts` or `dist/assets.js`. */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function exampleConfig(): string {
  return readFileSync(join(PACKAGE_ROOT, "templates", "miyoria.example.toml"), "utf8");
}

export function exampleEnv(): string {
  return readFileSync(join(PACKAGE_ROOT, "templates", "env.example"), "utf8");
}

/** Directory holding the bundled profiles, or `null` if this install has none. */
export function bundledProfilesDir(): string | null {
  for (const dir of [
    join(PACKAGE_ROOT, "assets", "profiles"),
    join(PACKAGE_ROOT, "..", "..", "profiles"),
  ]) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** Ids of the profiles in `dir` (sub-directories with a `profile.toml`), sorted. */
export function profileIds(dir: string | null): string[] {
  if (dir === null || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "profile.toml")))
    .map((e) => e.name)
    .sort();
}

/** `package.json` version of the CLI. */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
