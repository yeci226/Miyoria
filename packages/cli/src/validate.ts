// Input validation for config values. Errors are user-facing (zh-TW). Strings holding `${VAR}`
// references are not checked; their value is.
//
// What a value may be is the root schema's to say (`rootConfigSchema` of `@miyoria/core`, with the
// CLI's own `[stack]` and `[machine]`): a key it describes is checked by it, worded here. The rules
// below cover the keys it does not describe, and the formats it does not say (a URL, `host:port`,
// a database URL), which are checked on top of it.

import {
  type ConfigProblem,
  type ConfigSchema,
  checkConfig,
  schemaAt,
} from "@miyoria/runtime/kernel";
import { isEnvName } from "./env-file.js";
import { StackSchema } from "./stack/config.js";
import { MachineSchema } from "./stack/roles.js";
import { isTable, type TomlTable, type TomlValue } from "./toml-patch.js";

/** `null` when valid, else the error text. */
export type Check = (s: string) => string | null;

function urlWith(s: string, schemes: readonly string[], hint: string): string | null {
  const t = s.trim();
  if (t.includes("${")) return null;
  try {
    const u = new URL(t);
    const scheme = u.protocol.replace(/:$/, "");
    return schemes.includes(scheme) && u.hostname !== "" ? null : hint;
  } catch {
    return hint;
  }
}

export const httpUrl: Check = (s) =>
  urlWith(s, ["http", "https"], "要是 http:// 或 https:// 開頭的網址,例如 http://127.0.0.1:8001");

export const wsUrl: Check = (s) =>
  urlWith(
    s,
    ["ws", "wss", "http", "https"],
    "要是 ws:// 或 wss:// 開頭的網址,例如 ws://127.0.0.1:7882/stage-link",
  );

export const databaseUrl: Check = (s) => {
  const t = s.trim();
  if (t === "memory://" || t.includes("${")) return null;
  if (t.startsWith("sqlite:")) {
    return t.replace(/^sqlite:(\/\/)?/, "") === ""
      ? "SQLite 要有檔案路徑,例如 sqlite:data/miyoria.db"
      : null;
  }
  if (/^postgres(ql)?:/i.test(t))
    return "已經不支援 PostgreSQL:要是 sqlite:data/miyoria.db 或 memory://";
  return "要是 sqlite:data/miyoria.db 或 memory://";
};

export const port: Check = (s) => {
  const t = s.trim();
  const n = /^\d+$/.test(t) ? Number(t) : Number.NaN;
  return n >= 1 && n <= 65535 ? null : "port 要是 1–65535 的整數";
};

export const bind: Check = (s) => {
  const t = s.trim();
  if (t.includes("${")) return null;
  const hint = "格式是 主機:port,例如 127.0.0.1:7878";
  const colon = t.lastIndexOf(":");
  if (colon <= 0) return hint;
  const host = t.slice(0, colon);
  if (/\s/.test(host)) return hint;
  return port(t.slice(colon + 1)) === null ? null : hint;
};

export const discordId: Check = (s) => {
  const t = s.trim();
  return /^\d{17,20}$/.test(t) ? null : "Discord id 是 17–20 位數字(開發者模式 → 右鍵 → 複製 ID)";
};

export const optionalDiscordId: Check = (s) => (s.trim() === "" ? null : discordId(s));

/** Comma or space separated ids; empty is fine. */
export const discordIds: Check = (s) => {
  for (const part of s.split(/[, ]/)) {
    if (part.trim() === "") continue;
    const err = discordId(part);
    if (err) return err;
  }
  return null;
};

export const modelId: Check = (s) => {
  const t = s.trim();
  if (t === "") return "模型 id 不能是空的";
  if (/\s/.test(t)) return "模型 id 不能有空白";
  return null;
};

export const envName: Check = (s) =>
  isEnvName(s) ? null : `\`${s}\` 不是合法的環境變數名稱(英數字和底線,例如 LLM_API_KEY)`;

// ---- the root schema ---------------------------------------------------------------------

/** The sections only the CLI reads, which it adds to Core's root schema. */
export const CLI_SECTIONS = { stack: StackSchema, machine: MachineSchema } as const;

let loaded: Promise<ConfigSchema | null> | undefined;

/**
 * The root schema of the whole file. It needs every module package, so it is loaded on first
 * use; `null` when they cannot be loaded, and then only the rules below check values.
 */
export function configSchema(): Promise<ConfigSchema | null> {
  loaded ??= import("@miyoria/core").then(
    (core) => core.rootConfigSchema(CLI_SECTIONS),
    () => null,
  );
  return loaded;
}

/** The root schema and the document a value is checked in (as `Workspace.doc.data` holds it). */
export interface SchemaContext {
  schema: ConfigSchema;
  doc: TomlTable;
}

/** The context for checks in `doc`, `null` without a root schema. */
export async function schemaContext(doc: TomlTable): Promise<SchemaContext | null> {
  const schema = await configSchema();
  return schema === null ? null : { schema, doc };
}

