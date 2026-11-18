// The market's picture messages (docs/design/v5-play.md §11.5): the auction and the lottery as the
// `auction` / `lottery` templates of `PicturesKey`, over the same views the cards are written from.
// A picture goes above a notice's text, with its one-line summary as the alt text; the text card
// stays as it is under it, and is all there is when the renderer is absent, slow or answers `null`.
// Drawing never decides anything: a bid or a purchase is done before its picture is asked for.

import { type CommandReply, pictureParts } from "@miyoria/commands";
import type {
  AuctionPictureData,
  LotteryPictureData,
  PictureDataMap,
  PictureFile,
  PictureKind,
  Pictures,
} from "@miyoria/types";
import type { MarketConfig } from "./config.js";
import type { AuctionView, LotteryView, LotView } from "./service.js";
import type { LotteryWeek } from "./store.js";

/** Longest wait for a picture before the notice goes out with its text alone. */
export const PICTURE_TIMEOUT_MS = 8_000;

/** How a lot reads on its picture (a lot only exists once it opened, so never `upcoming`). */
function auctionState(lot: LotView): AuctionPictureData["state"] {
  if (lot.state === "cancelled") return "cancelled";
  return lot.min_bid !== null ? "open" : "closed";
}

/** The auction's picture data for `lot`; `mine` is the viewer's own bid, `null` for everyone. */
export function auctionPictureData(
  lot: LotView,
  view: Pick<AuctionView, "currency" | "mine" | "history">,
  config: Pick<MarketConfig, "utc_offset_minutes">,
): AuctionPictureData {
  return {
    state: auctionState(lot),
    item: { name: lot.name, detail: lot.detail },
    currency: view.currency,
    start_bid: lot.opening_bid,
    step: lot.step,
    opens_at: lot.opens_at,
    ends_at: lot.ends_at,
    extended: lot.extended,
    utc_offset_minutes: config.utc_offset_minutes,
    top: lot.top,
    bids: lot.bids,
    bidders: lot.bidders,
    mine: view.mine === null ? null : { amount: view.mine.amount, leading: view.mine.leading },
    history: view.history.map((h) => ({ amount: h.amount, name: h.name, at: h.at })),
  };
}

/** The week being sold; `mine` is in `view` when it was asked for someone. */
export function lotteryPictureData(
  view: LotteryView,
  config: Pick<MarketConfig, "utc_offset_minutes">,
): LotteryPictureData {
  return {
    state: "open",
    currency: view.currency,
    ticket_price: view.price,
    per_person: view.per_person,
    min_players: view.min_buyers,
    prize_share: view.prize_share,
    tickets: view.tickets,
    players: view.buyers,
    pot: view.pot,
    draw_at: view.draw_at,
    utc_offset_minutes: config.utc_offset_minutes,
    mine: view.mine,
    winners: [],
  };
}

/** A week that was drawn or refunded, for the result notice. */
export function drawPictureData(
  w: LotteryWeek,
  config: Pick<
    MarketConfig,
    | "utc_offset_minutes"
    | "lottery_price"
    | "lottery_per_week"
    | "lottery_min_buyers"
    | "lottery_prize_share"
  >,
  currency: string,
): LotteryPictureData {
  const drawn = w.status === "drawn" && w.winner !== null;
  return {
    state: drawn ? "drawn" : "cancelled",
    currency,
    ticket_price: config.lottery_price,
    per_person: config.lottery_per_week,
    min_players: config.lottery_min_buyers,
    // What was paid out of what was sold, so the picture's prize is the one paid.
    prize_share: drawn && w.pot > 0 ? w.prize / w.pot : config.lottery_prize_share,
    tickets: w.tickets,
    players: w.buyers,
    pot: w.pot,
    draw_at: w.draw_at,
    utc_offset_minutes: config.utc_offset_minutes,
    mine: null,
    winners: drawn && w.winner !== null ? [{ name: w.winner.name, prize: w.prize }] : [],
  };
}

/**
 * Draws `kind`, or `null`: no renderer, a failure, or longer than `timeoutMs`. Never throws, so a
 * notice always goes out.
 */
export async function drawPicture<K extends PictureKind>(
  pictures: Pictures | null | undefined,
  kind: K,
  data: PictureDataMap[K],
  timeoutMs: number = PICTURE_TIMEOUT_MS,
): Promise<PictureFile | null> {
  if (!pictures) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    return await Promise.race([pictures.render(kind, data).catch(() => null), late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `reply` with `file` above its card (its summary as the alt text); `reply` alone without one. */
export function withPicture(reply: CommandReply, file: PictureFile | null): CommandReply {
  if (file === null || reply.card === undefined) return reply;
  const parts = pictureParts(file);
  return {
    ...reply,
    card: { ...reply.card, blocks: [...parts.blocks, ...reply.card.blocks] },
    files: [...(reply.files ?? []), ...parts.files],
  };
}
