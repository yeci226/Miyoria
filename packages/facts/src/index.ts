// @miyoria/facts: the fact layer of V3 (docs/design/v3-architecture.md §5, §6, §8).
//
// * `EventLogService`: the append-only EventLog on the store's `events` area, with a hot window
//   in memory, and the `cause` walks.
// * `BusFacts`: turns V2 bus events into log lines (Observations, decisions, lines of hers).
// * `WorkingContextView`: what she knows right now, per-writer buckets.
// * `DeliveryLedgerView`: what really reached someone, ack-only.
// * `FactsModule` (`[modules.facts]`): runs them beside V2 and provides `EventLogKey`,
//   `WorkingContextKey`, `DeliveryLedgerKey` and `ActivityRecoveryKey`.
//
// The contracts are in `@miyoria/types` (log-event.ts): other packages depend on those, not on
// this one.

export { BusFacts, type BusFactsOptions } from "./bus.js";
export { defaultFactsConfig, type FactsConfig, FactsConfigSchema } from "./config.js";
export { observationBody, type WorkingContextOptions, WorkingContextView } from "./context.js";
export { type DeliveryLedgerOptions, DeliveryLedgerView } from "./delivery.js";
export {
  attentionOf,
  EventLogService,
  type EventLogServiceOptions,
  matchesFilter,
  turnOf,
} from "./log.js";
export { FactsModule, type FactsModuleOptions } from "./module.js";
export {
  BOOT_KEY,
  GAME_SESSION_SOURCE,
  LIFECYCLE_SOURCE,
  RESTORE_KEY_PREFIX,
  recoverGame,
  SHUTDOWN_KEY,
} from "./recovery.js";
export { type ReplayLine, toReplayLines } from "./replay.js";
export { type Revision, RevisionBook } from "./revisions.js";
