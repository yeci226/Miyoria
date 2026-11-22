import { Link } from "@tanstack/react-router";
import { Ban, Copy, MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import type { ReportDraftView, ReportList } from "@miyoria/contracts/api";
import { describeError } from "@/api/http";
import { RowActions } from "@/components/controls";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Page, PageHeader } from "@/components/page";
import { Dot, StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { ApproveDialog, CommentDialog, DuplicateDialog, RejectDialog } from "./Dialogs";
import { areaLabel, closeLabel, isPending, PLACE, STATUS } from "./labels";
import { isOff, useReportMutations, useReports } from "./queries";

/** The report module is off (or this Core has none). */
function ReportsOff({ detail }: { detail: string }) {
  return (
    <div role="status" className="grid max-w-xl gap-3 py-8">
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">回報模組沒有啟動</h2>
      <p className="text-[13px] text-muted-foreground">
        在 Core 的設定檔加上 <code className="font-mono text-foreground">[modules.report]</code>,寫上{" "}
        <code className="font-mono text-foreground">enabled = true</code>、repo 和 GitHub App 的設定(或 token),再重新啟動 Core。
      </p>
      <p className="text-xs text-muted-foreground">{detail}</p>
      <div>
        <Button asChild variant="outline">
          <Link to="/system" search={{ tab: "modules", q: "report" }}>
            到子系統頁看它的狀態
          </Link>
        </Button>
      </div>
    </div>
  );
}

function Summary({ data }: { data: ReportList }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1.5 py-1 text-[13px]">
      <div className="flex items-center gap-1.5">
        <dt className="text-muted-foreground">GitHub</dt>
        <dd className="inline-flex items-center gap-1.5">
          <Dot tone={data.ready ? "success" : "warning"} />
          {data.ready ? (
            <>
              <span className="font-mono">{data.repo}</span>
              <span className="text-muted-foreground">{data.auth === "app" ? "以 GitHub App 開" : "以 token 開"}</span>
            </>
          ) : (
            <span>沒有設定 GitHub App 或 token:不能核准,她也看不到回報工具</span>
          )}
        </dd>
      </div>
      <div className="flex items-center gap-1.5">
        <dt className="text-muted-foreground">24 小時內</dt>
        <dd className="tabular-nums">
          {data.today} / {data.global_daily}
        </dd>
      </div>
      <div className="flex items-center gap-1.5">
        <dt className="text-muted-foreground">每人每天</dt>
        <dd className="tabular-nums">{data.per_person_daily}</dd>
      </div>
      <div className="flex items-center gap-1.5">
        <dt className="text-muted-foreground">成員連結 GitHub</dt>
        <dd>{data.linking ? "開" : "關"}</dd>
      </div>
      <div className="flex items-center gap-1.5">
        <dt className="text-muted-foreground">自動開 issue</dt>
        <dd>{data.auto_open ? "開" : "關"}</dd>
      </div>
    </dl>
  );
}

function IssueLink({ number, url }: { number: number; url: string | null }) {
  return url ? (
    <a href={url} target="_blank" rel="noreferrer noopener" className="font-mono underline-offset-2 hover:underline">
      #{number}
    </a>
  ) : (
    <span className="font-mono">#{number}</span>
  );
}

function Fields({ draft }: { draft: ReportDraftView }) {
  const rows: [string, string | null][] = [
    ["發生了什麼", draft.happened],
    ["原本應該", draft.expected],
    ["怎麼重現", draft.steps],
  ];
  return (
    <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[6rem_1fr]">
      {rows.map(([label, text]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words">{text ?? "不清楚"}</dd>
        </div>
      ))}
    </dl>
  );
}

function Meta({ draft, now }: { draft: ReportDraftView; now: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <Badge variant="secondary">{areaLabel(draft.area)}</Badge>
      <span title={fmtDateTime(draft.created_at)}>{fmtRelative(draft.created_at, now)}</span>
      {draft.place && <span>在{PLACE[draft.place]}</span>}
      {draft.person_id ? (
        <Link to="/character" search={{ tab: "people", person: draft.person_id }} className="underline-offset-2 hover:underline">
          回報的人
        </Link>
      ) : (
        <span>回報的人不知道是誰或已被遺忘</span>
      )}
    </div>
  );
}

const MENTION_WHY: Record<ReportDraftView["mention"]["why"], string> = {
  on: "會",
  anonymous: "不會:不知道回報的人是誰",
  not_linked: "不會:回報的人沒有連結 GitHub",
  member_off: "不會:回報的人關掉了標記",
  owner_off: "不會:你拿掉了這份的標記",
};

/**
 * Whether the issue's last line will name the reporter, from their own GitHub link; the owner
 * may take it off this draft (or put it back).
 */
function MentionLine({ draft, waiting }: { draft: ReportDraftView; waiting: boolean }) {
  const { mention } = useReportMutations();
  const m = draft.mention;
  if (m.why === "anonymous" || m.why === "not_linked") return null;
  const toggle = (on: boolean) =>
    mention.mutate(
      { id: draft.id, on },
      {
        onSuccess: () => notify.ok(on ? "核准時會標記回報的人" : "這份不標記回報的人"),
        onError: (e) => notify.error(e, "改不了標記"),
      },
    );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
      <span className="text-muted-foreground">標記回報的人</span>
      <span>
        {m.will_add ? <>會在最後一行寫 <span className="font-mono">@{m.login}</span>(核准時再向 GitHub 確認一次)</> : MENTION_WHY[m.why]}
      </span>
      {m.why === "on" && (
        <Button writes size="sm" variant="outline" disabled={waiting} busy={mention.isPending} onClick={() => toggle(false)}>
          這份不標記
        </Button>
      )}
      {m.why === "owner_off" && (
        <Button writes size="sm" variant="outline" disabled={waiting} busy={mention.isPending} onClick={() => toggle(true)}>
          改回標記
        </Button>
      )}
    </div>
  );
}

