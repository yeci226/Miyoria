// The routes of her cards beyond issuing one (`card.ts`, `member.ts`): a member's own cards, one
// card with what only its owner sees, the dex (with the old collectibles as the closed series
// 舊收藏), whether each of their titles is shown to others, the pity, the wishlist, the whole
// catalogue, the public odds, and one person's cards for the owner
// (docs/design/v5-play.md §2, §6.3). Someone she has never met has none of these yet; their own
// cards stay theirs to see whatever she thinks of them now. Listing their cards or their dex is
// "opening their cards": someone who came over from the old records gets their keepsake then (P5).

import type {
  CardCatalogue,
  CardDex,
  CardOdds,
  CardPart,
  CardPity,
  CardTitle,
  CardWishlist,
  ListedCard,
  MyCard,
  PersonCards,
} from "@miyoria/contracts/api";
import { STRANGER } from "@miyoria/economy";
import {
  CARD_TEXTS,
  CardPortraitKey,
  type CardRecord,
  type CardService,
  CardsKey,
  isWishable,
  MAX_WISHES,
  type Part,
  SERIES,
  seriesOf,
} from "@miyoria/play/cards";
import { MemberCardStoreKey } from "@miyoria/store";
import { type PersonId, sameAccount } from "@miyoria/types";
import { cardsOf, dailyCard, normalizeSerial } from "./card.js";
import { keepsakeFor } from "./card-faces.js";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { accountsOf, loadMember, type MemberContext } from "./member.js";
import type { ApiContext, ApiState } from "./state.js";

const NO_CARDS = "這個 Core 還不能發卡";
const NO_SUCH_CARD = "這張卡不存在或已經作廢";
const NO_SUCH_TITLE = "你還沒有這個稱號";

function service(state: ApiState): CardService {
  const cards = state.optional(CardsKey);
  if (!cards) throw ApiError.unavailable(NO_CARDS);
  return cards;
}

const partOf = (p: Pick<Part, "id" | "slot" | "name" | "rarity">): CardPart => ({
  id: p.id,
  slot: p.slot,
  name: p.name,
  rarity: p.rarity,
});

function myCard(c: CardRecord): MyCard {
  return { card: dailyCard(c), pity_hit: c.pity_hit, wished: c.wished, price: c.price };
}

function dexOf(cards: CardService, person: PersonId | null): CardDex {
  const legacy = { name: "舊收藏", items: [] as CardDex["legacy"]["items"] };
  if (person === null) return { parts: [], series: [], titles: [], legacy };
  const dex = cards.dex(person);
  return {
    parts: dex.parts.map((p) => ({
      ...partOf({ id: p.part, slot: p.slot, name: p.name, rarity: p.rarity }),
      series: p.series,
      count: p.count,
      first_at: p.first_at,
    })),
    series: dex.series,
    titles: dex.titles.map((t) => ({
      series: t.series,
      title: t.title,
      public: t.public,
      earned_at: t.earned_at,
    })),
    legacy: { name: dex.legacy.series.name, items: dex.legacy.items },
  };
}

function pityOf(cards: CardService, person: PersonId | null): CardPity {
  return person === null
    ? { since: 0, pity: cards.config.pity, until: cards.config.pity }
    : cards.pity(person);
}

function wishlistOf(cards: CardService, person: PersonId | null): CardPart[] {
  if (person === null) return [];
  const byId = new Map(cards.catalogue().map((p) => [p.id, p]));
  return cards.wishlist(person).flatMap((id) => {
    const p = byId.get(id);
    return p ? [partOf(p)] : [];
  });
}

/** The public odds of a daily card, with its price and the day's cap. */
export function cardOdds(cards: CardService): CardOdds {
  const table = cards.odds();
  return { ...table, price: cards.config.price, per_day: cards.config.daily_cap };
}

/** The whole catalogue, every part as it is (blank, disabled and drop-only ones too), and the series. */
export function cardCatalogue(cards: CardService): CardCatalogue {
  return {
    parts: cards.catalogue().map((p) => ({
      ...partOf(p),
      series: p.series,
      series_name: p.series === null ? null : (seriesOf(p.series)?.name ?? null),
      drop_only: p.drop_only,
      blank: p.blank,
      enabled: p.enabled,
      wishable: isWishable(p),
    })),
    series: SERIES.map((s) => ({ id: s.id, name: s.name, title: s.title })),
  };
}

async function me(state: ApiState, c: Parameters<typeof loadMember>[1]): Promise<MemberContext> {
  return loadMember(state, c);
}

/** Who is looking at their cards; someone from before the cards finds their keepsake then. */
async function opening(state: ApiState, c: ApiContext): Promise<MemberContext> {
  const who = await me(state, c);
  const session = c.get("member");
  await keepsakeFor(state, who, session.name, session.avatar_url);
  return who;
}

