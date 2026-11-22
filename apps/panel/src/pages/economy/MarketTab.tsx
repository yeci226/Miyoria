// 經濟 / 市集: the weekly market as the owner sees it (docs/design/v5-play.md §11.4). The lots that ran
// and the lottery weeks drawn (`GET /api/market/history`), then the hand on it: set or skip the coming
// week's lot (from the kinds the config offers; the coming opening and its plan are shown), end the
// auction or draw the lottery now. Those two need `admin.economy.adjust`; the
// session does not say which nodes it holds, so a `403` is what tells, and the controls then say why.

import { type FormEvent, useId, useState } from "react";
import type { LotPlan, LotPlanRequest, MarketHistory, SettleRequest } from "@miyoria/contracts/api";
import { describeError, isApiError } from "@/api/http";
import { useMarketHistory, usePlanLot, useSettleMarket } from "@/app/queries";
import { useAdminSpace } from "@/app/space";
import { useCanWrite } from "@/app/session";
import { ConfirmDialog } from "@/components/confirm";
import { ModuleQuery } from "@/components/module-query";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { notify } from "@/lib/notify";
import { LOT_KIND, LOT_STATE, PICKED_BY, WEEK_STATE } from "@/pages/public/market-labels";

const MODULE = "市集(market 模組)";
const DENIED = "你的帳號沒有市集的權限(需要 admin.economy.adjust)";
const NOTE_MAX = 200;

type Plan = LotPlanRequest["lot"];

/** What the plan can be: the kinds the config offers (`offered`; the default is the frame alone), or no lot. */
const planOptions = (offered: MarketHistory["offered"]): { value: Plan; label: string }[] => [
  ...offered.map((k) => ({ value: k, label: LOT_KIND[k] })),
  { value: "skip", label: "這一週不拍" },
];

const planLabel = (p: LotPlan["plan"]) => (p === "skip" ? "不拍" : LOT_KIND[p]);

const isDenied = (e: unknown) => isApiError(e) && e.status === 403;

