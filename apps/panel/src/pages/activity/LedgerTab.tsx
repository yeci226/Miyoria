import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ArbiterDecisionView, ArbiterVerdict, LedgerEntry, LedgerLimits, RaisedTopic } from "@/api/types";
import { useArbiterDecisions, useLedger } from "@/app/queries";
import { Toolbar } from "@/components/page";
import { EmptyLine, QueryView } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import {
  LEDGER_KIND_LABEL,
  LEDGER_OUTCOME_LABEL,
  LEDGER_OUTCOME_TONE,
  REASON_LABEL,
  SOURCE_LABEL,
  VERDICT_LABEL,
  VERDICT_TONE,
} from "./labels";

const ALL = "__all";
const VERDICTS = Object.keys(VERDICT_LABEL) as ArbiterVerdict[];

function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={fmtDateTime(at)} className="whitespace-nowrap">
      {fmtRelative(at)}
    </time>
  );
}

function Stat({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-medium">{children}</dd>
      {sub && <dd className="min-w-0 truncate text-[13px] text-muted-foreground">{sub}</dd>}
    </div>
  );
}

/** What the arbiter lets her do right now, and what is on hold and why. */
export function LimitsCard({ limits }: { limits: LedgerLimits }) {
  const q = limits.quiet_hours;
  return (
    <Card>
      <CardHeader>
        <CardTitle>她現在的限制</CardTitle>
        {limits.paused && <StatusBadge tone="danger">自主已暫停</StatusBadge>}
      </CardHeader>
      <dl aria-label="限制" className="grid grid-cols-2 gap-x-8 gap-y-3 lg:grid-cols-4">
        <Stat
          label="今天主動開的次數"
          sub={limits.initiative_cap === null ? "沒有上限" : `上限 ${limits.initiative_cap} 次`}
        >
          <span className="tabular-nums">{limits.initiatives_today}</span>
          {limits.initiative_cap !== null && <span className="text-muted-foreground"> / {limits.initiative_cap}</span>}
        </Stat>
        <Stat label="下次可以主動" sub={limits.next_initiative_at ? fmtDateTime(limits.next_initiative_at) : undefined}>
          {limits.next_initiative_at ? <When at={limits.next_initiative_at} /> : "現在就可以"}
        </Stat>
        <Stat label="連續沒人理" sub="她主動開的話題連續沒被接">
          <span className="tabular-nums">{limits.unanswered_streak}</span> 次
        </Stat>
        <Stat label="安靜時段" sub={q ? `${q.start_hour}:00 – ${q.end_hour}:00` : undefined}>
          {q === null ? "沒有設定" : q.active ? <StatusBadge tone="warning">現在是</StatusBadge> : "現在不是"}
        </Stat>
      </dl>
      {limits.blocked.length === 0 ? (
        <EmptyLine>沒有被擋住的能力</EmptyLine>
      ) : (
        <Table aria-label="被擋住的能力">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-40">能力</TableHead>
              <TableHead>為什麼被擋</TableHead>
              <TableHead className="w-28">到什麼時候</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {limits.blocked.map((b) => (
              <TableRow key={b.capability}>
                <TableCell className="font-mono text-xs">{b.capability}</TableCell>
                <TableCell>{b.reason}</TableCell>
                <TableCell className="text-muted-foreground">{b.until ? <When at={b.until} /> : "不一定"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

const TOPIC_LABEL: Record<RaisedTopic["status"], string> = { waiting: "等回應", engaged: "有人接", ignored: "沒人理" };

function UnansweredCard({ topics }: { topics: RaisedTopic[] }) {
  if (topics.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>沒人接的話題</CardTitle>
        <span className="text-sm text-muted-foreground tabular-nums">{topics.length}</span>
      </CardHeader>
      <ul className="divide-y divide-line-soft" aria-label="沒人接的話題">
        {topics.map((t, i) => (
          <li key={i} className="flex items-center gap-3 py-(--row-y) text-sm">
            <span className="min-w-0 flex-1 truncate">{t.text}</span>
            {t.context && <span className="hidden text-[13px] text-muted-foreground sm:block">{contextShort(t.context)}</span>}
            <Badge variant="outline">{TOPIC_LABEL[t.status]}</Badge>
            <span className="w-20 text-right text-[13px] text-muted-foreground">
              <When at={t.at} />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Entries({ entries }: { entries: LedgerEntry[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>她做過和試過的事</CardTitle>
      </CardHeader>
      {entries.length === 0 ? (
        <EmptyLine>帳本是空的</EmptyLine>
      ) : (
        <Table aria-label="帳本">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>內容</TableHead>
              <TableHead className="hidden w-24 sm:table-cell">來源</TableHead>
              <TableHead className="hidden w-28 md:table-cell">地點</TableHead>
              <TableHead className="w-24">結果</TableHead>
              <TableHead className="w-24">時間</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="min-w-48 whitespace-normal">
                  <span className="grid gap-0.5">
                    <span>
                      {e.summary}
                      {e.self_initiated && <span className="ml-2 text-xs text-muted-foreground">主動</span>}
                    </span>
                    {e.detail && <span className="text-[13px] text-muted-foreground">{e.detail}</span>}
                    {e.turn && (
                      <Link
                        to="/activity"
                        search={{ tab: "prompts", turn: e.turn }}
                        className="w-fit text-xs text-muted-foreground underline-offset-4 hover:underline"
                      >
                        看這回合
                      </Link>
                    )}
                  </span>
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {SOURCE_LABEL[e.source] ?? e.source}
                  <span className="block text-xs">{LEDGER_KIND_LABEL[e.kind]}</span>
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  {e.context ? contextShort(e.context) : "—"}
                </TableCell>
                <TableCell>
                  <StatusBadge tone={LEDGER_OUTCOME_TONE[e.outcome]} pulse={e.outcome === "pending"}>
                    {LEDGER_OUTCOME_LABEL[e.outcome]}
                  </StatusBadge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <When at={e.at} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function DecisionRows({ decisions }: { decisions: ArbiterDecisionView[] }) {
  if (decisions.length === 0) return <EmptyLine>沒有符合的裁決</EmptyLine>;
  return (
    <Table aria-label="裁決">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-24">裁決</TableHead>
          <TableHead>原因</TableHead>
          <TableHead className="hidden w-24 sm:table-cell">來源</TableHead>
          <TableHead className="w-24">時間</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {decisions.map((d) => (
          <TableRow key={d.impulse}>
            <TableCell>
              <StatusBadge tone={VERDICT_TONE[d.verdict]}>{VERDICT_LABEL[d.verdict]}</StatusBadge>
            </TableCell>
            <TableCell className="min-w-48 whitespace-normal">
              <span className="grid gap-0.5">
                {d.summary && <span>{d.summary}</span>}
                <span className={d.summary ? "text-[13px] text-muted-foreground" : undefined}>
                  {d.reason && <span className="mr-2 font-medium">{REASON_LABEL[d.reason] ?? d.reason}</span>}
                  {d.detail}
                </span>
                {d.retry_at && (
                  <span className="text-[13px] text-muted-foreground">
                    之後再試:<When at={d.retry_at} />
                  </span>
                )}
              </span>
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">{SOURCE_LABEL[d.source] ?? d.source}</TableCell>
            <TableCell className="text-muted-foreground">
              <When at={d.at} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DecisionsCard() {
  const [verdict, setVerdict] = useState<string>(ALL);
  const decisions = useArbiterDecisions({ limit: 100, verdict: verdict === ALL ? undefined : (verdict as ArbiterVerdict) });
  return (
    <div className="grid gap-3">
      <Toolbar>
        <h2 className="text-sm font-medium">為什麼沒讓她做(裁決紀錄)</h2>
        <Select value={verdict} onValueChange={setVerdict}>
          <SelectTrigger aria-label="裁決結果" className="ml-auto w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>所有裁決</SelectItem>
            {VERDICTS.map((v) => (
              <SelectItem key={v} value={v}>
                {VERDICT_LABEL[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Toolbar>
      <Card>
        <QueryView query={decisions}>{(d) => <DecisionRows decisions={d.decisions} />}</QueryView>
      </Card>
    </div>
  );
}

/** The arbiter: her limits, what she did or tried, and why impulses were held back. */
export function LedgerTab() {
  const ledger = useLedger();
  return (
    <div className="grid gap-(--stage-gap)">
      <QueryView query={ledger}>
        {(view) => (
          <>
            <LimitsCard limits={view.limits} />
            <UnansweredCard topics={view.unanswered} />
            <Entries entries={view.entries} />
          </>
        )}
      </QueryView>
      <DecisionsCard />
    </div>
  );
}
