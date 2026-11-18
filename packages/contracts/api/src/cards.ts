// Her cards beyond the one route that issues them (`member.issueCard`): a person's own cards, one
// card with what only its owner sees, the dex (the parts they collected, series and titles, and the
// old collectibles as the closed series 舊收藏), the pity counter, the wishlist, and the public odds
// table every card is drawn by (docs/design/v5-play.md §2, §6.3). The admin side reads one
// person's cards, dex, pity and wishlist. Nothing here ranks anybody against anybody.

import { z } from "zod";
import { CardPartSchema, IssuedCardSchema } from "./member.js";
import { route } from "./route.js";

const Rarity = z.enum(["N", "R", "SR", "SSR"]);
const Slot = z.enum(["hand", "accessory", "outfit", "pose", "background"]);

/** Cards in a row without SR or better, the pity's length and how many until it applies. */
export const CardPitySchema = z
  .object({
    since: z.number().int(),
    pity: z.number().int(),
    /** Cards still to go; 0: the next card is SR or better. */
    until: z.number().int(),
  })
  .meta({ id: "ApiCardPity" });
export type CardPity = z.output<typeof CardPitySchema>;

/**
 * One of their cards in their list, with what only its owner sees: what one card's page needs,
 * so the list asks for nothing more per card. An older member card cost nothing it knows of, had
 * no pity or wishes, and keeps its fixed portrait.
 */
export const ListedCardSchema = IssuedCardSchema.extend({
  /** Fish coins it cost. */
  price: z.number().int(),
  /** The pity decided its rarity. */
  pity_hit: z.boolean(),
  /** Wished parts it has (their ids). */
  wished: z.array(z.string()),
  /**
   * Its picture: `live`, her picture rendered from what the card drew (opaque, its background
   * drawn; the fixed portrait stands in while it cannot be rendered), or `fixed`, the cut-out
   * portrait of its `pose`.
   */
  portrait: z.enum(["live", "fixed"]),
}).meta({ id: "ApiListedCard" });
export type ListedCard = z.output<typeof ListedCardSchema>;

/** `GET /api/member/cards`: their cards, newest first, daily and older ones together. */
export const MyCardsSchema = z
  .object({ cards: z.array(ListedCardSchema) })
  .meta({ id: "ApiMyCards" });
export type MyCards = z.output<typeof MyCardsSchema>;

/** One of their cards, with what only its owner sees. */
export const MyCardSchema = z
  .object({
    card: IssuedCardSchema,
    /** The pity decided its rarity. */
    pity_hit: z.boolean(),
    /** Wished parts it has (their ids). */
    wished: z.array(z.string()),
    /** Fish coins it cost. */
    price: z.number().int(),
  })
  .meta({ id: "ApiMyCard" });
export type MyCard = z.output<typeof MyCardSchema>;

/** One part they have. */
export const DexPartSchema = CardPartSchema.extend({
  series: z.string().nullable(),
  /** How many of their cards had it. */
  count: z.number().int(),
  first_at: z.string(),
}).meta({ id: "ApiDexPart" });
export type DexPart = z.output<typeof DexPartSchema>;

export const DexSeriesSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    title: z.string(),
    owned: z.number().int(),
    total: z.number().int(),
    complete: z.boolean(),
  })
  .meta({ id: "ApiDexSeries" });
export type DexSeries = z.output<typeof DexSeriesSchema>;

export const CardTitleSchema = z
  .object({
    series: z.string(),
    title: z.string(),
    /** Shown to others; private by default. */
    public: z.boolean(),
    earned_at: z.string(),
  })
  .meta({ id: "ApiCardTitle" });
export type CardTitle = z.output<typeof CardTitleSchema>;

/** Body of `PUT /api/member/cards/titles/{series}`: shown to others, or theirs alone. */
export const SetCardTitleRequestSchema = z
  .strictObject({ public: z.boolean() })
  .meta({ id: "ApiSetCardTitleRequest" });
export type SetCardTitleRequest = z.input<typeof SetCardTitleRequestSchema>;

/** An old collectible, kept as it was (copies counted together). */
export const LegacyItemSchema = z
  .object({
    item: z.string(),
    name: z.string(),
    rarity: z.string(),
    /** The old series' name. */
    series: z.string().nullable(),
    count: z.number().int(),
    first_at: z.string(),
  })
  .meta({ id: "ApiLegacyItem" });
export type LegacyItem = z.output<typeof LegacyItemSchema>;

/** `GET /api/member/cards/dex`: theirs alone. */
export const CardDexSchema = z
  .object({
    parts: z.array(DexPartSchema),
    series: z.array(DexSeriesSchema),
    titles: z.array(CardTitleSchema),
    /** The closed series 舊收藏: what the old collection gave them; nothing can be added to it. */
    legacy: z.object({ name: z.string(), items: z.array(LegacyItemSchema) }),
  })
  .meta({ id: "ApiCardDex" });
export type CardDex = z.output<typeof CardDexSchema>;

/** `GET/PUT /api/member/cards/wishlist`: at most three parts; wishing changes no odds. */
export const CardWishlistSchema = z
  .object({ parts: z.array(CardPartSchema), max: z.number().int() })
  .meta({ id: "ApiCardWishlist" });
