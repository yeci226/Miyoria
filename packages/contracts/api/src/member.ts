// The member view: what a person logged in with Discord sees of what she has of them, and the cards
// she gives them. The session alone says whose it is: no route takes an id, and a body with a field
// it does not know is refused. The numbers behind her feelings never leave: only their bands, and
// the ring's lap and fill (in steps of a twentieth, so it shows roughly where they are and nobody
// can read their bond off it). These schemas have no field for a raw value: a response is
// validated against them and what they do not name is stripped.

import { z } from "zod";
import { IdempotencyHeaders, route } from "./route.js";
import { SpaceQuery } from "./shared.js";

/** `GET /api/member/session`: who is logged in, as far as they need to see it. */
export const MemberSessionSchema = z
  .object({ name: z.string(), avatar_url: z.string().nullable() })
  .meta({ id: "ApiMemberSession" });
export type MemberSession = z.output<typeof MemberSessionSchema>;

/** 她眼中的你, in words. All `null` for someone she does not know. */
export const MemberCardSchema = z
  .object({
    call_name: z.string().nullable(),
    relationship: z.string().nullable(),
    affinity: z.string().nullable(),
    trust: z.string().nullable(),
    familiarity: z.string().nullable(),
    /** Only the line written for them: her private feeling names other people. */
    public_feeling: z.string().nullable(),
  })
  .meta({ id: "ApiMemberCard" });
export type MemberCard = z.output<typeof MemberCardSchema>;

export const MemberMemorySchema = z
  .object({
    text: z.string(),
    kind: z.string(),
    /** `YYYY-MM-DD`. */
    date: z.string(),
  })
  .meta({ id: "ApiMemberMemory" });
export type MemberMemory = z.output<typeof MemberMemorySchema>;

/** One of their own song requests. */
export const MemberSongSchema = z
  .object({
    title: z.string(),
    artist: z.string().nullable(),
    state: z.string(),
    requested_at: z.string(),
  })
  .meta({ id: "ApiMemberSong" });
export type MemberSong = z.output<typeof MemberSongSchema>;

/** How much someone talked to her on one local day: their own lines, counted. */
export const MemberDaySchema = z
  .object({
    date: z.string(),
    /** Lines written in text channels, threads and DMs. */
    text: z.number(),
    /** Lines said in voice. */
    voice: z.number(),
  })
  .meta({ id: "ApiMemberDay" });
export type MemberDay = z.output<typeof MemberDaySchema>;

/** The ring as they see it: the lap being filled and how full it is, no number. */
export const MemberRingSchema = z
  .object({
    /** The lap being filled, 0..9. */
    lap: z.number(),
    /** How full that lap is, 0..1 in steps of 1/20. */
    fraction: z.number(),
    /** All ten laps are full. */
    full: z.boolean(),
  })
  .meta({ id: "ApiMemberRing" });
export type MemberRing = z.output<typeof MemberRingSchema>;

/** Where they are with her: the tier, how far to the next and the ring. */
export const MemberBondSchema = z
  .object({
    /** The tier's name (`RELATIONSHIP_LABELS`): what code keys on. */
    tier: z.string(),
    /** The tier's stage, 1 to 3 (I, II, III); `null` for 討厭, 很討厭 and 永恆羈絆. */
    stage: z.number().int().min(1).max(3).nullable().optional(),
    /** Name and stage as they read it: 「知心 II」. */
    tier_label: z.string().optional(),
    /** The tier after it; `null` at the top. */
    next_tier: z.string().nullable(),
    /** The next step as they read it: the next stage, or after III the next tier; `null`: none. */
    next_label: z.string().nullable().optional(),
    /** How far to the next tier, 0..1 in steps of 1/20. */
    tier_progress: z.number(),
    ring: MemberRingSchema,
  })
  .meta({ id: "ApiMemberBond" });
export type MemberBond = z.output<typeof MemberBondSchema>;

/** `GET /api/member/me`. */
export const MemberViewSchema = z
  .object({
    card: MemberCardSchema,
    /** `null` for someone she does not know (or will not say). */
    bond: MemberBondSchema.nullable(),
    memories: z.array(MemberMemorySchema),
    songs: z.array(MemberSongSchema),
    /** The last 30 local days, oldest first, today last. */
    activity: z.array(MemberDaySchema),
    can_request_song: z.boolean(),
    /** What forgetting takes and leaves, in the words `/me memory forget` uses. */
    forget: z.object({ removes: z.string(), keeps: z.string() }),
  })
  .meta({ id: "ApiMemberView" });
export type MemberView = z.output<typeof MemberViewSchema>;

