// Which Space a route is about (docs/design/v5-places.md §6): the `?space=` of `SpaceQuery`, checked
// against identity's `Places`, or the route's default. Every per-Space route goes through one of
// these two, so the answers to an unknown Space or a stranger are the same everywhere.
//
//     // a member route
//     const person = await memberPerson(state, c);
//     const space = memberSpace(state, person, input.query.space);   // 404 / 403
//     // an admin route
//     const space = adminSpace(state, input.query.space);           // 404; null: no Space at all

import { PeopleStoreKey } from "@miyoria/store";
import { type PersonId, type Places, PlacesKey, type SpaceRef } from "@miyoria/types";
import { ApiError } from "./errors.js";
import type { ApiContext, ApiState } from "./state.js";

/** The words of the refusals, the same on every route. */
export const UNKNOWN_SPACE = "找不到這個伺服器";
export const NOT_A_MEMBER = "你不在這個伺服器裡";
export const NO_SPACE = "她還沒有加入任何伺服器";

/** `Places`, or a 503 while Core has none (a store without identity). */
export function placesOf(state: ApiState): Places {
  return state.service(PlacesKey, "places");
}

/** A Space a member route works in, and whether the person is a member there. */
export interface MemberSpace extends SpaceRef {
  /**
   * `false` only for the default of someone who is a member nowhere (they get the primary, as
   * before there were several). A route that is for members only refuses them itself.
   */
  member: boolean;
}

/**
 * The Space a member route is about. With `requested`: that Space, `404` when she is not in it (or
 * it does not exist), `403` when `person` is not a member there. Without: the primary if they are
 * a member there, else their first Space; someone who is a member nowhere gets the primary with
 * `member: false`; `404` when she is in no Space at all.
 */
export function memberSpace(
  state: ApiState,
  person: PersonId | null,
  requested?: string | null,
): MemberSpace {
  const places = placesOf(state);
  if (requested != null && requested !== "") {
    const space = places.space(requested);
    if (space === null) throw ApiError.notFound(UNKNOWN_SPACE);
    if (person === null || !places.isMember(person, space.id)) {
      throw new ApiError(403, NOT_A_MEMBER);
    }
    return { ...space, member: true };
  }
  const mine = person === null ? [] : places.spacesOf(person);
  const own = mine.find((s) => s.primary) ?? mine[0];
  if (own !== undefined) return { ...own, member: true };
  const fallback = places.primary() ?? places.spaces()[0];
  if (fallback === undefined) throw ApiError.notFound(NO_SPACE);
  return { ...fallback, member: false };
}

/**
 * The Space an admin route is about. With `requested`: that Space, `404` when she is not in it.
 * Without: the primary, else the first Space she is in; `null` when she is in none.
 */
export function adminSpace(state: ApiState, requested?: string | null): SpaceRef | null {
  const places = placesOf(state);
  if (requested != null && requested !== "") {
    const space = places.space(requested);
    if (space === null) throw ApiError.notFound(UNKNOWN_SPACE);
    return space;
  }
  return places.primary() ?? places.spaces()[0] ?? null;
}

/** The logged-in member's person on a member route; `null` when she does not know them yet. */
export async function memberPerson(state: ApiState, c: ApiContext): Promise<PersonId | null> {
  const person = await state.optional(PeopleStoreKey)?.personByAccount(c.get("member").account);
  return (person?.id as PersonId | undefined) ?? null;
}
