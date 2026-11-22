// Free-form gifts (docs/design/economy.md §16): a member names anything for her, the system prices
// it (a real-world estimate in NT$ at the economy's fixed rate), the member confirms, and she takes
// it or gives it back.
//
// * Member (`gifts` group, a session, limited per account): `GET /api/member/gifts` (what they
//   named and what she said), `POST /api/member/gifts/quote` `{ name }` with an `Idempotency-Key`
//   (a quote to confirm, nothing charged; a fixed food answers `fixed` and is fed by
//   `POST /api/member/feed` as before), `POST /api/member/gifts/{id}/confirm` (the only charge,
//   once), `POST /api/member/gifts/{id}/cancel`, `GET /api/member/gifts/{id}/picture` (a kept gift
//   as a PNG to show).
// * Public: `GET /api/public/gifts`: what she kept and her favourites; a giver's name only while
//   they stay on the public boards.
// * Admin (`giftsAdmin`): `GET /api/economy/gifts` (every status), `POST
//   /api/economy/gifts/{id}/refund`, `GET /api/economy/gifts/prices`, `PUT /api/economy/gifts/prices`
//   `{ name, kind, coins }`, `{ name, kind, twd }` or `{ name, block: true }`, `DELETE /api/economy/gifts/prices` `{ name }`;
//   the writes need `admin.economy.adjust`, like a hand on someone's coins.
//
// Without the economy these are a `503`. No shape carries a bond or relationship number.

import { z } from "zod";
import { IdempotencyHeaders, route } from "./route.js";

const NODE_GIFTS = "admin.economy.adjust";

export const GiftKindSchema = z
  .enum(["food", "drink", "small_object", "big_object", "experience"])
  .meta({ id: "ApiGiftKind" });

export const GiftStatusSchema = z
  .enum([
    "pending",
    "cancelled",
    "expired",
    "rejected",
    "confirmed",
    "accepted",
    "refused",
    "refunded",
    "refund_due",
  ])
  .meta({ id: "ApiGiftStatus" });

/** What a member is shown before anything is charged. */
export const GiftQuoteSchema = z
  .object({
    id: z.string(),
    item: z.string(),
    kind: GiftKindSchema,
    kind_word: z.string(),
    /** The real-world estimate in NT$ it came from; `null` for a coin pin or the fallback. */
    twd: z.number().int().nullable(),
    /** NT$ a coin, as it was used. */
    twd_per_coin: z.number(),
    /** The price in words: 隨手的小東西, 有點心意, 很貴重, 誇張. */
    band: z.string(),
    price: z.number().int(),
    currency: z.string(),
    balance: z.number().int(),
    balance_after: z.number().int(),
    expires_at: z.string(),
    /** A large gift: the confirmation says so, with the balance after. */
    big: z.boolean(),
    /** The fallback price: it could not be estimated now. */
    fallback: z.boolean(),
    note: z.string().nullable(),
  })
  .meta({ id: "ApiGiftQuote" });
export type GiftQuoteView = z.output<typeof GiftQuoteSchema>;

/** `POST /api/member/gifts/quote`: a quote, a fixed food to feed, or why it cannot be given. */
export const GiftAskResultSchema = z
  .object({
    status: z.enum(["quote", "fixed", "refused"]),
    quote: GiftQuoteSchema.nullable(),
    /** `rice`, `big_bowl`, `dessert` when the name is a fixed food. */
    item: z.enum(["rice", "big_bowl", "dessert"]).nullable(),
    reason: z.string().nullable(),
    message: z.string().nullable(),
  })
  .meta({ id: "ApiGiftAskResult" });
export type GiftAskResult = z.output<typeof GiftAskResultSchema>;

export const GiftQuoteRequestSchema = z
  .strictObject({ name: z.string().trim().min(1).max(80) })
  .meta({ id: "ApiGiftQuoteRequest" });
export type GiftQuoteRequest = z.input<typeof GiftQuoteRequestSchema>;

