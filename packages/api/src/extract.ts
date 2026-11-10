// Request extraction with axum's rejection semantics: JSON bodies need a JSON content type
// (415), must parse (400) and must match the expected shape (422); query strings that do not
// match their shape are 400.

import { errorMessage } from "@miyoria/kernel";
import type { ContextKey } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { ContextKeySchema } from "./schemas.js";
import type { ApiContext } from "./state.js";

function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid value";
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "application/json") return true;
  return mime.startsWith("application/") && mime.endsWith("+json");
}

/** Parses the JSON body with `schema`. */
export async function readJson<S extends z.ZodType>(
  c: ApiContext,
  schema: S,
): Promise<z.output<S>> {
  if (!isJsonContentType(c.req.header("content-type"))) {
    throw new ApiError(415, "Expected request with `Content-Type: application/json`");
  }
  const text = await c.req.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiError(400, `Failed to parse the request body as JSON: ${reason}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      `Failed to deserialize the JSON body into the target type: ${issueText(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** The query string as an object (the last value wins for repeated keys). */
export function queryObject(c: ApiContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URL(c.req.url).searchParams) out[key] = value;
  return out;
}

/** Parses the query string with `schema` (string fields; coerce in the schema). */
export function readQuery<S extends z.ZodType>(c: ApiContext, schema: S): z.output<S> {
  const parsed = schema.safeParse(queryObject(c));
  if (!parsed.success) {
    throw ApiError.badRequest(`Failed to deserialize query string: ${issueText(parsed.error)}`);
  }
  return parsed.data;
}

// ---- query field schemas (serde_urlencoded semantics) -----------------------------------

/** `usize`: digits only. */
export const usizeParam = z
  .string()
  .regex(/^\+?\d+$/, "invalid digit found in string")
  .transform((s) => Number.parseInt(s, 10));

/** `bool`: exactly `true` or `false`. */
export const boolParam = z
  .enum(["true", "false"], { error: "provided string was not `true` or `false`" })
  .transform((s) => s === "true");

/** `usize` in a JSON body. */
export const usizeJson = z.number().int().nonnegative();

/** A JSON-encoded `ContextKey` query value (`?context={"platform":...}`); empty or missing: `null`. */
export function contextParam(raw: string | undefined): ContextKey | null {
  const text = raw?.trim() ?? "";
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw ApiError.badRequest(`\`context\` must be a JSON context key: ${errorMessage(error)}`);
  }
  const key = ContextKeySchema.safeParse(parsed);
  if (!key.success) {
    throw ApiError.badRequest(
      `\`context\` must be a JSON context key: ${key.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return key.data;
}

/** `limit` clamped to `1..max`, `fallback` when absent. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(limit ?? fallback, 1), max);
}
