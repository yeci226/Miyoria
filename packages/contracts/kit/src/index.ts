// The rules every contract schema follows, and the JSON Schema a part is emitted as.
//
// A part is one folder of this package (`wire`, `voice-link`, ...). Its `src/index.ts` exports
// zod schemas; the TypeScript types are inferred from them, and `schema/<part>.json` is generated
// from them (`pnpm contracts:gen`) and checked in, for readers that are not TypeScript.
//
// Rules, checked by `checkRules` for every part (kit/test/parts.test.ts):
//
// 1. No `.transform`, `z.custom`, `z.date`, `z.bigint`, dynamic `.catch`: none of them has a JSON
//    Schema form. Normalising (trim, clamp, `null` to `undefined`) is the receiver's code, after
//    `parse`.
// 2. No `.refine`: JSON Schema drops it without a word, so the other side would not know the
//    rule. Use checks JSON Schema can say (`min`, `max`, `regex`, `int`, an enum).
// 3. An exported object, union or enum has a name: `.meta({ id: "<Part><Name>" })`. It becomes the
//    `$defs` key and the class name on the Python side. Names are unique across parts.
// 4. A field added to a shape that is already in use is `.optional()` or has a `.default()`, so a
//    peer that predates it stays valid. (Not checkable here; reviewers hold it.)
//
// The JSON Schema is emitted in zod's input mode: fields with a default are not required and
// objects do not forbid extra keys, which is what lets an older peer ignore what it does not know.
//
// A part may also export oRPC route contracts (`api`): procedures, or plain objects of them. They
// are not schemas themselves, so the export rules (rule 3, the prefix) skip them, but the input
// and output schema of every procedure they hold is checked against rules 1 and 2, and the named
// schemas those reach are emitted with the part. The unnamed `{ params, query, body }` wrapper of
// a route's input needs no name of its own. The tables themselves, without their schemas, are
// written to `schema/<part>.routes.json` for the panel's client (`emitRoutes`).

import { type AnyContractRouter, isContractProcedure, minifyContractRouter } from "@orpc/contract";
import { z } from "zod";

/** Kinds of schema that must carry a name when a part exports them. */
const NAMED_KINDS = new Set(["object", "union", "enum", "intersection", "tuple", "lazy"]);

/** Checks that `z.toJSONSchema` cannot express, by zod's own check name. */
const UNSAYABLE_CHECKS = new Set(["custom"]);

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** One part's JSON Schema file. */
export interface PartDocument {
  $schema: string;
  title: string;
  $defs: Record<string, unknown>;
}

/** The name a schema was given with `.meta({ id })`, if any. */
export function contractId(schema: z.ZodType): string | null {
  const id = z.globalRegistry.get(schema)?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The zod schemas among a module's exports, by export name, in name order. */
export function exportedSchemas(part: Record<string, unknown>): Map<string, z.ZodType> {
  const out = new Map<string, z.ZodType>();
  for (const name of Object.keys(part).sort()) {
    const value = part[name];
    if (value instanceof z.ZodType) out.set(name, value);
  }
  return out;
}

/**
 * The input and output schemas of the route contracts among a module's exports, by
 * `<export>.<path>.input|output`, each schema once (a group exported on its own and again inside
 * the whole table is one set of schemas).
 */
export function contractSchemas(part: Record<string, unknown>): Map<string, z.ZodType> {
  const out = new Map<string, z.ZodType>();
  const seen = new Set<unknown>();
  const visit = (value: unknown, at: string): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (isContractProcedure(value)) {
      const { inputSchema, outputSchema } = value["~orpc"];
      for (const [io, schema] of [
        ["input", inputSchema],
        ["output", outputSchema],
      ] as const) {
        if (schema instanceof z.ZodType && ![...out.values()].includes(schema)) {
          out.set(`${at}.${io}`, schema);
        }
      }
      return;
    }
    if (value instanceof z.ZodType || Object.getPrototypeOf(value) !== Object.prototype) return;
    for (const key of Object.keys(value).sort()) {
      visit((value as Record<string, unknown>)[key], `${at}.${key}`);
    }
  };
  for (const name of Object.keys(part).sort()) visit(part[name], name);
  return out;
}

