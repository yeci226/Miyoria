// 圖鑑: what they collected is parts, not cards. Their series and how far each is, the titles they
// earned, every part by slot or by series (the ones they do not have yet keep their name and
// rarity but stay locked), and the closed series 舊收藏 from the old collection. Theirs alone;
// nothing here is compared with anyone.

import { Check, Lock } from "lucide-react";
import { useState } from "react";
import type { CardCatalogue, CardDex, DexSeries } from "@miyoria/contracts/api";
import { EmptyLine } from "@/components/query-state";
import { Meter } from "@/components/status";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { type CatalogPart, catalogOf, seriesNames } from "./data";
import { TitleShown } from "./TitleShown";
import { isRarity, RarityBadge, SLOT_LABEL, SLOTS, shortDate } from "./labels";

function PartRow({ part }: { part: CatalogPart }) {
  const have = part.count > 0;
  return (
    <li
      className={cn("flex min-w-0 items-center gap-2.5 py-(--row-y)", !have && "text-muted-foreground")}
      aria-label={`${part.name},${part.rarity},${have ? `有 ${part.count} 張` : "還沒有"}`}
    >
      {have ? (
        <Check aria-hidden className="size-3.5 shrink-0 text-primary" />
      ) : (
        <Lock aria-hidden className="size-3.5 shrink-0 opacity-70" />
      )}
      <span className={cn("min-w-0 flex-1 truncate text-sm", !have && "opacity-75")}>{part.name}</span>
      <RarityBadge rarity={part.rarity} className={have ? undefined : "opacity-60"} />
      <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums">
        {have ? `×${part.count}` : "—"}
      </span>
    </li>
  );
}

function Group({ title, parts, aside }: { title: string; parts: CatalogPart[]; aside?: React.ReactNode }) {
  const have = parts.filter((p) => p.count > 0).length;
  return (
    <section aria-label={title} className="grid min-w-0 content-start gap-1">
      <h4 className="flex items-baseline gap-2 text-[13px] font-medium">
        {title}
        <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
          {have}/{parts.length}
        </span>
        {aside}
      </h4>
      <ul className="divide-y divide-line-soft">
        {parts.map((p) => (
          <PartRow key={p.id} part={p} />
        ))}
      </ul>
    </section>
  );
}

function SeriesList({ series }: { series: DexSeries[] }) {
  return (
    <ul className="divide-y divide-line-soft">
      {series.map((s) => (
        <li key={s.id} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_3rem] items-center gap-x-3 gap-y-0.5 py-(--row-y) sm:grid-cols-[9rem_minmax(0,1fr)_3rem_minmax(0,11rem)]">
          <span className="truncate text-sm">{s.name}</span>
          <Meter value={s.total === 0 ? 0 : s.owned / s.total} tone={s.complete ? "brand" : "neutral"} label={`${s.name} ${s.owned}/${s.total}`} />
          <span className="text-right font-mono text-xs tabular-nums">
            {s.owned}/{s.total}
          </span>
          <span className={cn("col-span-3 truncate text-xs sm:col-span-1", s.complete ? "text-primary" : "text-muted-foreground")}>
            {s.complete ? `稱號「${s.title}」` : `集滿得到「${s.title}」`}
          </span>
        </li>
      ))}
    </ul>
  );
}

type By = "slot" | "series";

export function Dex({ dex, catalogue }: { dex: CardDex; catalogue: CardCatalogue | undefined }) {
  const [by, setBy] = useState<By>("slot");
  const catalog = catalogOf(dex, catalogue);
  const seriesName = seriesNames(dex, catalogue);
  const groups =
    by === "slot"
      ? SLOTS.map((slot) => ({ key: slot, title: SLOT_LABEL[slot], parts: catalog.filter((p) => p.slot === slot) }))
      : [
          ...[...seriesName].map(([id, name]) => ({ key: id, title: name, parts: catalog.filter((p) => p.series === id) })),
          { key: "_", title: "不屬於系列", parts: catalog.filter((p) => p.series === null || !seriesName.has(p.series)) },
        ];
  const owned = catalog.filter((p) => p.count > 0).length;
  return (
    <div className="grid gap-(--stage-gap)">
      <section aria-label="系列" className="grid gap-1">
        <h3 className="flex items-baseline gap-2 text-[13px] font-medium">
          系列
          <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
            {dex.series.filter((s) => s.complete).length}/{dex.series.length}
          </span>
        </h3>
        {dex.series.length === 0 ? <EmptyLine>還沒有系列</EmptyLine> : <SeriesList series={dex.series} />}
      </section>

      {dex.titles.length > 0 && (
        <section aria-label="稱號" className="grid gap-1">
          <h3 className="text-[13px] font-medium">稱號</h3>
          <ul className="divide-y divide-line-soft">
            {dex.titles.map((t) => (
              <li key={t.series} className="flex items-baseline gap-3 py-(--row-y)">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{seriesName.get(t.series) ?? t.series}</span>
                <TitleShown title={t} />
                <span className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">{shortDate(t.earned_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="部件" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h3 className="flex items-baseline gap-2 text-[13px] font-medium">
            部件
            <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
              {owned}/{catalog.length}
            </span>
          </h3>
          <Segmented
            label="部件怎麼排"
            value={by}
            onChange={setBy}
            options={[
              { value: "slot", label: "依欄位" },
              { value: "series", label: "依系列" },
            ]}
          />
        </div>
        {catalog.length === 0 ? (
          <EmptyLine>還沒有部件</EmptyLine>
        ) : (
          <div className="grid gap-x-8 gap-y-6 md:grid-cols-2 2xl:grid-cols-3">
            {groups
              .filter((g) => g.parts.length > 0)
              .map((g) => (
                <Group key={g.key} title={g.title} parts={g.parts} />
              ))}
          </div>
        )}
      </section>

      <section aria-label={dex.legacy.name} className="grid gap-1">
        <h3 className="flex items-baseline gap-2 text-[13px] font-medium">
          {dex.legacy.name}
          <span className="text-xs font-normal text-muted-foreground">不再增加</span>
        </h3>
        {dex.legacy.items.length === 0 ? (
          <EmptyLine>沒有舊收藏</EmptyLine>
        ) : (
          <ul className="divide-y divide-line-soft">
            {dex.legacy.items.map((i) => (
              <li key={i.item} className="flex min-w-0 items-center gap-2.5 py-(--row-y)">
                <span className="min-w-0 flex-1 truncate text-sm">{i.name}</span>
                {i.series && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{i.series}</span>}
                {isRarity(i.rarity) ? (
                  <RarityBadge rarity={i.rarity} />
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">{i.rarity}</span>
                )}
                <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums">×{i.count}</span>
                <span className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">{shortDate(i.first_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
