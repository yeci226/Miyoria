// The files she makes (docs/design/v5-data.md §5, v5-architecture §11.2): the artifact store's
// lifecycle events, and the vocabulary its rows share with them.
//
// - `artifact.created`: one per stored artifact, in the transaction that writes its row. Its scope
//   is the artifact's own (the place it was made caps who may see it), so no default here.
// - `artifact.expired`: an artifact passed its expiry and was marked deleted; its shares went too.
// - `artifact.taken_down`: the owner took one down.
// - `artifact.deleted`: its own person deleted it on the member page; its shares went too.
// - `artifact.swept`: one per collection run that removed anything, with the counts (the daily
//   count of what the sweep unlinked, instead of one event per file).
// - `share.created`, `share.revoked`: a share token made or withdrawn (who asked is the envelope's
//   person and turn); `share.opened`: the first use of a token only, so every download does not
//   become an event.
// - `artifact.shared`: she handed an artifact to someone as an attachment of a message (the
//   `share` capability): who asked, in which turn, which artifact, where. Published on the bus by
//   the gate after the platform took the upload; the facts writer records it. No token is made.
//
// Artifact events are kept forever (`keep`), share events 365 days (`long`), as §2.5 says. All but
// `artifact.created` are for the owner.

import { z } from "zod";
import { AccountRefSchema, ContextKeySchema, TimestampSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** What kind of content an artifact is, from its sniffed media type. */
export const ArtifactKindSchema = z
  .enum(["image", "audio", "video", "document", "text"])
  .meta({ id: "EventsArtifactKind" });
export type ArtifactKind = z.output<typeof ArtifactKindSchema>;

/** What made it. `sing` is a song cover: never downloadable, only streamed. */
export const ArtifactSourceSchema = z
  .enum(["imagegen", "sandbox", "cards", "sing", "clip", "doc", "render"])
  .meta({ id: "EventsArtifactSource" });
export type ArtifactSource = z.output<typeof ArtifactSourceSchema>;

/** Why an artifact does not expire: put in an album, kept by a person, the owner or the cards. */
export const ArtifactKeptBySchema = z
  .enum(["album", "person", "owner", "cards"])
  .meta({ id: "EventsArtifactKeptBy" });
export type ArtifactKeptBy = z.output<typeof ArtifactKeptBySchema>;

/** Who a share token is for: one person (signed in), a space's members, anyone with the link. */
export const ShareAudienceSchema = z
  .enum(["person", "space", "link"])
  .meta({ id: "EventsShareAudience" });
export type ShareAudience = z.output<typeof ShareAudienceSchema>;

/** What a share token allows: playing or viewing in place, or also saving the file. */
export const ShareModeSchema = z.enum(["stream", "download"]).meta({ id: "EventsShareMode" });
export type ShareMode = z.output<typeof ShareModeSchema>;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** An `artifact.created` payload. */
export const ArtifactCreatedSchema = z
  .object({
    artifact_id: z.string(),
    sha256: Sha256Schema,
    size: z.number().int().min(1),
    /** Sniffed from the content. */
    mime: z.string(),
    kind: ArtifactKindSchema,
    /** As cleaned by the store. */
    filename: z.string(),
    source: ArtifactSourceSchema,
    /** The plugin that stored it. */
    plugin: z.string(),
    made_for: z.string().nullable(),
    derived_from: z.string().nullable(),
    /** `null` when it is kept. */
    expires_at: TimestampSchema.nullable(),
    kept_by: ArtifactKeptBySchema.nullable(),
    downloadable: z.boolean(),
  })
  .meta({ id: "EventsArtifactCreated" });
export type ArtifactCreatedData = z.output<typeof ArtifactCreatedSchema>;

/** An `artifact.expired` payload. */
export const ArtifactExpiredSchema = z
  .object({
    artifact_id: z.string(),
    sha256: Sha256Schema,
    expires_at: TimestampSchema,
    /** Its shares that were still live and were revoked with it. */
    shares_revoked: z.number().int().min(0),
  })
  .meta({ id: "EventsArtifactExpired" });
export type ArtifactExpiredData = z.output<typeof ArtifactExpiredSchema>;

/** An `artifact.taken_down` payload. */
export const ArtifactTakenDownSchema = z
  .object({
    artifact_id: z.string(),
    /** Who took it down (`owner`, `panel:<person>`, ...). */
    by: z.string(),
    reason: z.string(),
    shares_revoked: z.number().int().min(0),
  })
  .meta({ id: "EventsArtifactTakenDown" });
export type ArtifactTakenDownData = z.output<typeof ArtifactTakenDownSchema>;

/** An `artifact.deleted` payload: its own person deleted it (the member page). */
export const ArtifactDeletedSchema = z
  .object({
    artifact_id: z.string(),
    /** Who deleted it (`person:<id>`). */
    by: z.string(),
    shares_revoked: z.number().int().min(0),
  })
  .meta({ id: "EventsArtifactDeleted" });
export type ArtifactDeletedData = z.output<typeof ArtifactDeletedSchema>;

/** An `artifact.swept` payload: what one collection run removed. */
export const ArtifactSweptSchema = z
  .object({
    /** Deleted artifact rows past their grace, removed for good. */
    rows_removed: z.number().int().min(0),
    /** Blobs no live artifact used any more: row and file. */
    blobs_removed: z.number().int().min(0),
    bytes_freed: z.number().int().min(0),
    /** Blob files with no row (an ingest that never committed, a crash, a wipe). */
    orphan_files_removed: z.number().int().min(0),
    /** Temporary files of ingests that never finished. */
    temp_files_removed: z.number().int().min(0),
    /** Blob rows whose file is gone: their artifacts cannot be read. */
    missing_blobs: z.number().int().min(0),
  })
  .meta({ id: "EventsArtifactSwept" });
export type ArtifactSweptData = z.output<typeof ArtifactSweptSchema>;

/** A `share.created` payload. */
export const ShareCreatedSchema = z
  .object({
    share_id: z.string(),
    artifact_id: z.string(),
    audience: ShareAudienceSchema,
    person_id: z.string().nullable(),
    space_id: z.string().nullable(),
    mode: ShareModeSchema,
    expires_at: TimestampSchema.nullable(),
    max_uses: z.number().int().min(1).nullable(),
  })
  .meta({ id: "EventsShareCreated" });
export type ShareCreatedData = z.output<typeof ShareCreatedSchema>;

/** A `share.revoked` payload. */
export const ShareRevokedSchema = z
  .object({ share_id: z.string(), artifact_id: z.string(), reason: z.string() })
  .meta({ id: "EventsShareRevoked" });
export type ShareRevokedData = z.output<typeof ShareRevokedSchema>;

/** A `share.opened` payload: the first use of a token. */
export const ShareOpenedSchema = z
  .object({ share_id: z.string(), artifact_id: z.string() })
  .meta({ id: "EventsShareOpened" });
export type ShareOpenedData = z.output<typeof ShareOpenedSchema>;

/** An `artifact.shared` payload: one hand-over of an artifact as an attachment. */
export const ArtifactSharedSchema = z
  .object({
    artifact_id: z.string(),
    sha256: Sha256Schema,
    size: z.number().int().min(1),
    mime: z.string(),
    /** The name it was uploaded under (as cleaned by the store). */
    filename: z.string(),
    source: ArtifactSourceSchema,
    /** The account that asked for it, and received it. */
    requested_by: AccountRefSchema,
    /** Their person, when identity knows them. */
    person_id: z.string().nullable(),
    /** The turn the request was made in. */
    turn: z.string().nullable(),
    /** Where it was posted. */
    context: ContextKeySchema,
    /** The platform's id of the message that carries it. */
    message_id: z.string().nullable(),
    /** Whether image metadata (EXIF and the like) was stripped before the upload. */
    metadata_stripped: z.boolean(),
  })
  .meta({ id: "EventsArtifactShared" });
export type ArtifactSharedData = z.output<typeof ArtifactSharedSchema>;

export const ArtifactCreated = defineEvent({
  type: "artifact.created",
  v: 1,
  data: ArtifactCreatedSchema,
  tier: "keep",
});

export const ArtifactExpired = defineEvent({
  type: "artifact.expired",
  v: 1,
  data: ArtifactExpiredSchema,
  scope: "owner",
  tier: "keep",
});

export const ArtifactTakenDown = defineEvent({
  type: "artifact.taken_down",
  v: 1,
  data: ArtifactTakenDownSchema,
  scope: "owner",
  tier: "keep",
});

export const ArtifactDeleted = defineEvent({
  type: "artifact.deleted",
  v: 1,
  data: ArtifactDeletedSchema,
  scope: "owner",
  tier: "keep",
});

export const ArtifactSwept = defineEvent({
  type: "artifact.swept",
  v: 1,
  data: ArtifactSweptSchema,
  scope: "owner",
  tier: "keep",
});

export const ArtifactShared = defineEvent({
  type: "artifact.shared",
  v: 1,
  data: ArtifactSharedSchema,
  scope: "owner",
  tier: "keep",
});

export const ShareCreated = defineEvent({
  type: "share.created",
  v: 1,
  data: ShareCreatedSchema,
  scope: "owner",
  tier: "long",
});

export const ShareRevoked = defineEvent({
  type: "share.revoked",
  v: 1,
  data: ShareRevokedSchema,
  scope: "owner",
  tier: "long",
});

export const ShareOpened = defineEvent({
  type: "share.opened",
  v: 1,
  data: ShareOpenedSchema,
  scope: "owner",
  tier: "long",
});

/** Every artifact and share event type. */
export const ARTIFACT_EVENTS = [
  ArtifactCreated,
  ArtifactExpired,
  ArtifactTakenDown,
  ArtifactDeleted,
  ArtifactSwept,
  ArtifactShared,
  ShareCreated,
  ShareRevoked,
  ShareOpened,
] as const;
