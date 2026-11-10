import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Brain, RotateCcw, Shuffle, Wrench, X } from "lucide-react";
import { useDeferredValue, useState } from "react";
import type { LlmCallRecord, LlmCallsQuery } from "@/api/types";
import { useLlmCalls, useLlmStats } from "@/app/queries";
import type { LlmSearch } from "@/app/router";
import { SearchInput } from "@/components/controls";
import { Toolbar } from "@/components/page";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtCompact, fmtDateTime, fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fmtCost, fmtMs, hitRate, moduleLabel, purposeLabel, STATUS_LABEL, STATUS_TONE } from "./labels";

const ALL = "__all";
const SINCE = [
  { value: ALL, label: "全部保留的", minutes: null },
  { value: "15", label: "15 分鐘", minutes: 15 },
  { value: "60", label: "1 小時", minutes: 60 },
  { value: "360", label: "6 小時", minutes: 360 },
  { value: "1440", label: "24 小時", minutes: 1440 },
] as const;

function FilterSelect({ label, value, options, onChange, className }: { label: string; value: string | undefined; options: { value: string; label: string }[]; onChange: (v: string | undefined) => void; className?: string }) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger aria-label={label} className={cn("w-40", className)} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>所有{label}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Small markers of what was unusual about a call. */
function Marks({ c }: { c: LlmCallRecord }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground [&_svg]:size-3.5">
      {c.thinking && <Brain aria-label="思考" />}
      {c.tool_calls > 0 && <Wrench aria-label={`${c.tool_calls} 個工具呼叫`} />}
      {c.fallbacks.length > 0 && <Shuffle aria-label={`換了 ${c.fallbacks.length} 次模型`} className="text-primary" />}
      {c.retries.length > 0 && <RotateCcw aria-label={`重送 ${c.retries.length} 次`} className="text-primary" />}
      {c.repair !== null && <Badge variant="warning" className="px-1 py-0 text-[10px]">修正 {c.repair}</Badge>}
      {c.finish_reason === "length" && <AlertTriangle aria-label="被長度截斷" className="text-primary" />}
    </span>
  );
}

function CallRow({ c, onOpen }: { c: LlmCallRecord; onOpen: () => void }) {
  const u = c.usage;
  const r = "text-right tabular-nums";
  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell className="whitespace-nowrap font-mono text-[12px] text-muted-foreground" title={fmtDateTime(c.at)}>
        {fmtTime(c.at)}
      </TableCell>
      <TableCell>
        <button type="button" onClick={onOpen} className="flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Dot tone={STATUS_TONE[c.status]} pulse={c.status === "streaming"} />
          <span className="sr-only">{STATUS_LABEL[c.status]}</span>
          <span className="truncate font-medium">{purposeLabel(c.purpose)}</span>
        </button>
        <span className="block truncate pl-4 text-xs text-muted-foreground">
          {moduleLabel(c.module)}
          {c.label && ` · ${c.label}`}
        </span>
      </TableCell>
      <TableCell className="hidden max-w-48 truncate font-mono text-[12px] lg:table-cell" title={c.model ?? undefined}>
        {c.model ?? "—"}
      </TableCell>
      <TableCell className={r}>{u ? fmtCompact(u.prompt_tokens) : "—"}</TableCell>
      <TableCell className={cn(r, "hidden md:table-cell text-muted-foreground")}>{u ? `${Math.round(hitRate(u.prompt_tokens, u.cached_prompt_tokens) * 100)}%` : "—"}</TableCell>
      <TableCell className={r}>
        {u ? fmtCompact(u.completion_tokens) : "—"}
        {u?.reasoning_tokens ? <span className="block text-[11px] text-muted-foreground">推理 {fmtCompact(u.reasoning_tokens)}</span> : null}
      </TableCell>
      <TableCell className={cn(r, "hidden sm:table-cell")}>{fmtMs(c.first_token_ms)}</TableCell>
      <TableCell className={cn(r, "hidden sm:table-cell text-muted-foreground")}>{fmtMs(c.total_ms)}</TableCell>
      <TableCell className={cn(r, "font-mono text-[12px]")}>{fmtCost(c.cost_usd)}</TableCell>
      <TableCell className="hidden xl:table-cell">
        {c.status === "error" ? <span className="line-clamp-1 max-w-40 text-xs text-primary" title={c.error ?? undefined}>{c.error}</span> : <Marks c={c} />}
      </TableCell>
    </TableRow>
  );
}

