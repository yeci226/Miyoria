import type { JsonObject } from "@miyoria/contracts/wire";

/** Any value that survives `JSON.stringify` / `JSON.parse` unchanged (`@miyoria/contracts/wire`). */
export type { JsonObject, JsonPrimitive, JsonValue } from "@miyoria/contracts/wire";

/** True for plain JSON objects (not arrays, not `null`). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
