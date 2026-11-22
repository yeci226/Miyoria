// 深海交易所 on the member page (docs/design/exchange.md), v1: paper trading of real Taiwan and US
// stocks and the five local stocks with fish coins. The market's lists as tabs (新手推薦 · 這裡獨家
// first), a search box with the same suggestions as Discord, sortable columns, the watch list, the
// 熱力圖 tab (the server's holdings and the 熱門 lists as treemaps), a ticker's candle chart
// (當日 / 日線 / 週線 / 月線, MA5/20/60, volume, their own cost line) and the order ticket (coins
// by default, shares for the local stocks; 2× only
// where allowed, with the honest warning), their own holdings with the line where a 2× position is
// sold, the bankruptcy status, the rich list with the switch to stay off it (one server's members
// or everyone, `board-scope.tsx`; prices and holdings are global either way), and the rules. Every
// section ends with the exchange's small print. Everything is what `/api/member/exchange/*`
// answers; a refusal is the Core's own sentence. Moves always carry an arrow and a sign, never
// colour alone, and the colour follows the product's one convention (stated beside the table).

import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, lazy, type ReactNode, Suspense, useId, useMemo, useState } from "react";
import type {
  ExchangeAccount,
  ExchangeLine,
  ExchangeMarket,
  ExchangeOrderRequest,
  ExchangePortfolio,
  ExchangeQuote,
} from "@miyoria/contracts/api";
import { amountExamples, parseOrderAmount } from "@miyoria/types/exchange-amount";
import { isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { pushable, usePushed } from "@/app/push";
import { ChartEmpty } from "@/components/charts/charts";
import { ConfirmDialog } from "@/components/confirm";
import { OffLine } from "@/components/module-query";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtDateTime, fmtInt, fmtPct } from "@/lib/format";
import { notify } from "@/lib/notify";
import { readStorage, writeStorage } from "@/lib/storage";
import { WORLD } from "@/lib/world";
import { BoardScopePicker, useBoardScope } from "./board-scope";
import { newKey, WALLET } from "./spend";

// The candle chart (lightweight-charts) and the heat map (d3-hierarchy) load only when someone
// opens a ticker or the 熱力圖 tab: the page's own bundle does not carry either library.
const CandleChart = lazy(() => import("./exchange/CandleChart"));
const HeatMap = lazy(() => import("./exchange/HeatMap"));

const ROOT = ["member", "exchange"] as const;
const MARKET = [...ROOT, "market"] as const;
const ACCOUNT = [...ROOT, "account"] as const;
const PORTFOLIO = [...ROOT, "portfolio"] as const;
const BOARDS = [...ROOT, "boards"] as const;
const POLL_MS = 60_000;
const TAB_KEY = "miyoria.exchange.tab";
const TABS = ["market", "map", "mine", "boards", "rules"] as const;
type Tab = (typeof TABS)[number];
type Colors = ExchangeMarket["colors"];
type ListKind = ExchangeMarket["default_list"];

const retry = (n: number, e: Error) => !isNotProvided(e) && !(isApiError(e) && e.kind === "unavailable") && n < 2;
const poll = (q: { state: { error: unknown } }) => (q.state.error ? false : POLL_MS);

/** Millionths of a share as drawn: whole shares plainly, else four places. */
export const shares = (qty: number) => {
  const s = qty / 1_000_000;
  return Number.isInteger(s) ? String(s) : s.toFixed(4);
};
/** A change with its arrow and sign: `▲ +1.2%`, `▼ −0.8%`. */
export function change(x: number | null): string {
  if (x === null) return "—";
  const v = Math.round(x * 1000) / 10;
  if (v > 0) return `▲ +${v.toFixed(1)}%`;
  if (v < 0) return `▼ −${Math.abs(v).toFixed(1)}%`;
  return "0.0%";
}
/** The market's red and green (the same as the pictures). */
const RED = "#ef5f5f";
const GREEN = "#3fc48a";
export const upColor = (c: Colors) => (c === "us" ? GREEN : RED);
export const downColor = (c: Colors) => (c === "us" ? RED : GREEN);
const conventionWord = (c: Colors) => (c === "us" ? "綠漲紅跌(美股習慣)" : "紅漲綠跌(台股習慣)");
/** The coins' name and her pronoun in this profile (`lib/world.ts`). */
const COIN = WORLD.currency;
const HER = WORLD.pronoun;
const coins = (x: number | null) => (x === null ? "—" : x >= 100 ? fmtInt(Math.round(x)) : String(Math.round(x * 100) / 100));
const nativePrice = (l: ExchangeLine) =>
  l.price === null ? "—" : l.currency === "COIN" ? `${coins(l.price)} ${COIN}` : `${l.currency} ${l.price.toFixed(2)}`;