/** A gift as its giver sees it. */
export const GiftViewSchema = z
  .object({
    id: z.string(),
    item: z.string(),
    kind: GiftKindSchema.nullable(),
    kind_word: z.string().nullable(),
    /** The old scheme's tier, on gifts priced before the NT$ estimates. */
    tier: z.number().int().nullable(),
    price: z.number().int(),
    twd: z.number().int().nullable(),
    status: GiftStatusSchema,
    /** Her line; `null` when she said nothing or it was taken for her. */
    line: z.string().nullable(),
    favourite: z.boolean(),
    answered_by: z.enum(["her", "system", "admin"]).nullable(),
    created_at: z.string(),
    expires_at: z.string(),
    answer_due: z.string().nullable(),
    answered_at: z.string().nullable(),
  })
  .meta({ id: "ApiGiftView" });
export type GiftViewItem = z.output<typeof GiftViewSchema>;

/** `GET /api/member/gifts`. */
export const MyGiftsSchema = z
  .object({
    /** Members may name gifts now. */
    open: z.boolean(),
    currency: z.string(),
    /** NT$ a coin (the economy's one fixed rate). */
    twd_per_coin: z.number(),
    /** Above this many coins a gift is a large one. */
    big_gift_coins: z.number().int(),
    gifts: z.array(GiftViewSchema),
  })
  .meta({ id: "ApiMyGifts" });
export type MyGifts = z.output<typeof MyGiftsSchema>;

export const GiftConfirmResultSchema = z
  .object({
    gift: GiftViewSchema,
    /** This call charged it (false: an earlier one did). */
    charged: z.boolean(),
    balance: z.number().int(),
  })
  .meta({ id: "ApiGiftConfirmResult" });
export type GiftConfirmResult = z.output<typeof GiftConfirmResultSchema>;

/** `GET /api/member/gifts/{id}/picture`: the PNG as base64, with its one-line summary. */
export const GiftPictureSchema = z
  .object({ alt: z.string(), png: z.string().nullable() })
  .meta({ id: "ApiGiftPicture" });
export type GiftPicture = z.output<typeof GiftPictureSchema>;

/** One gift in her public collection. */
export const PublicGiftSchema = z
  .object({
    id: z.string(),
    item: z.string(),
    kind: GiftKindSchema.nullable(),
    kind_word: z.string().nullable(),
    line: z.string().nullable(),
    favourite: z.boolean(),
    at: z.string(),
    /** The giver's name; `null` when they left the boards or were forgotten. */
    from: z.string().nullable(),
  })
  .meta({ id: "ApiPublicGift" });
export type PublicGiftItem = z.output<typeof PublicGiftSchema>;

/** `GET /api/public/gifts`. */
export const PublicGiftsSchema = z
  .object({ recent: z.array(PublicGiftSchema), favourites: z.array(PublicGiftSchema) })
  .meta({ id: "ApiPublicGifts" });
export type PublicGifts = z.output<typeof PublicGiftsSchema>;

/** A gift on the owner's page. */
export const AdminGiftSchema = GiftViewSchema.extend({
  giver: z.string(),
  person: z.string().nullable(),
  priced_by: z.enum(["model", "cache", "pinned", "fallback", "rule"]),
  reason: z.string().nullable(),
  source: z.enum(["discord", "web"]),
  refunded_by: z.string().nullable(),
}).meta({ id: "ApiAdminGift" });
export type AdminGiftItem = z.output<typeof AdminGiftSchema>;

/** `GET /api/economy/gifts`. */
export const AdminGiftsSchema = z
  .object({
    currency: z.string(),
    twd_per_coin: z.number(),
    big_gift_coins: z.number().int(),
    gifts: z.array(AdminGiftSchema),
  })
  .meta({ id: "ApiAdminGifts" });
export type AdminGifts = z.output<typeof AdminGiftsSchema>;