/** Problems of one schema against rules 1 and 2, as lines starting with `name`. */
function sayability(name: string, schema: z.ZodType, problems: Set<string>): void {
  for (const io of ["input", "output"] as const) {
    try {
      z.toJSONSchema(schema, {
        io,
        unrepresentable: "throw",
        override: (ctx) => {
          for (const check of ctx.zodSchema._zod.def.checks ?? []) {
            const what = check._zod.def.check;
            if (io === "input" && UNSAYABLE_CHECKS.has(what)) {
              problems.add(`${name}: a ${what} check (.refine) does not reach JSON Schema`);
            }
          }
        },
      });
    } catch (error) {
      problems.add(`${name}: no JSON Schema form (${io}): ${message(error)}`);
    }
  }
}

/** `voice-link` → `VoiceLink`: what every name of that part starts with. */
export function partPrefix(part: string): string {
  return part
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What breaks the rules in one part: one line per problem, empty when it follows them. */
export function checkRules(partName: string, part: Record<string, unknown>): string[] {
  // A set: zod visits a schema once per place it is used, and one problem is one line.
  const problems = new Set<string>();
  const prefix = partPrefix(partName);
  for (const [name, schema] of exportedSchemas(part)) {
    const id = contractId(schema);
    const kind = schema._zod.def.type;
    if (id === null && NAMED_KINDS.has(kind)) {
      problems.add(`${name}: an exported ${kind} needs .meta({ id: "${prefix}..." })`);
    }
    if (id !== null && !id.startsWith(prefix)) {
      problems.add(`${name}: its id "${id}" does not start with "${prefix}"`);
    }
    sayability(name, schema, problems);
  }
  for (const [name, schema] of contractSchemas(part)) sayability(name, schema, problems);
  return [...problems];
}

/** The named schemas a part exports, by name. Two exports must not share a name. */
export function namedSchemas(part: Record<string, unknown>): Map<string, z.ZodType> {
  const out = new Map<string, z.ZodType>();
  for (const schema of exportedSchemas(part).values()) {
    const id = contractId(schema);
    if (id === null) continue;
    const other = out.get(id);
    if (other !== undefined && other !== schema) {
      throw new Error(`two schemas are named "${id}"`);
    }
    out.set(id, schema);
  }
  return out;
}

/**
 * The JSON Schema file of a part: one `$defs` entry for every named schema its exports (and the
 * routes among them) reach, names in order. `null` when that is none.
 */
export function emitPart(partName: string, part: Record<string, unknown>): PartDocument | null {
  const named = namedSchemas(part);
  const routes = contractSchemas(part);
  if (named.size === 0 && routes.size === 0) return null;
  // One object that holds them all: zod then puts every named schema it meets under `$defs`,
  // referenced by name, the ones nested inside others included. The route schemas themselves
  // are inline in that object, which is dropped; only what they name is kept.
  const all = z.object({ ...Object.fromEntries(routes), ...Object.fromEntries(named) });
  const whole = z.toJSONSchema(all, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
  });
  const defs = (whole.$defs ?? {}) as Record<string, unknown>;
  if (Object.keys(defs).length === 0) return null;
  const anonymous = Object.keys(defs).filter((key) => key.startsWith("__"));
  if (anonymous.length > 0) {
    throw new Error(
      `${partName}: a recursive schema has no name (${anonymous.join(", ")}); give it .meta({ id })`,
    );
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(defs).sort()) sorted[key] = defs[key];
  return { $schema: JSON_SCHEMA_DIALECT, title: `@miyoria/contracts/${partName}`, $defs: sorted };
}

/** The text of a part's file: two-space JSON and a final newline. */
export function formatDocument(document: PartDocument | RoutesDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** A part's route tables without their schemas, by export name (`schema/<part>.routes.json`). */
export type RoutesDocument = Record<string, unknown>;

function holdsRoutes(value: unknown): boolean {
  if (isContractProcedure(value)) return true;
  if (typeof value !== "object" || value === null || value instanceof z.ZodType) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).some(holdsRoutes);
}

/**
 * The route tables among a part's exports with every schema left out (oRPC's minified form:
 * method, path, input structure and metadata per route), for a client that calls the routes but
 * should not load zod and the schemas to do it: the panel. `null` when the part has no routes.
 */
export function emitRoutes(part: Record<string, unknown>): RoutesDocument | null {
  const out: RoutesDocument = {};
  for (const name of Object.keys(part).sort()) {
    const value = part[name];
    if (!isContractProcedure(value) && holdsRoutes(value))
      out[name] = minifyContractRouter(value as AnyContractRouter);
  }
  return Object.keys(out).length === 0 ? null : out;
}
