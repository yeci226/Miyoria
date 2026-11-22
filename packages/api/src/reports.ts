// Problem reports (`reports` group), over `ReportKey`: `GET /api/reports`, the owner's four
// decisions on a draft (`approve`, `comment`, `duplicate`, `reject`), and the reporter's GitHub
// mention on one draft (`mention`). Each is written to the audit log, refused or not; a refusal is
// its status and the service's sentence. Without the `report` module every route is a `503` that
// names it.

import {
  commentBody,
  issueBody,
  issueTitle,
  type Refusal,
  ReportKey,
  type ReportRow,
  type ReportService,
} from "@miyoria/brain/report";
import type { ReportDraftView, ReportList } from "@miyoria/contracts/api";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import type { ApiContext, ApiState } from "./state.js";
import { actorOf } from "./state.js";

function service(state: ApiState): ReportService {
  return state.service(ReportKey, "report module");
}

/** One report as the owner sees it: the cleaned fields and what became of it, no account. */
export function draftView(row: ReportRow, reports: ReportService): ReportDraftView {
  return {
    id: row.id,
    status: row.status,
    area: row.area,
    title: row.title,
    happened: row.happened,
    expected: row.expected,
    steps: row.steps,
    person_id: row.person_id,
    place:
      row.context === null
        ? null
        : row.context.kind === "dm"
          ? "dm"
          : row.context.kind === "channel" || row.context.kind === "thread"
            ? "channel"
            : "other",
    created_at: row.created_at,
    likely_duplicate:
      row.dup_number === null
        ? null
        : { number: row.dup_number, title: row.dup_title ?? "", url: row.dup_url ?? "" },
    issue_title: row.issue_title ?? issueTitle(row),
    issue_body:
      row.status === "opened" || row.status === "opening"
        ? (row.issue_body ?? issueBody(row))
        : issueBody(row),
    comment_body:
      row.status === "commented" || row.status === "commenting"
        ? (row.issue_body ?? commentBody(row))
        : commentBody(row),
    issue:
      row.issue_number === null ? null : { number: row.issue_number, url: row.issue_url ?? null },
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    reason: row.reason,
    last_error: row.last_error,
    closed_at: row.closed_at,
    close_reason: row.close_reason,
    notified_at: row.notified_at,
    mention: reports.mentionFor(row),
  };
}

/** Audits the decision and gives its row, or throws its refusal. */
async function decided(
  state: ApiState,
  c: ApiContext,
  action: string,
  id: string,
  detail: Record<string, string | number>,
  result: { ok: true; row: ReportRow } | Refusal,
): Promise<ReportDraftView> {
  await state.audit(
    c,
    `report.${action}`,
    id,
    result.ok ? detail : { ...detail, status: result.status, error: result.message },
    result.ok,
  );
  if (!result.ok) throw new ApiError(result.status, result.message);
  return draftView(result.row, service(state));
}

export const reportsRpc = {
  list: os.reports.list.handler(async ({ context: { state } }): Promise<ReportList> => {
    const reports = service(state);
    const { config } = reports;
    return {
      repo: config.repo,
      ready: reports.ready,
      auth: reports.auth,
      linking: reports.linker !== null,
      auto_open: config.auto_open,
      per_person_daily: config.per_person_daily,
      global_daily: config.global_daily,
      today: reports.today(),
      drafts: reports.list(null, 200).map((row) => draftView(row, reports)),
    };
  }),
  approve: os.reports.approve.handler(async ({ input, context: { state, c } }) => {
    const { title, body } = input.body;
    const edited = { title: title !== undefined, body: body !== undefined };
    const result = await service(state).approve(input.params.id, actorOf(c), {
      title: title ?? null,
      body: body ?? null,
    });
    return decided(
      state,
      c,
      "approve",
      input.params.id,
      {
        ...(edited.title ? { edited_title: 1 } : {}),
        ...(edited.body ? { edited_body: 1 } : {}),
        ...(result.ok && result.row.issue_number !== null
          ? { issue: result.row.issue_number }
          : {}),
      },
      result,
    );
  }),
  comment: os.reports.comment.handler(async ({ input, context: { state, c } }) => {
    const { issue, body } = input.body;
    const result = await service(state).comment(input.params.id, actorOf(c), issue, body ?? null);
    return decided(state, c, "comment", input.params.id, { issue }, result);
  }),
  duplicate: os.reports.duplicate.handler(async ({ input, context: { state, c } }) => {
    const { issue } = input.body;
    const result = await service(state).duplicate(input.params.id, actorOf(c), issue);
    return decided(state, c, "duplicate", input.params.id, { issue }, result);
  }),
  mention: os.reports.mention.handler(async ({ input, context: { state, c } }) => {
    const { on } = input.body;
    const result = service(state).setMention(input.params.id, on, actorOf(c));
    return decided(state, c, "mention", input.params.id, { on: on ? 1 : 0 }, result);
  }),
  reject: os.reports.reject.handler(async ({ input, context: { state, c } }) => {
    const result = service(state).reject(input.params.id, actorOf(c), input.body.reason);
    return decided(state, c, "reject", input.params.id, {}, result);
  }),
};