/** Body of `POST /api/member/forget`: the confirmation, nothing else. */
export const ForgetRequestSchema = z
  .strictObject({ confirm: z.literal(true) })
  .meta({ id: "ApiForgetRequest" });
export type ForgetRequest = z.input<typeof ForgetRequestSchema>;

/** Answer of `POST /api/member/forget`. */
export const MemberForgetResultSchema = z
  .object({
    deleted: z.number(),
    about: z.number(),
    derived: z.number(),
    /** Memories whose evidence is gone, so nothing ties them to the person; they stay. */
    unverified: z.number(),
  })
  .meta({ id: "ApiMemberForgetResult" });
export type MemberForgetResult = z.output<typeof MemberForgetResultSchema>;

/** Body of `POST /api/member/songs`. */
export const SongRequestSchema = z
  .strictObject({
    query: z.string().trim().min(1).max(120),
    /** Use a song priority ticket (coins, a daily limit): ahead of the songs without one. */
    priority: z.boolean().optional(),
  })
  .meta({ id: "ApiMemberSongRequest" });
export type SongRequest = z.input<typeof SongRequestSchema>;

/** Answer of `POST /api/member/songs`. */
export const SongAcceptedSchema = z
  .object({
    accepted: z.boolean(),
    /**
     * Why it waits, in zh-TW, when she is in voice in another server: it is sung the next time
     * she is in voice in the server it was asked for. Absent or `null` otherwise.
     */
    waiting: z.string().nullable().optional(),
  })
  .meta({ id: "ApiMemberSongAccepted" });
export type SongAccepted = z.output<typeof SongAcceptedSchema>;

// ---- cards ----------------------------------------------------------------------------------

/** A field she added to a card herself: its name and what she wrote. */
export const CardFieldSchema = z
  .object({ label: z.string(), text: z.string() })
  .meta({ id: "ApiCardField" });
export type CardField = z.output<typeof CardFieldSchema>;

/** A part drawn onto a card (what is in her hand, an accessory, the outfit, the pose, the background). */
export const CardPartSchema = z
  .object({
    /** `<slot>.<name>`: what the dex and the wishlist name it by. */
    id: z.string(),
    slot: z.enum(["hand", "accessory", "outfit", "pose", "background"]),
    name: z.string(),
    rarity: z.enum(["N", "R", "SR", "SSR"]),
  })
  .meta({ id: "ApiCardPart" });
export type CardPart = z.output<typeof CardPartSchema>;

/**
 * A card she gave someone: what she thought of them then, kept so its code can be checked. A daily
 * card (since phase 5) also has a rarity, the parts drawn onto it and her expression; an older
 * member card has none of these and stays exactly as it was.
 */
export const IssuedCardSchema = z
  .object({
    /** `MYR-XXXX-XXXX-XXXX`, Crockford base32 (no I L O U), 60 random bits from crypto. */
    serial: z.string(),
    /** ISO 8601 UTC. */
    issued_at: z.string(),
    /** Their display name when it was issued. */
    name: z.string(),
    /** Their avatar URL when it was issued, or null. */
    avatar_url: z.string().nullable(),
    /** The nth card this person has been given, from 1. */
    number: z.number().int(),
    call_name: z.string().nullable(),
    relationship: z.string().nullable(),
    affinity: z.string().nullable(),
    trust: z.string().nullable(),
    familiarity: z.string().nullable(),
    public_feeling: z.string().nullable(),
    /** What she wrote for them as she issued it; null on older cards or when she could not. */
    line: z.string().nullable(),
    /** The stamp she put on it, or null. */
    stamp: z.string().nullable(),
    /** Fields she chose to add (at most three); empty on older cards. */
    fields: z.array(CardFieldSchema),
    /** Which picture of her is on it: a key of the server's card poses (on a daily card, the one
     * nearest her drawn expression). */
    pose: z.string(),
    /** The card frame they had chosen then, null for none. */
    frame: z.string().nullable(),
    /** Bought foil finish; false on older cards. */
    foil: z.boolean(),
    /** When a reroll replaced it, or null: a voided card is shown as void, never as valid. */
    voided_at: z.string().nullable(),
    /** A daily card's rarity; null on an older member card. */
    rarity: z.enum(["N", "R", "SR", "SSR"]).nullable(),
    /** The parts drawn onto it, in slot order (blanks left out); empty on an older card. */
    parts: z.array(CardPartSchema),
    /** Her expression on it, in words (chosen by the relationship); null on an older card. */
    expression: z.string().nullable(),
    /**
     * Why she gave it: `daily` (bought), `milestone` (the relationship reached a new tier),
     * `keepsake` (they were here before the cards), `drop` (caught in a channel); absent on an
     * older member card.
     */
    kind: z.enum(["daily", "milestone", "keepsake", "drop"]).optional(),
  })
  .meta({ id: "ApiIssuedCard" });
