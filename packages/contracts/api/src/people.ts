// The people she knows and how she feels about them, and an admin's hand on their coins. Every
// route here is an admin route. How she feels is the heart's row (`heart_person`, docs/design/
// v5-heart.md §2.2): the list, the person page, the edits, the owner's adjustments and anchors all
// go through it, in its words (`bond`, `impression`). One list serves every page.

import { z } from "zod";
import {
  HeartCauseSchema,
  HeartEvidenceKindSchema,
  HeartFieldSchema,
} from "../../events/src/heart-log.js";
import { AccountRefSchema, RELATIONSHIP_LABELS, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";

/** The permission node of an admin's hand on someone's coins. */
const NODE_ECONOMY_ADJUST = "admin.economy.adjust";

/** The one relationship scale (its names are the wire contract's one list). */
export const RelationshipLabelSchema = z
  .enum(RELATIONSHIP_LABELS)
  .meta({ id: "ApiRelationshipLabel" });
export type RelationshipLabel = z.output<typeof RelationshipLabelSchema>;

/** One platform account of a person. */
export const PersonAccountSchema = z
  .object({
    account: AccountRefSchema,
    /** Most recently seen display name. */
    display_name: z.string(),
    first_seen: TimestampSchema,
    last_seen: TimestampSchema,
  })
  .meta({ id: "ApiPersonAccount" });
export type PersonAccount = z.output<typeof PersonAccountSchema>;

/** A cross-platform person with their accounts. */
export const PersonSchema = z
  .object({
    id: z.string(),
    /** The display name of the account they were first seen with. */
    display_name: z.string(),
    created_at: TimestampSchema,
    /** In the order they were first seen. */
    accounts: z.array(PersonAccountSchema),
  })
  .meta({ id: "ApiPerson" });
export type Person = z.output<typeof PersonSchema>;

/** The bond ring (H1): the lap being filled, how full it is, the ten laps round it. */
export const BondRingSchema = z
  .object({
    /** The lap being filled, 0..9. */
    lap: z.number(),
    /** How full that lap is, 0..1. */
    fraction: z.number(),
    /** All ten laps are full. */
    full: z.boolean(),
    /** For a bond below 0, how far towards -100 (0..1); 0 otherwise. */
    below: z.number(),
  })
  .meta({ id: "ApiBondRing" });
export type BondRing = z.output<typeof BondRingSchema>;

/**
 * One person in the list, and the numbers every page of the panel draws: the bond and its ring, the
 * eight values, how much she cares, her words that fit a line and the last times. Someone she has
 * not met (`has_row` false) is every number at where a newcomer starts.
 */
export const PersonRowSchema = z
  .object({
    person: PersonSchema,
    /** She has a heart row for them (they have spoken with her). */
    has_row: z.boolean(),
    blocked: z.boolean(),
    owner: z.boolean(),
    /** The tier's name (`RELATIONSHIP_LABELS`); 陌生人 without a row. What code keys on. */
    tier: RelationshipLabelSchema,
    /** The tier's stage, 1 to 3 (I, II, III); `null` for 陌生人, 討厭, 很討厭 and 永恆羈絆. */
    stage: z.number().int().min(1).max(3).nullable().optional(),
    /** Name and stage as people read it: 「知心 II」. */
    tier_label: z.string().optional(),
    /** -100 to 1000. */
    bond: z.number(),
    ring: BondRingSchema,
    /** 0 to 100. */
    trust: z.number(),
    /** 0 to 100. */
    familiarity: z.number(),
    /** -1 to 1. */
    warmth: z.number(),
    /** -1 to 1. */
    respect: z.number(),
    /** 0 to 1. */
    ease: z.number(),
    /** 0 to 1. */
    grudge: z.number(),
    /** 0 to 1. */
    longing: z.number(),
    /** 0 to 1. */
    rapport: z.number(),
    /** 0 to 1: how much she cares (在意), from the tier, her warmth and her longing. */
    cares: z.number(),
    /** How she acts with them. */
    stance: z.string(),
    /** What she thinks of them. */
    impression: z.string(),
    /** The line shown to them on the member page; `null`: none yet. */
    public_feeling: z.string().nullable(),
    /** What she calls them; `null`: their name. */
    call_name: z.string().nullable(),
    /** `owner`, `friend`, `regular`, `troll`, `blocked`, ... */
    tags: z.array(z.string()),
    interactions: z.number(),
    last_interaction: TimestampSchema.nullable(),
    /** The last time she saw them say anything anywhere. */
    last_seen: TimestampSchema.nullable(),
    last_together: TimestampSchema.nullable(),
    updated_at: TimestampSchema.nullable(),
  })
  .meta({ id: "ApiPersonRow" });
export type PersonRow = z.output<typeof PersonRowSchema>;

/** `GET /api/people`: a page, `next_cursor` opaque and `null` on the last one. */
export const PersonPageSchema = z
  .object({ items: z.array(PersonRowSchema), next_cursor: z.string().nullable() })
  .meta({ id: "ApiPersonPage" });
export type PersonPage = z.output<typeof PersonPageSchema>;

/** The tier a rise is held under for want of an anchor (H4). */
export const HeldTierSchema = z
  .object({ tier: z.number(), label: RelationshipLabelSchema })
  .meta({ id: "ApiHeldTier" });
export type HeldTier = z.output<typeof HeldTierSchema>;

/** The shared memory a tier from 知心 up rests on (H4). */
export const PersonAnchorSchema = z
  .object({
    /** The lowest bond of the tier it anchors. */
    tier: z.number(),
    tier_name: z.string(),
    /** The note line she chose; `null`: none (a migrated tier). */
    note_ref: z.string().nullable(),
    /** The words of that memory; `""` for a migrated tier. */
    quote: z.string(),
    at: TimestampSchema,
    /** `reflect` (her nightly reflection), `admin` or `migrate`. */
    by: z.enum(["reflect", "admin", "migrate"]),
  })
  .meta({ id: "ApiPersonAnchor" });
export type PersonAnchor = z.output<typeof PersonAnchorSchema>;

/** One change of one number, as the history shows it. */
export const HeartHistoryEntrySchema = z
  .object({
    /** The event's id: the next page's `before`. */
    id: z.string(),
    at: TimestampSchema,
    field: HeartFieldSchema,
    /** What was applied (0 when the day's cap took it all). */
    delta: z.number(),
    /** The number once the change was written. */
    value_after: z.number(),
    /** What was asked for before the caps; `null` for time and the migration. */
    proposed: z.number().nullable(),
    cause: HeartCauseSchema,
    /** Her words or the words she quotes as the reason; `""` without one. */
    reason_quote: z.string(),
  })
  .meta({ id: "ApiHeartHistoryEntry" });
export type HeartHistoryEntry = z.output<typeof HeartHistoryEntrySchema>;

/** A page of the history, newest first; `next_before` is the `before` of the next page. */
export const HeartHistoryPageSchema = z
  .object({ items: z.array(HeartHistoryEntrySchema), next_before: z.string().nullable() })
  .meta({ id: "ApiHeartHistoryPage" });
export type HeartHistoryPage = z.output<typeof HeartHistoryPageSchema>;

/** How much of today's caps one number has used, in each direction. */
export const FieldLedgerSchema = z
  .object({
    field: HeartFieldSchema,
    used_up: z.number(),
    used_down: z.number(),
    /** The most it may rise today (at the current bond). */
    cap_up: z.number(),
    cap_down: z.number(),
    /** How many `feel` proposals she made today in each direction. */
    proposed_up: z.number(),
    proposed_down: z.number(),
  })
  .meta({ id: "ApiFieldLedger" });
export type FieldLedger = z.output<typeof FieldLedgerSchema>;

/** One piece of evidence about them. */
export const PersonEvidenceSchema = z
  .object({
    id: z.string(),
    at: TimestampSchema,
    kind: HeartEvidenceKindSchema,
    detail: z.string(),
    weight: z.number().nullable(),
  })
  .meta({ id: "ApiPersonEvidence" });
export type PersonEvidence = z.output<typeof PersonEvidenceSchema>;

/** `GET /api/people/{id}`: the row, her words, the tier and the anchors, the history and today. */
export const PersonProfileSchema = z
  .object({
    ...PersonRowSchema.shape,
    /** The tier after this one; `null` at the top. */
    next_tier: RelationshipLabelSchema.nullable(),
    /** The next step as people read it: the next stage, or after III the next tier. */
    next_label: z.string().nullable().optional(),
    /** 0..1 of the way to the next tier. */
    tier_progress: z.number(),
    /** The lowest bond of the highest tier ever entered: decay stops there. */
    tier_floor: z.number(),
    /** The tier the bond is held under for want of an anchor; `null`: none. */
    held: HeldTierSchema.nullable(),
    anchors: z.array(PersonAnchorSchema),
    /** Things not yet talked through. */
    unfinished: z.string(),
    /** Jokes they share. */
    jokes: z.string(),
    /** What she does not like about them. */
    dislikes: z.string(),
    /** The newest changes, newest first. */
    history: HeartHistoryPageSchema,
    /** Today's caps (her local day), one row per number that has caps. */
    ledger: z.array(FieldLedgerSchema),
    /** The newest evidence, newest first. */
    evidence: z.array(PersonEvidenceSchema),
    memory_count: z.number(),
  })
  .meta({ id: "ApiPersonProfile" });
export type PersonProfile = z.output<typeof PersonProfileSchema>;

/**
 * Body of `PATCH /api/people/{id}`; a field left out (or `null`, except `call_name` and
 * `public_feeling`, where `null` clears it) is unchanged.
 */
export const UpdatePersonRequestSchema = z
  .object({
    /** Replaces every tag except `blocked` (set that with `blocked`). */
    tags: z.array(z.string()).nullish(),
    impression: z.string().nullish(),
    stance: z.string().nullish(),
    unfinished: z.string().nullish(),
    jokes: z.string().nullish(),
    dislikes: z.string().nullish(),
    public_feeling: z.string().nullable().optional(),
    call_name: z.string().nullable().optional(),
    blocked: z.boolean().nullish(),
  })
  .meta({ id: "ApiUpdatePersonRequest" });
export type UpdatePersonRequest = z.input<typeof UpdatePersonRequestSchema>;

/**
 * Body of `POST /api/people/{id}/adjust`: set `field` to `value`, or add `delta` to it, ignoring
 * the daily caps and the anchors (cause `admin`). Exactly one of `value` and `delta`.
 */
export const AdjustPersonRequestSchema = z
  .object({
    field: HeartFieldSchema,
    value: z.number().optional(),
    delta: z.number().optional(),
  })
  .meta({ id: "ApiAdjustPersonRequest" });
export type AdjustPersonRequest = z.input<typeof AdjustPersonRequestSchema>;

/** Body of `PUT /api/people/{id}/anchors/{tier}`: the shared memory the tier rests on. */
export const SetAnchorRequestSchema = z
  .object({
    /** The words of the memory, 1 to 500 characters. */
    quote: z.string(),
    /** The note line it comes from; `null` or left out: none. */
    note_ref: z.string().nullish(),
  })
  .meta({ id: "ApiSetAnchorRequest" });
export type SetAnchorRequest = z.input<typeof SetAnchorRequestSchema>;

/** `GET /api/people/{id}/wallet`: their coins and the newest rows, newest first. */
export const PersonWalletViewSchema = z
  .object({
    balance: z.number(),
    ledger: z.array(z.object({ ts: TimestampSchema, delta: z.number(), label: z.string() })),
  })
  .meta({ id: "ApiPersonWalletView" });
export type PersonWalletView = z.output<typeof PersonWalletViewSchema>;

/**
 * Body of `POST /api/people/{id}/wallet/adjust`: `amount` is a non-zero integer (negative takes
 * coins) up to the economy's limit, `note` 1 to 100 characters, `key` one per confirmed submit (the
 * same key twice answers the first). The server checks each by hand and answers 400 in its own
 * words, so the schema names the fields and leaves their types to it.
 */
export const WalletAdjustRequestSchema = z
  .object({
    amount: z.unknown().optional(),
    note: z.unknown().optional(),
    key: z.unknown().optional(),
  })
  .meta({ id: "ApiWalletAdjustRequest" });
export type WalletAdjustRequest = z.input<typeof WalletAdjustRequestSchema>;

/** What an adjustment did. */
export const WalletAdjustResultSchema = z
  .object({
    balance: z.number(),
    entry_id: z.string(),
    /** The key was used before: nothing new was posted. */
    duplicate: z.boolean(),
  })
  .meta({ id: "ApiWalletAdjustResult" });
export type WalletAdjustResult = z.output<typeof WalletAdjustResultSchema>;

/** A person's id in the path (a ULID, in any case; anything else is a 404). */
const PersonParams = z.object({ id: z.string() });

/** A person's id and a tier's lowest bond in the path. */
const AnchorParams = z.object({ id: z.string(), tier: z.coerce.number<number | string>() });

/** The digits of a `limit` or an offset (`usize`). */
const Usize = z.coerce.number<number | string>().int().min(0);

export const people = {
  /** Everyone she knows, most recent interaction first. */
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/people" })
    .input(
      z.object({
        query: z.object({
          /** Matches a name, an account id, a call name or a person id. */
          q: z.string().optional(),
          /** Default 100, at most 500. */
          limit: Usize.optional(),
          /** A previous `next_cursor`. */
          cursor: z.string().optional(),
        }),
      }),
    )
    .output(PersonPageSchema),
  /** The row, her words, the anchors, the newest history, today's caps and the evidence. */
  get: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/people/{id}" })
    .input(
      z.object({
        params: PersonParams,
        query: z.object({
          /** Changes in the history page; default 50, at most 500. */
          limit: Usize.optional(),
        }),
      }),
    )
    .output(PersonProfileSchema),
  /** The history, newest first, a page after `before`. */
  history: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/people/{id}/history" })
    .input(
      z.object({
        params: PersonParams,
        query: z.object({
          /** The `next_before` of the previous page. */
          before: z.string().optional(),
          /** Default 50, at most 500. */
          limit: Usize.optional(),
        }),
      }),
    )
    .output(HeartHistoryPageSchema),
  update: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "PATCH", path: "/api/people/{id}" })
    .input(z.object({ params: PersonParams, body: UpdatePersonRequestSchema }))
    .output(PersonRowSchema),
  adjust: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/people/{id}/adjust" })
    .input(z.object({ params: PersonParams, body: AdjustPersonRequestSchema }))
    .output(PersonRowSchema),
  /** Sets the shared memory a tier rests on; answers every anchor. */
  setAnchor: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "PUT", path: "/api/people/{id}/anchors/{tier}" })
    .input(z.object({ params: AnchorParams, body: SetAnchorRequestSchema }))
    .output(z.array(PersonAnchorSchema)),
  /** Removes the anchor of a tier (the bond stays); answers every anchor left. */
  removeAnchor: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "DELETE", path: "/api/people/{id}/anchors/{tier}" })
    .input(z.object({ params: AnchorParams }))
    .output(z.array(PersonAnchorSchema)),
  wallet: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/people/{id}/wallet" })
    .input(z.object({ params: PersonParams }))
    .output(PersonWalletViewSchema),
  adjustWallet: route
    .meta({ audience: "admin", permission: NODE_ECONOMY_ADJUST })
    .route({ method: "POST", path: "/api/people/{id}/wallet/adjust" })
    .input(z.object({ params: PersonParams, body: WalletAdjustRequestSchema }))
    .output(WalletAdjustResultSchema),
};
