import type { CostReport, UsageMap } from "@/api/types";
import { useCost, useLlmStats, useUsage } from "@/app/queries";
import { BarList, ChartBlock } from "@/components/charts/charts";
import { QueryView, SkeletonRows } from "@/components/query-state";
import { LatencyBlock, RangeToggle, SpendBlock, TokensBlock, useRange, useTrend } from "@/components/trends";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtCompact, fmtInt, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fmtPerMtok } from "./labels";

export function UsageTable({ usage, cost }: { usage: UsageMap; cost?: CostReport }) {
  const rows = Object.entries(usage).sort(([, a], [, b]) => b.calls - a.calls);
  const total = rows.reduce(
    (t, [, u]) => ({
      calls: t.calls + u.calls,
      prompt: t.prompt + u.prompt_tokens,
      cached: t.cached + u.cached_prompt_tokens,
      completion: t.completion + u.completion_tokens,
    }),
    { calls: 0, prompt: 0, cached: 0, completion: 0 },
  );
  const r = "text-right tabular-nums";
  return (
    <Table aria-label="LLM 用量">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>模型</TableHead>
          <TableHead className={r}>呼叫</TableHead>
          <TableHead className={r}>輸入</TableHead>
          <TableHead className={r}>快取命中</TableHead>
          <TableHead className={r}>輸出</TableHead>
          <TableHead className={r}>今日</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([model, u]) => {
          const today = cost?.today.models[model];
          const hit = u.prompt_tokens > 0 ? u.cached_prompt_tokens / u.prompt_tokens : 0;
          return (
            <TableRow key={model}>
              <TableCell className="max-w-64 break-all font-mono text-[13px]">{model}</TableCell>
              <TableCell className={r}>{fmtInt(u.calls)}</TableCell>
              <TableCell className={r}>{fmtCompact(u.prompt_tokens)}</TableCell>
              <TableCell className={r}>
                {fmtCompact(u.cached_prompt_tokens)}
                <span className="ml-1.5 text-muted-foreground">{Math.round(hit * 100)}%</span>
              </TableCell>
              <TableCell className={r}>{fmtCompact(u.completion_tokens)}</TableCell>
              <TableCell className={cn(r, !today && "text-muted-foreground")}>{today ? fmtUsd(today.cost_usd) : "—"}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
      {rows.length > 1 && (
        <TableFooter>
          <TableRow className="hover:bg-transparent">
            <TableCell>合計</TableCell>
            <TableCell className={r}>{fmtInt(total.calls)}</TableCell>
            <TableCell className={r}>{fmtCompact(total.prompt)}</TableCell>
            <TableCell className={r}>{fmtCompact(total.cached)}</TableCell>
            <TableCell className={r}>{fmtCompact(total.completion)}</TableCell>
            <TableCell className={r}>{cost ? fmtUsd(cost.today.total_usd) : "—"}</TableCell>
          </TableRow>
        </TableFooter>
      )}
    </Table>
  );
}

function CallsByModel() {
  const usage = useUsage();
  const rows = Object.entries(usage.data ?? {}).sort(([, a], [, b]) => b.calls - a.calls);
  const total = rows.reduce((n, [, u]) => n + u.calls, 0);
  return (
    <ChartBlock title="各模型呼叫" value={usage.isSuccess ? fmtInt(total) : "—"} unit="次" aside="Core 啟動以來">
      <QueryView query={usage} isEmpty={(d) => Object.keys(d).length === 0} empty="還沒有 LLM 呼叫" skeleton={<SkeletonRows count={3} />}>
        {() => (
          <BarList
            label="各模型呼叫次數"
            format={fmtInt}
            items={rows.map(([model, u]) => ({ key: model, label: <span className="font-mono text-xs">{model}</span>, value: u.calls }))}
          />
        )}
      </QueryView>
    </ChartBlock>
  );
}

/** The configured `[llm.pricing]` and the models seen without one. */
function PriceTable() {
  const stats = useLlmStats(null);
  const prices = stats.data?.prices ?? {};
  const seen = (stats.data?.by_model ?? []).map((g) => g.key).filter((k) => k !== "—");
  const models = [...new Set([...Object.keys(prices), ...seen])].sort();
  const r = "text-right font-mono text-[13px] tabular-nums";
  return (
    <Card>
      <CardHeader>
        <CardTitle>價格(每百萬 token,USD)</CardTitle>
        <span className="ml-auto text-xs text-muted-foreground">
          設定在 <code>miyoria.toml</code> 的 <code>[llm.pricing]</code>
        </span>
      </CardHeader>
      {stats.isPending ? (
        <SkeletonRows count={2} />
      ) : models.length === 0 ? (
        <p className="py-3 text-[13px] text-muted-foreground">沒有設定價格,也還沒有呼叫</p>
      ) : (
        <Table aria-label="價格">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>模型</TableHead>
              <TableHead className="text-right">輸入</TableHead>
              <TableHead className="text-right">快取命中的輸入</TableHead>
              <TableHead className="text-right">輸出</TableHead>
              <TableHead className="text-right">保留的呼叫</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((m) => {
              const p = prices[m];
              const calls = stats.data?.by_model.find((g) => g.key === m)?.calls ?? 0;
              return (
                <TableRow key={m}>
                  <TableCell className="font-mono text-[13px]">{m}</TableCell>
                  {p ? (
                    <>
                      <TableCell className={r}>{fmtPerMtok(p.input_per_mtok)}</TableCell>
                      <TableCell className={r}>
                        {p.cached_input_per_mtok === null ? <span className="text-muted-foreground">同輸入</span> : fmtPerMtok(p.cached_input_per_mtok)}
                      </TableCell>
                      <TableCell className={r}>{fmtPerMtok(p.output_per_mtok)}</TableCell>
                    </>
                  ) : (
                    <TableCell colSpan={3} className="text-right text-[13px] text-primary">
                      沒有設定價格,呼叫算作 $0
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">{fmtInt(calls)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

export function PricesTab() {
  const [range, setRange] = useRange();
  const trend = useTrend(range);
  const usage = useUsage();
  const cost = useCost();
  return (
    <div className="grid gap-(--stage-gap)">
      <PriceTable />
      <div className="grid gap-(--stage-gap) lg:grid-cols-2">
        <SpendBlock />
        <CallsByModel />
      </div>
      <div className="-mb-5 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">用量趨勢</h2>
        <RangeToggle range={range} onChange={setRange} />
      </div>
      <div className="grid gap-(--stage-gap) lg:grid-cols-2">
        <TokensBlock trend={trend} />
        <LatencyBlock trend={trend} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>用量明細</CardTitle>
        </CardHeader>
        <QueryView query={usage} isEmpty={(d) => Object.keys(d).length === 0} empty="還沒有 LLM 呼叫" skeleton={<SkeletonRows count={3} />}>
          {(data) => <UsageTable usage={data} cost={cost.data} />}
        </QueryView>
      </Card>
    </div>
  );
}
