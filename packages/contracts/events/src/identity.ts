// Identity records (docs/design/v5-data.md §4): who people are. Account links change by events
// too (§4.1), but the import is the first: `miyoria db import-links` (§4.3, §8 step 12) carries a
// person over from the V4 database with their id, accounts, handle, their own choices and the
// keepsake snapshot, and records one `identity.imported` per person it brings.
//
// For the owner only (`owner`), kept forever (`keep`). The envelope's `person_id` is the person.

import { z } from "zod";
import { TimestampSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** One account the import linked to the person. */
export const ImportedAccountSchema = z
  .object({ platform: z.string(), external_id: z.string() })
  .meta({ id: "EventsImportedAccount" });

/** A person's own choice the import carried over (decision D3). */
export const ImportedPrefSchema = z
  .enum(["privacy", "voice_consent"])
  .meta({ id: "EventsImportedPref" });

/** What the keepsake card is made from later (decision D4). */
export const LegacySnapshotSchema = z
  .object({
    /** The first time any of their accounts was seen. */
    first_seen: TimestampSchema,
    /** The name of the V4 bond tier they had at the archive, `null` without a relationship. */
    old_tier: z.string().nullable(),
    /** How many member cards she had given them. */
    cards: z.number().int().min(0),
  })
  .meta({ id: "EventsLegacySnapshot" });

/** An `identity.imported` payload. */
export const IdentityImportedSchema = z
  .object({
    /** Her name for them now. */
    handle: z.string(),
    /** Her name for them in V4, `null` when V4 had none; differs from `handle` after a clash. */
    old_handle: z.string().nullable(),
    /** The name the person was first known by. */
    name: z.string(),
    accounts: z.array(ImportedAccountSchema),
    prefs: z.array(ImportedPrefSchema),
    /**
     * `null` for a person the import made only to hold a choice: V4 kept the choice of an account
     * that was never a person (someone who only listened in voice), and dropping it could mean
     * talking to someone who said no.
     */
    legacy: LegacySnapshotSchema.nullable(),
    /** The file name (not the path) of the V4 database it came from. */
    from: z.string(),
  })
  .meta({ id: "EventsIdentityImported" });
export type IdentityImportedData = z.output<typeof IdentityImportedSchema>;

/** A person carried over from the V4 database. */
export const IdentityImported = defineEvent({
  type: "identity.imported",
  v: 1,
  data: IdentityImportedSchema,
  scope: "owner",
  tier: "keep",
});
