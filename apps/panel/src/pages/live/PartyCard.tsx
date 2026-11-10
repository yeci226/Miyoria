import type { PartyResultView, PartySessionView } from "@/api/v4-types";
import { useParty } from "@/app/v4-queries";
import { ModuleQuery } from "@/components/module-query";
import { EmptyLine } from "@/components/query-state";
import { Dot, StatusBadge } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import { endReason, scoreLine } from "@/lib/party";

const RECENT = 6;

function Running({ s, now }: { s: PartySessionView; now: number }) {
  const scores = s.scored ? scoreLine(s.players) : "";
  const here = s.players.filter((p) => !p.her && p.present).length;
  return (
    <li className="grid gap-1 border-b border-line-soft py-(--row-y) last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Dot tone="brand" pulse />
        <span className="font-medium">{s.title}</span>
        <span className="text-muted-foreground">{contextShort(s.context)}</span>
        <span className="text-[13px] text-muted-foreground">{here} 人在場</span>
        <time dateTime={s.started_at} title={fmtDateTime(s.started_at)} className="ml-auto text-[13px] text-muted-foreground">
          {fmtRelative(s.started_at, now)}開始
        </time>
      </div>
      {scores && <p className="pl-5 text-[13px] break-words text-muted-foreground">{scores}</p>}
    </li>
  );
}

function Finished({ s, now }: { s: PartyResultView; now: number }) {
  const scores = s.scored ? scoreLine(s.players) : "";
  return (
    <li className="grid gap-1 border-b border-line-soft py-(--row-y) last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">{s.title}</span>
        <span className="text-muted-foreground">{contextShort(s.context)}</span>
        <time dateTime={s.ended_at} title={fmtDateTime(s.ended_at)} className="ml-auto text-[13px] text-muted-foreground">
          {fmtRelative(s.ended_at, now)}
        </time>
      </div>
      <p className="text-[13px] break-words text-muted-foreground">
        {endReason(s.reason)}
        {scores && `。最後分數:${scores}`}
      </p>
    </li>
  );
}

/** The party game running in each voice channel now, and the ones that ended lately. */
export function PartyCard() {
  const q = useParty();
  const now = q.dataUpdatedAt > 0 ? q.dataUpdatedAt : Date.now();
  const running = q.data?.sessions.length ?? 0;
  return (
    <Card aria-label="派對遊戲">
      <CardHeader>
        <CardTitle>派對遊戲</CardTitle>
        {running > 0 && <StatusBadge tone="brand" pulse>進行中 {running}</StatusBadge>}
      </CardHeader>
      <ModuleQuery query={q} module="派對遊戲(party 模組)" skeleton={<Skeleton className="h-16 w-full" aria-busy="true" aria-label="載入中" />}>
        {(snap) => (
          <div className="grid gap-4">
            {snap.sessions.length === 0 ? (
              <EmptyLine className="py-1">現在沒有人在玩</EmptyLine>
            ) : (
              <ul aria-label="進行中的遊戲">{snap.sessions.map((s) => <Running key={s.id} s={s} now={now} />)}</ul>
            )}
            {snap.recent.length > 0 && (
              <section aria-label="最近的結果" className="grid gap-1">
                <h3 className="text-[13px] font-medium text-muted-foreground">最近的結果</h3>
                <ul>{snap.recent.slice(0, RECENT).map((s) => <Finished key={s.id} s={s} now={now} />)}</ul>
              </section>
            )}
          </div>
        )}
      </ModuleQuery>
    </Card>
  );
}
