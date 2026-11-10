// Where something happened, as she reads it from where she is, and whether it may be shown there
// at all. The rule (stated in packages/types/src/recent-past.ts and tested in
// test/recent.test.ts):
//
// * her own state (no place) is shown everywhere;
// * this place is shown;
// * a DM is shown only while the other person in it is one she is talking with, and then as
//   private ("do not quote or reveal it here"). 2026-11-10: she asked someone the same thing four
//   times in a channel because nothing there knew their DM had answered it; knowing is fine,
//   telling the channel is not;
// * another place of the same guild is shown unless the owner hid it or `PlaceAccess` says
//   someone here cannot see it; another guild never is;
// * seen from a DM, a guild place is shown only for what the person she is talking with took
//   part in (they were there).

import {
  type AccountRef,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  type Handle,
  type PlaceAccess,
  type PlaceRef,
  safeName,
} from "@miyoria/types";
import { isPrivate } from "./scope.js";

export type Disclosure = "show" | "private" | "hide";

/** Who is reading, as the place rule needs it. */
export interface Viewer {
  context: ContextKey;
  /** Handles of the people she is talking with. */
  talkingWith: ReadonlySet<Handle>;
  accounts: readonly AccountRef[];
  hidden: ReadonlySet<string>;
  access: PlaceAccess | null;
  /** DM context → the other person in it. */
  partners: ReadonlyMap<string, Handle>;
}

/** The other person in a DM, when known. */
export function partnerOf(viewer: Pick<Viewer, "partners">, place: ContextKey): Handle | null {
  return viewer.partners.get(contextKeyString(place)) ?? null;
}

/**
 * Whether what happened in `place` may be shown to `viewer`. `involves`: the people who took
 * part in it (only a DM viewer reads it: a guild place is shown there for what they took part in).
 */
export function disclose(
  place: ContextKey | null,
  viewer: Viewer,
  involves: readonly Handle[] = [],
): Disclosure {
  if (place === null) return "show";
  if (contextKeyEquals(place, viewer.context)) return "show";
  if (isPrivate(place)) {
    const partner = partnerOf(viewer, place);
    return partner !== null && viewer.talkingWith.has(partner) ? "private" : "hide";
  }
  if (place.platform !== viewer.context.platform) return "hide";
  if (isPrivate(viewer.context)) {
    // Their DM partner was there for it, so telling them is telling them what they saw.
    return involves.some((h) => viewer.talkingWith.has(h)) && placeOpen(place, viewer)
      ? "show"
      : "hide";
  }
  if (place.scope !== viewer.context.scope) return "hide";
  return placeOpen(place, viewer) ? "show" : "hide";
}

/** Not hidden by the owner, and everyone here can see it when a platform can tell. */
function placeOpen(place: ContextKey, viewer: Viewer): boolean {
  if (viewer.hidden.has(place.channel)) return false;
  const access = viewer.access;
  if (access === null) return true;
  return viewer.accounts.every((account) => access.canSee(account, place) === true);
}

/** How `place` reads from `viewer`. */
export function placeRef(place: ContextKey | null, viewer: Viewer): PlaceRef {
  if (place === null) return { kind: "here", label: "", context: null };
  if (contextKeyEquals(place, viewer.context))
    return { kind: "here", label: "這裡", context: place };
  if (isPrivate(place)) {
    const partner = partnerOf(viewer, place);
    return {
      kind: "dm",
      label: partner === null ? "私訊" : `和 ${safeName(partner)} 的私訊`,
      context: place,
    };
  }
  if (place.kind === "voice") return { kind: "voice", label: "語音", context: place };
  return { kind: "text", label: "別的文字頻道", context: place };
}

/** The mark a private entry carries. */
export const PRIVATE_MARK = "私訊裡的事,只給你知道,不要在這裡引用或透露";
