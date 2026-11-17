// Audit entries (docs/design/v5-data.md §2.7, §8 step 6): who changed what, one event each. There
// is no bus topic for them, so the type is the design's `audit.<area>.<action>`, made from the
// entry's action: `module.disable` is `audit.module.disable`, and a command's path
// (`admin memory wipe`) is `audit.admin.memory.wipe`. The action itself stays in the payload as it
// was written, words and all.
//
// `AuditRecorded` is the definition of the whole family (`audit.*`): the store gives every type
// under `audit.` its scope and tier. For the owner only (`owner`), kept forever (`keep`).

import { z } from "zod";
import { JsonValueSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** What every `audit.*` type starts with. */
export const AUDIT_TYPE_PREFIX = "audit.";

/** An audit entry's payload. */
export const AuditEntrySchema = z
  .object({
    /** Who did it: `discord:<id>`, `api`, `cli`, ... */
    actor: z.string(),
    /** What was done, as the writer named it (`module.disable`, `admin memory wipe`). */
    action: z.string(),
    target: z.string(),
    detail: JsonValueSchema,
    ok: z.boolean(),
  })
  .meta({ id: "EventsAuditEntry" });
export type AuditEntryData = z.output<typeof AuditEntrySchema>;

/** Every `audit.<area>.<action>` type. */
export const AuditRecorded = defineEvent({
  type: `${AUDIT_TYPE_PREFIX}*`,
  v: 1,
  data: AuditEntrySchema,
  scope: "owner",
  tier: "keep",
});

/** The event type of an audit entry's action: its words joined by dots, under `audit.`. */
export function auditType(action: string): string {
  const name = action
    .trim()
    .split(/[\s.]+/)
    .filter((word) => word !== "")
    .join(".");
  return `${AUDIT_TYPE_PREFIX}${name === "" ? "unnamed" : name}`;
}
