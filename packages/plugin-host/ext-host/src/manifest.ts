// `miyoria.extension.toml` (see `docs/ARCHITECTURE.md` §9.2).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, parseTomlJson } from "@miyoria/runtime/kernel";
import { z } from "zod";

/** File name of an extension manifest. */
export const MANIFEST_FILE = "miyoria.extension.toml";

/** Kind of extensions that own a `game.<id>.*` namespace. */
export const GAME_ADAPTER_KIND = "game-adapter";

/** Contribution kinds the host knows about. Unknown kinds only warn. */
export const KNOWN_KINDS: readonly string[] = [
  "module",
  "tools",
  "commands",
  "events",
  "prompt",
  "game-adapter",
  "provider",
  "panel",
];

export type Runtime = "node" | "deno" | "bun" | "binary";

/** Which node runs the extension. The core host runs `core` and `any`. */
export type Placement = "core" | "stage" | "any";

export function runsOnCore(placement: Placement): boolean {
  return placement === "core" || placement === "any";
}

/** Declared permissions. The host grants at most these. */
export interface Permissions {
  /** Topic patterns the extension may subscribe to and publish on (`"game.*"`, `"*"`). */
  events: string[];
  /** May register tools for the agent. */
  tools: boolean;
  /** May register commands. */
  commands: boolean;
  /** Hosts the extension talks to (informational; not sandboxed). */
  network: string[];
  /** High-risk input simulation (keyboard, mouse, ...). Granted only when also listed in the config override. */
  input: string[];
}

export interface ConfigSection {
  /** JSON Schema file of the extension config, relative to its directory. */
  schema: string | null;
}

/** An MCP server bundled with the extension. Parsed and exposed only. */
export interface McpServerSpec {
  name: string;
  /** stdio transport. */
  command: string | null;
  args: string[];
  env: Record<string, string>;
  /** Streamable HTTP transport. */
  url: string | null;
}

export const PermissionsSchema = z.object({
  events: z.array(z.string()).default([]),
  tools: z.boolean().default(false),
  commands: z.boolean().default(false),
  network: z.array(z.string()).default([]),
  input: z.array(z.string()).default([]),
});

const McpServerSpecSchema = z.object({
  name: z.string(),
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().nullable().default(null),
});

const ManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  /** The icon of its card on the panel: a lucide icon name in kebab case (`gamepad-2`). */
  icon: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a lucide icon name in kebab case, like `gamepad-2`")
    .max(40)
    .nullable()
    .default(null),
  /** Accepts a string or a list. */
  kind: z
    .union([z.string(), z.array(z.string())])
    .default([])
    .transform((k) => (typeof k === "string" ? [k] : k)),
  game: z.string().nullable().default(null),
  runtime: z.enum(["node", "deno", "bun", "binary"]),
  entry: z.string(),
  placement: z.enum(["core", "stage", "any"]).default("core"),
  permissions: PermissionsSchema.prefault({}),
  config: z.object({ schema: z.string().nullable().default(null) }).prefault({}),
  env: z.object({ pass: z.array(z.string()).default([]) }).prefault({}),
  mcp_servers: z.array(McpServerSpecSchema).default([]),
});

/**
 * `[env]`: host environment variables the extension reads. The extension process gets only a
 * small platform allowlist (`PATH`, `SystemRoot`, `TEMP`, `HOME`, ...; see `env.ts`) plus these,
 * never the whole environment of the core (which holds its secrets).
 *
 * ```toml
 * [env]
 * pass = ["MIYORIA_MC_URL", "MIYORIA_MC_*"]   # exact names, or a prefix ending in `*`
 * ```
 */
export interface EnvSpec {
  pass: string[];
}

/** An environment variable name, or a prefix of at least three characters ending in `*`. */
export function validEnvPattern(pattern: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(pattern) || /^[A-Za-z_][A-Za-z0-9_]{2,}\*$/.test(pattern);
}

export type ManifestErrorKind = "read" | "parse";

export class ManifestError extends Error {
  override readonly name = "ManifestError";

  constructor(
    readonly kind: ManifestErrorKind,
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      kind === "read"
        ? `cannot read \`${path}\`: ${message}`
        : `invalid manifest \`${path}\`: ${message}`,
      options,
    );
  }
}

/** Thrown by `ExtensionManifest.parse`. */
export class ManifestParseError extends Error {
  override readonly name = "ManifestParseError";
}

export class ExtensionManifest {
  /** Globally unique id, e.g. `"miyoria.minecraft"`. */
  id: string;
  version: string;
  /** Human-readable name; defaults to the id. */
  name: string | null;
  description: string | null;
  /** A lucide icon name for its card on the panel; `null`: the panel's default. */
  icon: string | null;
  /** What the extension contributes. */
  kind: string[];
  /**
   * Game id of a `game-adapter` extension (e.g. `"minecraft"`). Only that extension may publish
   * under `game.<id>.*` and register `game.<id>.*` tools.
   */
  game: string | null;
  runtime: Runtime;
  /** Entry point relative to the extension directory (script or binary). */
  entry: string;
  placement: Placement;
  permissions: Permissions;
  config: ConfigSection;
  /** Host environment variables passed through (see `EnvSpec`). */
  env: EnvSpec;
  mcp_servers: McpServerSpec[];

