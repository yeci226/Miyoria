// 經濟 / 交易所: the deep-sea exchange as the owner sees it (docs/design/exchange.md), v1. The
// daily mint and burn report against the payout cap (off by default) and whether the books
// balance, the net minted over today, 7 and 30 days against the coins in wallets with a warning
// past its line, the provider's
// last problem and the refresh the budget allows, the tickers people added (block for buying,
// unblock, remove one nobody holds; a split-like jump to confirm; a suspended ticker to settle at
// its last price or at zero), who is bankrupt, and every open position with a sale by hand. Every
// change asks first, needs `admin.economy.adjust` and is written to the audit log. The master
// switch and the parameters (fees, caps, the fixed rates) are in 系統 / 交易所 or the file; a rate
// change re-values everyone's holdings at once, which its field warns about.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ExchangeAdmin } from "@miyoria/contracts/api";
import { isApiError } from "@/api/http";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { ModuleQuery } from "@/components/module-query";
import { EmptyLine } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { notify } from "@/lib/notify";
import { WORLD } from "@/lib/world";

const KEY = ["exchange", "admin"] as const;
const DENIED = "你的帳號沒有交易所的權限(需要 admin.economy.adjust)";
const isDenied = (e: unknown) => isApiError(e) && e.status === 403;

const STATUS: Record<string, string> = {
  active: "正常",
  blocked: "只能賣",
  paused: "疑似分割,暫停",
  suspended: "沒有報價,暫停",
};

