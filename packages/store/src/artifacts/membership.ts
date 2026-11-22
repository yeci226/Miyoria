// Whether a person belongs to a space, for the `space` audience of a share (v5-architecture §11.2:
// 「這個 Space 的成員」). Written against a space id only, so the rule does not care how a space is
// made: a space is identity's `spaces` row (one per guild) and a member is an account that wrote
// there (`space_members`, kept by `Identity.resolve`). Since phase 6 the rule is `Places.isMember`
// (`identity/places.ts`); this file keeps the names the share code calls.

import type { PersonId } from "@miyoria/types";
import type { Db } from "../db.js";
import { isMemberOf } from "../identity/places.js";

/** Who belongs to which space. */
export type SpaceMembership = (person: PersonId, space: string) => boolean;

/** Whether `person` is a member of `space` through one of their accounts, and has not left. */
export function isSpaceMember(db: Db, person: PersonId, space: string): boolean {
  return isMemberOf(db, person, space);
}

/** `isSpaceMember` over one database. */
export function spaceMembership(db: Db): SpaceMembership {
  return (person, space) => isSpaceMember(db, person, space);
}
