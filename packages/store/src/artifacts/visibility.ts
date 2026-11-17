// Who may see an artifact: the event scopes (docs/design/v5-data.md §2.4) read for a file.
//
// | scope    | visible to                                                                     |
// |----------|--------------------------------------------------------------------------------|
// | `public` | anyone                                                                         |
// | `space`  | a viewer in the artifact's space                                               |
// | `room`   | a viewer in its room; a thread and its parent room see each other's            |
// | `dm`     | the person it was made for, viewing privately (a DM, the web: in no space)     |
// | `self`   | her own prompts                                                                |
// | `owner`  | the owner only                                                                 |
//
// The owner (the panel) sees every scope. A DM-made artifact is not shown to its person in a group
// room: that would show the group what was made in private. Nobody but the owner sees an artifact
// that is deleted, past its expiry, blocked or taken down.

import type { EventScope } from "@miyoria/contracts/events";
import type { PersonId } from "@miyoria/types";
import type { ReviewState } from "./schema.js";

/** Who is looking, and from where. */
export interface ArtifactViewer {
  /** The person looking (signed in, or the author of the turn); `null`: nobody in particular. */
  person_id: PersonId | null;
  /** The space they look from; `null`: none (a DM, the web, home). */
  space_id: string | null;
  /** The room they look from; `null`: none. */
  room_id: string | null;
  /** When `room_id` is a thread, its parent room. */
  parent_room_id?: string | null;
  /** Her own prompts (`self`). */
  self?: boolean;
  /** The owner or the panel: sees everything. */
  owner?: boolean;
}

/** What the visibility rule reads of an artifact. */
export interface VisibleArtifact {
  scope: EventScope;
  made_for: PersonId | null;
  space_id: string | null;
  room_id: string | null;
  /** When `room_id` is a thread, its parent room. */
  room_parent_id?: string | null;
  review: ReviewState;
  expires_at: string | null;
  deleted_at: string | null;
}

/** Whether an artifact is still there to be seen at `nowMs`: not deleted, expired or withdrawn. */
export function isLive(artifact: VisibleArtifact, nowMs: number): boolean {
  if (artifact.deleted_at !== null) return false;
  if (artifact.review === "blocked" || artifact.review === "taken_down") return false;
  return artifact.expires_at === null || Date.parse(artifact.expires_at) > nowMs;
}

function sameRoom(artifact: VisibleArtifact, viewer: ArtifactViewer): boolean {
  const room = artifact.room_id;
  if (room === null) return false;
  if (viewer.room_id === room) return true;
  // A thread and its parent see each other's; two threads of one room do not.
  if (viewer.parent_room_id != null && viewer.parent_room_id === room) return true;
  return artifact.room_parent_id != null && artifact.room_parent_id === viewer.room_id;
}

/** Whether `viewer` may see `artifact` by its scope alone (see the file comment). */
export function scopeAllows(artifact: VisibleArtifact, viewer: ArtifactViewer): boolean {
  if (viewer.owner === true) return true;
  switch (artifact.scope) {
    case "public":
      return true;
    case "space":
      return artifact.space_id !== null && viewer.space_id === artifact.space_id;
    case "room":
      return sameRoom(artifact, viewer);
    case "dm":
      return (
        artifact.made_for !== null &&
        viewer.person_id === artifact.made_for &&
        viewer.space_id === null
      );
    case "self":
      return viewer.self === true;
    case "owner":
      return false;
  }
}

/** Whether `viewer` may see `artifact` at `nowMs`: it is live and its scope allows them. */
export function maySee(artifact: VisibleArtifact, viewer: ArtifactViewer, nowMs: number): boolean {
  if (viewer.owner === true) return true;
  return isLive(artifact, nowMs) && scopeAllows(artifact, viewer);
}