function useExchangeAdmin() {
  const api = useApi();
  return useQuery({ queryKey: KEY, queryFn: ({ signal }) => api.rpc.exchangeAdmin.view(undefined, { signal }), refetchInterval: 60_000, retry: false });
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function Report({ v }: { v: ExchangeAdmin }) {
  const r = v.report;
  const balanced = r.books.postings === r.books.lines;
  const warning = v.providers.find((p) => p.last_error !== null);
  return (
    <Card aria-label="今天">
      <CardHeader>
        <CardTitle>今天</CardTitle>
      </CardHeader>
      {warning && (
        <p role="alert" className="text-[13px] text-primary">
          {`報價來源 ${warning.id} 的問題:${warning.last_error}。沒有有效報價時不成交、也不自動賣出。`}
        </p>
      )}
      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        <Fact label="交易所">{v.enabled ? "開" : "關(open = false)"}</Fact>
        <Fact label="今天燒掉">{fmtInt(r.today.burned)}</Fact>
        <Fact label="今天發出">{fmtInt(r.today.minted)}</Fact>
        <Fact label="淨發出 / 上限">{`${fmtInt(r.today.net)} / ${r.cap_daily > 0 ? fmtInt(r.cap_daily) : "不限"}`}</Fact>
        <Fact label="買進">{r.today.buys_halted ? "今天停了(到上限)" : "照常"}</Fact>
        <Fact label="吸收的虧損">{fmtInt(r.today.written_off)}</Fact>
        <Fact label="帳">{balanced ? "對得上" : `對不上(錢包 ${r.books.postings}、交易所 ${r.books.lines})`}</Fact>
        <Fact label="還沒入帳">{fmtInt(r.books.pending)}</Fact>
        <Fact label="報價更新">{`約每 ${v.refresh_seconds} 秒`}</Fact>
        <Fact label="固定匯率">{`1 ${COIN} = NT$${v.rates.twd_per_coin}・1 美元 = NT$${v.rates.twd_per_usd}`}</Fact>
      </dl>
      <p className="text-xs text-muted-foreground">改匯率會讓所有人的台股、美股持股市值一起變(股數不變)。匯率在 系統 / 經濟(twd_per_coin)和 系統 / 交易所(twd_per_usd)。</p>
      {r.days.length > 0 && (
        <ul className="divide-y divide-line-soft">
          {r.days.slice(0, 14).map((d) => (
            <li key={d.day} className="flex items-baseline gap-3 py-(--row-y) text-sm">
              <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">{d.date}</span>
              <span className="min-w-0 flex-1 tabular-nums">{`燒 ${fmtInt(d.burned)}・發 ${fmtInt(d.minted)}・淨 ${fmtInt(d.net)}・吸收 ${fmtInt(d.written_off)}`}</span>
            </li>
          ))}
        </ul>
      )}
      {r.bankrupt.length > 0 && <p className="text-[13px]">{`破產冷靜期中:${r.bankrupt.map((b) => `${b.name}(到 ${fmtDateTime(b.until)})`).join("、")}`}</p>}
    </Card>
  );
}

/** The coins' name in this profile (`lib/world.ts`). */
const COIN = WORLD.currency;
const WINDOW: Record<number, string> = { 1: "今天", 7: "7 天", 30: "30 天" };
const share = (x: number | null) => (x === null ? "—" : `${(Math.round(x * 1000) / 10).toFixed(1)}%`);
const signedInt = (n: number) => (n > 0 ? `+${fmtInt(n)}` : fmtInt(n));

/**
 * 魚幣發出: with the caps off by default nothing bounds what the exchange mints, so the owner sees
 * its net over today, 7 and 30 days against all coins in wallets, and a plain warning past the line
 * (`mint_warn_share`). A warning only: nothing is halted by it.
 */
function Mint({ v }: { v: ExchangeAdmin }) {
  const mint = v.report.mint;
  return (
    <Card aria-label={`${COIN}發出`}>
      <CardHeader>
        <CardTitle>{`${COIN}發出`}</CardTitle>
      </CardHeader>
      {mint.warning && (
        <p role="alert" className="text-[13px] text-primary">
          {mint.warning}
        </p>
      )}
      <ul className="divide-y divide-line-soft">
        {mint.windows.map((w) => (
          <li key={w.days} className="flex flex-wrap items-baseline gap-x-6 gap-y-1 py-(--row-y) text-sm tabular-nums">
            <span className="w-14 shrink-0 text-muted-foreground">{WINDOW[w.days] ?? `${w.days} 天`}</span>
            <span>{`淨發出 ${signedInt(w.net)}`}</span>
            <span className="text-muted-foreground">{`發出 ${fmtInt(w.minted)}・燒掉 ${fmtInt(w.burned)}`}</span>
            <span>{`占流通 ${share(w.share)}`}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {`流通中的${COIN}(所有錢包合計):${mint.circulation === null ? "經濟模組沒有提供" : fmtInt(mint.circulation)}。7 天淨發出超過 ${share(mint.warn_share)} 時這裡提醒(只是提醒)。上限預設不開:每天最多淨發出、一筆最多、一天最多買、持有上限、保證金上限,在 系統 / 交易所 填數字就會生效。`}
      </p>
    </Card>
  );
}

type Action =
  | { kind: "ticker"; code: string; action: "block" | "unblock" | "remove" }
  | { kind: "split"; code: string }
  | { kind: "name"; code: string; provider: string; current: string | null }
  | { kind: "settle"; code: string; at: "last" | "zero" }
  | { kind: "sell"; position: string; label: string };

function Tickers({ v, denied, onDenied }: { v: ExchangeAdmin; denied: boolean; onDenied: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [ask, setAsk] = useState<Action | null>(null);
  const [ratio, setRatio] = useState("");
  const [name, setName] = useState("");
  const run = useMutation({
    mutationFn: async (a: Action) => {
      if (a.kind === "ticker") await api.rpc.exchangeAdmin.ticker({ body: { code: a.code, action: a.action } });
      else if (a.kind === "split") await api.rpc.exchangeAdmin.split({ body: { code: a.code, ratio: Number(ratio) } });
      else if (a.kind === "name") await api.rpc.exchangeAdmin.name({ body: { code: a.code, name: name.trim() === "" ? null : name.trim() } });
      else if (a.kind === "settle") await api.rpc.exchangeAdmin.settle({ body: { code: a.code, at: a.at } });
      else await api.rpc.exchangeAdmin.sell({ body: { position: a.position } });
    },
    onSuccess: () => {
      setAsk(null);
      notify.ok("好了,記在稽核紀錄");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => {
      if (isDenied(e)) onDenied();
      notify.error(e);
    },
  });
  const title =
    ask === null
      ? ""
      : ask.kind === "ticker"
        ? `${ask.action === "block" ? "停止買進" : ask.action === "unblock" ? "恢復買進" : "移除"} ${ask.code}`
        : ask.kind === "split"
          ? `確認 ${ask.code} 分割`
          : ask.kind === "name"
            ? `${ask.code} 的顯示名稱`
          : ask.kind === "settle"
            ? `結算 ${ask.code}(${ask.at === "last" ? "最後價格" : "歸零"})`
            : `賣掉 ${ask.label}`;
  return (
    <>
      <Card aria-label="股票">
        <CardHeader>
          <CardTitle>股票</CardTitle>
        </CardHeader>
        {denied && <p className="text-[13px] text-muted-foreground">{DENIED}</p>}
        {v.tickers.length === 0 ? (
          <EmptyLine>還沒有人查過任何股票</EmptyLine>
        ) : (
          <ul className="divide-y divide-line-soft">
            {v.tickers.map((t) => (
              <li key={t.code} className="flex flex-wrap items-center gap-3 py-(--row-y) text-sm">
                <span className="w-24 shrink-0 font-mono text-[13px] font-medium">{t.code}</span>
                <span className="min-w-0 flex-1 truncate" title={t.provider_name}>
                  {`${t.name}${t.name_override ? "(你取的)" : ""}・${t.exchange} ${t.type}・${t.holders} 人持有`}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{`${STATUS[t.status] ?? t.status}${t.missing_days > 0 ? `・${t.missing_days} 天沒報價` : ""}`}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={denied}
                  onClick={() => {
                    setName(t.name_override ?? "");
                    setAsk({ kind: "name", code: t.code, provider: t.provider_name, current: t.name_override });
                  }}
                >
                  改名稱
                </Button>
                {t.market !== "local" && (
                  <span className="flex shrink-0 gap-1.5">
                    {t.status === "blocked" ? (
                      <Button size="sm" variant="outline" disabled={denied} onClick={() => setAsk({ kind: "ticker", code: t.code, action: "unblock" })}>
                        恢復買進
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={denied} onClick={() => setAsk({ kind: "ticker", code: t.code, action: "block" })}>
                        停止買進
                      </Button>
                    )}
                    {t.status === "paused" && (
                      <Button size="sm" variant="outline" disabled={denied} onClick={() => setAsk({ kind: "split", code: t.code })}>
                        確認分割
                      </Button>
                    )}
                    {t.status === "suspended" && (
                      <>
                        <Button size="sm" variant="outline" disabled={denied} onClick={() => setAsk({ kind: "settle", code: t.code, at: "last" })}>
                          照最後價格結算
                        </Button>
                        <Button size="sm" variant="outline" disabled={denied} onClick={() => setAsk({ kind: "settle", code: t.code, at: "zero" })}>
                          歸零結算
                        </Button>
                      </>
                    )}
                    {t.holders === 0 && (
                      <Button size="sm" variant="outline" disabled={denied} onClick={() => setAsk({ kind: "ticker", code: t.code, action: "remove" })}>
                        移除
                      </Button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card aria-label="持股">
        <CardHeader>
          <CardTitle>持股</CardTitle>
        </CardHeader>
        {v.positions.length === 0 ? (
          <EmptyLine>沒有人持有任何股票</EmptyLine>
        ) : (
          <ul className="divide-y divide-line-soft">
            {v.positions.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-(--row-y) text-sm">
                <span className="min-w-0 flex-1 truncate">{`${p.name}・${p.code}${p.leverage > 1 ? "・2 倍" : ""}`}</span>
                <span className="shrink-0 tabular-nums">{p.value === null ? "—" : fmtInt(Math.floor(p.value))}</span>
                <Button size="sm" variant="outline" disabled={denied} onClick={() => setAsk({ kind: "sell", position: p.id, label: `${p.name} 的 ${p.code}` })}>
                  賣掉
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog open={ask !== null} title={title} confirmLabel="確定" busy={run.isPending} onConfirm={() => ask && run.mutate(ask)} onClose={() => setAsk(null)}>
        {ask?.kind === "name" ? (
          <div className="grid gap-1">
            <label htmlFor="exchange-name" className="text-xs">
              顯示名稱(最多 60 字;空白 = 用熱門清單的名稱,沒有就用報價來源的)
            </label>
            <Input id="exchange-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <p className="text-xs text-muted-foreground">{`報價來源的名稱:${ask.provider}。這會寫進稽核紀錄。`}</p>
          </div>
        ) : ask?.kind === "split" ? (
          <div className="grid gap-1">
            <label htmlFor="exchange-split-ratio" className="text-xs">
              每一股變成幾股(1 拆 4 就填 4,4 合 1 就填 0.25)
            </label>
            <Input id="exchange-split-ratio" inputMode="decimal" value={ratio} onChange={(e) => setRatio(e.target.value)} />
          </div>
        ) : ask?.kind === "settle" ? (
          <p>{ask.at === "last" ? "所有持股照最後一筆有效價格賣掉。" : `所有持股以 0 結算,持有的人拿不回${COIN}。`}這會寫進稽核紀錄。</p>
        ) : ask?.kind === "sell" ? (
          <p>照最新報價賣掉,不收手續費;這會寫進稽核紀錄。</p>
        ) : (
          <p>這會寫進稽核紀錄。</p>
        )}
      </ConfirmDialog>
    </>
  );
}

/** The day's report, the tickers, the positions. */
export function ExchangeTab() {
  const q = useExchangeAdmin();
  const [denied, setDenied] = useState(false);
  return (
    <ModuleQuery query={q} module="交易所(exchange 模組)">
      {(v) => (
        <div className="grid gap-(--stage-gap)">
          <Report v={v} />
          <Mint v={v} />
          <Tickers v={v} denied={denied} onDenied={() => setDenied(true)} />
        </div>
      )}
    </ModuleQuery>
  );
}
