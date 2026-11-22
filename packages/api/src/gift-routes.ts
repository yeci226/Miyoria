// Free-form gifts on the member page, the public page and the panel (docs/design/economy.md §16),
// over `FreeGiftsKey`:
//
// * Member (`gifts`): `GET /api/member/gifts`, `POST /api/member/gifts/quote` `{ name }` with an
//   `Idempotency-Key` (nothing charged), `POST /api/member/gifts/{id}/confirm` (the only charge,
//   once), `POST /api/member/gifts/{id}/cancel`, `GET /api/member/gifts/{id}/picture` (a kept gift
//   drawn by `PicturesKey`, as base64). The person is the session's; a refusal is its status and
//   sentence, the same as in Discord. A stranger (or a blocked person) gets 403 in the same words.
// * Public (`giftsPublic`): `GET /api/public/gifts`, built at most once per `cache_secs` like the
//   board: what she kept and her favourites. A name, a gift or a line the public screen does not
//   pass is left out (the giver as 匿名, the line as nothing, the gift not listed).
// * Admin (`giftsAdmin`): the newest gifts of everyone, a refund (audited with the operator), the
//   owner's pins and blocks.

import type {
  AdminGifts,
  GiftAskResult,
  GiftPicture,
  MyGifts,
  PublicGiftItem,
  PublicGifts,
} from "@miyoria/contracts/api";
import {
  EconomyError,
  FreeGiftsKey,
  type GiftAsk,
  type GiftDesk,
  type PublicGift,
} from "@miyoria/economy";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  CurrencyKey,
  DEFAULT_CURRENCY,
  PicturesKey,
  safeName,
} from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import type { SessionRecord } from "./session.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";
import { keyOf } from "./wallet.js";

const log = getLogger("api.gifts");

const UNAVAILABLE = "送禮現在打不開";
const HIDDEN_NAME = "匿名";
/** Gifts the public page lists. */
const PUBLIC_GIFTS = 20;
/** Longest wait for a picture. */
const PICTURE_MS = 8_000;

function desk(state: ApiState): GiftDesk {
  const gifts = state.optional(FreeGiftsKey);
  if (!gifts) throw ApiError.unavailable(UNAVAILABLE);
  return gifts;
}

function accountOf(c: ApiContext): AccountRef {
  return (c.get("member") as SessionRecord).account;
}

/** Runs `fn`; the economy's refusals become their status and words. */
async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof EconomyError) throw new ApiError(error.status, error.message);
    if (error instanceof ApiError) throw error;
    log.warn({ error: errorMessage(error) }, "a gift failed");
    throw ApiError.unavailable(UNAVAILABLE);
  }
}

function askResult(a: GiftAsk): GiftAskResult {
  switch (a.status) {
    case "quote":
      return { status: "quote", quote: { ...a.quote }, item: null, reason: null, message: null };
    case "fixed":
      return { status: "fixed", quote: null, item: a.item, reason: null, message: null };
    case "refused":
      return { status: "refused", quote: null, item: null, reason: a.reason, message: a.message };
  }
}

export const giftsRpc = {
  mine: os.gifts.mine.handler(async ({ context: { state, c } }): Promise<MyGifts> => {
    const gifts = desk(state);
    return {
      open: gifts.open,
      currency: gifts.currency,
      twd_per_coin: gifts.rate,
      big_gift_coins: gifts.bigGiftCoins,
      gifts: await gifts.mine(accountOf(c)),
    };
  }),
  quote: os.gifts.quote.handler(async ({ input, context: { state, c } }) => {
    const key = `web:${keyOf(input.headers["idempotency-key"])}`;
    const gifts = desk(state);
    return askResult(await refusing(() => gifts.ask(accountOf(c), input.body.name, key, "web")));
  }),
  confirm: os.gifts.confirm.handler(async ({ input, context: { state, c } }) => {
    const gifts = desk(state);
    const done = await refusing(() => gifts.confirm(accountOf(c), input.params.id));
    return { gift: done.gift, charged: done.charged, balance: done.balance };
  }),
  cancel: os.gifts.cancel.handler(async ({ input, context: { state, c } }) => {
    const gifts = desk(state);
    return refusing(() => gifts.cancel(accountOf(c), input.params.id));
  }),
  picture: os.gifts.picture.handler(
    async ({ input, context: { state, c } }): Promise<GiftPicture> => {
      const gifts = desk(state);
      const data = await gifts.picture(accountOf(c), input.params.id);
      if (data === null) throw ApiError.notFound("沒有這份收下的禮物");
      const alt = `${data.name}送她的「${data.item}」(${data.date})。她說:「${data.line}」`;
      const pictures = state.optional(PicturesKey);
      if (!pictures) return { alt, png: null };
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PICTURE_MS));
      const file = await Promise.race([pictures.render("gift", data), timeout]);
      return {
        alt: file?.alt ?? alt,
        png: file ? Buffer.from(file.data).toString("base64") : null,
      };
    },
  ),
};

