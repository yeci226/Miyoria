import { useMemo } from "react";
import type { HeartHistoryPage, PersonRow } from "@miyoria/contracts/api";
import { usePeopleHistories } from "@/app/queries";
import { ChartBlock, ChartEmpty, type LineSeries, TimeChart } from "@/components/charts/charts";
import { Skeleton } from "@/components/ui/misc";
import { levels } from "./heart";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
/** Lines on one chart; more would need small multiples. */
const MAX = 5;

/**
 * The bond over time of the people she talks with most, on one time axis, from each one's
 * history. Each person's level holds until their next change.
 */
export function AffinityTrends({ people }: { people: PersonRow[] }) {
  const top = useMemo(
    () =>
      people
        .filter((p) => p.has_row && !p.blocked)
        .sort((a, b) => b.interactions - a.interactions)
        .slice(0, MAX),
    [people],
  );
  const histories = usePeopleHistories(top.map((p) => p.person.id));
  const pending = histories.some((h) => h.isPending);
  const pages = histories.map((h) => h.data);

  const { times, series, high } = useMemo(() => {
    const loaded = top
      .map((p, i) => ({ p, color: COLORS[i % COLORS.length] as string, page: pages[i] }))
      .filter((x): x is { p: PersonRow; color: string; page: HeartHistoryPage } => x.page !== undefined)
      .map((x) => ({ ...x, line: levels(x.page.items, ["bond"], { bond: x.p.bond }) }));
    const times = [...new Set(loaded.flatMap((x) => x.line.times))].sort((a, b) => a - b);
    const series: LineSeries[] = loaded.map(({ p, color, line }) => {
      let k = -1;
      const values = times.map((t) => {
        while (k + 1 < line.times.length && (line.times[k + 1] ?? Number.POSITIVE_INFINITY) <= t) k++;
        return k >= 0 ? (line.values.bond[k] ?? null) : null;
      });
      return { key: p.person.id, label: p.person.display_name, color, values };
    });
    // The axis grows with the highest bond shown (up to 1000).
    const peak = Math.max(100, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
    return { times, series, high: Math.ceil(peak / 100) * 100 };
  }, [top, pages]);

  if (top.length === 0) return null;
  return (
    <ChartBlock title="羈絆走勢" aside={`互動最多的 ${top.length} 個人`}>
      {pending && times.length === 0 ? (
        <Skeleton className="h-[200px] w-full" />
      ) : times.length < 2 ? (
        <ChartEmpty height={200}>還沒有羈絆變化的紀錄</ChartEmpty>
      ) : (
        <TimeChart label="羈絆走勢" times={times} series={series} domain={[-100, high]} zero height={200} format={(v) => String(Math.round(v))} />
      )}
    </ChartBlock>
  );
}
