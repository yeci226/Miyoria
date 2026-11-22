// A person's cards on their sheet (角色 / 人): the facts (how many, the pity, the wishlist), their
// cards newest first with what was drawn and what each cost, and the dex as series progress. Read
// only; nothing when the cards module is not running or the Core is older.

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import type { MyCard, PersonCards } from "@miyoria/contracts/api";
import { isApiError } from "@/api/http";
import { usePersonCards } from "@/app/queries";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Meter } from "@/components/status";
import { Button } from "@/components/ui/button";
import { fmtInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WORLD } from "@/lib/world";
import { verifyUrl } from "@/pages/public/card";
import { CardThumb, KIND_LABEL, KINDS, kindOf, RarityBadge, shortDate } from "@/pages/public/cards/labels";
import { Section } from "./PersonHeart";

const FIRST = 8;

function CardRow({ entry }: { entry: MyCard }) {
  const { card } = entry;
  const drawn = [card.expression, ...card.parts.map((p) => p.name)].filter(Boolean).join("・");
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 py-2">
      <CardThumb card={card} className="w-8" />
      <div className="grid min-w-0 gap-0.5">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {card.rarity && <RarityBadge rarity={card.rarity} />}
          <span>{KIND_LABEL[kindOf(card)]}</span>
          {card.foil && <span className="text-xs text-muted-foreground">閃卡</span>}
          {entry.pity_hit && <span className="text-xs text-primary">保底</span>}
          {card.voided_at && <span className="text-xs text-muted-foreground">已作廢</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground" title={drawn || undefined}>
          {drawn || card.relationship || "—"}
        </p>
      </div>
      <div className="grid justify-items-end gap-0.5 text-right">
        <span className="font-mono text-xs tabular-nums">{entry.price > 0 ? `${fmtInt(entry.price)} ${WORLD.currency}` : "不用錢"}</span>
        <a
          href={verifyUrl(card.serial)}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          title={card.serial}
        >
          {shortDate(card.issued_at)}
          <ExternalLink aria-hidden className="size-3" />
          <span className="sr-only">打開 {card.serial}</span>
        </a>
      </div>
    </li>
  );
}

function Body({ data }: { data: PersonCards }) {
  const [all, setAll] = useState(false);
  const { cards, dex, pity, wishlist } = data;
  const counts = KINDS.map((k) => [k, cards.filter((c) => kindOf(c.card) === k).length] as const).filter(([, n]) => n > 0);
  const shown = all ? cards : cards.slice(0, FIRST);
  const parts = dex.parts.length;
  return (
    <div className="grid gap-5">
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
        <dt className="text-muted-foreground">張數</dt>
        <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {cards.length} 張
          {counts.length > 0 && (
            <span className="text-[13px] text-muted-foreground">{counts.map(([k, n]) => `${KIND_LABEL[k]} ${n}`).join(" · ")}</span>
          )}
        </dd>
        <dt className="text-muted-foreground">保底</dt>
        <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 tabular-nums">
          {pity.until === 0 ? "下一張保證 SR 以上" : `再 ${pity.until} 張保證 SR 以上`}
          <span className="text-[13px] text-muted-foreground">
            連續 {pity.since} / {pity.pity}
          </span>
        </dd>
        <dt className="text-muted-foreground">願望單</dt>
        <dd className="min-w-0">{wishlist.length === 0 ? "沒有" : wishlist.map((p) => p.name).join("、")}</dd>
        <dt className="text-muted-foreground">圖鑑</dt>
        <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {parts} 個部件
          {dex.titles.length > 0 && <span className="text-[13px] text-muted-foreground">稱號 {dex.titles.map((t) => `「${t.title}」`).join("")}</span>}
          {dex.legacy.items.length > 0 && (
            <span className="text-[13px] text-muted-foreground">
              {dex.legacy.name} {dex.legacy.items.reduce((n, i) => n + i.count, 0)} 件
            </span>
          )}
        </dd>
      </dl>

      {cards.length > 0 && (
        <div className="grid gap-1">
          <ul className="divide-y divide-line-soft">
            {shown.map((c) => (
              <CardRow key={c.card.serial} entry={c} />
            ))}
          </ul>
          {cards.length > FIRST && (
            <Button size="sm" variant="link" className="justify-self-start px-0" onClick={() => setAll(!all)}>
              {all ? "只看最新的" : `顯示全部 ${cards.length} 張`}
            </Button>
          )}
        </div>
      )}

      {dex.series.length > 0 && (
        <div className="grid gap-1">
          <h4 className="text-[13px] text-muted-foreground">系列</h4>
          <ul className="divide-y divide-line-soft">
            {dex.series.map((s) => (
              <li key={s.id} className="grid grid-cols-[7rem_minmax(0,1fr)_2.5rem] items-center gap-3 py-1.5 text-sm">
                <span className={cn("truncate", s.complete && "text-primary")}>{s.name}</span>
                <Meter value={s.total === 0 ? 0 : s.owned / s.total} tone={s.complete ? "brand" : "neutral"} label={`${s.name} ${s.owned}/${s.total}`} />
                <span className="text-right font-mono text-xs tabular-nums">
                  {s.owned}/{s.total}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Their cards; nothing when the cards module is off or the Core has no such route. */
export function CardsSection({ personId }: { personId: string }) {
  const q = usePersonCards(personId);
  if (q.isPending) {
    return (
      <Section title="卡片">
        <SkeletonRows count={3} />
      </Section>
    );
  }
  if (q.isError) {
    if (isApiError(q.error) && (q.error.kind === "unavailable" || q.error.kind === "not_provided")) return null;
    return (
      <Section title="卡片">
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      </Section>
    );
  }
  return (
    <Section title="卡片">
      {q.data.cards.length === 0 && q.data.dex.parts.length === 0 ? (
        <p className="text-sm text-muted-foreground">還沒有卡</p>
      ) : (
        <Body data={q.data} />
      )}
    </Section>
  );
}