type Opened = "approve" | "comment" | "duplicate" | "reject" | null;

function DraftRow({ draft, ready, now }: { draft: ReportDraftView; ready: boolean; now: number }) {
  const [open, setOpen] = useState<Opened>(null);
  const waiting = draft.status !== "draft";
  const why = !ready ? "沒有設定 GitHub App 或 token" : undefined;
  return (
    <li data-report={draft.id} className="grid gap-2.5 border-b border-line-soft py-3.5 last:border-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="grid min-w-0 flex-1 basis-72 gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 break-words text-[14px] font-semibold">{draft.title}</h3>
            {waiting && <StatusBadge tone={STATUS[draft.status].tone} pulse>{STATUS[draft.status].label}</StatusBadge>}
          </div>
          <Meta draft={draft} now={now} />
        </div>
        <div className="flex items-center gap-1.5">
          <Button writes disabled={waiting || !ready} title={why} onClick={() => setOpen("approve")}>
            核准
          </Button>
          <RowActions label={`「${draft.title}」的其他處理`}>
            <DropdownMenuItem disabled={waiting || !ready} onSelect={() => setOpen("comment")}>
              <MessageSquarePlus />
              {draft.likely_duplicate ? `改成加到 #${draft.likely_duplicate.number} 的留言` : "改成加到已有的 issue"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={waiting} onSelect={() => setOpen("duplicate")}>
              <Copy />
              標成重複
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={waiting} onSelect={() => setOpen("reject")}>
              <Ban />
              拒絕
            </DropdownMenuItem>
          </RowActions>
        </div>
      </div>
      {draft.likely_duplicate && (
        <p className="text-[13px]">
          <span className="text-muted-foreground">很像 </span>
          <IssueLink number={draft.likely_duplicate.number} url={draft.likely_duplicate.url || null} />
          <span className="ml-1.5 break-words">{draft.likely_duplicate.title}</span>
        </p>
      )}
      <Fields draft={draft} />
      <MentionLine draft={draft} waiting={waiting} />
      {draft.last_error && (
        <p role="alert" className="text-[13px] text-primary">
          {draft.last_error}
        </p>
      )}
      {open === "approve" && <ApproveDialog draft={draft} onClose={() => setOpen(null)} />}
      {open === "comment" && <CommentDialog draft={draft} onClose={() => setOpen(null)} />}
      {open === "duplicate" && <DuplicateDialog draft={draft} onClose={() => setOpen(null)} />}
      {open === "reject" && <RejectDialog draft={draft} onClose={() => setOpen(null)} />}
    </li>
  );
}

function Outcome({ draft, now }: { draft: ReportDraftView; now: number }) {
  const status = STATUS[draft.status];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      {draft.issue && <IssueLink number={draft.issue.number} url={draft.issue.url} />}
      {draft.status === "rejected" && draft.reason && <span className="break-words">{draft.reason}</span>}
      {draft.closed_at && (
        <span className="text-muted-foreground" title={fmtDateTime(draft.closed_at)}>
          {fmtRelative(draft.closed_at, now)}
          {closeLabel(draft.close_reason)}
        </span>
      )}
      {draft.notified_at && <span className="text-muted-foreground">已提醒她跟回報的人說</span>}
      {draft.decided_by === "auto" && <span className="text-muted-foreground">自動開的</span>}
    </div>
  );
}

function DoneRow({ draft, now }: { draft: ReportDraftView; now: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li data-report={draft.id} className="grid gap-2 border-b border-line-soft py-3 last:border-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="min-w-0 flex-1 basis-72 text-left text-[14px] font-medium break-words hover:underline underline-offset-2"
        >
          {draft.title}
        </button>
        <Outcome draft={draft} now={now} />
      </div>
      <Meta draft={draft} now={now} />
      {open && <Fields draft={draft} />}
    </li>
  );
}

export function ReportsPage() {
  const reports = useReports();
  const now = Date.now();
  if (reports.isPending) {
    return (
      <Page>
        <PageHeader title="回報" />
        <SkeletonRows />
      </Page>
    );
  }
  if (reports.isError) {
    return (
      <Page>
        <PageHeader title="回報" />
        {isOff(reports.error) ? (
          <ReportsOff detail={describeError(reports.error)} />
        ) : (
          <ErrorLine error={reports.error} onRetry={() => void reports.refetch()} />
        )}
      </Page>
    );
  }
  const data = reports.data;
  const pending = data.drafts.filter(isPending);
  const done = data.drafts.filter((d) => !isPending(d));
  return (
    <Page>
      <PageHeader title="回報" />
      <Summary data={data} />
      <Card>
        <CardHeader>
          <CardTitle>待審核</CardTitle>
        </CardHeader>
        {pending.length === 0 ? (
          <EmptyLine>沒有待審核的回報</EmptyLine>
        ) : (
          <ul className="grid">
            {pending.map((d) => (
              <DraftRow key={d.id} draft={d} ready={data.ready} now={now} />
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>處理過的</CardTitle>
        </CardHeader>
        {done.length === 0 ? (
          <EmptyLine>還沒有處理過的回報</EmptyLine>
        ) : (
          <ul className="grid">
            {done.map((d) => (
              <DoneRow key={d.id} draft={d} now={now} />
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
