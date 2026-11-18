// The event types the store knows today, with their default scope and their tier (v5-data §2.4,
// §2.5). The store owns the registry because the store is what stamps `tier` and resolves the
// default `scope` when it commits an event; Core hands the store its registry when it opens it
// (`EventStore` takes one), so later plugins add their definitions there.
//
// Payload schemas are permissive (`JsonValueSchema`) on purpose: the real ones per type are a
// later step (K12a in docs/design/v5-contracts.md).
//
// The `facts.*` types are what the V3 facts writer (`@miyoria/memory/facts`) records: one type per
// line kind, and three for observations, split by how long they are kept. They are not named
// after the bus topic a line came from: a line's `data` is the facts body (an `ObservationBody`,
// a decision trace), not the topic's payload, and the topic stays in `data.origin.topic`. Step 6 of
// v5-data §8 replaced the turn ones with the turn records below.
//
// The chat line types (`platform.message.created`, `voice.utterance`, `voice.playback`, defined
// with their payloads in `@miyoria/contracts/events`) are the raw record of conversation.
// `facts.observation.said` and `facts.utterance` stay beside them: they are her observations of
// those lines, a derived view, not the record.
//
// The turn records (`agent.decision`, `agent.turn.outcome`) and the audit entries (`audit.*`) are
// defined there too (§8 step 6). The facts writer records her decision and each turn's outcome
// under those types, not as `facts.decision` / `facts.result` lines: one record each.
//
// Each routed LLM call is one `llm.call` (§8 step 7), metadata and cost only, for the owner, kept
// 90 days; the facts writer records it from the bus.
//
// A change of configuration (§6, §8 step 8) is one event, for the owner, kept: a new config revision
// (`config.revised`) or a per-place setting written or removed (`settings.changed`), so the panel's
// "who changed what" comes from the log.
//
// The artifact store (§5, §8 step 10) records each stored artifact (`artifact.created`, in the
// artifact's own scope), each expiry, take-down and collection run, and each share token made,
// revoked and first used (`ARTIFACT_EVENTS`). A hand-over as an attachment (`artifact.shared`) is
// published on the bus by the gate and recorded by the facts writer.
//
// A live evaluation run (`eval.run`, `EVAL_EVENTS`) is published by the `eval` module after a
// nightly run and recorded by the facts writer too: for the owner, kept.
//
// Every row the economy plugin's coin ledger posts is one `economy.posted` (§3.3, decision D8),
// appended in the posting's transaction: for the owner, kept like the ledger.
//
// Every change of one of her numbers for a person is one `heart.changed`, appended in the
// transaction that writes the `heart_person` row: for the owner, kept. What happened between her
// and someone that the nightly reflection weighs is one `heart.evidence`, kept a year
// (`HEART_LOG_EVENTS`, docs/design/v5-heart.md §2.2).
//
// Every card she gives is one `cards.drawn`, appended with its `cards_card` row, and a series of the
// dex completed one `cards.titled` (`CARDS_EVENTS`): in the person's DM scope, kept a year.
//
// An auction lot that closed is one `market.lot_closed`, a lottery week drawn or refunded one
// `market.lottery_drawn` (`MARKET_EVENTS`): money records, for the owner, kept.
//
// A karaoke singing that Core scored is one `karaoke.scored` (`KARAOKE_EVENTS`), appended with its
// result: in the singer's DM scope, kept a year like the cards.
//
// A definition named `<prefix>.*` is a family: it gives its scope and tier to every type under
// `<prefix>.` that has no definition of its own (`audit.module.disable` takes `audit.*`'s).

import {
  ARTIFACT_EVENTS,
  AuditRecorded,
  CARDS_EVENTS,
  CHAT_EVENTS,
  defineEvent,
  EconomyPosted,
  type EconomyPostedData,
  EVAL_EVENTS,
  type EventDefaults,
  EventRegistry,
  HEART_LOG_EVENTS,
  HeartChanged,
  type HeartChangedData,
  HeartEvidence,
  type HeartEvidenceData,
  IdentityImported,
  KARAOKE_EVENTS,
  LlmCall,
  MARKET_EVENTS,
  TURN_EVENTS,
} from "@miyoria/contracts/events";
import { JsonValueSchema } from "@miyoria/contracts/wire";

export {
  EconomyPosted,
  type EconomyPostedData,
  HeartChanged,
  type HeartChangedData,
  HeartEvidence,
  type HeartEvidenceData,
};

/** Prefix of every type the facts writer records. */
export const FACTS_TYPE_PREFIX = "facts.";

/** Something she perceived that is not a person's words, and not ambient. 90 days. */
export const FactsObservation = defineEvent({
  type: "facts.observation",
  v: 1,
  data: JsonValueSchema,
  tier: "short",
});

