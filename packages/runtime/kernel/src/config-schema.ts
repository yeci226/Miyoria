// The schema of the whole `miyoria.toml`, composed from what each owner declares: a zod schema
// per top-level section (next to the code that reads it) and each module's `configSchema` under
// `modules.<id>`. This file holds only the generic pieces; Core composes the real one, since it is
// the one that knows every module.
//
// A config schema follows the contract rules (`@miyoria/contracts/kit`) where they fit: no
// `.refine`, nothing JSON Schema cannot say for the input side. It differs in two ways: fields
// carry `.default()` / `.prefault()` (the file may leave anything out), and a section may
// `.transform` what it parsed into what its reader uses (a `Map`, a class), because the JSON Schema
// is emitted for the input only.
//
// The schema says what is right. What a reader does with something that is not differs by
// section (refuse to start, skip one module, use the default), so a check classifies each problem
// with a policy instead of making every one fatal.

import {
  type Character,
  DEFAULT_CHARACTER,
  DEFAULT_CURRENCY,
  type JsonValue,
} from "@miyoria/types";
import { z } from "zod";
import { ConfigError } from "./config.js";

/** A config schema (a zod schema), for packages that hold schemas without depending on zod. */
export type ConfigSchema = z.ZodType;

/** What a problem does: stops the start, is logged, or is left as the reader leaves it. */
export type ConfigSeverity = "error" | "warning" | "ignore";

/** One place in a document that does not fit its schema. */
export interface ConfigProblem {
  /** Dotted, TOML-quoted where needed: `modules."platform.discord.bot".token`. */
  path: string;
  keys: readonly (string | number)[];
  /** What the schema expected there (zod's wording). */
  expected: string;
  /** The zod issue itself, for a caller that words it in its own language (the CLI). */
  issue: z.core.$ZodIssue;
  severity: ConfigSeverity;
}

/** The severity of a problem at `keys`. */
export type ConfigPolicy = (keys: readonly (string | number)[]) => ConfigSeverity;

export interface ConfigCheckOptions {
  /** Default: every problem is an error. */
  policy?: ConfigPolicy;
  /**
   * Leaves strings holding `${NAME}` alone: a document written with its references unexpanded
   * (a config revision, the file as the CLI edits it) is checked for everything else.
   */
  skipEnvRefs?: boolean;
}

/**
 * A section's schema, or a table of them (`{ embedding: EmbeddingConfigSchema }` for `[memory]`,
 * whose reader only reads `[memory.embedding]`): a table lets other keys through.
 */
export type ConfigSection = z.ZodType | { readonly [key: string]: ConfigSection };

/** The pieces of a root schema. */
export interface ConfigSchemaParts {
  /** Top-level sections other than `modules`, by name. */
  sections: Readonly<Record<string, ConfigSection>>;
  /** Each module's `configSchema` by id; `null` for a module whose section only has `enabled`. */
  modules: ReadonlyMap<string, z.ZodType | null>;
}

/**
 * `[core]`: the core node's own keys, read one by one by `@miyoria/core`'s `settings.ts`, which
 * uses the default for a key that is missing, empty or not a string. It is here, in the lowest
 * package of the core node that has zod, because `@miyoria/core` does not depend on zod itself.
 */
export const CoreSectionSchema = z.object({
  /** `sqlite:<path>` (relative to the config file's directory) or `memory://`. */
  database_url: z.string().optional(),
  /** Folder under `profiles_dir` of the active character. */
  profile: z.string().optional(),
  profiles_dir: z.string().optional(),
  /** `info`, or a filter list like `info,miyoria=debug`. */
  log: z.string().optional(),
});

const word = (fallback: string, max = 32) => z.string().trim().min(1).max(max).default(fallback);

/**
 * `[character]`: who she is in this profile (docs/design/v5-profiles.md). Every default is
 * `DEFAULT_CHARACTER`'s (a test keeps them equal), so a file without the section reads as before.
 */
export const CharacterSectionSchema = z.object({
  /** Her own name. */
  name: word(DEFAULT_CHARACTER.name),
  /** The short name most people use; `""`: none. */
  short_name: z.string().trim().max(32).default(DEFAULT_CHARACTER.short_name),
  /** Other spellings of the short name. */
  other_names: z
    .array(z.string().trim().min(1).max(32))
    .max(16)
    .default([...DEFAULT_CHARACTER.other_names]),
  /** How texts refer to her. */
  pronoun: word(DEFAULT_CHARACTER.pronoun, 8),
  /** The name of her stock exchange. */
  exchange_name: word(DEFAULT_CHARACTER.exchange_name),
  /** What she is, in a word (`鯨魚`); `""`: nothing in particular. */
  creature: z.string().trim().max(16).default(DEFAULT_CHARACTER.creature),
});

/** `[character]` of a config tree; a missing or unreadable section is `DEFAULT_CHARACTER`. */
export function characterOf(section: JsonValue | undefined): Character {
  const parsed = CharacterSectionSchema.safeParse(section ?? {});
  return parsed.success ? parsed.data : DEFAULT_CHARACTER;
}

/** `[modules.economy] currency`: shown everywhere the coins are named. */
export const CurrencySchema = z.string().trim().min(1).max(16).default(DEFAULT_CURRENCY);

/**
 * The coins' name of a config tree: `[modules.economy] currency`, read as the economy reads it
 * (trimmed, 1 to 16 characters); missing or unreadable is `DEFAULT_CURRENCY`.
 */
export function currencyOf(economy: JsonValue | undefined): string {
  const raw =
    economy !== null && typeof economy === "object" && !Array.isArray(economy)
      ? economy.currency
      : undefined;
  const parsed = CurrencySchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CURRENCY;
}