/** A TOML value as Core sees it once loaded: integers are numbers, dates their text. */
function jsonOf(value: TomlValue): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonOf);
  if (isTable(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonOf(v)]));
  }
  return value;
}

/** Whether the root schema describes the value at `path`. */
export function described(ctx: SchemaContext | null, path: readonly string[]): boolean {
  return ctx !== null && schemaAt(ctx.schema, path) !== null;
}

const TYPE_NAMES: Record<string, string> = {
  string: "字串",
  number: "數字",
  int: "整數",
  boolean: "true 或 false",
  array: "陣列",
  object: "表格",
  record: "表格",
};

/** A problem in the CLI's words. */
function wording(problem: ConfigProblem): string {
  const issue = problem.issue;
  switch (issue.code) {
    case "invalid_type": {
      const name = TYPE_NAMES[issue.expected] ?? issue.expected;
      return /^[A-Za-z]/.test(name) ? `要是 ${name}` : `要是${name}`;
    }
    case "too_big":
      if (issue.origin === "number" || issue.origin === "int") {
        return `不能${issue.inclusive === false ? "大於或等於" : "大於"} ${issue.maximum}`;
      }
      return problem.expected;
    case "too_small":
      if (issue.origin === "number" || issue.origin === "int") {
        return `不能${issue.inclusive === false ? "小於或等於" : "小於"} ${issue.minimum}`;
      }
      return problem.expected;
    case "invalid_value":
      return `要是 ${issue.values.map((v) => JSON.stringify(v)).join("、")} 其中之一`;
    default:
      return problem.expected;
  }
}

/**
 * What the root schema says about putting `value` at `path` of the document: `null` when it
 * fits (or the schema does not describe that key), else the error text. Only problems at `path`
 * or inside `value` count; what is wrong elsewhere in the file is not this value's fault.
 */
export function schemaCheck(
  ctx: SchemaContext | null,
  path: readonly string[],
  value: TomlValue,
): string | null {
  if (ctx === null || !described(ctx, path)) return null;
  const doc = jsonOf(ctx.doc) as Record<string, unknown>;
  let table = doc;
  for (const key of path.slice(0, -1)) {
    const next = table[key];
    table[key] = typeof next === "object" && next !== null && !Array.isArray(next) ? next : {};
    table = table[key] as Record<string, unknown>;
  }
  table[path.at(-1) ?? ""] = jsonOf(value);
  const problems = checkConfig(ctx.schema, doc, { skipEnvRefs: true });
  // A table that takes no other keys (`[stack]`) names the key it does not know on itself.
  const unknown = problems.find(
    (p) =>
      p.issue.code === "unrecognized_keys" &&
      p.keys.length === path.length - 1 &&
      p.keys.every((key, i) => path[i] === key) &&
      p.issue.keys.includes(path.at(-1) ?? ""),
  );
  if (unknown !== undefined) return `\`${path.at(-1)}\` 不是這個表格認得的鍵`;
  const problem = problems.find((p) => path.every((key, i) => p.keys[i] === key));
  if (problem === undefined) return null;
  const inside = problem.keys.slice(path.length);
  return inside.length === 0
    ? wording(problem)
    : `${inside.map((k) => (typeof k === "number" ? `[${k}]` : k)).join(".")} ${wording(problem)}`;
}

/**
 * Checks a value written with `miyoria config set`: by the root schema where it describes the
 * key, then by the key's name for the formats it does not say and the keys it does not describe.
 */
export function valueForKey(
  path: readonly string[],
  value: TomlValue,
  ctx: SchemaContext | null = null,
): string | null {
  const last = path.at(-1) ?? "";
  if (typeof value === "string" && value.includes("${")) return null;
  const fromSchema = schemaCheck(ctx, path, value);
  if (fromSchema !== null) return fromSchema;
  const own = !described(ctx, path);
  const string = (check: Check) =>
    typeof value === "string" ? check(value) : `\`${last}\` 要是字串`;
  if (own && (last === "enabled" || last === "dev") && typeof value !== "boolean") {
    return `\`${last}\` 要是 true 或 false`;
  }
  if (own && last === "port") {
    return typeof value === "bigint" && value >= 1n && value <= 65535n
      ? null
      : "port 要是 1–65535 的整數";
  }
  if (last === "bind") return string(bind);
  if (last === "database_url") return string(databaseUrl);
  if (last === "core_url") return string(wsUrl);
  if (own && last === "command_guilds") {
    if (!Array.isArray(value) || isTable(value)) return '要是陣列,例如 ["123456789012345678"]';
    for (const v of value) {
      if (typeof v !== "string") return '伺服器 id 要用字串,例如 ["123456789012345678"]';
      const err = discordId(v);
      if (err) return err;
    }
    return null;
  }
  if (last === "url" || last.endsWith("_url") || last.endsWith("_uri")) return string(httpUrl);
  return null;
}