/** A name's pin or block. */
export const GiftOverrideSchema = z
  .object({
    item_key: z.string(),
    item: z.string(),
    kind: GiftKindSchema.nullable(),
    /** The estimate or the owner's pin in NT$ (follows the rate). */
    twd: z.number().int().nullable(),
    /** The owner's pin in coins (does not follow the rate; the old tiers were kept this way). */
    coins: z.number().int().nullable(),
    /** What it costs now, in coins; `null` for a block or a refusal. */
    price: z.number().int().nullable(),
    refuse: z.string().nullable(),
    source: z.enum(["model", "pinned", "blocked"]),
    by: z.string().nullable(),
    at: z.string(),
  })
  .meta({ id: "ApiGiftOverride" });
export type GiftOverride = z.output<typeof GiftOverrideSchema>;

/** Body of `PUT /api/economy/gifts/prices`: a price in coins or NT$ and a kind, or a block. */
export const GiftPinRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    coins: z.number().int().min(1).optional(),
    twd: z.number().int().min(1).optional(),
    kind: GiftKindSchema.optional(),
    block: z.boolean().optional(),
  })
  .meta({ id: "ApiGiftPinRequest" });
export type GiftPinRequest = z.input<typeof GiftPinRequestSchema>;

export const GiftUnpinRequestSchema = z
  .strictObject({ name: z.string().trim().min(1).max(80) })
  .meta({ id: "ApiGiftUnpinRequest" });
export type GiftUnpinRequest = z.input<typeof GiftUnpinRequestSchema>;

const member = () => route.meta({ audience: "member", permission: null, limited: true });
const IdParams = z.object({ id: z.string().min(1).max(64) });

/** The member's side: needs a session (by cookie), limited per account. */
export const gifts = {
  mine: member().route({ method: "GET", path: "/api/member/gifts" }).output(MyGiftsSchema),
  /** Names a gift: a quote (nothing charged), a fixed food, or why not. Same key, same answer. */
  quote: member()
    .route({ method: "POST", path: "/api/member/gifts/quote" })
    .input(z.object({ headers: IdempotencyHeaders, body: GiftQuoteRequestSchema }))
    .output(GiftAskResultSchema),
  /** The only charge; a second call charges nothing (`409` expired or cancelled). */
  confirm: member()
    .route({ method: "POST", path: "/api/member/gifts/{id}/confirm" })
    .input(z.object({ params: IdParams }))
    .output(GiftConfirmResultSchema),
  cancel: member()
    .route({ method: "POST", path: "/api/member/gifts/{id}/cancel" })
    .input(z.object({ params: IdParams }))
    .output(GiftViewSchema),
  picture: member()
    .route({ method: "GET", path: "/api/member/gifts/{id}/picture" })
    .input(z.object({ params: IdParams }))
    .output(GiftPictureSchema),
};

export const giftsPublic = {
  collection: route
    .meta({ audience: "public", permission: null })
    .route({ method: "GET", path: "/api/public/gifts" })
    .output(PublicGiftsSchema),
};

/** The owner's side. */
export const giftsAdmin = {
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/economy/gifts" })
    .output(AdminGiftsSchema),
  /** Gives a charged gift back in full (audited); `409` when there is nothing to give back. */
  refund: route
    .meta({ audience: "admin", permission: NODE_GIFTS })
    .route({ method: "POST", path: "/api/economy/gifts/{id}/refund" })
    .input(z.object({ params: IdParams }))
    .output(z.object({ ok: z.literal(true) })),
  prices: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/economy/gifts/prices" })
    .output(z.object({ overrides: z.array(GiftOverrideSchema) })),
  pin: route
    .meta({ audience: "admin", permission: NODE_GIFTS })
    .route({ method: "PUT", path: "/api/economy/gifts/prices" })
    .input(z.object({ body: GiftPinRequestSchema }))
    .output(z.object({ item: z.string(), item_key: z.string() })),
  unpin: route
    .meta({ audience: "admin", permission: NODE_GIFTS })
    .route({ method: "DELETE", path: "/api/economy/gifts/prices" })
    .input(z.object({ body: GiftUnpinRequestSchema }))
    .output(z.object({ removed: z.boolean() })),
};
