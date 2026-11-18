// The relationship a card shows, from the heart's row (`PublicBond`): words only, and the tier that
// picks her expression. Someone she has no row for is a stranger.

import { type HeartPerson, publicBond } from "@miyoria/heart/person";
import { bondBand, familiarityBand, relationshipLabel, trustBand } from "@miyoria/types";
import type { CardRelationship } from "./store.js";

export function cardRelationship(
  person: Pick<
    HeartPerson,
    "bond" | "trust" | "familiarity" | "public_feeling" | "call_name"
  > | null,
): CardRelationship {
  if (person === null) {
    const tier = relationshipLabel({ affinity: 0, met: false });
    return {
      tier,
      tier_label: tier,
      closeness: bondBand(0),
      trust: trustBand(0),
      familiarity: familiarityBand(0),
      public_feeling: null,
    };
  }
  const b = publicBond(person);
  return {
    tier: b.tier,
    tier_label: b.tier_label,
    closeness: b.closeness,
    trust: b.trust,
    familiarity: b.familiarity,
    public_feeling: b.public_feeling,
  };
}
