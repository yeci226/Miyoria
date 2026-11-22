// @miyoria/play/market: the weekly market (docs/design/v5-play.md §4.5, §11.4).
//
// - `config.ts`: `[modules.market]` (the song priority ticket, the auction, the lottery).
// - `time.ts`: her local days and weeks, when a lot opens and the lottery is drawn.
// - `lots.ts`: what the auction sells, the rotation, and her pick of the week's lot.
// - `schema.ts`, `migrations.ts`, `store.ts`: the `market` store plugin (`market_lots`,
//   `market_bids`, `market_lottery_draws`, `market_lottery_tickets`, `market_song_tickets`; the
//   legacy `market_lottery_weeks`), each Space's rows, and its events (`events.ts`);
//   `retireMarketSql` gives every hold and open ticket back when it is removed.
// - `markets.ts`: `Markets` (`MarketKey`): one market per Space, and the song priority ticket.
// - `service.ts`: `MarketService`: bids and holds, a won lot burned, the name lot, lottery tickets
//   and the draw, the song priority ticket (`SongPriorityKey`), the views and the owner's controls.
// - `notices.ts`, `commands.ts`: the neutral cards it posts and `/me auction`, `/me lottery`.
// - `pictures.ts`: their `auction` / `lottery` pictures (`PicturesKey`), best-effort above the text.
// - `notes.ts`: what she hears of a lot won and of a draw.
// - `module.ts`: module `market` and `MarketKey`; `card.ts`: its card on the panel.

export { marketCard } from "./card.js";
export { registerCommands, unregisterCommands } from "./commands.js";
export {
  LOT_KINDS,
  type LotKind,
  lotteryChannel,
  type MarketConfig,
  MarketConfigSchema,
  marketConfig,
} from "./config.js";
export { MARKET_SOURCE } from "./events.js";
export {
  LlmLotPicker,
  LOT_TITLE,
  type LotPick,
  type LotPicker,
  parsePick,
  rotationKind,
} from "./lots.js";
export {
  MarketRegistry,
  type MarketRegistryOptions,
  type Markets,
  type SharedMarketDeps,
} from "./markets.js";
export { marketSchema, retireMarketSql } from "./migrations.js";
export { MarketKey, MarketModule, type MarketModuleOptions, TICK_MS } from "./module.js";
export {
  auctionNotice,
  BUY_COUNTS,
  extensionRule,
  lotResultNotice,
  lotteryNotice,
  lotteryResultNotice,
  ROUTES,
} from "./notices.js";
export {
  auctionPictureData,
  drawPicture,
  drawPictureData,
  lotteryPictureData,
  PICTURE_TIMEOUT_MS,
  withPicture,
} from "./pictures.js";
export {
  type AuctionView,
  type BidResult,
  type BuyResult,
  type CallNames,
  type LotteryView,
  type LotView,
  MAX_BID,
  type MarketDeps,
  type MarketHistory,
  type MarketRefusal,
  MarketService,
  type MyBid,
  type MyTickets,
  type NameResult,
  STALE_MS,
} from "./service.js";
export {
  type Bid,
  type Lot,
  type LotteryWeek,
  MarketStore,
  marketTables,
  type Ticket,
} from "./store.js";
export { lastSlot, localDay, nextSlot, weekdayOf } from "./time.js";
