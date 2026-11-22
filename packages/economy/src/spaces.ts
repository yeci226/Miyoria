// Which Space (server) the economy's per-Space things belong to (docs/design/v5-places.md §2): a
// prediction and its bets, a bounty, and the per-server form of the sponsor board. The wallet and
// everything else of a person stays global: one person, one wallet.
//
// * Opening: the Space of the context she is in; with none (a DM, her own timer), the primary
//   one, the default wherever no Space is given.
// * Showing: in a server, that server's; in a DM, the person's own servers'.
// * Taking part: only a member of the thing's Space (`Places.isMember`: they wrote there).
// * A thing of no Space (`null`: she knew of no Space when it was made) is everyone's.
//
// Without `Places` (no Core identity, the unit tests) nothing is filtered: one place, as before.

import type { ContextKey, PersonId, Places } from "@miyoria/types";

/** The Space a context is in (identity's id): its room's, else its server's; `null` for a DM. */
export function spaceAt(
  places: Places | undefined,
  ctx: ContextKey | null | undefined,
): string | null {
  if (!places || !ctx) return null;
  const at = places.at(ctx);
  if (at?.space_id) return at.space_id;
  if (ctx.scope === null) return null;
  return places.ofGuild(ctx.platform, ctx.scope)?.id ?? null;
}

/** Where something she opens in `ctx` belongs: that Space, else the primary; `null` with none. */
export function spaceToOpen(
  places: Places | undefined,
  ctx: ContextKey | null | undefined,
): string | null {
  if (!places) return null;
  return spaceAt(places, ctx) ?? places.primary()?.id ?? null;
}

/**
 * The Spaces a list shown in `ctx` covers: the server it is in, or in a DM the servers `person`
 * is a member of (someone who is a member nowhere: the primary, as before there were several).
 * `undefined`: no filter (no `Places`).
 */
export function spacesToShow(
  places: Places | undefined,
  ctx: ContextKey | null | undefined,
  person: PersonId | null,
): string[] | undefined {
  if (!places) return undefined;
  const here = spaceAt(places, ctx);
  if (here !== null) return [here];
  const mine = person === null ? [] : places.spacesOf(person).map((s) => s.id);
  if (mine.length > 0) return mine;
  const fallback = places.primary() ?? places.spaces()[0];
  return fallback ? [fallback.id] : [];
}

/** A Space's name for a sentence: `「名字」`, or `那個伺服器` when she does not know it. */
export function spaceName(places: Places | undefined, space: string): string {
  const name = places?.space(space)?.name;
  return name ? `「${name}」` : "那個伺服器";
}

/**
 * Whether `person` may take part in a thing of `space`: anyone for a thing of no Space or without
 * `Places`, else a member there.
 */
export function mayTakePart(
  places: Places | undefined,
  person: PersonId,
  space: string | null | undefined,
): boolean {
  if (!places || space == null) return true;
  return places.isMember(person, space);
}
