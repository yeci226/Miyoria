// Everything a game sends is untrusted text: action names, descriptions, JSON schemas, context,
// force queries, result messages. None of it may read as an instruction from the owner, and none
// of it may grow without bound. This file bounds it and neutralizes it with the shared helpers.

import { dataBlock, neutralize, safeName } from "@miyoria/types";

/** Where the host's goal list and the prompt tell her this text came from. */
export const SOURCE = "neuro-game";

export const LIMITS = {
  description: 600,
  schemaChars: 4000,
  schemaDepth: 6,
  schemaNodes: 200,
  schemaString: 200,
  context: 1500,
  query: 1500,
  state: 3000,
  result: 600,
  goalName: 40,
  argsChars: 16_000,
} as const;

/** `text` neutralized, trimmed and cut to `max` characters (code points). */
export function bounded(text: string, max: number): string {
  const clean = neutralize(text).trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : clean;
}

/** The goal name the host accepts (`[a-z0-9_-]{1,40}`) for a game's action name, unique in `taken`. */
export function goalName(raw: string, taken: ReadonlySet<string>): string {
  let base = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, LIMITS.goalName);
  if (base === "") base = "action";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const suffix = `_${i}`;
    const candidate = `${base.slice(0, LIMITS.goalName - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The description she reads for an action: marked as the game's words, not the owner's. */
export function goalDescription(name: string, description: string): string {
  return dataBlock(SOURCE, `動作 ${name}`, bounded(description, LIMITS.description));
}

/**
 * A schema copy whose strings are neutralized and cut, and whose size, depth and node count are
 * bounded. `null` when it is too big or too deep to keep: the action is then left out, because
 * half a schema would make her send arguments the game cannot take.
 */
export function sanitizeSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | null | undefined {
  if (schema === undefined) return undefined;
  let nodes = 0;
  const walk = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > LIMITS.schemaNodes || depth > LIMITS.schemaDepth)
      throw new RangeError("schema too large");
    if (typeof value === "string") return bounded(value, LIMITS.schemaString);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === "__proto__") continue;
        out[bounded(k, 64)] = walk(v, depth + 1);
      }
      return out;
    }
    return null;
  };
  try {
    const copy = walk(schema, 0) as Record<string, unknown>;
    return JSON.stringify(copy).length > LIMITS.schemaChars ? null : copy;
  } catch {
    return null;
  }
}

/** A game's name as one inert line. */
export function gameLabel(game: string): string {
  return safeName(game, 60);
}

/** A block of the game's text with its provenance, or "" when there is nothing. */
export function gameBlock(title: string, body: string, max: number): string {
  const text = bounded(body, max);
  return text === "" ? "" : dataBlock(SOURCE, title, text);
}