export type IssuedCard = z.output<typeof IssuedCardSchema>;

/**
 * What a card costs them now: the daily card itself (the first of the day too), and the foil
 * finish on top; a price is null when it is off sale or there is no wallet.
 */
export const CardPricesSchema = z
  .object({
    card: z.number().nullable(),
    foil: z.number().nullable(),
  })
  .meta({ id: "ApiCardPrices" });
export type CardPrices = z.output<typeof CardPricesSchema>;

/** `GET /api/member/card`. */
export const MemberCardsSchema = z
  .object({
    /** Their newest card that is not voided (a daily card, or else their last older card). */
    latest: IssuedCardSchema.nullable(),
    /** Daily cards issued to them in the current local day. */
    today: z.number(),
    /** Most daily cards a person may be issued per local day. */
    per_day: z.number(),
    prices: CardPricesSchema,
    /** Their coins now; null when their wallet cannot be used. */
    balance: z.number().nullable(),
    /** Cards in a row without SR or better, and how many until the next is guaranteed one. */
    pity: z.object({ since: z.number(), pity: z.number(), until: z.number() }).nullable(),
  })
  .meta({ id: "ApiMemberCards" });
export type MemberCards = z.output<typeof MemberCardsSchema>;

/** Body of `POST /api/member/card`: a foil finish on top, if they pay for it. */
export const IssueCardRequestSchema = z
  .strictObject({
    foil: z.boolean().optional(),
  })
  .meta({ id: "ApiIssueCardRequest" });
export type IssueCardRequest = z.input<typeof IssueCardRequestSchema>;

/** Body of `POST /api/member/live/pat`: empty, or where on her picture the pat landed (0..1). */
const PatUnit = z.number().finite().min(0).max(1);
export const PatRequestSchema = z
  .union([z.strictObject({}), z.strictObject({ x: PatUnit, y: PatUnit })])
  .meta({ id: "ApiPatRequest" });
export type PatRequest = z.input<typeof PatRequestSchema>;

/** Answer of a pat: what the live page counts. */
export const PatResultSchema = z
  .object({
    pats: z.object({
      /** Pats in the last minute, everyone together. */
      recent: z.number(),
      /** Members may pat her. */
      open: z.boolean(),
    }),
  })
  .meta({ id: "ApiPatResult" });
export type PatResult = z.output<typeof PatResultSchema>;

export const EmptyRequestSchema = z.strictObject({}).meta({ id: "ApiEmptyRequest" });

/**
 * Every route needs a session of any tier (by cookie only) and is limited per account; `429` with
 * `Retry-After` past the limit. A blocked person gets the answers of a stranger she has never met.
 * `GET /api/member/export` (a file) is not here: it is a plain download.
 */
export const member = {
  session: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/session" })
    .output(MemberSessionSchema),
  me: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/me" })
    .output(MemberViewSchema),
  /** `/me memory forget all`; the memory permission nodes are checked by the handler. */
  forget: route
    .meta({ audience: "member", permission: null })
    .route({ method: "POST", path: "/api/member/forget" })
    .input(z.object({ body: ForgetRequestSchema }))
    .output(MemberForgetResultSchema),
  /** A song request, as if said in chat: moderation, the gate and her own say apply. */
  requestSong: route
    .meta({ audience: "member", permission: null })
    .route({ method: "POST", path: "/api/member/songs" })
    // `?space=`: the server it is sung in (a member of several picks; default their own).
    .input(z.object({ query: SpaceQuery.optional(), body: SongRequestSchema }))
    .output(SongAcceptedSchema),
  cards: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/card" })
    .output(MemberCardsSchema),
  /**
   * A daily card of what the page shows them now: it costs coins (the first of the day too), at
   * most a few a day; foil costs more. Takes an idempotency key.
   */
  issueCard: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "POST", path: "/api/member/card" })
    .input(z.object({ headers: IdempotencyHeaders.optional(), body: IssueCardRequestSchema }))
    .output(IssuedCardSchema),
  /** A head-pat, as themselves only. `403` while pats are off, `429` for too many, `503` without the live module. */
  pat: route
    .meta({ audience: "member", permission: null })
    .route({ method: "POST", path: "/api/member/live/pat" })
    .input(z.object({ body: PatRequestSchema }))
    .output(PatResultSchema),
};
