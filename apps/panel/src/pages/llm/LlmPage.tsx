import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { LLM_TABS, type LlmTab } from "@/app/nav";
import { useCost } from "@/app/queries";
import type { LlmSearch } from "@/app/router";
import { Page, PageHeader } from "@/components/page";
import { StatusBadge } from "@/components/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtUsd } from "@/lib/format";
import { CallSheet } from "./CallSheet";
import { CallsTab } from "./CallsTab";
import { OverviewTab } from "./OverviewTab";
import { PricesTab } from "./PricesTab";

const route = getRouteApi("/llm");

function Budget() {
  const cost = useCost();
  const c = cost.data;
  if (!c) return null;
  const tone = c.state === "ok" ? "neutral" : c.state === "degraded" ? "warning" : "danger";
  return (
    <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
      今天 <span className="font-medium text-foreground tabular-nums">{fmtUsd(c.today.total_usd)}</span>
      {c.daily_usd !== null && <span className="tabular-nums">/ {fmtUsd(c.daily_usd)}</span>}
      {c.state !== "ok" && <StatusBadge tone={tone}>{c.state === "degraded" ? "已降級" : "預算用盡"}</StatusBadge>}
    </span>
  );
}

/** Every LLM call she makes: breakdowns, the call inspector, prices. */
export function LlmPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const tab = search.tab ?? (search.thought || search.turn || search.call ? "calls" : "overview");
  return (
    <Tabs
      value={tab}
      onValueChange={(t) => void navigate({ to: "/llm", search: (s: LlmSearch) => ({ ...s, tab: t as LlmTab }), replace: true })}
    >
      <TabsList>
        {LLM_TABS.map((t) => (
          <TabsTrigger key={t.tab} value={t.tab}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <Page>
        <PageHeader title="LLM" actions={<Budget />} />
        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="calls">
          <CallsTab search={search} />
        </TabsContent>
        <TabsContent value="prices">
          <PricesTab />
        </TabsContent>
        <CallSheet id={search.call} onClose={() => void navigate({ to: "/llm", search: (s: LlmSearch) => ({ ...s, call: undefined }), replace: true })} />
      </Page>
    </Tabs>
  );
}
