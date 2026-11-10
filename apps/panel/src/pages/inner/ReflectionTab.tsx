import type { ReactNode } from "react";
import type { FeedbackTally, ReflectionRun } from "@/api/types";
import { useReflection } from "@/app/queries";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtRelative } from "@/lib/format";

function When({ at }: { at: string | null }) {
  if (!at) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={at} title={fmtDateTime(at)} className="whitespace-nowrap">
      {fmtRelative(at)}
    </time>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate tabular-nums">{children}</dd>
    </div>
  );
}

function talkText(talk: number | null): string {
  if (talk === null || talk === 0) return "—";
  return talk < 0 ? `安靜一點 ${talk.toFixed(1)}` : `活潑一點 +${talk.toFixed(1)}`;
}

function RunItem({ r }: { r: ReflectionRun }) {
  const changes = [
    r.insights > 0 ? `整理記憶 ${r.insights}` : null,
    r.superseded > 0 ? `取代過時記憶 ${r.superseded}` : null,
    r.documents.length > 0 ? `資料:${r.documents.join("、")}` : null,
    r.feelings.length > 0 ? `感覺:${r.feelings.join("、")}` : null,
  ].filter((x): x is string => x !== null);
  return (
    <li className="grid gap-x-6 gap-y-2 py-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-muted-foreground sm:flex-col sm:gap-1">
        <When at={r.at} />
        <StatusBadge tone={r.kind === "daily" ? "brand" : "neutral"}>{r.kind === "daily" ? "每日" : "長對話後"}</StatusBadge>
      </div>
      <div className="grid min-w-0 gap-2">
        {r.error ? (
          <p className="font-mono text-xs text-primary">{r.error}</p>
        ) : (
          <p className="max-w-[70ch] leading-relaxed">{r.summary || "—"}</p>
        )}
        {changes.length > 0 && <p className="text-[13px] text-muted-foreground">{changes.join(" · ")}</p>}
        {r.lessons.length > 0 && (
          <ul className="grid gap-0.5 text-[13px]" aria-label="學到的事">
            {r.lessons.map((l) => (
              <li key={l}>・{l}</li>
            ))}
          </ul>
        )}
        {r.goals.length > 0 && <p className="text-[13px]">目標:{r.goals.join("、")}</p>}
      </div>
    </li>
  );
}

function tallyText(t: FeedbackTally): string {
  const parts: string[] = [];
  if (t.reactions_pos + t.reactions_neg > 0) parts.push(`反應 +${t.reactions_pos} / -${t.reactions_neg}`);
  if (t.replies > 0) parts.push(`回覆她 ${t.replies}`);
  if (t.started > 0) parts.push(`她開話題 ${t.started}(有人接 ${t.answered}、沒人理 ${t.ignored})`);
  if (t.positive + t.negative > 0) parts.push(`稱讚 ${t.positive}、嫌她 ${t.negative}`);
  if (t.denied > 0) parts.push(`被擋下 ${t.denied}`);
  return parts.join(" · ") || "—";
}

export function ReflectionTab() {
  const reflection = useReflection();
  return (
    <QueryView query={reflection} skeleton={<Card><SkeletonRows count={4} /></Card>}>
      {(v) => (
        <div className="grid gap-(--stage-gap)">
          <Card>
            <CardHeader>
              <CardTitle>反思</CardTitle>
              {v.stats.idle_reason && <StatusBadge tone="neutral">{v.stats.idle_reason}</StatusBadge>}
            </CardHeader>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3" aria-label="反思狀態">
              <Fact label="今天">
                {v.stats.calls_today} / {v.stats.max_calls_per_day}
              </Fact>
              <Fact label="上次每日反思">
                <When at={v.stats.last_daily_at} />
              </Fact>
              <Fact label="上次長對話後">
                <When at={v.stats.last_light_at} />
              </Fact>
            </dl>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>學到的事</CardTitle>
            </CardHeader>
            {v.lessons.length === 0 ? (
              <EmptyLine>還沒有學到什麼</EmptyLine>
            ) : (
              <Table aria-label="學到的事">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>她學到的</TableHead>
                    <TableHead className="hidden w-32 sm:table-cell">關於</TableHead>
                    <TableHead className="hidden w-36 md:table-cell">多話程度</TableHead>
                    <TableHead className="w-24">到期</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {v.lessons.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="max-w-[60ch] whitespace-pre-wrap">{l.text}</TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">
                        {l.display_name ?? l.scope ?? "所有地方"}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">{talkText(l.talk)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        <When at={l.expires_at} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>大家的反應(7 天)</CardTitle>
            </CardHeader>
            {v.feedback.length === 0 ? (
              <EmptyLine>還沒有回饋</EmptyLine>
            ) : (
              <Table aria-label="回饋">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-48">人或地方</TableHead>
                    <TableHead>訊號</TableHead>
                    <TableHead className="hidden lg:table-cell">例子</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {v.feedback.map((t) => (
                    <TableRow key={t.subject}>
                      <TableCell className="align-top font-medium">{t.label || t.subject}</TableCell>
                      <TableCell className="align-top text-[13px]">{tallyText(t)}</TableCell>
                      <TableCell className="hidden max-w-[40ch] align-top text-[13px] text-muted-foreground lg:table-cell">
                        {t.examples.join(" / ") || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>反思紀錄</CardTitle>
            </CardHeader>
            {v.runs.length === 0 ? (
              <EmptyLine>她還沒有反思過</EmptyLine>
            ) : (
              <ol className="divide-y divide-line-soft" aria-label="反思紀錄">
                {v.runs.map((r) => (
                  <RunItem key={r.id} r={r} />
                ))}
              </ol>
            )}
          </Card>
        </div>
      )}
    </QueryView>
  );
}
