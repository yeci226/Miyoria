// The arbiter's recent decisions, kept from `arbiter.decision` since the `api` module started
// (the arbiter keeps a ledger of what she did, not of every verdict it gave). Newest last.

import {
  type ArbiterDecision,
  type BusEvent,
  Events,
  is,
  isJsonObject,
  type JsonValue,
} from "@miyoria/types";

/** Decisions kept. */
export const TRAIL_CAPACITY = 500;

export class DecisionTrail {
  readonly #items: ArbiterDecision[] = [];

  constructor(private readonly capacity = TRAIL_CAPACITY) {}

  /** Records the decision of an `arbiter.decision` envelope; other events are ignored. */
  handle(env: BusEvent): void {
    // Read only with an object payload, as before.
    if (!is(Events.ArbiterDecided, env) || !isJsonObject(env.data as JsonValue)) return;
    const decision = env.data;
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
