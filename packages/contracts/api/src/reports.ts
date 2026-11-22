// Problem reports (module `report`): what members told her was broken, as drafts the owner turns
// into GitHub issues. The owner's side only: the drafts and what became of them, and the four
// decisions on a draft. Every route needs `admin.reports.review` (owners and admins have it), and
// without the module every route is a `503` that names it.
//
// The fields are what a member said, already cleaned; the reporter is only their person id.

import { z } from "zod";
import { route } from "./route.js";

/** The node of the owner's hand on reports. */
export const NODE_REPORTS = "admin.reports.review";

const meta = {
  audience: "admin",
  permission: NODE_REPORTS,
  refusal: `reviewing problem reports needs \`${NODE_REPORTS}\``,
} as const;

export const ReportStatusSchema = z
  .enum(["draft", "opening", "opened", "commenting", "commented", "duplicate", "rejected"])
  .meta({ id: "ApiReportStatus" });
export type ReportStatus = z.output<typeof ReportStatusSchema>;

/** One report as the owner sees it. */
export const ReportDraftViewSchema = z
  .object({
    id: z.string(),
    status: ReportStatusSchema,
    area: z.string(),
    title: z.string(),
    happened: z.string(),
    expected: z.string(),
    steps: z.string().nullable(),
    /** The reporter's person id; `null` once they were forgotten, or for someone she did not know. */
    person_id: z.string().nullable(),
    /** `channel` or `dm`; `null` once the reporter was forgotten. */
    place: z.enum(["channel", "dm", "other"]).nullable(),
    created_at: z.string(),
    /** The open issue the search found most alike. */
    likely_duplicate: z
      .object({ number: z.number().int(), title: z.string(), url: z.string() })
      .nullable(),
    /** What an approval would send, or what was sent. */
    issue_title: z.string(),
    issue_body: z.string(),
    /** What "add as a comment instead" would send. */
    comment_body: z.string(),
    /** The issue it became, was added to, or is a duplicate of. */
    issue: z.object({ number: z.number().int(), url: z.string().nullable() }).nullable(),
    decided_by: z.string().nullable(),
    decided_at: z.string().nullable(),
    reason: z.string().nullable(),
    last_error: z.string().nullable(),
    closed_at: z.string().nullable(),
    close_reason: z.string().nullable(),
    notified_at: z.string().nullable(),
    /**
     * Whether an approval names the reporter as `@login` on the issue's last line: only for a
     * reporter who linked their GitHub account and allows it, unless the owner took it off this
     * draft. `login` is the name last read (GitHub is asked again at approval); `why`: `on`,
     * `anonymous`, `not_linked`, `member_off`, `owner_off`.
     */
    mention: z.object({
      login: z.string().nullable(),
      will_add: z.boolean(),
      why: z.enum(["on", "anonymous", "not_linked", "member_off", "owner_off"]),
    }),
  })
  .meta({ id: "ApiReportDraftView" });
export type ReportDraftView = z.output<typeof ReportDraftViewSchema>;

/** `GET /api/reports`. */
export const ReportListSchema = z
  .object({
    /** `owner/name`; empty when none is set. */
    repo: z.string(),
    /** The GitHub App (or a token) and a repo: approvals can reach GitHub, and she is offered the tool. */
    ready: z.boolean(),
    /** How Core reaches GitHub: as the App (recommended), with the fallback token, or not at all. */
    auth: z.enum(["app", "token"]).nullable(),
    /** Members can link their GitHub account on the member page. */
    linking: z.boolean(),
    auto_open: z.boolean(),
    per_person_daily: z.number().int(),
    global_daily: z.number().int(),
    /** Reports in the last 24 hours. */
    today: z.number().int(),
    /** Newest first, at most 200. */
    drafts: z.array(ReportDraftViewSchema),
  })
  .meta({ id: "ApiReportList" });
export type ReportList = z.output<typeof ReportListSchema>;

/** Body of `POST /api/reports/{id}/approve`: the title or the body as edited, else the report's own. */
export const ReportApproveRequestSchema = z
  .object({
    title: z.string().max(256).optional(),
    body: z.string().max(20_000).optional(),
  })
  .meta({ id: "ApiReportApproveRequest" });
export type ReportApproveRequest = z.input<typeof ReportApproveRequestSchema>;

/** Body of `POST /api/reports/{id}/reject`. */
export const ReportRejectRequestSchema = z
  .object({ reason: z.string().min(1).max(500) })
  .meta({ id: "ApiReportRejectRequest" });
export type ReportRejectRequest = z.input<typeof ReportRejectRequestSchema>;

/** Body of `POST /api/reports/{id}/duplicate`. */
export const ReportDuplicateRequestSchema = z
  .object({ issue: z.number().int().min(1) })
  .meta({ id: "ApiReportDuplicateRequest" });
export type ReportDuplicateRequest = z.input<typeof ReportDuplicateRequestSchema>;

/** Body of `POST /api/reports/{id}/comment`: the comment as edited, else the report's own. */
export const ReportCommentRequestSchema = z
  .object({ issue: z.number().int().min(1), body: z.string().max(20_000).optional() })
  .meta({ id: "ApiReportCommentRequest" });
export type ReportCommentRequest = z.input<typeof ReportCommentRequestSchema>;

/** Body of `POST /api/reports/{id}/mention`: `false` takes the reporter's mention off this draft. */
export const ReportMentionRequestSchema = z
  .object({ on: z.boolean() })
  .meta({ id: "ApiReportMentionRequest" });
export type ReportMentionRequest = z.input<typeof ReportMentionRequestSchema>;

const ReportParams = z.object({ id: z.string().min(1).max(64) });

export const reports = {
  list: route.meta(meta).route({ method: "GET", path: "/api/reports" }).output(ReportListSchema),
  /**
   * Opens the issue on GitHub. `404` unknown, `409` decided already, `502` GitHub refused (the
   * draft stays, with the error), `503` no token or repo.
   */
  approve: route
    .meta(meta)
    .route({ method: "POST", path: "/api/reports/{id}/approve" })
    .input(z.object({ params: ReportParams, body: ReportApproveRequestSchema }))
    .output(ReportDraftViewSchema),
  /** Adds the report to issue #N instead of opening one; the same refusals as `approve`. */
  comment: route
    .meta(meta)
    .route({ method: "POST", path: "/api/reports/{id}/comment" })
    .input(z.object({ params: ReportParams, body: ReportCommentRequestSchema }))
    .output(ReportDraftViewSchema),
  /** Marks it a duplicate of issue #N; nothing is written on GitHub. */
  duplicate: route
    .meta(meta)
    .route({ method: "POST", path: "/api/reports/{id}/duplicate" })
    .input(z.object({ params: ReportParams, body: ReportDuplicateRequestSchema }))
    .output(ReportDraftViewSchema),
  /** The reporter's mention on this draft's issue, on or off; `409` once it is decided. */
  mention: route
    .meta(meta)
    .route({ method: "POST", path: "/api/reports/{id}/mention" })
    .input(z.object({ params: ReportParams, body: ReportMentionRequestSchema }))
    .output(ReportDraftViewSchema),
  reject: route
    .meta(meta)
    .route({ method: "POST", path: "/api/reports/{id}/reject" })
    .input(z.object({ params: ReportParams, body: ReportRejectRequestSchema }))
    .output(ReportDraftViewSchema),
};