/** Every recorded LLM call, filterable; a row opens the call in full. */
export function CallsTab({ search }: { search: LlmSearch }) {
  const navigate = useNavigate();
  const stats = useLlmStats(null);
  const [text, setText] = useState(search.q ?? "");
  const q = useDeferredValue(text.trim());
  const [since, setSince] = useState<string>(ALL);
  const set = (patch: Partial<LlmSearch>) => void navigate({ to: "/llm", search: (s: LlmSearch) => ({ ...s, ...patch, tab: "calls" }), replace: true });

  const minutes = SINCE.find((s) => s.value === since)?.minutes ?? null;
  const query: LlmCallsQuery = {
    purpose: search.purpose,
    model: search.model,
    module: search.module,
    status: search.status,
    trouble: search.trouble,
    thought: search.thought,
    turn: search.turn,
    q: q || undefined,
    since: minutes === null ? undefined : new Date(Math.floor((Date.now() - minutes * 60_000) / 60_000) * 60_000).toISOString(),
  };
  const calls = useLlmCalls(query);
  const items = calls.data?.pages.flatMap((p) => p.items) ?? [];
  const first = calls.data?.pages[0];
  const s = stats.data;
  const open = (id: string) => void navigate({ to: "/llm", search: (prev: LlmSearch) => ({ ...prev, call: id }) });

  return (
    <div className="grid gap-4">
      <Toolbar>
        <SearchInput value={text} onChange={setText} placeholder="搜尋內容、錯誤、模型" label="搜尋呼叫" className="sm:w-64" />
        <FilterSelect
          label="用途"
          value={search.purpose}
          onChange={(v) => set({ purpose: v })}
          options={(s?.by_purpose ?? []).map((g) => ({ value: g.key, label: `${purposeLabel(g.key)} · ${g.calls}` }))}
        />
        <FilterSelect label="模型" value={search.model} onChange={(v) => set({ model: v })} options={(s?.by_model ?? []).filter((g) => g.key !== "—").map((g) => ({ value: g.key, label: g.key }))} className="w-56" />
        <FilterSelect label="模組" value={search.module} onChange={(v) => set({ module: v })} options={(s?.by_module ?? []).filter((g) => g.key !== "—").map((g) => ({ value: g.key, label: moduleLabel(g.key) }))} className="w-32" />
        <FilterSelect
          label="狀態"
          value={search.status}
          onChange={(v) => set({ status: v as LlmSearch["status"] })}
          options={(["ok", "error", "aborted", "streaming"] as const).map((x) => ({ value: x, label: STATUS_LABEL[x] }))}
          className="w-28"
        />
        <Select value={since} onValueChange={setSince}>
          <SelectTrigger aria-label="時間範圍" className="w-32" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SINCE.map((x) => (
              <SelectItem key={x.value} value={x.value}>
                {x.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch id="llm-trouble" checked={search.trouble ?? false} onCheckedChange={(v) => set({ trouble: v || undefined })} />
          <Label htmlFor="llm-trouble" className="font-normal text-muted-foreground">
            只看出過狀況的
          </Label>
        </div>
      </Toolbar>
      {(search.thought || search.turn) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">只顯示</span>
          <Badge variant="brand" className="gap-1 pr-0.5">
            {search.thought ? `想法 ${search.thought.slice(-8)}` : `對話 ${search.turn?.slice(-8)}`} 的呼叫
            <button type="button" aria-label="清除" className="rounded-sm p-0.5 hover:bg-primary/20" onClick={() => set({ thought: undefined, turn: undefined })}>
              <X className="size-3" />
            </button>
          </Badge>
        </div>
      )}
      <Card>
        <div className="flex items-center justify-between gap-3 pb-1 text-[13px] text-muted-foreground">
          <span>
            {first ? (
              <>
                符合 <span className="font-medium text-foreground tabular-nums">{first.matched}</span> 次 · 記憶體裡保留最近 {first.kept} 次
              </>
            ) : (
              "—"
            )}
          </span>
          {calls.isFetching && !calls.isPending && <span className="text-xs">更新中…</span>}
        </div>
        {calls.isPending ? (
          <SkeletonRows count={8} />
        ) : calls.isError ? (
          <ErrorLine error={calls.error} onRetry={() => void calls.refetch()} />
        ) : items.length === 0 ? (
          <EmptyLine>沒有符合的呼叫</EmptyLine>
        ) : (
          <Table aria-label="LLM 呼叫">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-20">時間</TableHead>
                <TableHead>用途 · 誰</TableHead>
                <TableHead className="hidden lg:table-cell">模型</TableHead>
                <TableHead className="text-right">輸入</TableHead>
                <TableHead className="hidden text-right md:table-cell">快取</TableHead>
                <TableHead className="text-right">輸出</TableHead>
                <TableHead className="hidden text-right sm:table-cell">首字</TableHead>
                <TableHead className="hidden text-right sm:table-cell">總時間</TableHead>
                <TableHead className="text-right">花費</TableHead>
                <TableHead className="hidden xl:table-cell">
                  <span className="sr-only">標記</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => (
                <CallRow key={c.id} c={c} onOpen={() => open(c.id)} />
              ))}
            </TableBody>
          </Table>
        )}
        {calls.hasNextPage && (
          <div className="pt-3 text-center">
            <Button size="sm" variant="outline" busy={calls.isFetchingNextPage} onClick={() => void calls.fetchNextPage()}>
              載入更多
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
