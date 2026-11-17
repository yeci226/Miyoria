// Library side of `miyoria ext new | list | install | validate`.
//
// These functions are synchronous and touch only the file system (and the `git` binary for
// installs); the app wires them to CLI subcommands.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type Config, errorMessage } from "@miyoria/runtime/kernel";
import { newId } from "@miyoria/types";
import { extensionSettings, hostConfigFromConfig, resolvedDirs } from "./config.js";
import { findExtensionDirs } from "./host.js";
import { ExtensionManifest, MANIFEST_FILE, runsOnCore, validId } from "./manifest.js";
import { SKIP_DIRS } from "./watch.js";

export class ExtensionCliError extends Error {
  override readonly name = "ExtensionCliError";
}

/** Outcome of `validate`. */
export interface Validation {
  manifest: ExtensionManifest | null;
  errors: string[];
  warnings: string[];
}

export function isValid(v: Validation): boolean {
  return v.errors.length === 0;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Checks the manifest of the extension in `dir` and the files it names. */
export function validate(dir: string): Validation {
  const v: Validation = { manifest: null, errors: [], warnings: [] };
  let manifest: ExtensionManifest;
  try {
    manifest = ExtensionManifest.load(dir);
  } catch (error) {
    v.errors.push(errorMessage(error));
    return v;
  }
  v.errors.push(...manifest.errors());
  v.warnings.push(...manifest.warnings());
  if (manifest.entry.trim() !== "" && !isFile(join(dir, manifest.entry))) {
    v.warnings.push(`entry \`${manifest.entry}\` does not exist yet (build the extension first?)`);
  }
  const schema = manifest.config.schema;
  if (schema !== null) {
    let text: string | null = null;
    try {
      text = readFileSync(join(dir, schema), "utf8");
    } catch (error) {
      v.errors.push(`config schema \`${schema}\`: ${errorMessage(error)}`);
    }
    if (text !== null) {
      try {
        JSON.parse(text);
      } catch (error) {
        v.errors.push(`config schema \`${schema}\` is not JSON: ${errorMessage(error)}`);
      }
    }
  }
  v.manifest = manifest;
  return v;
}

/** One row of `ext list`. */
export interface ExtensionListing {
  dir: string;
  /** `null` when the manifest cannot be read. */
  manifest: ExtensionManifest | null;
  /** From `[extensions."<id>"] enabled`, default `true`. */
  enabled: boolean;
  /** Placement `core` or `any`. */
  runs_on_core: boolean;
  problems: string[];
}

/** Every extension directory found under the configured dirs. */
export function list(config: Config, base: string): ExtensionListing[] {
  const host = hostConfigFromConfig(config);
  const out: ExtensionListing[] = [];
  for (const root of resolvedDirs(host, base)) {
    for (const dir of findExtensionDirs(root)) {
      const v = validate(dir);
      const m = v.manifest;
      out.push({
        dir,
        manifest: m,
        enabled: m ? (extensionSettings(config, m.id).enabled ?? true) : false,
        runs_on_core: m ? runsOnCore(m.placement) : false,
        problems: [...v.errors, ...v.warnings],
      });
    }
  }
  return out;
}

/** `ext install` result. */
export interface Installed {
  id: string;
  dir: string;
  warnings: string[];
}

/** Whether `source` should be cloned with git rather than copied. */
export function isGitSource(source: string): boolean {
  return (
    ["https://", "http://", "git@", "ssh://", "git://", "git+"].some((p) => source.startsWith(p)) ||
    source.endsWith(".git")
  );
}

/**
 * Copies a local extension directory, or clones a git URL with the `git` binary, into the
 * first configured extension dir as `<dir>/<id>`.
 */
export function install(config: Config, base: string, source: string): Installed {
  const host = hostConfigFromConfig(config);
  const targetRoot = resolvedDirs(host, base)[0];
  if (targetRoot === undefined) throw new ExtensionCliError("`[modules.extensions] dirs` is empty");
  try {
    mkdirSync(targetRoot, { recursive: true });
  } catch (error) {
    throw new ExtensionCliError(`creating ${targetRoot}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  let staged: string;
  let cleanup: boolean;
  if (isDir(source)) {
    staged = source;
    cleanup = false;
  } else if (isGitSource(source)) {
    staged = join(targetRoot, `.install-${newId()}`);
    const url = source.startsWith("git+") ? source.slice(4) : source;
    const result = spawnSync("git", ["clone", "--depth", "1", "--", url, staged], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) {
      throw new ExtensionCliError(
        `running \`git\` (is it installed?): ${errorMessage(result.error)}`,
        { cause: result.error },
      );
    }
    if (result.status !== 0) {
      rmSync(staged, { recursive: true, force: true });
      throw new ExtensionCliError(`\`git clone ${url}\` failed (exit code: ${result.status})`);
    }
    cleanup = true;
  } else {
    throw new ExtensionCliError(`\`${source}\` is neither a directory nor a git URL`);
  }

  try {
    const v = validate(staged);
    if (!isValid(v) || v.manifest === null) {
      throw new ExtensionCliError(`invalid extension: ${v.errors.join("; ")}`);
    }
    const dir = join(targetRoot, v.manifest.id);
    if (existsSync(dir)) throw new ExtensionCliError(`${dir} already exists`);
    if (cleanup) {
      try {
        renameSync(staged, dir);
      } catch (error) {
        throw new ExtensionCliError(`moving into ${dir}: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    } else {
      copyDir(staged, dir);
    }
    return { id: v.manifest.id, dir, warnings: v.warnings };
  } finally {
    if (cleanup && existsSync(staged)) rmSync(staged, { recursive: true, force: true });
  }
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRS.includes(entry.name)) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else {
      try {
        copyFileSync(src, dst);
      } catch (error) {
        throw new ExtensionCliError(`copying ${src}: ${errorMessage(error)}`, { cause: error });
      }
    }
  }
}

/** Options of `newExtension`. */
export interface NewOptions {
  /**
   * Version spec of the `@miyoria/sdk` dependency. Inside the monorepo `workspace:*`;
   * elsewhere a semver range.
   */
  sdk?: string;
  /** Extension id; defaults to the name. */
  id?: string | null;
}

/**
 * Scaffolds a TypeScript extension in `<parent>/<name>` and returns its directory. `name` must
 * be lowercase letters, digits and `-`.
 */
export function newExtension(parent: string, name: string, opts: NewOptions = {}): string {
  if (!/^[a-z0-9-]{1,32}$/u.test(name) || name.startsWith("-")) {
    throw new ExtensionCliError(
      `extension name \`${name}\` must be 1-32 chars of a-z, 0-9 and \`-\``,
    );
  }
  const id = opts.id ?? name;
  if (!validId(id)) throw new ExtensionCliError(`invalid extension id \`${id}\``);
  const sdk = opts.sdk ?? "workspace:*";
  const dir = join(parent, name);
  if (existsSync(dir)) throw new ExtensionCliError(`${dir} already exists`);
  const tool = `${name.replaceAll("-", "_")}.echo`;
  const files: [string, string][] = [
    [
      MANIFEST_FILE,
      `id = "${id}"
version = "0.1.0"
name = "${name}"
kind = ["tools", "commands"]
runtime = "node"
entry = "dist/index.js"
placement = "any"

[permissions]
events = []
tools = true
commands = true

[config]
schema = "config.schema.json"
`,
    ],
    [
      "package.json",
      `{
  "name": "miyoria-ext-${name}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -w -p tsconfig.json"
  },
  "dependencies": {
    "@miyoria/sdk": "${sdk}"
  },
  "devDependencies": {
    "@types/node": "^24",
    "typescript": "^5.7.2"
  }
}
`,
    ],
    [
      "tsconfig.json",
      `{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
`,
    ],
    [
      "src/index.ts",
      `import { defineExtension } from "@miyoria/sdk";

export default defineExtension({
  async activate(ctx) {
    ctx.tools.register({
      name: "${tool}",
      description: "把收到的文字原樣回傳",
      params: { text: { type: "string", description: "要回傳的文字" } },
      run: async ({ text }) => String(text),
    });

    ctx.commands.register({
      path: "${name}",
      description: "跟 ${name} 打招呼",
      run: async (inv) => \`哈囉,\${inv.invoker_display_name}!\`,
    });

    ctx.log.info("${name} activated");
  },
});
`,
    ],
    [
      "config.schema.json",
      `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
`,
    ],
    [".gitignore", "node_modules/\ndist/\n"],
  ];
  for (const [rel, content] of files) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, content);
    } catch (error) {
      throw new ExtensionCliError(`writing ${path}: ${errorMessage(error)}`, { cause: error });
    }
  }
  return dir;
}
