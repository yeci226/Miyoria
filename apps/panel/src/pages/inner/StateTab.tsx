import type { ReactNode } from "react";
import type { SelfView } from "@/api/types";
import { EmptyLine } from "@/components/query-state";
import { Bipolar, Meter, StatusBadge } from "@/components/status";
import { RangeToggle, StateFacets, useRange, useTrend } from "@/components/trends";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { AGENDA_LABEL, AGENDA_TONE, DRIVE_LABEL, DRIVE_ORDER, scopeLabel } from "./labels";

const n2 = (v: number) => v.toFixed(2);

function Row({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_3rem] items-center gap-3 py-(--row-y)">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="contents">
        <span className="min-w-0">{children}</span>
        <span className="text-right font-mono text-xs tabular-nums">{value}</span>
      </dd>
    </div>
  );
}

function When({ at }: { at: string | null }) {
  if (!at) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={at} title={fmtDateTime(at)} className="whitespace-nowrap">
      {fmtRelative(at)}
    </time>
  );
}

function StateCard({ self }: { self: SelfView }) {
  const mood = self.mood;
  return (
    <Card>
      <CardHeader>
        <CardTitle>狀態</CardTitle>
      </CardHeader>
      <dl className="divide-y divide-line-soft" aria-label="她的狀態">
        {mood && (
          <>
            <Row label="心情" value={n2(mood.valence)}>
              <Bipolar value={mood.valence * 100} label={`心情 ${n2(mood.valence)}`} />
            </Row>
            <Row label="興奮" value={n2(mood.arousal)}>
              <Meter value={mood.arousal} label={`興奮 ${n2(mood.arousal)}`} />
            </Row>
            <Row label="精神" value={n2(mood.energy)}>
              <Meter value={mood.energy} tone="brand" label={`精神 ${n2(mood.energy)}`} />
            </Row>
          </>
        )}
        <Row label="無聊" value={n2(self.boredom)}>
          <Meter value={self.boredom} label={`無聊 ${n2(self.boredom)}`} />
        </Row>
        {DRIVE_ORDER.map((d) => (
          <Row key={d} label={DRIVE_LABEL[d]} value={n2(self.drives[d])}>
            <Meter value={self.drives[d]} tone="brand" label={`${DRIVE_LABEL[d]} ${n2(self.drives[d])}`} />
          </Row>
        ))}
      </dl>
    </Card>
  );
}

function PolicyCard({ self }: { self: SelfView }) {
  const p = self.policy;
  const rows = Object.entries(p.talkativeness).sort(([a], [b]) => (a < b ? -1 : 1));
  return (
    <Card>
      <CardHeader>
        <CardTitle>方針</CardTitle>
      </CardHeader>
      <div className="border-b border-line-soft">
        <dl>
          <Row label="主動程度" value={n2(p.initiative)}>
            <Meter value={p.initiative} tone="brand" label={`主動程度 ${n2(p.initiative)}`} />
          </Row>
        </dl>
        {p.initiative_why && (
          <p className="-mt-1 pb-2.5 pl-[6.25rem] text-[13px] text-muted-foreground">{p.initiative_why}</p>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyLine>沒有自己定的多話程度</EmptyLine>
      ) : (
        <Table aria-label="多話程度">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>範圍</TableHead>
              <TableHead className="w-28">多話程度</TableHead>
              <TableHead>她的理由</TableHead>
              <TableHead className="w-24">到期</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(([scope, t]) => (
              <TableRow key={scope}>
                <TableCell className="whitespace-nowrap" title={scope}>
                  {scopeLabel(scope)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Meter value={t.level} tone="brand" label={`多話程度 ${n2(t.level)}`} />
                    <span className="font-mono text-xs tabular-nums">{n2(t.level)}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{t.why || "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {t.until ? <When at={t.until} /> : "不限"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function AgendaCard({ self }: { self: SelfView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>議程</CardTitle>
        {self.agenda.some((a) => a.status === "open") && (
          <span className="text-sm text-muted-foreground tabular-nums">
            {self.agenda.filter((a) => a.status === "open").length}
          </span>
        )}
      </CardHeader>
      {self.agenda.length === 0 ? (
        <EmptyLine>沒有打算做的事</EmptyLine>
      ) : (
        <Table aria-label="議程">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>事項</TableHead>
              <TableHead className="hidden md:table-cell">她的理由</TableHead>
              <TableHead className="w-24">時間</TableHead>
              <TableHead className="w-20">狀態</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {self.agenda.map((a) => (
              <TableRow key={a.id} className={a.status === "open" ? undefined : "text-muted-foreground"}>
                <TableCell className="min-w-48">{a.text}</TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">{a.why || "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  <When at={a.status === "open" ? (a.due ?? a.expires_at) : a.closed_at} />
                </TableCell>
                <TableCell>
                  <StatusBadge tone={AGENDA_TONE[a.status]}>{AGENDA_LABEL[a.status]}</StatusBadge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

/** Her state over time; just the current values on a Core without telemetry. */
function StateTrend({ self }: { self: SelfView }) {
  const [range, setRange] = useRange();
  const trend = useTrend(range);
  if (trend.query.isError) return <StateCard self={self} />;
  return <StateFacets trend={trend} live={self} action={<RangeToggle range={range} onChange={setRange} />} />;
}

export function StateTab({ self }: { self: SelfView }) {
  return (
    <div className="grid gap-(--stage-gap)">
      <StateTrend self={self} />
      <div className="grid items-start gap-(--stage-gap) lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <PolicyCard self={self} />
        {/* Her plans live in GoalAgenda (the 目標 tab); this list only fills without the mind. */}
        {self.agenda.length > 0 && <AgendaCard self={self} />}
      </div>
    </div>
  );
}
