// What the economy moves in a relationship besides what someone said (`RelationshipEffectsKey`):
// a paid gift adds a hair of bond and trust. Since phase 4 step 4 it is a change of `heart_person` with cause `evidence`, under the same daily
// caps as her own proposals (docs/design/v5-heart.md §2.3 "禮物維持現有的一點點"): a gift of the
// same kind is worth `repeat_damping` less each time the same day, and stops at its own daily cap
// (`kind_cap`).
//
// The evidence itself (`heart.evidence`, which moves nothing) is recorded by the caller through
// `HeartKey.evidence`.

import type { PersonId, RelationshipEffects, RelationshipGain } from "@miyoria/types";
import { toTimestamp } from "@miyoria/types";
import { BLOCKED_TAG, hasTag } from "./model.js";
import { dayStart, type HeartChangeRequest, localDay } from "./rules.js";
import type { HeartStore } from "./store.js";

/** The reason each kind of gain records: also how today's earlier ones of its kind are found. */
export const GAIN_QUOTES: Readonly<Record<RelationshipGain["kind"], string>> = {
  treat: "送了禮物",
};

/** `RelationshipEffects` on `heart_person`. */
export class HeartEffects implements RelationshipEffects {
  readonly #people: HeartStore;

  constructor(people: HeartStore) {
    this.#people = people;
  }

  async gain(
    person: PersonId,
    gain: RelationshipGain,
    now: number,
  ): Promise<{ affinity: number; trust: number }> {
    const none = { affinity: 0, trust: 0 };
    const row = this.#people.get(person);
    if (row !== null && hasTag(row, BLOCKED_TAG)) return none;
    const quote = GAIN_QUOTES[gain.kind];
    const rules = this.#people.rules;
    const day = localDay(now, rules);
    const earlier = this.#people.log.changesBetween(
      person,
      toTimestamp(dayStart(day, rules)),
      toTimestamp(dayStart(day + 1, rules)),
    );
    const requests: HeartChangeRequest[] = [];
    const wanted: [field: "bond" | "trust", amount: number, cap: number | null][] = [
      ["bond", gain.affinity, gain.kind_cap?.affinity ?? null],
      ["trust", gain.trust, gain.kind_cap?.trust ?? null],
    ];
    for (const [field, amount, cap] of wanted) {
      if (!(amount > 0)) continue;
      const same = earlier.filter(
        (e) =>
          e.change.cause === "evidence" &&
          e.change.field === field &&
          e.change.reason_quote === quote,
      );
      const used = same.reduce((sum, e) => sum + Math.max(e.change.delta, 0), 0);
      let delta = amount * rules.repeat_damping ** same.length;
      if (cap !== null) delta = Math.min(delta, Math.max(cap - used, 0));
      if (delta <= 0) continue;
      requests.push({ type: "adjust", field, delta, cause: "evidence", quote });
    }
    if (requests.length === 0) return none;
    return totals(this.#people.applyAll(person, requests, { now }));
  }
}

function totals(applied: readonly { change: { field: string; delta: number } }[]) {
  let affinity = 0;
  let trust = 0;
  for (const { change } of applied) {
    if (change.field === "bond") affinity += change.delta;
    if (change.field === "trust") trust += change.delta;
  }
  return { affinity, trust };
}