// ---- the public collection ----------------------------------------------------------------

function shownGift(state: ApiState, g: PublicGift): PublicGiftItem | null {
  const side = state.publicSide;
  const item = safeName(g.item, 40);
  if (!side.passes(state, item)) return null;
  const line = g.line === null ? null : safeName(g.line, 80);
  const from = g.from === null ? null : safeName(g.from);
  return {
    id: g.id,
    item,
    kind: g.kind,
    kind_word: g.kind_word,
    line: line !== null && side.passes(state, line) ? line : null,
    favourite: g.favourite,
    at: g.at,
    from: from === null ? null : side.passes(state, from) ? from : HIDDEN_NAME,
  };
}

async function build(state: ApiState): Promise<PublicGifts> {
  const gifts = state.optional(FreeGiftsKey);
  if (!gifts) return { recent: [], favourites: [] };
  const all = await gifts.collection(PUBLIC_GIFTS);
  const keep = (list: readonly PublicGift[]) =>
    list.map((g) => shownGift(state, g)).filter((g): g is PublicGiftItem => g !== null);
  return { recent: keep(all.recent), favourites: keep(all.favourites) };
}

/** What the collection last answered, and when: built at most once per `cache_secs`. */
const held = new WeakMap<ApiState, { at: number; value: PublicGifts }>();

export const giftsPublicRpc = {
  collection: os.giftsPublic.collection.handler(async ({ context }) => {
    const { state, c } = context;
    const side = state.publicSide;
    const wait = side.admit(side.client(c));
    if (wait !== null) throw ApiError.tooMany(wait);
    context.resHeaders?.set(
      "cache-control",
      `public, max-age=${Math.ceil(side.config.cache_secs)}`,
    );
    context.resHeaders?.set("x-content-type-options", "nosniff");
    const now = state.now();
    const hit = held.get(state);
    if (hit && now - hit.at < side.config.cache_secs * 1000) return hit.value;
    let value: PublicGifts;
    try {
      value = await build(state);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot build the gift collection");
      value = { recent: [], favourites: [] };
    }
    held.set(state, { at: now, value });
    return value;
  }),
};

// ---- the owner's side ---------------------------------------------------------------------

export const giftsAdminRpc = {
  list: os.giftsAdmin.list.handler(async ({ context: { state } }): Promise<AdminGifts> => {
    const gifts = desk(state);
    return {
      currency: gifts.currency,
      twd_per_coin: gifts.rate,
      big_gift_coins: gifts.bigGiftCoins,
      gifts: gifts.adminList(100),
    };
  }),
  refund: os.giftsAdmin.refund.handler(async ({ input, context: { state, c } }) => {
    const gifts = desk(state);
    const done = await refusing(() => gifts.refund(input.params.id, actorOf(c)));
    if (!done) throw new ApiError(409, "這份禮物沒有可以退的錢");
    return { ok: true as const };
  }),
  prices: os.giftsAdmin.prices.handler(async ({ context: { state } }) => ({
    overrides: desk(state)
      .overrides()
      .map((o) => ({
        item_key: o.item_key,
        item: o.item,
        kind: o.kind,
        twd: o.twd,
        coins: o.coins,
        price: o.price,
        refuse: o.refuse,
        source: o.source,
        by: o.by,
        at: o.at,
      })),
  })),
  pin: os.giftsAdmin.pin.handler(async ({ input, context: { state, c } }) => {
    const gifts = desk(state);
    const { name, coins, twd, kind, block } = input.body;
    if (block !== true && (kind === undefined || (coins === undefined) === (twd === undefined))) {
      throw ApiError.badRequest(
        `要給種類和${state.optional(CurrencyKey) ?? DEFAULT_CURRENCY}價錢或台幣估價其中一個,或 block: true`,
      );
    }
    const choice =
      block === true
        ? null
        : { kind: kind as NonNullable<typeof kind>, coins: coins ?? null, twd: twd ?? null };
    return refusing(async () => gifts.pin(name, choice, actorOf(c)));
  }),
  unpin: os.giftsAdmin.unpin.handler(async ({ input, context: { state } }) => ({
    removed: desk(state).unpin(input.body.name),
  })),
};
