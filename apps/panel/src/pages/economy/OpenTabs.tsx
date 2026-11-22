import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { PredictionView } from "@miyoria/contracts/api";
import { isApiError } from "@/api/http";
import { useApi } from "@/app/connection";
import { queryKeys, useRoom } from "@/app/queries";
import { useAdminPredictions } from "@/app/queries-economy";
import { BarList } from "@/components/charts/charts";
import { ConfirmDialog } from "@/components/confirm";
import { ModuleQuery } from "@/components/module-query";
import { Meter, StatusBadge, type Tone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtInt, fmtPct, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { PREDICTION_STATUS_LABEL, SETTLED_BY_LABEL } from "./labels";

const MODULE = "經濟(economy 模組)";
const DENIED = "你的帳號沒有結算預測的權限(需要 admin.economy.adjust)";

/** What the owner's hand on one prediction is: one option wins, or it is called off. */
type Settle = { id: string; question: string; option: string | null };

function useSettlePrediction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: Settle) =>
      s.option === null
        ? api.rpc.economy.cancelPrediction({ params: { id: s.id } })
        : api.rpc.economy.resolvePrediction({ params: { id: s.id }, body: { option: s.option } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.predictions }),
  });
}

/** The owner settles or calls off one still waiting, even one that settles by itself. */
function SettleControls({ p, denied, onAsk }: { p: PredictionView; denied: boolean; onAsk: (s: Settle) => void }) {
  if (p.status !== "open" && p.status !== "closed") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {p.options.map((o) => (
        <Button
          key={o.label}
          size="sm"
          variant="outline"
          writes
          disabled={denied}
          title={denied ? DENIED : undefined}
          onClick={() => onAsk({ id: p.id, question: p.question, option: o.label })}
        >
          結算為「{o.label}」
        </Button>
      ))}
      <Button size="sm" variant="ghost" writes disabled={denied} title={denied ? DENIED : undefined} onClick={() => onAsk({ id: p.id, question: p.question, option: null })}>
        取消並退回
      </Button>
    </div>
  );
}

/** How it settles while it waits, then who settled it and when. */
function HowSettled({ p }: { p: PredictionView }) {
  const s = p.settled_by;
  if (s === null) return <p className="text-[13px] text-muted-foreground">{p.settles.label}</p>;
  return (
    <p className="text-[13px] text-muted-foreground">
      {SETTLED_BY_LABEL[s.by] ?? s.by} · {s.note}
      {s.who ? ` · ${s.who}` : ""} · {fmtDateTime(s.at)}
    </p>
  );
}

const STATUS_TONE: Record<string, Tone> = { open: "brand", closed: "warning", resolved: "neutral", cancelled: "neutral" };

/**
 * Predictions open now and the ones settled lately, with where the stakes stand, how each settles
 * (or who settled it), and the owner's hand on the ones still waiting. Settling needs
 * `admin.economy.adjust`; the session does not say which nodes it holds, so a `403` is what tells.
 * With two or more servers: the predictions of the server the page is about (`?space=`), each
 * opened and bet on there only.
 */
export function PredictionsTab() {
  const { query: q, multiple, space } = useAdminPredictions();
  const now = q.dataUpdatedAt > 0 ? q.dataUpdatedAt : Date.now();
  const settle = useSettlePrediction();
  const [asked, setAsked] = useState<Settle | null>(null);
  const [shown, setShown] = useState<Settle | null>(null);
  const [denied, setDenied] = useState(false);
  const ask = (s: Settle) => {
    setAsked(s);
    setShown(s);
  };
  const run = () => {
    if (asked === null) return;
    settle.mutate(asked, {
      onSuccess: (r) => {
        notify.ok(r.settled.refunded ? `退回了 ${fmtInt(r.settled.pool)} ${r.currency}` : `結算了:「${r.settled.winner}」`);
        setAsked(null);
      },
      onError: (err) => {
        if (isApiError(err) && err.status === 403) {
          setDenied(true);
          setAsked(null);
        }
        notify.error(err);
      },
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>預測</CardTitle>
      </CardHeader>
      {multiple && space && <p className="text-[13px] text-muted-foreground">{space.name} 的預測:只有那個伺服器的成員看得到、能押。</p>}
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
                <HowSettled p={p} />
                <SettleControls p={p} denied={denied} onAsk={ask} />
              </li>
            ))}
          </ul>
        )}
      </ModuleQuery>
      {denied && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {DENIED}
        </p>
      )}
      <ConfirmDialog
        open={asked !== null}
        title={shown?.option === null ? "取消這個預測" : "結算這個預測"}
        confirmLabel={shown?.option === null ? "取消並退回" : "結算"}
        busy={settle.isPending}
        onConfirm={run}
        onClose={() => setAsked(null)}
      >
        <p>
          {shown?.option === null
            ? `「${shown?.question ?? ""}」取消,押的全部退回。`
            : `「${shown?.question ?? ""}」照「${shown?.option ?? ""}」結算:押中的人平分大家押的(抽成燒掉),其他人的不退。會自己結算的預測也會照你選的。`}
        </p>
      </ConfirmDialog>
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
