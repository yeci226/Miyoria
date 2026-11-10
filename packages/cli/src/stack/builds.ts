// What `miyoria update` rebuilds and `doctor --deep` compares: the SDK, extension `dist`, the panel,
// the overlay and the Minecraft mod jar. "Stale" means a source file is newer than the newest
// output file.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Config } from "@miyoria/kernel";
import { isJsonObject } from "@miyoria/types";
import type { Runner } from "./system.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "dist.next", "build", ".gradle", ".git", "out"]);

/** Newest modification time (ms) of any file under the paths; 0 when there is none. */
export function newestMtime(paths: readonly string[]): number {
  let newest = 0;
  const visit = (path: string) => {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(basename(path))) return;
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (!path.endsWith(".tsbuildinfo")) {
      newest = Math.max(newest, stat.mtimeMs);
    }
  };
  for (const path of paths) visit(path);
  return newest;
}

/** Same walk for outputs: their folders are the ones `newestMtime` skips by name. */
function newestOutput(paths: readonly string[]): number {
  let newest = 0;
  const visit = (path: string) => {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else newest = Math.max(newest, stat.mtimeMs);
  };
  for (const path of paths) visit(path);
  return newest;
}

export type FreshState = "fresh" | "stale" | "missing";

export interface Freshness {
  state: FreshState;
  detail: string;
}

/** One second of slack: file systems with coarse timestamps. */
const SLACK_MS = 1000;

export function freshness(
  sources: readonly string[],
  outputs: readonly string[],
  marker?: string,
): Freshness {
  const out = newestOutput(outputs);
  if (out === 0 || (marker !== undefined && !existsSync(marker))) {
    return { state: "missing", detail: "沒有建置輸出" };
  }
  const src = newestMtime(sources);
  if (src > out + SLACK_MS) {
    const hours = Math.max(1, Math.round((src - out) / 3_600_000));
    return { state: "stale", detail: `原始碼比輸出新(約 ${hours} 小時)` };
  }
  return { state: "fresh", detail: "與原始碼一致" };
}

// ---- targets -----------------------------------------------------------------------------

export interface BuildTarget {
  id: string;
  label: string;
  cwd: string;
  sources: string[];
  outputs: string[];
  /** File that must exist for the output to count (the panel's `index.html`). */
  marker?: string;
  command: string;
  args: string[];
  /**
   * Vite builds: the output goes to `<dir>.next` and replaces `<dir>` only when the build worked,
   * so a failed build (a locked temp file) never leaves an empty `dist`.
   */
  swapDir?: string;
  /**
   * Arguments for a second try when the first build fails (the Vite build without the minifier,
   * for antivirus that locks esbuild's temp files). A fallback, not the default.
   */
  fallbackArgs?: string[];
  /** Config section naming this target (extension id); missing outputs only fail when set up. */
  configured?: boolean;
}

/** Vite flags that avoid esbuild's minifier temp files, which antivirus tends to lock. */
export const SAFE_VITE_ARGS = ["--minify", "false", "--target", "esnext"];

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

function hasBuildScript(pkg: Record<string, unknown> | null): boolean {
  return isJsonObject(pkg?.scripts) && typeof pkg.scripts.build === "string";
}

export interface ExtensionInfo {
  id: string;
  dir: string;
  entry: string;
  packageName: string | null;
  hasBuild: boolean;
}

/** Folders with a `miyoria.extension.toml` under the configured extension dirs (two levels deep). */
export function discoverExtensions(configDir: string, config: Config): ExtensionInfo[] {
  const section = config.module("extensions").config;
  const dirs =
    isJsonObject(section) && Array.isArray(section.dirs)
      ? section.dirs.filter((d): d is string => typeof d === "string")
      : ["extensions"];
  const found: ExtensionInfo[] = [];
  const consider = (dir: string): boolean => {
    const manifest = join(dir, "miyoria.extension.toml");
    if (!existsSync(manifest)) return false;
    const text = readFileSync(manifest, "utf8");
    const field = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1];
    if (field("runtime") !== "node") return true;
    const pkg = readJson(join(dir, "package.json"));
    found.push({
      id: field("id") ?? basename(dir),
      dir,
      entry: field("entry") ?? "dist/index.js",
      packageName: typeof pkg?.name === "string" ? pkg.name : null,
      hasBuild: hasBuildScript(pkg),
    });
    return true;
  };
  const subdirs = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== "node_modules" && e.name !== "examples")
        .map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  };
  for (const base of dirs) {
    const root = resolve(configDir, base);
    for (const child of subdirs(root)) {
      if (consider(child)) continue;
      for (const grandchild of subdirs(child)) consider(grandchild);
    }
  }
  return found;
}