/** One of their own cards: a daily card of theirs, or an older one on one of their accounts. */
async function oneOf(state: ApiState, who: MemberContext, input: string): Promise<MyCard> {
  const missing = () => new ApiError(404, NO_SUCH_CARD);
  const serial = normalizeSerial(input);
  if (serial === null) throw missing();
  const daily = state.optional(CardsKey)?.card(serial);
  if (daily) {
    if (daily.person !== who.person?.id) throw missing();
    return myCard(daily);
  }
  const older = await state.optional(MemberCardStoreKey)?.bySerial(state.profile(), serial);
  const mine = older && accountsOf(who).some((a) => sameAccount(a, older.account));
  if (!older || !mine) throw missing();
  const card = (await cardsOf(state, [older.account], null)).find((x) => x.serial === serial);
  if (!card) throw missing();
  return { card, pity_hit: false, wished: [], price: 0 };
}

/**
 * Their cards for their list, newest first, each with what one card's page shows its owner (what
 * it cost, the pity, the wished parts, which picture it has): daily cards (every kind), then
 * their older member cards. A daily card's picture is her rendered one whenever something renders
 * it (`cardArt`), the same for every daily card.
 */
async function listedCards(state: ApiState, who: MemberContext): Promise<ListedCard[]> {
  const cards = state.optional(CardsKey);
  const person = who.person?.id ?? null;
  const portrait: ListedCard["portrait"] = state.optional(CardPortraitKey) ? "live" : "fixed";
  const daily = cards && person ? cards.cards(person, { limit: 500 }) : [];
  // With no person, only the older cards of their accounts.
  const older = await cardsOf(state, accountsOf(who), null);
  return [
    ...daily.map(
      (c): ListedCard => ({
        ...dailyCard(c),
        price: c.price,
        pity_hit: c.pity_hit,
        wished: c.wished,
        portrait,
      }),
    ),
    ...older.map(
      (c): ListedCard => ({ ...c, price: 0, pity_hit: false, wished: [], portrait: "fixed" }),
    ),
  ];
}

/** The cards routes on the route table: the member's and the public odds (see `rpc.ts`). */
export const cardsRpc = {
  mine: os.cards.mine.handler(async ({ context }) => {
    const who = await opening(context.state, context.c);
    return { cards: await listedCards(context.state, who) };
  }),
  one: os.cards.one.handler(async ({ input, context }) =>
    oneOf(context.state, await me(context.state, context.c), input.params.serial),
  ),
  dex: os.cards.dex.handler(async ({ context }) => {
    const cards = service(context.state);
    const who = await opening(context.state, context.c);
    return dexOf(cards, who.person?.id ?? null);
  }),
  pity: os.cards.pity.handler(async ({ context }) => {
    const who = await me(context.state, context.c);
    return pityOf(service(context.state), who.person?.id ?? null);
  }),
  wishlist: os.cards.wishlist.handler(async ({ context }): Promise<CardWishlist> => {
    const who = await me(context.state, context.c);
    return {
      parts: wishlistOf(service(context.state), who.person?.id ?? null),
      max: MAX_WISHES,
    };
  }),
  setWishlist: os.cards.setWishlist.handler(async ({ input, context }): Promise<CardWishlist> => {
    const who = await me(context.state, context.c);
    const cards = service(context.state);
    const person = who.person?.id ?? null;
    // Someone she has never met has no cards to wish among yet, and is told so.
    if (person === null) throw new ApiError(403, STRANGER);
    const problem = cards.setWishlist(person, input.body.parts);
    if (problem !== null) throw ApiError.badRequest(CARD_TEXTS[problem]);
    return { parts: wishlistOf(cards, person), max: MAX_WISHES };
  }),
  odds: os.cards.odds.handler(({ context }) => cardOdds(service(context.state))),
  setTitle: os.cards.setTitle.handler(async ({ input, context }): Promise<CardTitle> => {
    const who = await me(context.state, context.c);
    const cards = service(context.state);
    const person = who.person?.id ?? null;
    // Someone she has never met has no titles, and is told so.
    if (person === null) throw new ApiError(403, STRANGER);
    const title = cards.setTitlePublic(person, input.params.series, input.body.public);
    if (title === null) throw new ApiError(404, NO_SUCH_TITLE);
    return {
      series: title.series,
      title: title.title,
      public: title.public,
      earned_at: title.earned_at,
    };
  }),
  catalogue: os.cards.catalogue.handler(async ({ context }) => {
    // A member route like the dex it serves: their session first, then the catalogue.
    await me(context.state, context.c);
    return cardCatalogue(service(context.state));
  }),
};

/** One person's cards for the owner (`GET /api/people/{id}/cards`). */
export const cardsAdminRpc = {
  person: os.cardsAdmin.person.handler(({ input, context }): PersonCards => {
    const cards = service(context.state);
    const person = input.params.id;
    return {
      cards: cards.cards(person, { limit: 200 }).map(myCard),
      dex: dexOf(cards, person),
      pity: pityOf(cards, person),
      wishlist: wishlistOf(cards, person),
    };
  }),
};
