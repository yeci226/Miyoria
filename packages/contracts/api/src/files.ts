// What she made for someone (v5-architecture §11.2): the member page 「她做給我的」 and the owner's
// view of every artifact with its audit trail and take-down.
//
// Member routes (a session of any tier; the person comes from the session only):
//
// * `GET /api/member/files`: their items, newest first, with who may open each one's link now, and
//   today's link quota. `links` says whether links can be made at all (a file origin is set) and
//   whether a link for one person or a server works (the Discord login).
// * `POST /api/member/files/{id}/keep` `{ keep }`: keep it (it stops expiring) or let it expire
//   again, 7 days from now.
// * `DELETE /api/member/files/{id}`: gone for everyone, its links with it.
// * `POST /api/member/files/{id}/visibility` `{ visibility, days? }`: who its link opens for:
//   `none` (no link), `person` (only them, logged in), `space` (the members of the server it was
//   made in), `link` (anyone with the link). The old links stop working; a new one is shown once.
//   Never wider than where it was made: something made in a DM is never for a server.
// * `POST /api/member/files/{id}/download`: an address on the file origin that downloads it, for
//   two minutes.
//
// `GET /api/member/files/pass/{token}` (not on this table: a redirect) is where the file origin
// sends a visitor of a link for one person or a server, to check who they are.
//
// Admin routes: `GET /api/files` (every artifact, filters), `GET /api/files/history` (the audit
// trail: made, shared, opened, revoked, deleted, taken down, expired), `POST
// /api/files/{id}/takedown` `{ reason }`, `POST /api/files/shares/{id}/revoke` `{ reason }`.

import { z } from "zod";
import { route } from "./route.js";

export const FileVisibilitySchema = z
  .enum(["none", "person", "space", "link"])
  .meta({ id: "ApiFileVisibility" });
export type FileVisibility = z.output<typeof FileVisibilitySchema>;

const KindSchema = z.enum(["image", "audio", "video", "document", "text"]);

export const MemberFileSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    kind: KindSchema,
    mime: z.string(),
    size: z.number().int(),
    /** What made it: 生圖, 沙箱, 卡片, 翻唱, ... */
    source: z.string(),
    made_at: z.string(),
    /** `null`: kept. */
    expires_at: z.string().nullable(),
    kept: z.boolean(),
    /** Where it was made, in words a member sees: a DM, a server, or neither. */
    made_in: z.enum(["dm", "server", "elsewhere"]),
    /** Who its live link opens for now (the widest, when there are several). */
    visibility: FileVisibilitySchema,
    /** When the widest live link stops working; `null`: no link, or none of its own. */
    link_expires_at: z.string().nullable(),
    /** A song cover: never downloaded or linked, only heard in voice and on stream. */
    listen_only: z.boolean(),
    /** The visibilities this item may take (never wider than where it was made). */
    allowed: z.array(FileVisibilitySchema),
  })
  .meta({ id: "ApiMemberFile" });
export type MemberFile = z.output<typeof MemberFileSchema>;

export const MemberFilesSchema = z
  .object({
    links: z.object({
      /** A file origin is set: links and downloads work. */
      available: z.boolean(),
      /** Links for one person or a server work (the Discord login is on). */
      scoped: z.boolean(),
    }),
    quota: z.object({ used: z.number().int(), per_day: z.number().int() }),
    items: z.array(MemberFileSchema),
  })
  .meta({ id: "ApiMemberFiles" });
export type MemberFiles = z.output<typeof MemberFilesSchema>;

export const MemberFileKeepRequestSchema = z
  .object({ keep: z.boolean() })
  .strict()
  .meta({ id: "ApiMemberFileKeepRequest" });

export const MemberFileVisibilityRequestSchema = z
  .object({
    visibility: FileVisibilitySchema,
    /** How long the new link works, 1 to 30 days; default 7 (never past the item itself). */
    days: z.number().int().min(1).max(30).optional(),
  })
  .strict()
  .meta({ id: "ApiMemberFileVisibilityRequest" });
export type MemberFileVisibilityRequest = z.input<typeof MemberFileVisibilityRequestSchema>;

export const MemberFileVisibilityResultSchema = z
  .object({
    item: MemberFileSchema,
    /** The new link, shown this once; `null` for `none`. */
    url: z.string().nullable(),
  })
  .meta({ id: "ApiMemberFileVisibilityResult" });