/** `[extensions."<id>"]` exists and is not turned off. */
function extensionConfigured(config: Config, id: string): boolean {
  const section = config.section("extensions");
  const own = isJsonObject(section) ? section[id] : undefined;
  return isJsonObject(own) && own.enabled !== false;
}

export function buildTargets(root: string, configDir: string, config: Config): BuildTarget[] {
  const targets: BuildTarget[] = [];
  const sdk = join(root, "packages", "sdk");
  targets.push({
    id: "sdk",
    label: "SDK(@miyoria/sdk)",
    cwd: root,
    sources: [join(sdk, "src"), join(sdk, "package.json"), join(sdk, "tsconfig.build.json")],
    outputs: [join(sdk, "dist")],
    command: "pnpm",
    args: ["--filter", "@miyoria/sdk", "build"],
  });
  for (const ext of discoverExtensions(configDir, config)) {
    if (!ext.hasBuild || ext.packageName === null) continue;
    targets.push({
      id: `ext:${ext.id}`,
      label: `擴充 ${ext.id}`,
      cwd: root,
      sources: [
        join(ext.dir, "src"),
        join(ext.dir, "package.json"),
        join(ext.dir, "tsconfig.build.json"),
        join(sdk, "src"),
      ],
      outputs: [dirname(join(ext.dir, ext.entry))],
      marker: join(ext.dir, ext.entry),
      command: "pnpm",
      args: ["--filter", ext.packageName, "build"],
      configured: extensionConfigured(config, ext.id),
    });
  }
  for (const app of ["panel", "overlay"] as const) {
    const dir = join(root, "apps", app);
    if (!existsSync(join(dir, "package.json"))) continue;
    targets.push({
      id: app,
      label: app === "panel" ? "管理面板(apps/panel)" : "Overlay(apps/overlay)",
      cwd: root,
      sources: [
        join(dir, "src"),
        join(dir, "public"),
        join(dir, "index.html"),
        join(dir, "package.json"),
        join(dir, "vite.config.ts"),
      ],
      outputs: [join(dir, "dist")],
      marker: join(dir, "dist", "index.html"),
      command: "pnpm",
      args: ["--filter", `@miyoria/${app}`, "exec", "vite", "build"],
      fallbackArgs: ["--filter", `@miyoria/${app}`, "exec", "vite", "build", ...SAFE_VITE_ARGS],
      swapDir: join(dir, "dist"),
    });
  }
  return targets;
}

export function checkTarget(t: BuildTarget): Freshness {
  return freshness(t.sources, t.outputs, t.marker);
}

// ---- Minecraft mod -----------------------------------------------------------------------

export interface ModInfo {
  dir: string;
  version: string;
  /** The jar Gradle produces. */
  jar: string;
  sources: string[];
}

export function modInfo(root: string): ModInfo | null {
  const dir = join(root, "extensions", "minecraft", "mod");
  if (!existsSync(join(dir, "build.gradle"))) return null;
  let version = "0.1.0";
  try {
    const m = /^mod_version\s*=\s*(\S+)/m.exec(
      readFileSync(join(dir, "gradle.properties"), "utf8"),
    );
    if (m?.[1]) version = m[1];
  } catch {
    // keep the default
  }
  return {
    dir,
    version,
    jar: join(dir, "build", "libs", `miyoria-bridge-${version}.jar`),
    sources: [
      join(dir, "src"),
      join(dir, "build.gradle"),
      join(dir, "gradle.properties"),
      join(dir, "settings.gradle"),
    ],
  };
}

