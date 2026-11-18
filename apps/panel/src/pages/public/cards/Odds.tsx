// 機率表: the public odds every daily card is drawn by, the same for everyone (rarity, then each
// slot's parts), and above it their own pity counter. The numbers are the Core's, printed as it
// sends them (two decimals, each list adding up to 100.00).

import type { CardOdds, CardPity } from "@miyoria/contracts/api";
import { EmptyLine } from "@/components/query-state";
import { Meter } from "@/components/status";
import { fmtInt } from "@/lib/format";
import { RarityBadge } from "./labels";

/** Their pity: how many cards in a row had nothing SR or better, and how many are left. */
export function PityLine({ pity }: { pity: CardPity }) {
  const fill = pity.pity > 0 ? Math.min(1, pity.since / pity.pity) : 0;
  return (
    <div className="grid gap-2">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium">
          {pity.until === 0 ? "下一張保證 SR 以上" : `再 ${pity.until} 張保證 SR 以上`}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          已連續 {pity.since} 張沒有 SR 以上 · 第 {pity.pity} 張保底
        </span>
      </p>
      <Meter value={fill} tone={pity.until === 0 ? "brand" : "neutral"} label={`保底 ${pity.since}/${pity.pity}`} />
    </div>
  );
}

const pct = (shown: string) => `${shown}%`;

/**
 * A slot's parts as horizontal bars, most likely first (the Core's order), with the columns lined
 * up across rows: the panel's `BarList`, but with a fixed value column so 76.40% and 0.30% sit on
 * the same edge and every bar starts at the same x.
 */
function SlotBars({ label, items }: { label: string; items: { key: string; name: string; rarity: string | null; shown: string }[] }) {
  const max = Math.max(0, ...items.map((i) => Number(i.shown)));
  return (
    <ul aria-label={label} className="grid gap-2">
      {items.map((i) => {
        const v = Number(i.shown);
        return (
          <li key={i.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem] items-center gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              {i.rarity ? <RarityBadge rarity={i.rarity} /> : <span aria-hidden className="w-9 shrink-0" />}
              <span className={i.rarity ? "truncate" : "truncate text-muted-foreground"}>{i.name}</span>
            </span>
            <span aria-hidden className="h-1.5 rounded-[2px] bg-muted">
              <span
                className="block h-full rounded-[2px] bg-(--chart-line)"
                style={{ width: `${max > 0 && v > 0 ? Math.max(2, (v / max) * 100) : 0}%` }}
              />
            </span>
            <span className="text-right font-mono text-[13px] tabular-nums">{pct(i.shown)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function Odds({ odds, pity, currency }: { odds: CardOdds; pity: CardPity | null; currency: string }) {
  const pityBy = new Map((odds.pity?.rarities ?? []).map((r) => [r.rarity, r.shown]));
  return (
    <div className="grid gap-(--stage-gap)">
      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">一張</dt>
          <dd className="text-sm font-medium tabular-nums">
            {fmtInt(odds.price)} {currency}
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">一天最多</dt>
          <dd className="text-sm font-medium tabular-nums">{odds.per_day} 張</dd>
        </div>
        {odds.pity && (
          <div className="grid gap-0.5">
            <dt className="text-xs text-muted-foreground">保底</dt>
            <dd className="text-sm font-medium tabular-nums">連續 {odds.pity.after} 張沒有 SR 以上,下一張必定 SR 以上</dd>
          </div>
        )}
      </dl>

      {pity && (
        <section aria-label="你的保底" className="grid gap-2">
          <h3 className="text-[13px] font-medium">你的保底</h3>
          <PityLine pity={pity} />
        </section>
      )}

      <section aria-label="稀有度" className="grid gap-1">
        <h3 className="text-[13px] font-medium">稀有度</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="py-1.5 text-left font-normal">
                <span className="sr-only">稀有度</span>
              </th>
              <th scope="col" className="w-full py-1.5 font-normal">
                <span className="sr-only">比例</span>
              </th>
              <th scope="col" className="py-1.5 pl-4 text-right font-normal whitespace-nowrap">機率</th>
              {odds.pity && (
                <th scope="col" className="py-1.5 pl-4 text-right font-normal whitespace-nowrap">保底那張</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft border-t border-line-soft">
            {odds.rarities.map((r) => (
              <tr key={r.rarity}>
                <th scope="row" className="py-(--row-y) pr-4 text-left font-normal">
                  <RarityBadge rarity={r.rarity} />
                </th>
                <td className="py-(--row-y)">
                  <Meter value={r.percent / 100} label={`${r.rarity} ${pct(r.shown)}`} />
                </td>
                <td className="py-(--row-y) pl-4 text-right font-mono text-[13px] tabular-nums">{pct(r.shown)}</td>
                {odds.pity && (
                  <td className="py-(--row-y) pl-4 text-right font-mono text-[13px] text-muted-foreground tabular-nums">
                    {pityBy.has(r.rarity) ? pct(pityBy.get(r.rarity) ?? "0.00") : "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="每個欄位的部件" className="grid gap-3">
        <h3 className="text-[13px] font-medium">每個欄位的部件</h3>
        {odds.slots.length === 0 ? (
          <EmptyLine>沒有部件</EmptyLine>
        ) : (
          <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
            {odds.slots.map((s) => (
              <section key={s.slot} aria-label={s.name} className="grid content-start gap-2.5">
                <h4 className="text-xs text-muted-foreground">{s.name}</h4>
                <SlotBars
                  label={`${s.name}的部件機率`}
                  items={[
                    ...s.parts.map((p) => ({ key: p.id, name: p.name, rarity: p.rarity, shown: p.shown })),
                    ...(s.empty ? [{ key: "_empty", name: "沒有東西", rarity: null, shown: s.empty.shown }] : []),
                  ]}
                />
              </section>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
