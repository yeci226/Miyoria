// A `heart_person` row as the readers outside the heart see it (`@miyoria/types`): `HeartView` for
// the prompt and her initiative, `HeartRecord` with every text field for the nightly reflection.

import type { HeartRecord, HeartView } from "@miyoria/types";
import { BLOCKED_TAG, type HeartPerson, hasTag, OWNER_TAG } from "./model.js";

/** A row as its readers see it. */
export function viewOf(p: HeartPerson): HeartView {
  return {
    person: p.person_id,
    bond: p.bond,
    trust: p.trust,
    familiarity: p.familiarity,
    warmth: p.warmth,
    respect: p.respect,
    ease: p.ease,
    grudge: p.grudge,
    longing: p.longing,
    rapport: p.rapport,
    stance: p.stance,
    impression: p.impression,
    call_name: p.call_name,
    tags: [...p.tags],
    owner: hasTag(p, OWNER_TAG),
    blocked: hasTag(p, BLOCKED_TAG),
    last_seen: p.last_seen,
    last_together: p.last_together,
  };
}

/** A row with every text field, its tier floor and anchors. */
export function recordOf(p: HeartPerson): HeartRecord {
  return {
    ...viewOf(p),
    unfinished: p.unfinished,
    jokes: p.jokes,
    dislikes: p.dislikes,
    public_feeling: p.public_feeling,
    tier_floor: p.tier_floor,
    anchors: p.anchors.map((a) => ({ ...a })),
    interactions: p.interactions,
    last_interaction: p.last_interaction,
  };
}