export function modFreshness(mod: ModInfo): Freshness {
  return freshness(mod.sources, [mod.jar], mod.jar);
}

/** `<minecraft_dir>/mods` from `[extensions."miyoria.minecraft"] minecraft_dir`, when set. */
export function minecraftModsDir(config: Config): string | null {
  const section = config.section("extensions");
  const own = isJsonObject(section) ? section["miyoria.minecraft"] : undefined;
  const dir = isJsonObject(own) ? own.minecraft_dir : undefined;
  return typeof dir === "string" && dir.trim() !== "" ? join(dir, "mods") : null;
}

/** The bridge jars in a `mods` folder. */
export function installedModJars(modsDir: string): string[] {
  try {
    return readdirSync(modsDir)
      .filter((n) => /^miyoria-bridge.*\.jar$/i.test(n) && !/sources/i.test(n))
      .map((n) => join(modsDir, n));
  } catch {
    return [];
  }
}

/** Protocol number in `Protocol.java` and in `PROTOCOL.md`'s title; both must agree. */
export function protocolVersions(root: string): { source: number | null; doc: number | null } {
  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  const java = read(
    join(root, "extensions/minecraft/mod/src/main/java/dev/miyoria/bridge/protocol/Protocol.java"),
  );
  const doc = read(join(root, "extensions/minecraft/PROTOCOL.md"));
  const source = /int\s+VERSION\s*=\s*(\d+)/.exec(java)?.[1];
  const title = /\(protocol\s+(\d+)/i.exec(doc)?.[1];
  return { source: source ? Number(source) : null, doc: title ? Number(title) : null };
}

// ---- JDK ---------------------------------------------------------------------------------

export interface Jdk {
  home: string | null;
  major: number;
}

/** `java -version` prints to stderr: `version "21.0.3"` or the old `"1.8.0_422"`. */
export function parseJavaMajor(text: string): number | null {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  const first = Number(m[1]);
  return first === 1 ? Number(m[2]) : first;
}

async function javaMajor(run: Runner, exe: string): Promise<number | null> {
  const r = await run(exe, ["-version"], { timeoutMs: 15_000 });
  return r.missing || r.timedOut ? null : parseJavaMajor(`${r.stderr}\n${r.stdout}`);
}

export interface JdkReport {
  /** The default `java` on PATH (what Gradle would use without JAVA_HOME). */
  onPath: number | null;
  /** A JDK 21 that was found: JAVA_HOME, or one of the usual install folders. */
  jdk21: Jdk | null;
}

function jdkFolders(platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return ["/usr/lib/jvm", join(homedir(), ".sdkman/candidates/java")];
  const programs = [process.env.ProgramFiles ?? "C:\\Program Files"];
  const names = ["Eclipse Adoptium", "Java", "Microsoft", "Zulu", "Amazon Corretto", "BellSoft"];
  return [
    ...programs.flatMap((p) => names.map((n) => join(p, n))),
    join(homedir(), ".gradle", "jdks"),
  ];
}

export async function findJdk21(
  run: Runner,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  folders: readonly string[] = jdkFolders(platform),
): Promise<JdkReport> {
  const exe = platform === "win32" ? "java.exe" : "java";
  const onPath = await javaMajor(run, "java");
  const homes: string[] = [];
  if (env.JAVA_HOME?.trim()) homes.push(env.JAVA_HOME);
  for (const folder of folders) {
    try {
      for (const name of readdirSync(folder)) {
        if (/(^|[^\d])21([^\d]|$)/.test(name)) homes.push(join(folder, name));
      }
    } catch {
      // folder not installed
    }
  }
  for (const home of homes) {
    const java = join(home, "bin", exe);
    if (!existsSync(java)) continue;
    if ((await javaMajor(run, java)) === 21) return { onPath, jdk21: { home, major: 21 } };
  }
  return { onPath, jdk21: null };
}
