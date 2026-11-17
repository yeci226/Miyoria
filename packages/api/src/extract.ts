// Request extraction with axum's rejection semantics: JSON bodies need a JSON content type
// (415), must parse (400) and must match the expected shape (422); query strings that do not
// match their shape are 400.

import { errorMessage } from "@miyoria/runtime/kernel";
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

/** The JSON value of a body: 415 without a JSON content type, 400 when it does not parse. */
function parseJsonBody(contentType: string | undefined, text: string): unknown {
  if (!isJsonContentType(contentType)) {
    throw new ApiError(415, "Expected request with `Content-Type: application/json`");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiError(400, `Failed to parse the request body as JSON: ${reason}`);
  }
}

/** Parses the JSON body with `schema`. */
export async function readJson<S extends z.ZodType>(
  c: ApiContext,
  schema: S,
): Promise<z.output<S>> {
  const raw = parseJsonBody(c.req.header("content-type"), await c.req.text());
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      `Failed to deserialize the JSON body into the target type: ${issueText(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * The request of a route on the route table that takes a JSON body, checked the way `readJson`
 * checks one (415, 400; the shape is the route's own schema, 422). It leaves the body unread, and
 * a `+json` type becomes `application/json`, the only one oRPC reads as JSON.
 */
export async function jsonRequest(request: Request): Promise<Request> {
  const contentType = request.headers.get("content-type") ?? undefined;
  const text = await request.clone().text();
  parseJsonBody(contentType, text);
  if (contentType?.toLowerCase().startsWith("application/json")) return request;
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request(request.url, { method: request.method, headers, body: text });
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

// ---- query field schemas (URL-encoded form semantics) -----------------------------------

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

/** A count of the query string, which the contract has checked to be digits (`undefined`: absent). */
export function countOf(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : Number.parseInt(raw, 10);
}

/** `limit` clamped to `1..max`, `fallback` when absent. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(limit ?? fallback, 1), max);
}
