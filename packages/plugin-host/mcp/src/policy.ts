// Pure helpers: tool filters, registry names and result flattening.

import { isJsonObject, type JsonObject, type JsonValue } from "@miyoria/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Longest tool name the registry accepts. */
export const MAX_TOOL_NAME = 64;

/** Matches `text` against a pattern with `*` (any run) and `?` (one char). */
export function globMatch(pattern: string, text: string): boolean {
  const p = Array.from(pattern);
  const t = Array.from(text);
  let pi = 0;
  let ti = 0;
  let star: [number, number] | null = null;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) {
      pi += 1;
      ti += 1;
    } else if (pi < p.length && p[pi] === "*") {
      star = [pi, ti];
      pi += 1;
    } else if (star !== null) {
      const [sp, st]: [number, number] = star;
      pi = sp + 1;
      ti = st + 1;
      star = [sp, st + 1];
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi += 1;
  return pi === p.length;
}

/** Allow / deny lists of tool name patterns. */
export class ToolFilter {
  constructor(
    readonly allow: readonly string[] = [],
    readonly deny: readonly string[] = [],
  ) {}

  /** Deny wins; an empty allow list allows everything not denied. */
  allows(tool: string): boolean {
    if (this.deny.some((p) => globMatch(p, tool))) return false;
    return this.allow.length === 0 || this.allow.some((p) => globMatch(p, tool));
  }
}

function sanitize(s: string): string {
  return Array.from(s, (c) => (/^[A-Za-z0-9_-]$/u.test(c) ? c : "_")).join("");
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x00000100000001b3n;
const MASK64 = (1n << 64n) - 1n;

/** FNV-1a, folded to 32 bits, as 8 hex digits. Stable across runs. */
function shortHash(s: string): string {
  let h = FNV_OFFSET;
  for (const b of Buffer.from(s, "utf8")) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK64;
  }
  const folded = (h ^ (h >> 32n)) & 0xffffffffn;
  return folded.toString(16).padStart(8, "0");
}

/**
 * Registry name `mcp_<server>_<tool>`, sanitized to the registry's rules and at most 64
 * characters. If the plain name is too long or already in `taken` (two tools that sanitize
 * alike), a hash of the original names keeps it unique. Returns `null` only if even that is
 * taken.
 */
export function registryName(
  server: string,
  tool: string,
  taken: ReadonlySet<string>,
): string | null {
  const plain = `mcp_${sanitize(server)}_${sanitize(tool)}`;
  if (plain.length <= MAX_TOOL_NAME && !taken.has(plain)) return plain;
  const hash = shortHash(`${server}\0${tool}`);
  const keep = MAX_TOOL_NAME - hash.length - 1;
  const hashed = `${plain.slice(0, keep)}_${hash}`;
  return taken.has(hashed) ? null : hashed;
}

/**
 * Schema keywords that only document the schema. `$id` stays (it is the base `$ref`s resolve
 * against), and so do `examples` (they show the model what a good argument looks like).
 */
const SCHEMA_NOISE: ReadonlySet<string> = new Set(["$schema", "$comment", "title"]);

/** Keywords whose value is a map of name to schema (the names are data, not keywords). */
const SCHEMA_MAPS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  // Draft 4–7: each value is a schema or a list of property names (left as it is).
  "dependencies",
] as const;
/** Keywords whose value is one schema. */
const SCHEMA_ONE = [
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "contentSchema",
  "not",
  "contains",
  "if",
  "then",
  "else",
] as const;
/** Keywords whose value is a list of schemas. */
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/**
 * A tool's input schema without what only documents it (`$schema`, `$comment`, `title`), at
 * every level. Property names are kept even when they are `title`.
 */
export function compactSchema(schema: JsonValue): JsonValue {
  if (!isJsonObject(schema)) return schema;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_NOISE.has(key)) continue;
    out[key] = value;
  }
  for (const key of SCHEMA_MAPS) {
    const map = out[key];
    if (!isJsonObject(map)) continue;
    const next: JsonObject = {};
    for (const [name, sub] of Object.entries(map)) next[name] = compactSchema(sub);
    out[key] = next;
  }
  for (const key of SCHEMA_ONE) {
    if (out[key] !== undefined) out[key] = compactSchema(out[key]);
  }
  for (const key of SCHEMA_LISTS) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = list.map(compactSchema);
  }
  // `items` as a list (draft 4 tuples).
  if (Array.isArray(schema.items)) out.items = schema.items.map(compactSchema);
  return out;
}

/**
 * Variables every stdio server gets from the host: enough to find programs and a home or temp
 * directory and to reach the network through a proxy, nothing else (no tokens, no API keys).
 * Compared case-insensitively. A server needing more lists them in `env_pass`, or sets them
 * with `env`.
 */
const STDIO_ENV_ALLOW: ReadonlySet<string> = new Set(
  [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "SYSTEMDRIVE",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
  ].map((name) => name.toUpperCase()),
);

/**
 * The environment of a stdio server: the allowlisted host variables, the ones named in
 * `pass` (exact names, or a prefix ending in `*`), then the server's own `env` on top.
 */
export function stdioEnv(
  host: Readonly<Record<string, string | undefined>>,
  pass: readonly string[],
  own: Readonly<Record<string, string>>,
): Record<string, string> {
  const passed = pass.map((p) => p.toUpperCase());
  const wanted = (name: string): boolean => {
    const upper = name.toUpperCase();
    return (
      STDIO_ENV_ALLOW.has(upper) ||
      passed.some((p) => (p.endsWith("*") ? upper.startsWith(p.slice(0, -1)) : upper === p))
    );
  };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(host)) {
    if (value !== undefined && wanted(name)) env[name] = value;
  }
  return Object.assign(env, own);
}

/** Cuts `text` to `max` characters (0 = unlimited) and notes the cut. */
export function truncateChars(text: string, max: number): string {
  if (max === 0) return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const dropped = chars.length - max;
  return `${chars.slice(0, max).join("")}\n[truncated: ${dropped} more characters]`;
}

type Block = CallToolResult["content"][number];

function flattenBlock(block: Block): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return `[image omitted: ${block.mimeType}]`;
    case "audio":
      return `[audio omitted: ${block.mimeType}]`;
    case "resource_link":
      return `[resource link: ${block.name} ${block.uri}]`;
    case "resource": {
      const r = block.resource;
      if ("text" in r && typeof r.text === "string") return `[resource ${r.uri}]\n${r.text}`;
      if ("blob" in r) {
        return `[binary resource omitted: ${r.uri} (${r.mimeType ?? "unknown type"})]`;
      }
      return "[unsupported resource omitted]";
    }
    default:
      return "[unsupported content omitted]";
  }
}

/**
 * Flattens a tool result into text for the model: text parts verbatim, other parts as short
 * placeholders. Structured content is used when there is no content at all.
 */
export function flattenResult(
  result: Pick<CallToolResult, "content" | "structuredContent">,
): string {
  const parts = (result.content ?? []).map(flattenBlock);
  if (parts.length === 0 && result.structuredContent != null) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  if (parts.length === 0) return "(empty result)";
  return parts.join("\n");
}
