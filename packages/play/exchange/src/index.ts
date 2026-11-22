// @miyoria/play/exchange: the deep-sea exchange (深海交易所, docs/design/exchange.md).
//
// - `engine/`: the pure engine (prices, rounds, orders, fees, the vault, the level, the limits,
//   leverage and liquidation), seeded and without a clock. The module and the simulation run it.
// - `sim/`: the offline simulation and its pass criteria.
// - `config.ts`: `[modules.exchange]`; `schema.ts`, `migrations.ts`, `store.ts`: the `exchange`
//   store plugin; `service.ts`: `ExchangeService`; `texts.ts`: what a member is told.
// - `pictures.ts`, `commands.ts`: the picture answers and `/me market`.
// - `words.ts`: her side (news worded, opening and closing lines, the weekly rating).
// - `module.ts`: module `exchange` and `ExchangeKey`.

export { PATHS, registerCommands, unregisterCommands } from "./commands.js";
export {
  type ExchangeConfig,
  ExchangeConfigSchema,
  engineParams,
  exchangeConfig,
  OTHER_SECTOR,
  rulesOf,
  STARTERS_TW,
  STARTERS_US,
  type StarterEntry,
  starterEntries,
  tierIndex,
} from "./config.js";
export * from "./engine/index.js";
export { HER_RULES, herNote } from "./her.js";
export { exchangeSchema } from "./migrations.js";
export { ExchangeKey, ExchangeModule, type ExchangeModuleOptions, TICK_MS } from "./module.js";
export * from "./pictures.js";
export * from "./real/candles.js";
export {
  type Asker,
  type CandleSet,
  type ChartMarks,
  DISCLAIMER,
  LEVERAGE_WARNING,
  type MintReport,
  type MintWindow,
  mintReportOf,
  NO_DIVIDENDS,
  NO_EXCHANGE_RULE,
  noticeText as realNoticeText,
  RealDesk,
  type RealHolding,
  type RealLine,
  type RealMarketView,
  type RealOrderLine,
  type RealOrderRequest,
  type RealPortfolio,
  type RealQuote,
  type RealReport,
} from "./real/desk.js";
export {
  DEFAULT_HOUSE,
  HOUSE_REASON,
  type HouseBook,
  type HouseParams,
  netOfLines,
  netOfPostings,
  QTY_REAL,
  type RealPosition,
} from "./real/house.js";
export * from "./real/instruments.js";
export * from "./real/lists.js";
export * from "./real/local.js";
export * from "./real/maps.js";
export * from "./real/provider.js";
export * from "./real/signals.js";
export * from "./real/sources.js";
export { RealStore } from "./real/store.js";
export * from "./real/yahoo.js";
export * from "./service.js";
export { STRATEGY_LABEL, type StrategyName } from "./sim/agents.js";
export { defaultAgents, runSim, type SimOptions, type SimResult } from "./sim/run.js";
export {
  type StrategyRow,
  type Summary,
  simulate,
  stressParams,
  summarize,
} from "./sim/summary.js";
export * from "./store.js";
export { CURRENCY, END_WHY, hourOf, noticeText, refundText } from "./texts.js";