  constructor(data: z.output<typeof ManifestSchema>) {
    this.id = data.id;
    this.version = data.version;
    this.name = data.name;
    this.description = data.description;
    this.icon = data.icon;
    this.kind = data.kind;
    this.game = data.game;
    this.runtime = data.runtime;
    this.entry = data.entry;
    this.placement = data.placement;
    this.permissions = data.permissions;
    this.config = data.config;
    this.env = data.env;
    this.mcp_servers = data.mcp_servers;
  }

  /** Reads `<dir>/miyoria.extension.toml`. Throws `ManifestError`. */
  static load(dir: string): ExtensionManifest {
    const path = join(dir, MANIFEST_FILE);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      throw new ManifestError("read", path, errorMessage(error), { cause: error });
    }
    try {
      return ExtensionManifest.parse(text);
    } catch (error) {
      throw new ManifestError("parse", path, errorMessage(error), { cause: error });
    }
  }

  /** Parses manifest TOML. Throws `ManifestParseError`. */
  static parse(text: string): ExtensionManifest {
    let raw: unknown;
    try {
      raw = parseTomlJson(text);
    } catch (error) {
      throw new ManifestParseError(errorMessage(error), { cause: error });
    }
    const result = ManifestSchema.safeParse(raw);
    if (!result.success) throw new ManifestParseError(z.prettifyError(result.error));
    return new ExtensionManifest(result.data);
  }

  displayName(): string {
    return this.name ?? this.id;
  }

  /** The game id this extension owns, when it is a declared game adapter. */
  gameId(): string | null {
    return this.game !== null && this.kind.includes(GAME_ADAPTER_KIND) ? this.game : null;
  }

  /** Supervisor module id of this extension: `ext.<id>`. */
  moduleId(): string {
    return `ext.${this.id}`;
  }

  /** Problems that make the manifest unusable (independent of the files). */
  errors(): string[] {
    const errors: string[] = [];
    if (!validId(this.id)) {
      errors.push(
        `id \`${this.id}\` must be 1-64 chars of lowercase letters, digits, \`.\`, \`-\` or \`_\``,
      );
    }
    if (this.version.trim() === "") errors.push("version is empty");
    if (this.entry.trim() === "") errors.push("entry is empty");
    if (this.game !== null) {
      if (!validGameId(this.game)) {
        errors.push(
          `game \`${this.game}\` must be 1-32 chars of lowercase letters, digits, \`-\` or \`_\``,
        );
      }
      if (!this.kind.includes(GAME_ADAPTER_KIND)) {
        errors.push(`\`game\` needs kind \`${GAME_ADAPTER_KIND}\``);
      }
    }
    for (const pattern of this.permissions.events) {
      if (!validPattern(pattern)) errors.push(`invalid event pattern \`${pattern}\``);
    }
    for (const pattern of this.env.pass) {
      if (!validEnvPattern(pattern)) {
        errors.push(
          `invalid env pattern \`${pattern}\` (a variable name, or a prefix of 3+ characters ending in \`*\`)`,
        );
      }
    }
    for (const server of this.mcp_servers) {
      if ((server.command === null) === (server.url === null)) {
        errors.push(`mcp server \`${server.name}\` needs exactly one of \`command\` or \`url\``);
      }
    }
    return errors;
  }

  /** Suspicious but usable settings. */
  warnings(): string[] {
    const warnings: string[] = [];
    for (const kind of this.kind) {
      if (!KNOWN_KINDS.includes(kind)) warnings.push(`unknown kind \`${kind}\``);
    }
    if (this.kind.length === 0) warnings.push("no `kind` declared");
    if (this.kind.includes(GAME_ADAPTER_KIND) && this.game === null) {
      warnings.push(
        `kind \`${GAME_ADAPTER_KIND}\` without \`game\`: it cannot publish game events`,
      );
    }
    if (this.kind.includes("tools") && !this.permissions.tools) {
      warnings.push("kind `tools` without `permissions.tools = true`");
    }
    if (this.kind.includes("commands") && !this.permissions.commands) {
      warnings.push("kind `commands` without `permissions.commands = true`");
    }
    if (this.permissions.input.length > 0) {
      warnings.push(`requests high-risk input permissions: ${this.permissions.input.join(", ")}`);
    }
    return warnings;
  }
}

/** Game ids: 1-32 lowercase ASCII letters, digits, `-`, `_` (one topic segment). */
export function validGameId(id: string): boolean {
  return /^[a-z0-9_-]{1,32}$/.test(id);
}

/** Extension ids: lowercase ASCII letters, digits, `.`, `-`, `_`. */
export function validId(id: string): boolean {
  return /^[a-z0-9._-]{1,64}$/.test(id) && !id.startsWith(".") && !id.endsWith(".");
}

/** Topic patterns: `*`, `a.b`, or `a.b.*`. */
export function validPattern(pattern: string): boolean {
  if (pattern === "*") return true;
  return validTopic(pattern.endsWith(".*") ? pattern.slice(0, -2) : pattern);
}

/** Concrete topics: non-empty dotted segments of `[a-z0-9_-]`. */
export function validTopic(topic: string): boolean {
  return topic.length <= 128 && topic.split(".").every((seg) => /^[a-z0-9_-]+$/.test(seg));
}
