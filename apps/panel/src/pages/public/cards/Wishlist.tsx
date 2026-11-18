// 願望單: up to three parts they would like (picked from the Core's catalogue, the parts it marks
// wishable), saved or cleared on the
// Core. Wishing changes no odds; she mentions it when a wished part comes. The Core's own sentence
// is shown when it will not take a list.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart, X } from "lucide-react";
import { useState } from "react";
import type { CardWishlist } from "@miyoria/contracts/api";
import { describeError } from "@/api/http";
import { useApi } from "@/app/connection";
import { EmptyLine } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import { Chip } from "../CardSection";
import { CARD_KEYS, type CatalogPart } from "./data";
import { RarityBadge, SLOT_LABEL, SLOTS } from "./labels";

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function Wishlist({ saved, catalog }: { saved: CardWishlist; catalog: CatalogPart[] }) {
  const api = useApi();
  const client = useQueryClient();
  const savedIds = saved.parts.map((p) => p.id);
  // The list as being edited; null: the saved one.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const ids = draft ?? savedIds;
  const max = saved.max;
  const byId = new Map<string, { name: string; rarity: string; slot: string }>();
  for (const p of catalog) byId.set(p.id, p);
  for (const p of saved.parts) if (!byId.has(p.id)) byId.set(p.id, p);

  const save = useMutation({
    mutationFn: (parts: string[]) => api.rpc.cards.setWishlist({ body: { parts } }),
    onMutate: () => setRefused(null),
    onSuccess: (list) => {
      client.setQueryData(CARD_KEYS.wishlist, list);
      setDraft(null);
      notify.ok(list.parts.length === 0 ? "願望單清空了" : "願望單存好了");
    },
    onError: (e) => setRefused(describeError(e)),
  });

  const toggle = (id: string) => {
    setRefused(null);
    setDraft(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  };
  const dirty = !same(ids, savedIds);
  const full = ids.length >= max;
  // What the Core takes on a wishlist: a drop-only part too, never a blank or a disabled one.
  const wishable = catalog.filter((p) => p.wishable);

  return (
    <div className="grid gap-(--stage-gap)">
      <section aria-label="你的願望" className="grid max-w-2xl gap-2">
        <h3 className="flex items-baseline gap-2 text-[13px] font-medium">
          你的願望
          <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
            {ids.length}/{max}
          </span>
        </h3>
        {ids.length === 0 ? (
          <EmptyLine>還沒有願望</EmptyLine>
        ) : (
          <ol className="divide-y divide-line-soft">
            {ids.map((id) => {
              const p = byId.get(id);
              return (
                <li key={id} className="flex min-w-0 items-center gap-3 py-(--row-y)">
                  <Heart aria-hidden className="size-3.5 shrink-0 text-primary" />
                  <span className="w-10 shrink-0 text-xs text-muted-foreground">
                    {p && (SLOTS as readonly string[]).includes(p.slot) ? SLOT_LABEL[p.slot as (typeof SLOTS)[number]] : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{p?.name ?? id}</span>
                  {p && <RarityBadge rarity={p.rarity} />}
                  <Button variant="ghost" size="icon-sm" aria-label={`拿掉 ${p?.name ?? id}`} onClick={() => toggle(id)}>
                    <X />
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="secondary" size="sm" busy={save.isPending && ids.length > 0} disabled={!dirty || save.isPending} onClick={() => save.mutate(ids)}>
            儲存
          </Button>
          <Button
            variant="outline"
            size="sm"
            busy={save.isPending && ids.length === 0}
            disabled={(savedIds.length === 0 && ids.length === 0) || save.isPending}
            onClick={() => {
              setDraft([]);
              save.mutate([]);
            }}
          >
            清空
          </Button>
          {dirty && !save.isPending && (
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              還原
            </Button>
          )}
          <span className="text-xs text-muted-foreground">願望不改變機率</span>
        </div>
        {refused && (
          <p role="alert" className="text-[13px] text-primary">
            {refused}
          </p>
        )}
      </section>

      <section aria-label="挑部件" className="grid gap-4">
        <h3 className="text-[13px] font-medium">挑部件</h3>
        {wishable.length === 0 ? (
          <EmptyLine>沒有可以挑的部件</EmptyLine>
        ) : (
          SLOTS.map((slot) => {
            const parts = wishable.filter((p) => p.slot === slot);
            if (parts.length === 0) return null;
            return (
              <div key={slot} className="grid gap-2 sm:grid-cols-[3.5rem_minmax(0,1fr)] sm:items-start">
                <h4 className="pt-1.5 text-xs text-muted-foreground">{SLOT_LABEL[slot]}</h4>
                <div className="flex flex-wrap gap-1.5">
                  {parts.map((p) => {
                    const on = ids.includes(p.id);
                    return (
                      <Chip
                        key={p.id}
                        on={on}
                        disabled={!on && full}
                        onClick={() => toggle(p.id)}
                        label={`${p.name} ${p.rarity}${p.count > 0 ? ",已經有了" : ""}`}
                        className="inline-flex items-center gap-1.5"
                      >
                        <span className={on ? "text-foreground" : p.count > 0 ? "text-muted-foreground" : "text-foreground"}>{p.name}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{p.rarity}</span>
                      </Chip>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
