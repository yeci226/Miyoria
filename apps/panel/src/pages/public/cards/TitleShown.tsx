// Whether one of their titles is shown to others (on the public check of their cards) or theirs
// alone: the words it says now, and a switch that asks the Core to change it. Private when earned.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import type { CardDex, CardTitle } from "@miyoria/contracts/api";
import { useApi } from "@/app/connection";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { notify } from "@/lib/notify";
import { CARD_KEYS } from "./data";

export function TitleShown({ title }: { title: CardTitle }) {
  const api = useApi();
  const client = useQueryClient();
  const id = useId();
  const set = useMutation({
    mutationFn: (value: boolean) => api.rpc.cards.setTitle({ params: { series: title.series }, body: { public: value } }),
    onSuccess: (saved) => {
      client.setQueryData<CardDex>(CARD_KEYS.dex, (dex) =>
        dex ? { ...dex, titles: dex.titles.map((t) => (t.series === saved.series ? saved : t)) } : dex,
      );
      notify.ok(saved.public ? `「${saved.title}」別人看得到了` : `「${saved.title}」只有你看得到了`);
    },
    onError: (e) => notify.error(e),
  });
  const shown = set.isPending ? (set.variables ?? title.public) : title.public;
  return (
    <span className="flex shrink-0 items-center gap-2">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {shown ? "公開" : "只有你看得到"}
      </Label>
      <Switch
        id={id}
        checked={shown}
        disabled={set.isPending}
        aria-label={`「${title.title}」給別人看`}
        onCheckedChange={(v) => set.mutate(v)}
      />
    </span>
  );
}
