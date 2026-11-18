// 我的卡: every card she gave them, newest first (daily, milestone, keepsake and drop cards, then
// their older member cards), as pictures to open. A kind filter appears once there are two kinds.

import { Sparkles } from "lucide-react";
import { useState } from "react";
import type { ListedCard, MyCards as MyCardsView } from "@miyoria/contracts/api";
import { EmptyLine } from "@/components/query-state";
import { Segmented } from "@/components/ui/segmented";
import { CardDialog } from "./CardDialog";
import { type Kind, KIND_LABEL, KINDS, kindOf, CardThumb, RarityBadge, shortDate } from "./labels";

function Tile({ card, onOpen }: { card: ListedCard; onOpen: () => void }) {
  const kind = kindOf(card);
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${KIND_LABEL[kind]} 第 ${card.number} 張${card.rarity ? ` ${card.rarity}` : ""}${card.foil ? " 閃卡" : ""},${shortDate(card.issued_at)}`}
        className="group grid w-full gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-transparent"
      >
        <span className="relative block">
          <CardThumb card={card} className="transition-[filter] duration-150 group-hover:brightness-110" />
          {card.foil && (
            <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-[4px] bg-black/55 text-primary [text-shadow:none]">
              <Sparkles aria-hidden className="size-3" />
            </span>
          )}
        </span>
        <span className="flex min-h-5 min-w-0 items-center gap-1.5">
          {card.rarity && <RarityBadge rarity={card.rarity} />}
          <span className="truncate text-xs text-foreground">{KIND_LABEL[kind]}</span>
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{shortDate(card.issued_at)}</span>
      </button>
    </li>
  );
}

export function MyCards({ view, currency }: { view: MyCardsView; currency: string }) {
  const [kind, setKind] = useState<Kind | "all">("all");
  const [open, setOpen] = useState<ListedCard | null>(null);
  const cards = view.cards;
  if (cards.length === 0) return <EmptyLine>還沒有卡</EmptyLine>;
  const counts = new Map<Kind, number>();
  for (const c of cards) counts.set(kindOf(c), (counts.get(kindOf(c)) ?? 0) + 1);
  const kinds = KINDS.filter((k) => counts.has(k));
  const shown = kind === "all" ? cards : cards.filter((c) => kindOf(c) === kind);
  return (
    <div className="grid gap-4">
      {kinds.length > 1 && (
        <Segmented
          label="看哪一種卡"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: `全部 ${cards.length}` },
            ...kinds.map((k) => ({ value: k, label: `${KIND_LABEL[k]} ${counts.get(k) ?? 0}` })),
          ]}
        />
      )}
      <ul className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10">
        {shown.map((c) => (
          <Tile key={c.serial} card={c} onOpen={() => setOpen(c)} />
        ))}
      </ul>
      <CardDialog card={open} currency={currency} onClose={() => setOpen(null)} />
    </div>
  );
}