const WEEKDAY: Record<string, string> = { Sun: "日", Mon: "一", Tue: "二", Wed: "三", Thu: "四", Fri: "五", Sat: "六" };
const TAIPEI = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** `11/24(一)09:00` on Taipei's clock (the US open with its daylight saving comes from the Core). */
export function taipeiWhen(iso: string): string {
  const p = Object.fromEntries(TAIPEI.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.month}/${p.day}(${WEEKDAY[p.weekday ?? ""] ?? ""})${p.hour}:${p.minute}`;
}
/** When an order fills: at the next valid quote, or after the next open (Taipei time). */
export const fillsWhen = (nextOpen: string | null) =>
  nextOpen === null ? "下一筆有效報價成交" : `休市中:下一個開盤 ${taipeiWhen(nextOpen)}(台北時間)後第一筆有效報價成交,之前可以取消`;
/** A price's word: 現價, or what it is (`收盤價(11/20)・休市中`, `開盤參考價…`). */
const priceWord = (l: ExchangeLine) => (l.basis === "quote" ? "現價" : l.basis === null ? "價格" : (l.price_note ?? "價格"));

function useMarket() {
  const api = useApi();
  return useQuery({ queryKey: MARKET, queryFn: ({ signal }) => api.rpc.exchange.market(undefined, { signal }), refetchInterval: poll, retry });
}
function useAccount() {
  const api = useApi();
  return useQuery({ queryKey: ACCOUNT, queryFn: ({ signal }) => api.rpc.exchange.account(undefined, { signal }), refetchInterval: poll, retry });
}
function usePortfolio() {
  const api = useApi();
  return useQuery({ queryKey: PORTFOLIO, queryFn: ({ signal }) => api.rpc.exchange.portfolio(undefined, { signal }), refetchInterval: poll, retry });
}

/** After anything that moves coins or holdings: everything here, and the wallet. */
function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ROOT });
    void client.invalidateQueries({ queryKey: WALLET });
  };
}

function Loaded<T>({ query, rows = 3, children }: { query: UseQueryResult<T>; rows?: number; children: (data: T) => ReactNode }) {
  if (query.isPending) return <SkeletonRows count={rows} />;
  if (query.isError) return <ErrorLine error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function Move({ value, colors }: { value: number | null; colors: Colors }) {
  const color = value === null || value === 0 ? undefined : value > 0 ? upColor(colors) : downColor(colors);
  return (
    <span className="tabular-nums font-medium" style={color ? { color } : undefined}>
      {change(value)}
    </span>
  );
}

function Part({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-w-0 content-start gap-2">
      <h3 className="flex items-baseline justify-between gap-3 text-[13px] font-medium">
        {title}
        {aside && <span className="text-xs font-normal text-muted-foreground">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

/** The small print at the end of every section. */
export function SmallPrint({ m, real = true, leverage = false }: { m: ExchangeMarket; real?: boolean; leverage?: boolean }) {
  return (
    <p className="border-t border-line-soft pt-2 text-xs text-muted-foreground">
      {m.small_print.base}
      {real && m.small_print.real}
      {leverage && m.small_print.leverage}
    </p>
  );
}

// ---- 市場: lists, search, a ticker -----------------------------------------------------------

type SortKey = "code" | "price" | "coin" | "change";

function ListTable({ rows, colors, onPick, holders }: { rows: (ExchangeLine & { holders: number | null })[]; colors: Colors; onPick: (code: string) => void; holders: boolean }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "code", desc: false });
  const sorted = useMemo(() => {
    const v = (r: ExchangeLine) =>
      sort.key === "code" ? r.code : sort.key === "price" ? (r.price ?? -1) : sort.key === "coin" ? (r.coin_price ?? -1) : Math.abs(r.change ?? 0);
    return [...rows].sort((a, b) => {
      const x = v(a);
      const y = v(b);
      const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [rows, sort]);
  const head = (key: SortKey, label: string, className = "") => (
    <th scope="col" className={`py-1 font-normal ${className}`} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className="hover:text-foreground" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "code" }))}>
        {label}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
  if (rows.length === 0) return <EmptyLine>這個清單還沒有東西</EmptyLine>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          {head("code", "代號")}
          <th scope="col" className="py-1 font-normal">名稱</th>
          {head("price", "價格", "text-right")}
          {head("coin", `${COIN}一股`, "text-right")}
          {head("change", "漲跌", "text-right")}
          {holders && <th scope="col" className="py-1 text-right font-normal">持有人數</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-line-soft">
        {sorted.map((r) => (
          <tr key={r.code} className="hover:bg-hover">
            <td className="py-(--row-y)">
              <button type="button" className="font-mono text-[13px] font-medium underline-offset-2 hover:underline" onClick={() => onPick(r.code)}>
                {r.code}
              </button>
            </td>
            <td className="max-w-40 truncate py-(--row-y)">{r.name}</td>
            <td className="py-(--row-y) text-right tabular-nums">
              {nativePrice(r)}
              {r.basis !== null && r.basis !== "quote" && (
                <span className="block text-[11px] text-muted-foreground" title={r.price_note ?? undefined}>
                  {r.basis === "close" ? `收盤 ${r.price_date ? r.price_date.slice(5).replace("-", "/").replace(/^0/, "") : ""}` : "開盤參考價"}
                </span>
              )}
            </td>
            <td className="py-(--row-y) text-right tabular-nums">{r.currency === "COIN" ? "—" : coins(r.coin_price)}</td>
            <td className="py-(--row-y) text-right">
              <Move value={r.change} colors={colors} />
            </td>
            {holders && <td className="py-(--row-y) text-right tabular-nums">{r.holders ?? 0}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Search({ onPick }: { onPick: (code: string) => void }) {
  const api = useApi();
  const [q, setQ] = useState("");
  const id = useId();
  const typed = q.trim().slice(0, 24);
  const suggest = useQuery({
    queryKey: [...ROOT, "suggest", typed.toUpperCase()],
    queryFn: ({ signal }) => api.rpc.exchange.suggest({ query: { q: typed } }, { signal }),
    enabled: typed.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  const lookup = useMutation({
    mutationFn: (code: string) => api.rpc.exchange.lookup({ body: { code } }),
    onSuccess: (r) => {
      setQ("");
      onPick(r.instrument.code);
    },
    onError: (e) => notify.error(e),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (typed) lookup.mutate(typed);
  };
  return (
    <form className="grid gap-1" onSubmit={submit} role="search">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        找股票:台股代號(2330、0050)、美股代號(AAPL)或名稱
      </label>
      <div className="flex gap-2">
        <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        <Button type="submit" variant="outline" busy={lookup.isPending}>
          查詢
        </Button>
      </div>
      {typed && (suggest.data?.items.length ?? 0) > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="建議">
          {suggest.data?.items.slice(0, 10).map((s) => (
            <li key={s.code}>
              <Button type="button" variant="outline" size="sm" onClick={() => lookup.mutate(s.code)}>
                {`${s.code} ${s.name}`}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function Ticker({ m, code, onBack }: { m: ExchangeMarket; code: string; onBack: () => void }) {
  const api = useApi();
  const refresh = useRefresh();
  // Its price by push while a stream is there (a minute's quotes show within seconds), else polled.
  const key = [...ROOT, "ticker", code] as const;
  const pushed = usePushed("exchange_ticker", code, key, pushable(code));
  const ticker = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.rpc.exchange.ticker({ params: { code } }, { signal }),
    refetchInterval: pushed ? false : poll,
    retry,
  });
  const watch = useMutation({
    mutationFn: (on: boolean) => api.rpc.exchange.watch({ body: { code, on } }),
    onSuccess: (r) => {
      notify.ok(r.watching ? "加入觀察了" : "取消觀察了");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  return (
    <Loaded query={ticker} rows={5}>
      {(t) => (
        <div className="grid gap-6">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onBack}>
              回清單
            </Button>
            <Button variant="outline" size="sm" busy={watch.isPending} onClick={() => watch.mutate(!t.watching)}>
              {t.watching ? "取消觀察" : "加入觀察"}
            </Button>
          </div>
          <Suspense fallback={<ChartEmpty height={288}>載入 K 線…</ChartEmpty>}>
            <CandleChart code={t.line.code} title={`${t.line.code} ${t.line.name}`} colors={m.colors} open={t.line.open} move={<Move value={t.line.change} colors={m.colors} />} />
          </Suspense>
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <Fact label={priceWord(t.line)}>{nativePrice(t.line)}</Fact>
            {t.line.currency !== "COIN" && <Fact label={`約${COIN}一股`}>{coins(t.line.coin_price)}</Fact>}
            <Fact label="漲跌">
              <Move value={t.line.change} colors={m.colors} />
            </Fact>
            <Fact label={t.line.basis === "close" ? "收盤時間" : "報價時間"}>
              {t.line.basis === "reference" ? "還沒有第一筆價格" : t.line.at ? `${fmtDateTime(t.line.at)}${t.line.age_minutes !== null ? `(約 ${t.line.age_minutes} 分鐘前)` : ""}` : "還沒有報價"}
            </Fact>
            <Fact label="市場">{t.line.open ? "開盤中" : t.line.next_open ? `休市・下一個開盤 ${taipeiWhen(t.line.next_open)}` : "休市"}</Fact>
          </dl>
          {t.line.stale && <p className="text-[13px] text-muted-foreground">報價太舊,暫停成交;持股不會因為沒有報價被賣出。</p>}
          {t.line.basis !== null && t.line.basis !== "quote" && (
            <p className="text-[13px] text-muted-foreground">
              {`${t.line.price_note ?? ""}:這是最後知道的價格,只用來顯示和估算持股市值;下單會在${t.line.next_open ? `下一個開盤 ${taipeiWhen(t.line.next_open)}(台北時間)後` : "下一筆有效報價"}成交。`}
            </p>
          )}
          <p className="text-[13px] text-muted-foreground">{t.line.local ? t.line.local.what_moves : t.line.source}</p>
          {t.line.local?.today && <p className="text-[13px] tabular-nums">{t.line.local.today}</p>}
          <OrderPart m={m} line={t.line} />
          <SmallPrint m={m} real={t.line.local === null} />
        </div>
      )}
    </Loaded>
  );
}

function MarketTab({ m, code, setCode }: { m: ExchangeMarket; code: string | null; setCode: (code: string | null) => void }) {
  const api = useApi();
  const [list, setList] = useState<ListKind>(m.default_list);
  const key = [...ROOT, "list", list] as const;
  const pushed = usePushed("exchange_list", list, key, code === null);
  const rows = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.rpc.exchange.list({ params: { kind: list } }, { signal }),
    refetchInterval: pushed ? false : poll,
    retry,
  });
  if (code !== null) return <Ticker m={m} code={code} onBack={() => setCode(null)} />;
  return (
    <div className="grid gap-6">
      {list === "local" && m.default_list === "local" && (
        <div className="grid gap-1 text-[13px]">
          <p className="font-medium">{`第一次來?這裡用${COIN}買賣股票,只是遊戲:`}</p>
          <p className="text-muted-foreground">{`・新手推薦的五檔是這裡獨家,一股約 100 ${COIN}、單日漲跌最多 ±10%、不開放槓桿`}</p>
          <p className="text-muted-foreground">・台股和美股照真實報價,可以買零股;每筆收 {fmtPct(m.rules.fee, 1)} 手續費,燒掉</p>
        </div>
      )}
      <Search onPick={setCode} />
      <Tabs value={list} onValueChange={(v) => setList(v as ListKind)} className="gap-3">
        <TabsList variant="inline" aria-label="清單">
          {m.lists.map((l) => (
            <TabsTrigger key={l.kind} value={l.kind}>
              {l.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <p className="text-xs text-muted-foreground">{`顏色:${conventionWord(m.colors)};漲跌也一律標 ▲▼ 和正負號`}</p>
      <Loaded query={rows} rows={5}>
        {(l) => <ListTable rows={l.rows} colors={m.colors} onPick={setCode} holders={l.kind === "popular"} />}
      </Loaded>
      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        {m.sessions.map((s) => (
          <Fact key={s.market} label={s.market === "tw" ? "台股" : s.market === "us" ? "美股" : s.market}>
            {`${s.hours} ${s.open ? "開盤中" : "休市"}${s.stale ? "・報價停滯" : ""}`}
          </Fact>
        ))}
        <Fact label="固定匯率">{`1 ${COIN} = NT$${m.rates.twd_per_coin}・1 美元 = NT$${m.rates.twd_per_usd}`}</Fact>
      </dl>
      {m.house.buys_halted && <p className="text-[13px] text-muted-foreground">{`今天交易所發出的${COIN}到上限了,今天停止買進(賣出照常)。`}</p>}
      <SmallPrint m={m} real={list !== "local"} />
    </div>
  );
}

/** A cap as the rules say it: `0` is none. */
const capText = (n: number, unit = "") => (n > 0 ? `${fmtInt(n)}${unit}` : "不限");

// ---- the order ticket ------------------------------------------------------------------------

function OpenAccount({ account }: { account: ExchangeAccount }) {
  const api = useApi();
  const refresh = useRefresh();
  const open = useMutation({
    mutationFn: () => api.rpc.exchange.open(),
    onSuccess: () => {
      notify.ok("開好戶了");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  return (
    <div className="grid gap-2">
      <p className="text-sm">還沒開戶。開戶不花錢;開了之後才能買賣。</p>
      {account.cannot_open ? (
        <p role="alert" className="text-[13px] text-primary">
          {account.cannot_open}
        </p>
      ) : (
        <Button className="justify-self-start" busy={open.isPending} onClick={() => open.mutate()}>
          開戶
        </Button>
      )}
    </div>
  );
}

/** What the 2× opt-in says, in full (owner 2026-11-21). */
export const LEVERAGE_RISKS = [
  "2 倍:放進去的保證金 M,可以買到 2M 的部位;漲跌都是兩倍。",
  "賠的可能超過保證金:不夠的部分先從你的錢包扣,再賣掉你其他的持股來補。最壞會賠光錢包和其他持股。",
  "不會欠錢:全部賠光時,剩下的由交易所吸收,你會進入破產冷靜期,所有持股結清,一段時間內不能買進。",
  "每一筆報價都會檢查;價格跳空時,可能沒有先通知就被自動賣出。",
  "只有一股夠貴、有前一天收盤價的股票才能用 2 倍;新手推薦的獨家股票不開放。",
  `這是市場的規則,不是${HER}做的決定;${HER}不會評論任何人的部位。`,
];

function LeverageOptIn({ m, account }: { m: ExchangeMarket; account: ExchangeAccount }) {
  const api = useApi();
  const refresh = useRefresh();
  const [asking, setAsking] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const id = useId();
  const opt = useMutation({
    mutationFn: () => api.rpc.exchange.leverage({ body: { accept: true } }),
    onSuccess: () => {
      setAsking(false);
      notify.ok("可以用 2 倍了");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  if (!m.rules.leverage || account.leverage.opted_in) return null;
  if (!account.leverage.allowed) return account.leverage.why ? <p className="text-xs text-muted-foreground">2 倍:{account.leverage.why}</p> : null;
  return (
    <>
      <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setAsking(true)}>
        開啟 2 倍
      </Button>
      <ConfirmDialog open={asking} title="開啟 2 倍之前" confirmLabel="我了解,開啟" busy={opt.isPending} confirmDisabled={!agreed} onConfirm={() => opt.mutate()} onClose={() => setAsking(false)}>
        <div className="grid gap-2">
          <ul className="grid list-disc gap-1 pl-5">
            {LEVERAGE_RISKS.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <SmallPrint m={m} leverage />
          <div className="flex items-center gap-2">
            <Checkbox id={id} checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} />
            <label htmlFor={id}>我看過了,知道可能賠掉保證金以外的錢,最壞會賠光錢包和其他持股</label>
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}

function QuoteBody({ q, m }: { q: ExchangeQuote; m: ExchangeMarket }) {
  return (
    <div className="grid gap-3">
      <p className="font-medium text-foreground">{q.sentence}</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-foreground">
        <Fact label="標的">{q.code}</Fact>
        <Fact label={q.price_note ? `${q.price_note.split("・")[0]}(${COIN}一股)` : `現價(${COIN}一股)`}>{coins(q.price)}</Fact>
        {q.side === "buy" ? (
          <>
            <Fact label="付出">{`${fmtInt(q.coins)} ${m.currency}`}</Fact>
            <Fact label="約買到">{`${shares(q.qty)} 股`}</Fact>
            <Fact label="手續費(燒掉)">{fmtInt(q.fee)}</Fact>
            {q.line_price !== null && <Fact label="跌到這裡自動賣出">{coins(q.line_price)}</Fact>}
          </>
        ) : (
          <>
            <Fact label="賣出股數">{shares(q.qty)}</Fact>
            <Fact label="約收到">{fmtInt(q.gross)}</Fact>
            <Fact label="手續費">{fmtInt(q.fee)}</Fact>
            <Fact label="約拿回">{`${fmtInt(q.net)} ${m.currency}`}</Fact>
          </>
        )}
      </dl>
      {q.warning && <p className="text-[13px] font-medium text-foreground">{q.warning}</p>}
      <p className="text-xs">{`${fillsWhen(q.next_open)};實際的數字可能不同。`}</p>
      <SmallPrint m={m} leverage={q.leverage > 1} />
    </div>
  );
}

function OrderTicket({ m, account, line }: { m: ExchangeMarket; account: ExchangeAccount; line: ExchangeLine }) {
  const api = useApi();
  const refresh = useRefresh();
  const local = line.local !== null;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  // One input (owner 2026-11-22): a bare number is shares, `$` and a number is coins.
  const [amount, setAmount] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [lev, setLev] = useState<"1" | "2">("1");
  const [quote, setQuote] = useState<ExchangeQuote | null>(null);
  const [key, setKey] = useState(newKey);
  const id = useId();
  const parsed = parseOrderAmount(amount, side, COIN);
  const request = (): ExchangeOrderRequest | null => {
    if (!parsed.ok) return null;
    const a = parsed.amount;
    const r: ExchangeOrderRequest = { side, code: line.code };
    if (a.unit === "all") r.all = true;
    else if (a.unit === "coins") r.coins = a.value;
    else r.shares = a.value;
    if (side === "buy" && lev === "2") r.leverage = 2;
    return r;
  };
  const ask = useMutation({
    mutationFn: (body: ExchangeOrderRequest) => api.rpc.exchange.quote({ body }),
    onSuccess: (q) => {
      setKey(newKey());
      setQuote(q);
    },
    onError: (e) => notify.error(e),
  });
  const place = useMutation({
    mutationFn: (body: ExchangeOrderRequest) => api.rpc.exchange.order({ headers: { "idempotency-key": key }, body }),
    onSuccess: (o) => {
      setQuote(null);
      notify.ok(`委託送出了,${fillsWhen(o.next_open)}`);
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = request();
    if (!parsed.ok || body === null) {
      setError(parsed.ok ? null : parsed.message);
      return;
    }
    setError(null);
    ask.mutate(body);
  };
  const canLev = !local && account.leverage.opted_in && m.rules.leverage;
  return (
    <form className="grid max-w-xl gap-4" onSubmit={submit} aria-label="下單">
      <Segmented label="買或賣" value={side} onChange={setSide} options={[{ value: "buy", label: "買進" }, { value: "sell", label: "賣出" }]} />
      <div className="grid gap-1">
        <label className="text-xs text-muted-foreground" htmlFor={`${id}-amount`}>
          {side === "buy" ? `買多少:數字是股數,$ 開頭是${COIN}` : `賣多少:數字是股數,$ 開頭是${COIN},或寫「全部」`}
        </label>
        <Input
          id={`${id}-amount`}
          inputMode="decimal"
          value={amount}
          placeholder={side === "buy" ? "3 或 $200" : "全部、3 或 $200"}
          aria-invalid={error !== null}
          aria-describedby={`${id}-help`}
          onChange={(e) => {
            setAmount(e.target.value);
            setError(null);
          }}
        />
        <p id={`${id}-help`} className={`text-xs ${error ? "text-primary" : "text-muted-foreground"}`} role={error ? "alert" : undefined}>
          {error ?? amountExamples(line.coin_price, side, COIN)}
        </p>
        {side === "buy" && <p className="text-xs text-muted-foreground">{`一筆含手續費${m.rules.order_max > 0 ? ` ${m.rules.order_min} 到 ${m.rules.order_max}` : `至少 ${m.rules.order_min}`} ${COIN}`}</p>}
      </div>
      {side === "buy" && canLev && <Segmented label="倍數" value={lev} onChange={setLev} options={[{ value: "1", label: "1 倍" }, { value: "2", label: "2 倍" }]} />}
      {side === "buy" && lev === "2" && <p className="text-[13px] font-medium">2 倍可能賠掉保證金以外的錢,最壞會賠光錢包和其他持股。</p>}
      {!line.open && <p className="text-xs text-muted-foreground">{fillsWhen(line.next_open)}</p>}
      <p className="text-xs text-muted-foreground">
        {`今天還能下 ${account.today.orders_left} 筆${account.today.buy_left === null ? "" : `、買 ${fmtInt(account.today.buy_left)}`};可以投入 ${account.investable === null ? "—" : fmtInt(account.investable)} ${m.currency}`}
      </p>
      <Button type="submit" className="justify-self-start" busy={ask.isPending} disabled={!m.enabled}>
        試算並確認
      </Button>
      <ConfirmDialog
        open={quote !== null}
        title={quote?.side === "sell" ? "確認賣出" : quote && quote.leverage > 1 ? "確認 2 倍買進" : "確認買進"}
        confirmLabel="送出委託"
        busy={place.isPending}
        onConfirm={() => {
          const body = request();
          if (body) place.mutate(body);
        }}
        onClose={() => setQuote(null)}
      >
        {quote && <QuoteBody q={quote} m={m} />}
      </ConfirmDialog>
    </form>
  );
}

function OrderPart({ m, line }: { m: ExchangeMarket; line: ExchangeLine }) {
  const account = useAccount();
  return (
    <Part title="下單">
      <Loaded query={account} rows={2}>
        {(a) =>
          !a.opened ? (
            <OpenAccount account={a} />
          ) : (
            <div className="grid gap-4">
              {a.blocked && <p className="text-[13px] text-muted-foreground">你現在只能賣出手上的持股,不能買進。</p>}
              <OrderTicket m={m} account={a} line={line} />
              {line.local === null && <LeverageOptIn m={m} account={a} />}
            </div>
          )
        }
      </Loaded>
    </Part>
  );
}

// ---- 我的 --------------------------------------------------------------------------------------

function MineTab({ m }: { m: ExchangeMarket }) {
  const api = useApi();
  const refresh = useRefresh();
  const portfolio = usePortfolio();
  const cancel = useMutation({
    mutationFn: (order: string) => api.rpc.exchange.cancel({ body: { order } }),
    onSuccess: (r) => {
      notify.ok(r.refunded > 0 ? `取消了,退回 ${r.refunded} ${m.currency}` : "取消了");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  const sell = useMutation({
    mutationFn: (position: string) => api.rpc.exchange.order({ headers: { "idempotency-key": newKey() }, body: { side: "sell", code: position.split("|")[0] ?? "", position: position.split("|")[1] ?? "" } }),
    onSuccess: () => {
      notify.ok("賣單送出了");
      refresh();
    },
    onError: (e) => notify.error(e),
  });
  return (
    <Loaded query={portfolio} rows={4}>
      {(p: ExchangePortfolio) => {
        const leverage = p.holdings.some((h) => h.leverage > 1);
        const pnl = p.totals.value - p.totals.cost;
        return (
          <div className="grid gap-8">
            {p.bankrupt && (
              <p role="status" className="text-sm font-medium">
                {`破產冷靜期到 ${fmtDateTime(p.bankrupt.until)}:所有持股已經結清,不會欠錢(交易所吸收 ${fmtInt(p.bankrupt.written_off)} ${m.currency})。之前不能買進。`}
              </p>
            )}
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              <Fact label="錢包">{p.balance === null ? "—" : `${fmtInt(Math.floor(p.balance))} ${m.currency}`}</Fact>
              <Fact label="持股市值">{fmtInt(Math.floor(p.totals.value))}</Fact>
              <Fact label="成本">{fmtInt(p.totals.cost)}</Fact>
              <Fact label="損益">
                <Move value={p.totals.cost > 0 ? pnl / p.totals.cost : null} colors={m.colors} />
              </Fact>
            </dl>
            <p className="text-xs text-muted-foreground">{`只有你自己看得到這裡;${HER}也看不到任何人的持股。`}</p>
            <Part title="持股">
              {p.holdings.length === 0 ? (
                <EmptyLine>沒有持股</EmptyLine>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {p.holdings.map((h) => (
                    <li key={h.id} className="grid gap-1 py-(--row-y) text-sm">
                      <p className="flex flex-wrap items-baseline gap-3">
                        <span className="font-mono text-[13px] font-medium">{h.code}</span>
                        <span className="min-w-0 flex-1 truncate">{`${h.name}・${shares(h.qty)} 股${h.leverage > 1 ? "・2 倍" : ""}`}</span>
                        <span className="tabular-nums">{`市值 ${coins(h.value)}・成本 ${fmtInt(h.cost)}`}</span>
                        <Move value={h.value !== null && h.cost > 0 ? h.value / h.cost - 1 : null} colors={m.colors} />
                      </p>
                      {h.leverage > 1 && (
                        <p className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          {`保證金 ${fmtInt(h.margin)}・剩 ${h.ratio === null ? "—" : fmtPct(Math.max(0, h.ratio))}・跌到 ${coins(h.line_price)} 自動賣出`}
                          <Button size="sm" variant="outline" disabled={!h.can_sell} busy={sell.isPending} onClick={() => sell.mutate(`${h.code}|${h.id}`)}>
                            賣掉這筆
                          </Button>
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Part>
            <Part title="委託">
              {p.orders.filter((o) => o.status === "open").length === 0 ? (
                <EmptyLine>沒有等待中的委託</EmptyLine>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {p.orders
                    .filter((o) => o.status === "open")
                    .map((o) => (
                      <li key={o.id} className="flex flex-wrap items-baseline gap-3 py-(--row-y) text-sm">
                        <span className="font-mono text-[13px]">{o.code}</span>
                        <span className="min-w-0 flex-1">
                          {o.side === "buy" ? `買進 ${fmtInt(o.coins)} ${m.currency}` : `賣出 ${shares(o.qty)} 股`}
                          <span className="block text-xs text-muted-foreground">{fillsWhen(o.next_open)}</span>
                        </span>
                        <Button size="sm" variant="outline" busy={cancel.isPending} onClick={() => cancel.mutate(o.id)}>
                          取消
                        </Button>
                      </li>
                    ))}
                </ul>
              )}
            </Part>
            <Part title="成交">
              {p.fills.length === 0 ? (
                <EmptyLine>還沒有成交</EmptyLine>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {p.fills.slice(0, 10).map((f) => (
                    <li key={f.id} className="flex flex-wrap items-baseline gap-3 py-(--row-y) text-sm">
                      <span className="font-mono text-[13px]">{f.code}</span>
                      <span className="min-w-0 flex-1">{`${f.side === "sell" ? "賣出" : "買進"} ${shares(f.qty)} 股・每股 ${coins(f.price)}・手續費 ${f.fee}`}</span>
                      <span className="font-mono text-xs text-muted-foreground">{fmtDateTime(f.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Part>
            {p.notices.length > 0 && (
              <Part title="通知">
                <ul className="divide-y divide-line-soft">
                  {p.notices.slice(0, 8).map((n) => (
                    <li key={n.id} className="py-(--row-y) text-sm">
                      {n.text}
                    </li>
                  ))}
                </ul>
              </Part>
            )}
            <SmallPrint m={m} leverage={leverage || p.bankrupt !== null} />
          </div>
        );
      }}
    </Loaded>
  );
}

// ---- 排行榜 ------------------------------------------------------------------------------------

function Visibility({ account }: { account: ExchangeAccount }) {
  const api = useApi();
  const refresh = useRefresh();
  const boardId = useId();
  const showId = useId();
  const set = useMutation({
    mutationFn: (patch: { hide_boards?: boolean; show_holdings?: boolean }) => api.rpc.exchange.visibility({ body: patch }),
    onSuccess: () => refresh(),
    onError: (e) => notify.error(e),
  });
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <Switch id={boardId} checked={!account.hide_boards} disabled={set.isPending} onCheckedChange={(on) => set.mutate({ hide_boards: !on })} />
        <label htmlFor={boardId} className="text-sm">
          我要上榜
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{`預設會上榜。關掉之後你不會出現在富人榜上,${HER}也不會提到你在交易所的事。`}</p>
      <div className="flex items-center gap-2">
        <Switch id={showId} checked={account.show_holdings} disabled={set.isPending} onCheckedChange={(on) => set.mutate({ show_holdings: on })} />
        <label htmlFor={showId} className="text-sm">
          在富人榜上公開我持有哪幾檔
        </label>
      </div>
    </div>
  );
}

function BoardsTab({ m }: { m: ExchangeMarket }) {
  const api = useApi();
  const scope = useBoardScope();
  const boards = useQuery({
    queryKey: [...BOARDS, ...scope.key],
    queryFn: ({ signal }) => api.rpc.exchange.boards({ query: scope.query }, { signal }),
    enabled: !scope.loading,
    refetchInterval: poll,
    retry,
  });
  const account = useAccount();
  return (
    <div className="grid gap-8">
      {account.data?.opened && <Visibility account={account.data} />}
      <BoardScopePicker scope={scope} />
      <Loaded query={boards} rows={5}>
        {(b) => (
          <Part title="富人榜" aside="錢包加持股市值">
            {b.rich.length === 0 ? (
              <EmptyLine>還沒有人上榜</EmptyLine>
            ) : (
              <ol className="divide-y divide-line-soft">
                {b.rich.map((r) => (
                  <li key={r.rank} className={`flex items-baseline gap-3 py-(--row-y) text-sm ${r.me ? "font-medium" : ""}`}>
                    <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{r.rank}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {r.name}
                      {r.me && <span className="ml-1 text-xs text-primary">你</span>}
                      {r.holdings && <span className="ml-2 font-mono text-xs text-muted-foreground">{r.holdings.map((h) => h.code).join(" ")}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums">{`${fmtInt(r.worth)} ${b.currency}`}</span>
                  </li>
                ))}
              </ol>
            )}
            {b.me && <p className="text-[13px] text-muted-foreground">{b.me.hidden ? "你設定了不上榜。" : b.me.rich === null ? "你還沒有名次。" : `你是第 ${b.me.rich} 名。`}</p>}
          </Part>
        )}
      </Loaded>
      <SmallPrint m={m} />
    </div>
  );
}

// ---- 規則 --------------------------------------------------------------------------------------

function RulesTab({ m }: { m: ExchangeMarket }) {
  const r = m.rules;
  return (
    <div className="grid gap-6">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
        <Fact label="委託">市價,以下一筆有效報價成交</Fact>
        <Fact label="手續費">{`每筆 ${fmtPct(r.fee, 1)},最少 ${r.fee_min},燒掉`}</Fact>
        <Fact label="買進後">{`${r.min_hold_minutes} 分鐘才能賣`}</Fact>
        <Fact label="一筆">{r.order_max > 0 ? `${r.order_min} 到 ${r.order_max}` : `至少 ${r.order_min}`}</Fact>
        <Fact label="一天">{`${r.orders_per_day} 筆、買 ${capText(r.buy_per_day)}`}</Fact>
        <Fact label="持有上限">{r.limit_total > 0 ? `成本合計 ${fmtInt(r.limit_total)} 起` : "不限"}</Fact>
        <Fact label="開戶">{`認識滿 ${r.account_min_days} 天、${r.account_min_tier}以上`}</Fact>
        <Fact label="2 倍">{r.leverage ? `認識滿 ${r.leverage_min_days} 天、${r.leverage_min_tier}以上;保證金合計 ${capText(r.margin_cap)}` : "沒有開放"}</Fact>
        <Fact label="每天最多淨發出">{r.payout_cap_daily > 0 ? `${fmtInt(r.payout_cap_daily)},到了當天停止買進` : "不限"}</Fact>
        <Fact label="破產冷靜期">{`${r.bankrupt_cooling_days} 天`}</Fact>
        <Fact label="報價最舊">{`${Math.round(r.quote_max_age_seconds / 60)} 分鐘`}</Fact>
        <Fact label="觀察清單">{`最多 ${r.watch_max} 檔`}</Fact>
      </dl>
      <ul className="grid list-disc gap-1 pl-5 text-[13px]">
        <li>{m.no_dividends}</li>
        <li>{m.no_exchange}</li>
        <li>{`交易所是對手方:買進的${COIN}燒掉,賣出時重新發出;價格照真實報價,固定匯率換成${COIN}。`}</li>
        <li>報價太舊或看起來不對,就不成交也不自動賣出。</li>
      </ul>
      <SmallPrint m={m} leverage={r.leverage} />
    </div>
  );
}

// ---- the block ---------------------------------------------------------------------------------

/**
 * 深海交易所: the market and its lists, the heat maps, their own book, the rich list, the rules.
 * `initialCode` opens a ticker at once (the dev-only demo uses it).
 */
export function Exchange({ initialCode = null }: { initialCode?: string | null } = {}) {
  const market = useMarket();
  const stored = readStorage(TAB_KEY);
  const [tab, setTab] = useState<Tab>(TABS.includes(stored as Tab) ? (stored as Tab) : "market");
  const [code, setCode] = useState<string | null>(initialCode);
  const pick = (v: string) => {
    if (!TABS.includes(v as Tab)) return;
    setTab(v as Tab);
    writeStorage(TAB_KEY, v);
  };
  /** A heat map's tile: its ticker on the market tab. */
  const open = (c: string) => {
    setCode(c);
    pick("market");
  };
  if (market.isError && isNotProvided(market.error)) return null;
  const off = market.isError && isApiError(market.error) && market.error.kind === "unavailable";
  return (
    <Card aria-label={WORLD.exchange_name}>
      <CardHeader>
        <CardTitle>{WORLD.exchange_name}</CardTitle>
      </CardHeader>
      {off ? (
        <OffLine title="交易所現在沒有開" onRetry={() => void market.refetch()} />
      ) : market.isError ? (
        <ErrorLine error={market.error} onRetry={() => void market.refetch()} />
      ) : market.isPending ? (
        <SkeletonRows count={6} />
      ) : (
        <Tabs value={tab} onValueChange={pick} className="gap-4">
          <TabsList variant="inline" aria-label={WORLD.exchange_name}>
            <TabsTrigger value="market">市場</TabsTrigger>
            <TabsTrigger value="map">熱力圖</TabsTrigger>
            <TabsTrigger value="mine">我的</TabsTrigger>
            <TabsTrigger value="boards">富人榜</TabsTrigger>
            <TabsTrigger value="rules">規則</TabsTrigger>
          </TabsList>
          {!market.data.enabled && <p className="text-[13px] text-muted-foreground">交易所還沒開放,下面是規則和目前的價格。</p>}
          <TabsContent value="market">
            <MarketTab m={market.data} code={code} setCode={setCode} />
          </TabsContent>
          <TabsContent value="map">
            {/* Mounted only while this tab is open: its map is polled only then. */}
            {tab === "map" && (
              <Suspense fallback={<SkeletonRows count={6} />}>
                <HeatMap m={market.data} onPick={open} footer={<SmallPrint m={market.data} />} />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="mine">
            <MineTab m={market.data} />
          </TabsContent>
          <TabsContent value="boards">
            <BoardsTab m={market.data} />
          </TabsContent>
          <TabsContent value="rules">
            <RulesTab m={market.data} />
          </TabsContent>
        </Tabs>
      )}
    </Card>
  );
}
