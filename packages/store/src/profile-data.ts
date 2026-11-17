// How raw column values become plain JSON (backups, inventories). The categories
// themselves and their SQL live in `data.ts`.

import type { JsonValue } from "@miyoria/types";
import { fromMicros, normalizeTimestamp } from "./common.js";

export type ExportColumn = "text" | "num" | "bool" | "ts" | "json";

/** A raw SQLite value of a column of kind `kind` as JSON. */
export function exportValue(kind: ExportColumn, raw: unknown): JsonValue {
  if (raw === null || raw === undefined) return null;
  switch (kind) {
    case "text":
      return String(raw);
    case "num":
      return Number(raw);
    case "bool":
      return typeof raw === "boolean" ? raw : Number(raw) !== 0;
    case "ts":
      if (typeof raw === "number" || typeof raw === "bigint") return fromMicros(Number(raw));
      if (raw instanceof Date) return raw.toISOString();
      return normalizeTimestamp(String(raw));
    case "json":
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw) as JsonValue;
        } catch {
          return raw;
        }
      }
      return JSON.parse(JSON.stringify(raw)) as JsonValue;
  }
}
