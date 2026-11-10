import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { CostReport, ModuleInfo, ModuleStateKind } from "@/api/types";
import { useCost, useExtensions, useMcpServers, useModules, useSelf } from "@/app/queries";
import { ChartBlock, type Part, SegmentBar } from "@/components/charts/charts";
import { ConsciousnessBlock } from "@/components/consciousness";
import { NowStrip, useHerNow } from "@/components/live-state";
import { Page, PageHeader } from "@/components/page";
import { Dot, STATE_LABEL, type Tone } from "@/components/status";
import {
  ActivityBlock,
  LatencyBlock,
  RangeToggle,
  SpendBlock,
  StateFacets,
  ThoughtsBlock,
  TokensBlock,
  useRange,
  useTrend,
} from "@/components/trends";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { fmtUsd } from "@/lib/format";
import { SayCard } from "@/pages/live/SayCard";
import { VoiceCard } from "@/pages/live/VoiceCard";
import { RulesRail } from "@/pages/rules/RulesRail";

interface Issue {
  key: string;
  tone: Tone;
  title: string;
  detail?: string | null;
  to: ReactNode;
}

function budgetIssue(cost: CostReport): Issue | null {
  if (cost.state === "ok") return null;
  const limit = cost.daily_usd !== null ? ` / ${fmtUsd(cost.daily_usd)}` : "";
  return {
    key: "budget",
    tone: cost.state === "exhausted" ? "danger" : "warning",
    title: cost.state === "exhausted" ? "LLM 預算用盡" : "LLM 預算已降級",
    detail: `${fmtUsd(cost.today.total_usd)}${limit}`,
    to: null,
  };
}

const go = (label: string, search: { tab: "modules" | "mcp" | "extensions"; q?: string }) => (
  <Link to="/system" search={search} aria-label={`查看 ${label}`}>
    <ChevronRight className="size-4" />
  </Link>
);

const toLlm = (
  <Link to="/llm" search={{ tab: "prices" }} aria-label="查看 LLM 花費">
    <ChevronRight className="size-4" />
  </Link>
);