function Lots({ lots }: { lots: MarketHistory["lots"] }) {
  return (
    <Table aria-label="拍賣紀錄">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-24 md:w-36">開始</TableHead>
          <TableHead className="min-w-[7rem]">拍品</TableHead>
          <TableHead className="hidden w-24 md:table-cell">誰挑的</TableHead>
          <TableHead className="min-w-[4.5rem] md:w-28">狀態</TableHead>
          <TableHead className="min-w-[5rem] md:w-36">得標</TableHead>
          <TableHead className="hidden w-28 text-right md:table-cell">出價</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lots.map((l) => (
          <TableRow key={l.id}>
            <TableCell className="text-[13px] whitespace-normal text-muted-foreground tabular-nums md:whitespace-nowrap">{fmtDateTime(l.opens_at)}</TableCell>
            <TableCell className="whitespace-normal break-words">
              {l.name}
              {l.note && <p className="text-xs text-muted-foreground">{l.note}</p>}
              {l.call_name && <p className="text-xs text-muted-foreground">「{l.call_name}」</p>}
            </TableCell>
            <TableCell className="hidden text-muted-foreground md:table-cell">{PICKED_BY[l.picked_by] ?? l.picked_by}</TableCell>
            <TableCell>
              {LOT_STATE[l.state] ?? l.state}
              {l.extended && <p className="text-xs text-muted-foreground">延長過</p>}
            </TableCell>
            <TableCell className="whitespace-normal break-words tabular-nums">
              {l.winner ? (
                <>
                  {l.winner.name} <span className="text-muted-foreground">{fmtInt(l.winner.price)}</span>
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
              {fmtInt(l.bids)} 次 · {fmtInt(l.bidders)} 人
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Weeks({ weeks }: { weeks: MarketHistory["weeks"] }) {
  return (
    <Table aria-label="樂透紀錄">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-24 md:w-36">開獎</TableHead>
          <TableHead className="text-right md:w-28">賣出</TableHead>
          <TableHead className="text-right md:w-20">獎池</TableHead>
          <TableHead className="hidden w-20 text-right md:table-cell">獎金</TableHead>
          <TableHead className="hidden w-20 text-right md:table-cell">燒掉</TableHead>
          <TableHead className="min-w-[5rem]">中獎</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {weeks.map((w) => (
          <TableRow key={w.week}>
            <TableCell className="text-[13px] whitespace-normal text-muted-foreground tabular-nums md:whitespace-nowrap">
              {w.drawn_at ? fmtDateTime(w.drawn_at) : "—"}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtInt(w.tickets)} 張 · {fmtInt(w.buyers)} 人
            </TableCell>
            <TableCell className="text-right tabular-nums">{fmtInt(w.pot)}</TableCell>
            <TableCell className="hidden text-right tabular-nums md:table-cell">{fmtInt(w.prize)}</TableCell>
            <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">{fmtInt(w.burned)}</TableCell>
            <TableCell className="whitespace-normal break-words">
              {w.state === "refunded" || w.winner === null ? <span className="text-muted-foreground">{WEEK_STATE[w.state]}</span> : w.winner}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function NextLot({
  history,
  denied,
  onDenied,
}: {
  history: MarketHistory;
  denied: boolean;
  onDenied: () => void;
}) {
  // The server the page is about (the shell's switcher); each has its own market.
  const plan = usePlanLot(useAdminSpace().space);
  const canWrite = useCanWrite();
  const id = useId();
  const [choice, setChoice] = useState<Plan | null>(null);
  const [note, setNote] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const next = history.next;
  const off = denied || !canWrite;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (choice === null || off) return;
    const trimmed = note.trim();
    plan.mutate(trimmed === "" ? { lot: choice } : { lot: choice, note: trimmed }, {
      onSuccess: (r) => {
        setRefused(null);
        setNote("");
        notify.ok(`${fmtDateTime(r.opens_at)} 那一場:${planLabel(r.plan)}`);
      },
      onError: (err) => {
        if (isDenied(err)) onDenied();
        setRefused(describeError(err));
      },
    });
  };
  return (
    <Card aria-label="下一場拍賣">
      <CardHeader>
        <CardTitle>下一場拍賣</CardTitle>
      </CardHeader>
      {next ? (
        <p className="text-sm">
          {fmtDateTime(next.opens_at)} 那一場:
          <span className="font-medium">{next.plan === null ? "由她挑" : planLabel(next.plan)}</span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">拍賣現在沒有開(沒有開或沒有設頻道)</p>
      )}
      <form className="grid gap-3" onSubmit={submit}>
        <div className="grid gap-2">
          <p className="text-[13px] font-medium">拍什麼</p>
          <Segmented<Plan> label="下一場拍什麼" value={choice} options={planOptions(history.offered)} onChange={setChoice} disabled={off} size="md" />
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="grid gap-2">
            <Label htmlFor={id}>備註</Label>
            <Input id={id} maxLength={NOTE_MAX} value={note} disabled={off} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button type="submit" variant="secondary" writes busy={plan.isPending} disabled={choice === null || denied} title={denied ? DENIED : undefined}>
            設定
          </Button>
        </div>
        {refused && (
          <p role="alert" className="text-[13px] text-primary">
            {refused}
          </p>
        )}
        <p className="text-xs text-muted-foreground">沒有設定就由她挑。這一週的已經開始的話,設定的是下一週的。</p>
      </form>
    </Card>
  );
}

const SETTLE: Record<SettleRequest["what"], { title: string; confirm: string; body: string }> = {
  auction: {
    title: "現在結束這一場拍賣",
    confirm: "結束拍賣",
    body: "最高出價的人馬上得標,得標的錢燒掉,其他人押著的還回去。沒有人出價就什麼都不發生。",
  },
  lottery: {
    title: "現在開這一週的樂透",
    confirm: "開獎",
    body: "人數夠就馬上抽出中獎的人並發獎金;不夠就每一筆全額退回。",
  },
};

function SettleNow({ denied, onDenied }: { denied: boolean; onDenied: () => void }) {
  const settle = useSettleMarket(useAdminSpace().space);
  // What is asked stays while the dialog closes, so its words do not blank out mid-fade.
  const [what, setWhat] = useState<SettleRequest["what"]>("auction");
  const [open, setOpen] = useState(false);
  const askFor = (w: SettleRequest["what"]) => {
    setWhat(w);
    setOpen(true);
  };
  const run = () => {
    settle.mutate(what, {
      onSuccess: () => {
        notify.ok(what === "auction" ? "拍賣結束了" : "樂透開過獎了");
        setOpen(false);
      },
      onError: (err) => {
        if (isDenied(err)) {
          onDenied();
          setOpen(false);
        }
        notify.error(err);
      },
    });
  };
  const ask = SETTLE[what];
  return (
    <Card aria-label="現在結算">
      <CardHeader>
        <CardTitle>現在結算</CardTitle>
      </CardHeader>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" writes disabled={denied} title={denied ? DENIED : undefined} onClick={() => askFor("auction")}>
          拍賣現在結束
        </Button>
        <Button variant="outline" writes disabled={denied} title={denied ? DENIED : undefined} onClick={() => askFor("lottery")}>
          樂透現在開獎
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title={ask.title}
        confirmLabel={ask.confirm}
        busy={settle.isPending}
        onConfirm={run}
        onClose={() => setOpen(false)}
      >
        <p>{ask.body}</p>
      </ConfirmDialog>
    </Card>
  );
}

/** The market's history first, then the owner's hand on the coming week. */
export function MarketTab() {
  const q = useMarketHistory(useAdminSpace().space);
  const [denied, setDenied] = useState(false);
  const deny = () => setDenied(true);
  const running = !q.isError;
  return (
    <div className="grid gap-(--stage-gap)">
      <Card aria-label="拍賣紀錄">
        <CardHeader>
          <CardTitle>拍賣紀錄</CardTitle>
        </CardHeader>
        <ModuleQuery query={q} module={MODULE} isEmpty={(d) => d.lots.length === 0} empty="還沒有拍賣紀錄">
          {(d) => <Lots lots={d.lots} />}
        </ModuleQuery>
      </Card>
      {running && (
        <>
          <Card aria-label="樂透紀錄">
            <CardHeader>
              <CardTitle>樂透紀錄</CardTitle>
            </CardHeader>
            <ModuleQuery query={q} module={MODULE} isEmpty={(d) => d.weeks.length === 0} empty="還沒有開過獎">
              {(d) => <Weeks weeks={d.weeks} />}
            </ModuleQuery>
          </Card>
          {denied && (
            <p role="status" className="text-[13px] text-muted-foreground">
              {DENIED}
            </p>
          )}
          <div className="grid items-start gap-(--stage-gap) lg:grid-cols-2">
            {q.data && <NextLot history={q.data} denied={denied} onDenied={deny} />}
            <SettleNow denied={denied} onDenied={deny} />
          </div>
        </>
      )}
    </div>
  );
}