/** What people said, in text or voice (the raw chat record, decision D2). 365 days. */
export const FactsObservationSaid = defineEvent({
  type: "facts.observation.said",
  v: 1,
  data: JsonValueSchema,
  tier: "long",
});

/** An ambient observation (presence, state ticks, game hazards). Folded after 14 days. */
export const FactsObservationAmbient = defineEvent({
  type: "facts.observation.ambient",
  v: 1,
  data: JsonValueSchema,
  tier: "ambient",
});

export const FactsThought = defineEvent({
  type: "facts.thought",
  v: 1,
  data: JsonValueSchema,
  tier: "short",
});

export const FactsDecision = defineEvent({
  type: "facts.decision",
  v: 1,
  data: JsonValueSchema,
  tier: "short",
});

/** A line of hers about to be said: the record of what she said, kept like chat. */
export const FactsUtterance = defineEvent({
  type: "facts.utterance",
  v: 1,
  data: JsonValueSchema,
  tier: "long",
});

/** A delivery ack of one of her lines. */
export const FactsDelivered = defineEvent({
  type: "facts.delivered",
  v: 1,
  data: JsonValueSchema,
  tier: "long",
});

export const FactsAction = defineEvent({
  type: "facts.action",
  v: 1,
  data: JsonValueSchema,
  tier: "short",
});

export const FactsResult = defineEvent({
  type: "facts.result",
  v: 1,
  data: JsonValueSchema,
  tier: "short",
});

export const FactsSteer = defineEvent({
  type: "facts.steer",
  v: 1,
  data: JsonValueSchema,
  tier: "short",
});

/** A change of the owner's rules: small, and the "why" of later behaviour. Kept. */
export const FactsDirective = defineEvent({
  type: "facts.directive",
  v: 1,
  data: JsonValueSchema,
  tier: "keep",
});

export const FactsProposal = defineEvent({
  type: "facts.proposal",
  v: 1,
  data: JsonValueSchema,
  tier: "short",
});

/**
 * `redact()` replaced an event's content. `data` is `{ target, reason }` (the target's id and a
 * short reason, never the text). For the owner only, and kept.
 */
export const PrivacyRedacted = defineEvent({
  type: "privacy.redacted",
  v: 1,
  data: JsonValueSchema,
  scope: "owner",
  tier: "keep",
});

/**
 * A new config revision. `data` is `{ version, created_by, note, changed }`, `changed` the dotted
 * paths (TOML-style, quoted where needed) that differ from the revision before.
 */
export const ConfigRevised = defineEvent({
  type: "config.revised",
  v: 1,
  data: JsonValueSchema,
  scope: "owner",
  tier: "keep",
});

/**
 * A per-place setting written or removed. `data` is `{ scope, scope_id, plugin, key, value, by }`,
 * `value` `null` when it was removed.
 */
export const SettingsChanged = defineEvent({
  type: "settings.changed",
  v: 1,
  data: JsonValueSchema,
  scope: "owner",
  tier: "keep",
});

/** Every `facts.*` definition. */
export const FACTS_EVENTS = [
  FactsObservation,
  FactsObservationSaid,
  FactsObservationAmbient,
  FactsThought,
  FactsDecision,
  FactsUtterance,
  FactsDelivered,
  FactsAction,
  FactsResult,
  FactsSteer,
  FactsDirective,
  FactsProposal,
] as const;

/** A new registry holding every type the store knows. Callers may register more. */
export function coreEventRegistry(): EventRegistry {
  return new EventRegistry().register(
    ...FACTS_EVENTS,
    ...CHAT_EVENTS,
    ...TURN_EVENTS,
    AuditRecorded,
    LlmCall,
    PrivacyRedacted,
    ConfigRevised,
    SettingsChanged,
    ...ARTIFACT_EVENTS,
    ...EVAL_EVENTS,
    IdentityImported,
    EconomyPosted,
    ...HEART_LOG_EVENTS,
    ...CARDS_EVENTS,
    ...MARKET_EVENTS,
    ...KARAOKE_EVENTS,
  );
}

/**
 * The scope and tier of `type`: its own definition's, else the nearest family's (`a.b.*`, then
 * `a.*`), else what the registry gives a type nobody registered.
 */
export function typeDefaults(registry: EventRegistry, type: string): EventDefaults {
  if (registry.get(type) !== null) return registry.defaults(type);
  const words = type.split(".");
  for (let n = words.length - 1; n > 0; n--) {
    const family = `${words.slice(0, n).join(".")}.*`;
    if (registry.get(family) !== null) return registry.defaults(family);
  }
  return registry.defaults(type);
}