/** What is wrong right now; nothing at all when nothing is. */
function Attention() {
  const modules = useModules();
  const cost = useCost();
  const mcp = useMcpServers();
  const extensions = useExtensions();

  const issues: Issue[] = [];
  for (const m of modules.data ?? []) {
    const bad = m.state === "failed" || m.state === "degraded" || (m.enabled && m.state === "stopped");
    if (bad) {
      issues.push({ key: `m:${m.id}`, tone: m.state === "failed" ? "danger" : "warning", title: `${m.name} ${STATE_LABEL[m.state]}`, detail: m.reason, to: go(m.name, { tab: "modules", q: m.id }) });
    }
  }
  for (const s of mcp.data ?? []) {
    if (s.state === "failed") issues.push({ key: `mcp:${s.name}`, tone: "danger", title: `MCP ${s.name} 連線失敗`, detail: s.error, to: go(s.name, { tab: "mcp", q: s.name }) });
  }
  for (const x of extensions.data ?? []) {
    if (x.state === "failed" || x.state === "degraded") {
      issues.push({ key: `ext:${x.id}`, tone: x.state === "failed" ? "danger" : "warning", title: `${x.name} ${STATE_LABEL[x.state]}`, detail: x.reason, to: go(x.name, { tab: "extensions", q: x.id }) });
    }
  }
  const b = cost.data ? budgetIssue(cost.data) : null;
  if (b) issues.unshift({ ...b, to: toLlm });

  if (modules.isPending || issues.length === 0) return null;
  return (
    <Card aria-label="需要注意">
      <CardHeader>
        <CardTitle>需要注意</CardTitle>
      </CardHeader>
      <ul className="divide-y divide-line-soft">
        {issues.map((i) => (
          <li key={i.key} className="flex items-start gap-2.5 py-(--row-y)">
            <Dot tone={i.tone} className="mt-1.5" />
            <p className="grid min-w-0 flex-1 text-[13px]">
              <span className="font-medium">{i.title}</span>
              {i.detail && (
                <span className="truncate text-xs text-muted-foreground" title={i.detail}>
                  {i.detail}
                </span>
              )}
            </p>
            {i.to && (
              <span className="text-muted-foreground [&_a]:flex [&_a]:size-7 [&_a]:items-center [&_a]:justify-center [&_a]:rounded-md hover:[&_a]:bg-hover hover:[&_a]:text-foreground">
                {i.to}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

const STATE_COLOR: Record<ModuleStateKind, string> = {
  running: "var(--chart-2)",
  degraded: "var(--chart-4)",
  starting: "var(--chart-3)",
  stopping: "var(--chart-3)",
  failed: "var(--chart-1)",
  stopped: "var(--chart-quiet)",
  disabled: "var(--chart-faint)",
};

const STATE_ORDER: ModuleStateKind[] = ["running", "starting", "stopping", "degraded", "failed", "stopped", "disabled"];

function ModulesBlock() {
  const modules = useModules();
  const list: ModuleInfo[] = modules.data ?? [];
  const enabled = list.filter((m) => m.enabled);
  const running = enabled.filter((m) => m.state === "running").length;
  const parts: Part[] = STATE_ORDER.map((s) => ({
    key: s,
    label: STATE_LABEL[s],
    value: list.filter((m) => m.state === s).length,
    color: STATE_COLOR[s],
  })).filter((p) => p.value > 0);
  const restarts = list.filter((m) => m.recent_restarts > 0).sort((a, b) => b.recent_restarts - a.recent_restarts);
  return (
    <ChartBlock
      title="子系統"
      value={modules.isSuccess ? running : "—"}
      unit={modules.isSuccess ? `/ ${enabled.length} 執行中` : undefined}
      action={
        <Link to="/system" search={{ tab: "modules" }} className="text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          全部
        </Link>
      }
    >
      {modules.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="grid gap-4">
          <SegmentBar parts={parts} label="子系統狀態" />
          {restarts.length > 0 && (
            <ul className="grid gap-2 border-t pt-3 text-[13px]" aria-label="最近重啟">
              {restarts.slice(0, 4).map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3">
                  <span className="truncate">{m.name}</span>
                  <span className="text-muted-foreground tabular-nums">重啟 {m.recent_restarts} 次</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ChartBlock>
  );
}

/** The one opening on the picture: what she is doing, and her live state. */
function Opening() {
  const now = useHerNow();
  return (
    <div className="opening relative flex min-h-44 flex-col justify-end gap-1.5 border-b px-4 pb-4 [text-shadow:0_1px_2px_rgba(0,0,0,0.7)] sm:px-7 md:-mt-15 md:min-h-58">
      <p className="relative text-2xl leading-tight font-semibold tracking-[-0.02em]">
        {now.label}
        {now.detail && ` · ${now.detail}`}
      </p>
      <div className="relative">
        <NowStrip />
      </div>
    </div>
  );
}

export function OverviewPage() {
  const [range, setRange] = useRange();
  const trend = useTrend(range);
  const self = useSelf();
  return (
    <>
      <Opening />
      <Page
        rail={
          <>
            <Attention />
            <RulesRail />
            <VoiceCard />
            <SayCard />
            <SpendBlock />
            <ModulesBlock />
          </>
        }
      >
        <PageHeader title="總覽" />
        <ConsciousnessBlock />
        <div className="-mb-5 flex min-h-[26px] items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">趨勢</h2>
          <RangeToggle range={range} onChange={setRange} />
        </div>
        <div className="grid gap-(--stage-gap) lg:grid-cols-2">
          <ActivityBlock trend={trend} />
          <ThoughtsBlock range={range} />
        </div>
        <StateFacets trend={trend} live={self.data} />
        <div className="grid gap-(--stage-gap) lg:grid-cols-2">
          <TokensBlock trend={trend} />
          <LatencyBlock trend={trend} />
        </div>
      </Page>
    </>
  );
}
