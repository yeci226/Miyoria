// @miyoria/memory/facts: the fact layer of V3 (docs/design/v3-architecture.md §5, §6, §8).
//
// * `EventLogService`: the append-only EventLog on the store's event log (`events`), with a hot
//   window in memory, and the `cause` walks; `envelope.ts` maps its lines to envelopes and back.
// * `BusFacts`: turns bus events into log lines (Observations, decisions, results, proposals);
//   her own lines are written by the main line's turns, not here.
// * `WorkingContextView`: what she knows right now, per-writer buckets.
// * `DeliveryLedgerView`: what really reached someone, ack-only.
// * `FactsModule` (`[modules.facts]`): runs them and provides `EventLogKey`,
//   `WorkingContextKey`, `DeliveryLedgerKey` and `ActivityRecoveryKey`.
//
// The contracts are in `@miyoria/types` (log-event.ts): other packages depend on those, not on
// this one.

export { BusFacts, type BusFactsOptions } from "./bus.js";
export { defaultFactsConfig, type FactsConfig, FactsConfigSchema } from "./config.js";
export { observationBody, type WorkingContextOptions, WorkingContextView } from "./context.js";
export { type DeliveryLedgerOptions, DeliveryLedgerView } from "./delivery.js";
export {
  authorOf,
  FACTS_TYPES,
  fromLogged,
  lineKind,
  lineType,
  toQuery,
  toWrite,
  typesOf,
} from "./envelope.js";
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
