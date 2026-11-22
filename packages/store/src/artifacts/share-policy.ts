// Who an artifact may be shared with (v5-architecture §11.2, owner 2026-11-22): never wider than
// where it was made.
//
// | made in            | its person | another person              | the space's members | anyone with the link |
// |--------------------|------------|-----------------------------|---------------------|----------------------|
// | a DM (`dm`)        | yes        | no                          | never               | only its person asks |
// | a room or space    | yes        | a member of that space only | that space only     | only its person asks |
// | anywhere, `public` | yes        | yes                         | yes                 | yes                  |
// | `self`, `owner`    | its person, unless `owner`; nobody else                                  |
//
// "Only its person asks" is `widen`: the caller says the person the artifact was made for asked for
// it themself (on the member page). Widening opens the link audience and nothing else: a DM-made
// artifact never becomes visible to a space, and it never goes to another person, whoever asks.
// Membership is asked through `SpaceMembership`, so the rule is written against a space id only.

import type { EventScope, ShareAudience } from "@miyoria/contracts/events";
import type { PersonId } from "@miyoria/types";
import type { SpaceMembership } from "./membership.js";

/** What the rule reads of an artifact. */
export interface ShareableArtifact {
  scope: EventScope;
  made_for: PersonId | null;
  space_id: string | null;
}

/** Who a share would be for. */
export interface ShareTarget {
  audience: ShareAudience;
  person_id?: PersonId | null;
  space_id?: string | null;
}

/** Why an audience is refused. */
export type AudienceRefusal =
  | "person_outside"
  | "space_outside"
  | "dm_to_space"
  | "link_not_public"
  | "not_shareable";

export type AudienceVerdict =
  | { ok: true }
  | { ok: false; reason: AudienceRefusal; message: string };

const refuse = (reason: AudienceRefusal, message: string): AudienceVerdict => ({
  ok: false,
  reason,
  message,
});

/** Whether `artifact` was made in a guild room or space (not a DM, not at home). */
function isLocal(artifact: ShareableArtifact): boolean {
  return (artifact.scope === "space" || artifact.scope === "room") && artifact.space_id !== null;
}

/**
 * Whether `artifact` may be shared with `target` (see the file comment). `widen`: its person asked
 * for a wider audience themself; only the link audience opens with it.
 */
export function audienceAllowed(
  artifact: ShareableArtifact,
  target: ShareTarget,
  isMember: SpaceMembership,
  widen = false,
): AudienceVerdict {
  if (artifact.scope === "public") return { ok: true };
  const local = isLocal(artifact);
  switch (target.audience) {
    case "person": {
      const person = target.person_id ?? null;
      if (person !== null && person === artifact.made_for && artifact.scope !== "owner") {
        return { ok: true };
      }
      if (person !== null && local && isMember(person, artifact.space_id as string)) {
        return { ok: true };
      }
      return refuse("person_outside", "that person is outside where the artifact was made");
    }
    case "space":
      if (artifact.scope === "dm") {
        return refuse("dm_to_space", "something made in a DM is never shared with a space");
      }
      if (local && target.space_id != null && artifact.space_id === target.space_id) {
        return { ok: true };
      }
      return refuse("space_outside", "that space is wider than where the artifact was made");
    case "link": {
      const widenable =
        artifact.made_for !== null &&
        (artifact.scope === "dm" || artifact.scope === "room" || artifact.scope === "space");
      if (widen && widenable) return { ok: true };
      if (!widenable && (artifact.scope === "self" || artifact.scope === "owner")) {
        return refuse("not_shareable", "this artifact is not shared by link");
      }
      return refuse(
        "link_not_public",
        "only a public artifact is shared by link, or its own person makes it public",
      );
    }
  }
}