function sectionSchema(section: ConfigSection): z.ZodType {
  if (section instanceof z.ZodType) return section;
  const shape: Record<string, z.ZodType> = {};
  for (const [key, child] of Object.entries(section)) shape[key] = sectionSchema(child).optional();
  return z.looseObject(shape);
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** `["modules", "platform.discord.bot", "token"]` → `modules."platform.discord.bot".token`. */
export function configPath(keys: readonly (string | number)[]): string {
  let out = "";
  for (const key of keys) {
    if (typeof key === "number") out += `[${key}]`;
    else {
      const part = BARE_KEY.test(key) ? key : JSON.stringify(key);
      out = out === "" ? part : `${out}.${part}`;
    }
  }
  return out;
}

const ENABLED = { enabled: z.boolean().optional() };

/**
 * `[modules.<id>]` as the file holds it: the module's own schema plus `enabled`, which the kernel
 * takes off before the module sees its section (`Config.module`).
 */
export function moduleSectionSchema(schema: z.ZodType | null): z.ZodType {
  if (schema === null) return z.looseObject(ENABLED);
  if (schema instanceof z.ZodObject) return schema.safeExtend(ENABLED);
  return z.intersection(z.object(ENABLED), schema);
}

/**
 * The root schema: every section optional, `modules.<id>` per module. Sections and modules it
 * does not name are let through, as every reader lets them through today.
 */
export function composeConfigSchema(parts: ConfigSchemaParts): z.ZodType {
  const modules: Record<string, z.ZodType> = {};
  for (const [id, schema] of parts.modules) modules[id] = moduleSectionSchema(schema).optional();
  const root: Record<string, z.ZodType> = {};
  for (const [name, section] of Object.entries(parts.sections)) {
    root[name] = sectionSchema(section).optional();
  }
  root.modules = z.looseObject(modules).optional();
  return z.looseObject(root);
}

/** The value at `keys` in `doc`, `undefined` when the path does not lead anywhere. */
function valueAt(doc: unknown, keys: readonly PropertyKey[]): unknown {
  let value = doc;
  for (const key of keys) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

/** Every problem of `doc` against `schema`, in zod's order, the ignored ones included. */
export function checkConfig(
  schema: z.ZodType,
  doc: unknown,
  options: ConfigCheckOptions = {},
): ConfigProblem[] {
  const result = schema.safeParse(doc ?? {});
  if (result.success) return [];
  const out: ConfigProblem[] = [];
  for (const issue of result.error.issues) {
    const keys = issue.path.map((k) => (typeof k === "number" ? k : String(k)));
    if (options.skipEnvRefs) {
      const value = valueAt(doc, issue.path);
      if (typeof value === "string" && value.includes("${")) continue;
    }
    out.push({
      path: configPath(keys),
      keys,
      expected: issue.message,
      issue,
      severity: options.policy?.(keys) ?? "error",
    });
  }
  return out;
}

/** One line per problem: `at \`path\`: expected`. */
export function describeProblem(problem: ConfigProblem): string {
  return problem.path === "" ? problem.expected : `at \`${problem.path}\`: ${problem.expected}`;
}

/**
 * A `ConfigError("invalid")` naming every problem, in the style of `parseSection`'s: one problem
 * reads `invalid config at \`path\`: ...`, several are listed one per line.
 */
export function configProblemsError(problems: readonly ConfigProblem[]): ConfigError {
  const first = problems[0];
  if (problems.length === 1 && first !== undefined) {
    return new ConfigError("invalid", `invalid config ${describeProblem(first)}`, first.path);
  }
  const lines = problems.map((p) => `  ${describeProblem(p)}`).join("\n");
  return new ConfigError(
    "invalid",
    `invalid config (${problems.length} problems):\n${lines}`,
    first?.path,
  );
}

/**
 * The JSON Schema of a config schema's input (what may be written in the file): fields with a
 * default are not required, objects do not forbid other keys, and what JSON Schema cannot say (a
 * transform's output, a custom check) is left open. Module manifests (`manifestJson`) and the
 * whole file come from this one function.
 */
export function configJsonSchema(schema: z.ZodType): JsonValue {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonValue;
}

/**
 * The schema that describes the value at `keys`, or `null` when no schema says anything about it
 * (a key an object lets through without naming it). Wrappers (optional, default, nullable, a
 * transform's input side) are looked through.
 */
export function schemaAt(schema: z.ZodType, keys: readonly (string | number)[]): z.ZodType | null {
  let current: z.ZodType | null = schema;
  for (const key of keys) {
    current = current === null ? null : childOf(unwrap(current), key);
    if (current === null) return null;
  }
  return current;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    const def = current._zod.def as { type: string; innerType?: z.ZodType; in?: z.ZodType };
    if (def.innerType !== undefined) current = def.innerType;
    else if (def.type === "pipe" && def.in !== undefined) current = def.in;
    else return current;
  }
}

function childOf(schema: z.ZodType, key: string | number): z.ZodType | null {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    if (typeof key === "string" && Object.hasOwn(shape, key)) return shape[key] ?? null;
    const rest = schema._zod.def.catchall as z.ZodType | undefined;
    return rest === undefined || rest instanceof z.ZodUnknown ? null : rest;
  }
  if (schema instanceof z.ZodRecord) return schema._zod.def.valueType as unknown as z.ZodType;
  if (schema instanceof z.ZodArray) {
    return typeof key === "number" ? (schema.element as z.ZodType) : null;
  }
  if (schema instanceof z.ZodIntersection) {
    const def = schema._zod.def;
    return (
      childOf(unwrap(def.right as z.ZodType), key) ?? childOf(unwrap(def.left as z.ZodType), key)
    );
  }
  return null;
}