export type MemberFileVisibilityResult = z.output<typeof MemberFileVisibilityResultSchema>;

export const MemberFileDownloadSchema = z
  .object({ url: z.string() })
  .meta({ id: "ApiMemberFileDownload" });

const IdParams = z.object({ id: z.string().min(1).max(64) });

const member = () => route.meta({ audience: "member", permission: null, limited: true });

export const memberFiles = {
  list: member().route({ method: "GET", path: "/api/member/files" }).output(MemberFilesSchema),
  /** `404` for anything that is not theirs, or gone. */
  keep: member()
    .route({ method: "POST", path: "/api/member/files/{id}/keep" })
    .input(z.object({ params: IdParams, body: MemberFileKeepRequestSchema }))
    .output(MemberFileSchema),
  remove: member()
    .route({ method: "DELETE", path: "/api/member/files/{id}" })
    .input(z.object({ params: IdParams }))
    .output(z.object({ deleted: z.boolean() }).meta({ id: "ApiMemberFileDeleted" })),
  /** `409` with the reason when the visibility is not allowed or the quota is used up. */
  visibility: member()
    .route({ method: "POST", path: "/api/member/files/{id}/visibility" })
    .input(z.object({ params: IdParams, body: MemberFileVisibilityRequestSchema }))
    .output(MemberFileVisibilityResultSchema),
  /** `409` without a file origin, or for a song cover. */
  download: member()
    .route({ method: "POST", path: "/api/member/files/{id}/download" })
    .input(z.object({ params: IdParams }))
    .output(MemberFileDownloadSchema),
};

export const AdminFileSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    kind: KindSchema,
    mime: z.string(),
    size: z.number().int(),
    source: z.string(),
    plugin: z.string(),
    /** The original of a cleaned copy. */
    derived_from: z.string().nullable(),
    made_for: z.string().nullable(),
    scope: z.string(),
    space_id: z.string().nullable(),
    review: z.string(),
    created_at: z.string(),
    expires_at: z.string().nullable(),
    kept_by: z.string().nullable(),
    deleted_at: z.string().nullable(),
    downloadable: z.boolean(),
    /** Its share links that still open something. */
    live_links: z.number().int(),
  })
  .meta({ id: "ApiAdminFile" });
export type AdminFile = z.output<typeof AdminFileSchema>;

export const AdminFilesSchema = z
  .object({
    /** A file origin is set. */
    origin: z.string().nullable(),
    items: z.array(AdminFileSchema),
  })
  .meta({ id: "ApiAdminFiles" });
export type AdminFiles = z.output<typeof AdminFilesSchema>;

export const FileHistoryEntrySchema = z
  .object({
    id: z.string(),
    at: z.string(),
    type: z.string(),
    /** Who asked, when the event names a person. */
    person_id: z.string().nullable(),
    turn: z.string().nullable(),
    data: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "ApiFileHistoryEntry" });
export type FileHistoryEntry = z.output<typeof FileHistoryEntrySchema>;

const ReasonSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict()
  .meta({ id: "ApiFileReason" });

const admin = () => route.meta({ audience: "admin", permission: null });

export const filesAdmin = {
  list: admin()
    .route({ method: "GET", path: "/api/files" })
    .input(
      z.object({
        query: z.object({
          person: z.string().max(64).optional(),
          source: z.string().max(32).optional(),
          before: z.string().max(64).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          deleted: z.enum(["0", "1"]).optional(),
        }),
      }),
    )
    .output(AdminFilesSchema),
  history: admin()
    .route({ method: "GET", path: "/api/files/history" })
    .input(
      z.object({
        query: z.object({
          before: z.string().max(64).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      }),
    )
    .output(z.array(FileHistoryEntrySchema)),
  /** Nobody but the owner sees it again; its links stop. `404` for an unknown id. */
  takedown: admin()
    .route({ method: "POST", path: "/api/files/{id}/takedown" })
    .input(z.object({ params: IdParams, body: ReasonSchema }))
    .output(AdminFileSchema),
  revoke: admin()
    .route({ method: "POST", path: "/api/files/shares/{id}/revoke" })
    .input(z.object({ params: IdParams, body: ReasonSchema }))
    .output(z.object({ revoked: z.boolean() }).meta({ id: "ApiFileShareRevoked" })),
};
