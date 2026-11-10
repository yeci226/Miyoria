// `miyoria.toml` loading.
//
// String values may reference environment variables as `${NAME}` or `${NAME:-default}`, so
// secrets can stay in `.env` / the environment.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { isJsonObject, type JsonObject, type JsonValue } from "@miyoria/types";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

export type ConfigErrorCode = "read" | "parse" | "missing_env" | "invalid";

/**
 * The dotted `paths` (`"key"`, `"section.key"`) a raw module section still sets: for keys that
 * are gone, so an old `miyoria.toml` that has them loads (they are ignored) with a deprecation
 * warning instead of failing.
 */
export function presentKeys(raw: unknown, paths: readonly string[]): string[] {
  return paths.filter((path) => {
    let at: unknown = raw;
    for (const part of path.split(".")) {
      if (!isJsonObject(at as JsonValue) || !Object.hasOwn(at as JsonObject, part)) return false;
      at = (at as JsonObject)[part];
    }
    return true;
  });
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(
    readonly code: ConfigErrorCode,
    message: string,
    /** Dotted config path (`invalid`) or env var name (`missing_env`). */
    readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Looks an environment variable up. */
export type EnvLookup = (name: string) => string | undefined;

export const processEnv: EnvLookup = (name) => process.env[name];

/**
 * Expands `${NAME}` and `${NAME:-default}`. A set, non-empty variable wins; otherwise the
 * default applies; a set but empty variable without default expands to `""`; an unset one
 * without default is an error. An unterminated `${` is kept as is.
 */
export function expandEnv(text: string, env: EnvLookup = processEnv): string {
  let out = "";
  let rest = text;
  for (let start = rest.indexOf("${"); start !== -1; start = rest.indexOf("${")) {
    out += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf("}");
    if (end === -1) return out + rest.slice(start);
    const expr = after.slice(0, end);
    const sep = expr.indexOf(":-");
    const name = sep === -1 ? expr : expr.slice(0, sep);
    const fallback = sep === -1 ? undefined : expr.slice(sep + 2);
    const value = env(name);
    if (value !== undefined && value !== "") out += value;
    else if (fallback !== undefined) out += fallback;
    else if (value !== undefined) out += value;
    else throw new ConfigError("missing_env", `environment variable \`${name}\` is not set`, name);
    rest = after.slice(end + 1);
  }
  return out + rest;
}

/** Expands environment references in every string of a JSON tree (returns a new tree). */
export function interpolateEnv(value: JsonValue, env: EnvLookup = processEnv): JsonValue {
  if (typeof value === "string") return value.includes("${") ? expandEnv(value, env) : value;
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env));
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v, env);
    return out;
  }
  return value;
}

/** TOML → JSON: dates and times become their RFC 3339 / TOML text form. */
function tomlToJson(value: unknown): JsonValue {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(tomlToJson);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "object" && value !== null) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = tomlToJson(v);
    return out;
  }
  return value as JsonValue;
}

/** Parses TOML text into JSON. Throws `ConfigError("parse")`. */
export function parseTomlJson(text: string): JsonObject {
  try {
    return tomlToJson(parseToml(text)) as JsonObject;
  } catch (error) {
    throw new ConfigError("parse", `invalid TOML: ${(error as Error).message}`, undefined, {
      cause: error,
    });
  }
}

/**
 * Validates `value` with `schema`. `undefined` / `null` validate as `{}`, so schemas whose
 * fields all have defaults accept a missing section (like `#[serde(default)]`).
 * Throws `ConfigError("invalid")` naming `path`.
 */
export function parseSection<S extends z.ZodType>(
  schema: S,
  value: JsonValue | undefined,
  path: string,
): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new ConfigError(
    "invalid",
    `invalid config at \`${path}\`: ${z.prettifyError(result.error)}`,
    path,
    { cause: result.error },
  );
}

export interface ModuleSection {
  /** Modules are enabled unless `enabled = false` is set. */
  enabled: boolean;
  /** `[modules.<id>]` without `enabled`; `null` when the section is missing. */
  config: JsonValue | null;
}

/**
 * The whole config tree, kept as JSON so each module can validate its own section with its own
 * schema.
 */
export class Config {
  readonly #root: JsonValue;

  private constructor(root: JsonValue) {
    this.#root = root;
  }

  /** Reads and parses a TOML file. Does not load `.env`; call `loadDotenv` first. */
  static async load(path: string, env: EnvLookup = processEnv): Promise<Config> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      throw new ConfigError(
        "read",
        `cannot read config file \`${path}\`: ${(error as Error).message}`,
        undefined,
        { cause: error },
      );
    }
    return Config.fromToml(text, env);
  }

  static fromToml(text: string, env: EnvLookup = processEnv): Config {
    return new Config(interpolateEnv(parseTomlJson(text), env));
  }

  /** Uses an already-parsed tree as is (no interpolation). */
  static fromValue(root: JsonValue): Config {
    return new Config(root);
  }

  get raw(): JsonValue {
    return this.#root;
  }

  /** Section at a dotted path, e.g. `"llm"` or `"core.profile"`. */
  section(path: string): JsonValue | undefined {
    let value: JsonValue | undefined = this.#root;
    for (const key of path.split(".")) {
      if (!isJsonObject(value)) return undefined;
      value = value[key];
    }
    return value;
  }

  /** Validates a section with `schema`; a missing section validates as `{}`. */
  get<S extends z.ZodType>(path: string, schema: S): z.output<S> {
    return parseSection(schema, this.section(path), path);
  }

  /** `[modules.<id>]`; `id` may contain dots (`modules."platform.discord.bot"`). */
  module(id: string): ModuleSection {
    const modules = this.section("modules");
    const section = isJsonObject(modules) ? modules[id] : undefined;
    if (!isJsonObject(section)) return { enabled: true, config: null };
    const { enabled, ...config } = section;
    return { enabled: typeof enabled === "boolean" ? enabled : true, config };
  }
}

/**
 * Loads `.env` from the directory of `configPath` into `env` (default `process.env`). Variables
 * that are already set win, like dotenvy. A missing file is fine. Returns the names it set.
 */
export function loadDotenv(
  configPath: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  let text: string;
  try {
    text = readFileSync(join(dirname(configPath), ".env"), "utf8");
  } catch {
    return [];
  }
  const set: string[] = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (env[name] === undefined && typeof value === "string") {
      env[name] = value;
      set.push(name);
    }
  }
  return set;
}