export type CardWishlist = z.output<typeof CardWishlistSchema>;

/** Body of `PUT /api/member/cards/wishlist`: the part ids, in order; empty clears it. */
export const SetWishlistRequestSchema = z
  .strictObject({ parts: z.array(z.string().max(64)).max(3) })
  .meta({ id: "ApiSetWishlistRequest" });
export type SetWishlistRequest = z.input<typeof SetWishlistRequestSchema>;

/** One part of the catalogue, as every card is drawn from it. */
export const CataloguePartSchema = CardPartSchema.extend({
  /** The series it counts toward, and that series' name; null: none. */
  series: z.string().nullable(),
  series_name: z.string().nullable(),
  /** Only a card dropped in a channel can give it. */
  drop_only: z.boolean(),
  /** "Nothing there" (an empty hand, no accessory): drawn and shown, never collected. */
  blank: z.boolean(),
  /** A disabled part is never drawn and does not count toward its series. */
  enabled: z.boolean(),
  /** It can be on a wishlist: collectable now (not blank, enabled); a drop-only part can. */
  wishable: z.boolean(),
}).meta({ id: "ApiCataloguePart" });
export type CataloguePart = z.output<typeof CataloguePartSchema>;

/** `GET /api/member/cards/catalogue`: every part, by slot then id, and every series. */
export const CardCatalogueSchema = z
  .object({
    parts: z.array(CataloguePartSchema),
    series: z.array(z.object({ id: z.string(), name: z.string(), title: z.string() })),
  })
  .meta({ id: "ApiCardCatalogue" });
export type CardCatalogue = z.output<typeof CardCatalogueSchema>;

const Chance = z.object({
  /** Exact, 0..100. */
  percent: z.number(),
  /** Two decimals; each list sums to 100.00. */
  shown: z.string(),
});

/** `GET /api/public/cards/odds`: what every daily card is drawn by, the same for everyone. */
export const CardOddsSchema = z
  .object({
    rarities: z.array(Chance.extend({ rarity: Rarity })),
    /** After `after` cards without SR or better, the next card's rarity; null: no pity. */
    pity: z
      .object({ after: z.number().int(), rarities: z.array(Chance.extend({ rarity: Rarity })) })
      .nullable(),
    slots: z.array(
      z.object({
        slot: Slot,
        name: z.string(),
        parts: z.array(
          Chance.extend({
            id: z.string(),
            name: z.string(),
            rarity: Rarity,
            series: z.string().nullable(),
            /** The series' name; null: none. */
            series_name: z.string().nullable(),
          }),
        ),
        /** The chance the slot comes out empty; null when it never does. */
        empty: Chance.nullable(),
      }),
    ),
    /** Fish coins per daily card, and how many a day. */
    price: z.number().int(),
    per_day: z.number().int(),
  })
  .meta({ id: "ApiCardOdds" });
export type CardOdds = z.output<typeof CardOddsSchema>;

/** `GET /api/people/{id}/cards`: one person's cards for the owner. */
export const PersonCardsSchema = z
  .object({
    cards: z.array(MyCardSchema),
    dex: CardDexSchema,
    pity: CardPitySchema,
    wishlist: z.array(CardPartSchema),
  })
  .meta({ id: "ApiPersonCards" });
export type PersonCards = z.output<typeof PersonCardsSchema>;

/**
 * The member routes need a session (by cookie) and are limited per account; the odds are open to
 * anyone; the person's cards are the panel's.
 */
export const cards = {
  mine: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/cards" })
    .output(MyCardsSchema),
  /** One of their own cards; `404` for a card that is not theirs. */
  one: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/card/{serial}" })
    .input(z.object({ params: z.object({ serial: z.string() }) }))
    .output(MyCardSchema),
  dex: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/cards/dex" })
    .output(CardDexSchema),
  pity: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/cards/pity" })
    .output(CardPitySchema),
  wishlist: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/cards/wishlist" })
    .output(CardWishlistSchema),
  /** `400` with a sentence for more than three, a repeat or an unknown part. */
  setWishlist: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "PUT", path: "/api/member/cards/wishlist" })
    .input(z.object({ body: SetWishlistRequestSchema }))
    .output(CardWishlistSchema),
  odds: route
    .meta({ audience: "public", permission: null })
    .route({ method: "GET", path: "/api/public/cards/odds" })
    .output(CardOddsSchema),
  /**
   * One of their titles shown to others (on the public check of their cards) or theirs alone;
   * `404` for a title they do not have.
   */
  setTitle: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "PUT", path: "/api/member/cards/titles/{series}" })
    .input(z.object({ params: z.object({ series: z.string() }), body: SetCardTitleRequestSchema }))
    .output(CardTitleSchema),
  /** The whole catalogue, owned or not: what the dex and the wishlist pick from. */
  catalogue: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/cards/catalogue" })
    .output(CardCatalogueSchema),
};

/** The owner's side: one person's cards, dex, pity and wishlist. */
export const cardsAdmin = {
  person: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/people/{id}/cards" })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(PersonCardsSchema),
};
