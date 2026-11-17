// Column types the store's Drizzle tables share.

import type { Timestamp } from "@miyoria/types";
import { customType } from "drizzle-orm/sqlite-core";
import { fromMicros, toMicros } from "./common.js";

/**
 * A time stored as INTEGER microseconds since the epoch (like every other table of the store),
 * read and written as a `Timestamp` (RFC 3339 text).
 */
export const micros = customType<{ data: Timestamp; driverData: number }>({
  dataType: () => "integer",
  toDriver: (value) => toMicros(value),
  fromDriver: (value) => fromMicros(Number(value)),
});
