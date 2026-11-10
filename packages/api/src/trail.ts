// The arbiter's recent decisions, kept from `arbiter.decision` since the `api` module started
// (the arbiter keeps a ledger of what she did, not of every verdict it gave). Newest last.

import {
  ARBITER_DECISION_TOPIC,
  type ArbiterDecision,
  type Envelope,
  v2Payload,
} from "@miyoria/types";

/** Topic the trail follows. */
export const TRAIL_TOPIC = ARBITER_DECISION_TOPIC;
/** Decisions kept. */
export const TRAIL_CAPACITY = 500;

export class DecisionTrail {
  readonly #items: ArbiterDecision[] = [];

  constructor(private readonly capacity = TRAIL_CAPACITY) {}

  /** Records the decision of an `arbiter.decision` envelope; other events are ignored. */
  handle(env: Envelope): void {
    const decision = v2Payload(env.event, TRAIL_TOPIC);
    if (decision === null) return;
    // A merge or a retry publishes again for the same impulse: the newest verdict replaces.
    const at = this.#items.findIndex((d) => d.impulse === decision.impulse);
    if (at >= 0) this.#items.splice(at, 1);
    this.#items.push(decision);
    while (this.#items.length > this.capacity) this.#items.shift();
  }

  /** Newest first. */
  recent(): ArbiterDecision[] {
    return this.#items.toReversed();
  }
}
