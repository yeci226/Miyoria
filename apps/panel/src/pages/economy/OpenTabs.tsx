import { useCommissions, usePredictions, useRoom } from "@/app/v4-queries";
import { BarList } from "@/components/charts/charts";
import { ModuleQuery } from "@/components/module-query";
import { Meter, StatusBadge, type Tone } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtInt, fmtPct, fmtRelative } from "@/lib/format";
import { COMMISSION_KIND_LABEL, PREDICTION_STATUS_LABEL } from "./labels";

const MODULE = "經濟(economy 模組)";

/** Commissions people paid for that she has not handed in or declined. */
export function CommissionsTab() {
  const q = useCommissions();
  const now = q.dataUpdatedAt > 0 ? q.dataUpdatedAt : Date.now();
  return (
    <Card>
      <CardHeader>
        <CardTitle>等她做的委託</CardTitle>
      </CardHeader>
      <ModuleQuery query={q} module={MODULE} isEmpty={(d) => d.commissions.length === 0} empty="沒有等她做的委託">
        {(d) => (
          <Table aria-label="委託">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-24">種類</TableHead>
                <TableHead>要她做什麼</TableHead>
                <TableHead className="w-24 text-right">價錢</TableHead>
                <TableHead className="w-32">期限</TableHead>
                <TableHead className="hidden w-32 md:table-cell">下單</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.commissions.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{COMMISSION_KIND_LABEL[c.kind] ?? c.label}</TableCell>
                  <TableCell className="min-w-56 whitespace-normal break-words">
                    {c.brief}
                    <span className="ml-2 font-mono text-[11px] text-muted-foreground">{c.id}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtInt(c.price)} <span className="text-muted-foreground">{d.currency}</span>
                  </TableCell>
                  <TableCell>
                    <time dateTime={c.due_at} title={fmtDateTime(c.due_at)} className={Date.parse(c.due_at) < now ? "text-primary" : undefined}>
                      {fmtRelative(c.due_at, now)}
                    </time>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    <time dateTime={c.created_at} title={fmtDateTime(c.created_at)}>
                      {fmtRelative(c.created_at, now)}
                    </time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ModuleQuery>
    </Card>
  );
}

const STATUS_TONE: Record<string, Tone> = { open: "brand", closed: "warning", resolved: "neutral", cancelled: "neutral" };

/** Predictions open now and the ones settled lately, with where the stakes stand. */
export function PredictionsTab() {
  const q = usePredictions();
  const now = q.dataUpdatedAt > 0 ? q.dataUpdatedAt : Date.now();
  return (
    <Card>
      <CardHeader>
        <CardTitle>預測</CardTitle>
      </CardHeader>
      <ModuleQuery query={q} module={MODULE} isEmpty={(d) => d.predictions.length === 0} empty="沒有預測">
        {(d) => (
          <ul aria-label="預測" className="grid">
            {d.predictions.map((p) => (
              <li key={p.id} className="grid gap-3 border-b border-line-soft py-4 first:pt-1 last:border-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="min-w-0 text-sm font-medium break-words">{p.question}</h3>
                  <StatusBadge tone={STATUS_TONE[p.status] ?? "neutral"}>{PREDICTION_STATUS_LABEL[p.status] ?? p.status}</StatusBadge>
                  <span className="font-mono text-[11px] text-muted-foreground">{p.id}</span>
                  <span className="ml-auto text-[13px] text-muted-foreground tabular-nums">
                    {p.status === "open" ? `${fmtRelative(p.closes_at, now)}截止` : fmtDateTime(p.closes_at)} · 池 {fmtInt(p.total)} {d.currency}
                  </span>
                </div>
                {p.total === 0 ? (
                  <p className="text-[13px] text-muted-foreground">還沒有人下注</p>
                ) : (
                  <BarList
                    label={`${p.question} 的下注`}
                    format={(v) => `${fmtInt(v)} ${d.currency}`}
                    items={p.options.map((o, i) => ({
                      key: String(i),
                      label: (
                        <span className={p.winner === o.label ? "font-semibold text-foreground" : undefined}>
                          {o.label}
                          {p.winner === o.label && " · 猜中"}
                        </span>
                      ),
                      value: o.staked,
                      detail: `${o.backers} 人${o.multiplier === null ? "" : ` · 現在押 1 賠 ${o.multiplier}`}`,
                    }))}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </ModuleQuery>
    </Card>
  );
}

/** Her room: every item and how far the audience got funding it. */
export function RoomTab() {
  const q = useRoom();
  return (
    <Card>
      <CardHeader>
        <CardTitle>她的房間</CardTitle>
      </CardHeader>
      <ModuleQuery query={q} module={MODULE} isEmpty={(d) => d.room.length === 0} empty="房間裡還沒有可以集資的東西">
        {(d) => (
          <Table aria-label="房間的東西">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>東西</TableHead>
                <TableHead className="hidden w-24 md:table-cell">種類</TableHead>
                <TableHead className="w-56">集資</TableHead>
                <TableHead className="hidden w-24 text-right md:table-cell">幾個人</TableHead>
                <TableHead className="w-24">狀態</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.room.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-normal break-words">{r.label}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{r.kind_label}</TableCell>
                  <TableCell>
                    <div className="grid gap-1.5">
                      <span className="text-[13px] tabular-nums">
                        {fmtInt(r.funded)} <span className="text-muted-foreground">/ {fmtInt(r.price)} {d.currency}</span>
                        <span className="ml-2 text-muted-foreground">{r.price > 0 ? fmtPct(Math.min(1, r.funded / r.price)) : ""}</span>
                      </span>
                      <Meter value={r.price > 0 ? r.funded / r.price : 0} tone="brand" label={`${r.label} 的集資`} />
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">{r.backers}</TableCell>
                  <TableCell>{r.placed ? <StatusBadge tone="success">已擺上</StatusBadge> : <span className="text-muted-foreground">集資中</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ModuleQuery>
    </Card>
  );
}
