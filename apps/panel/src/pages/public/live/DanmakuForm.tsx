import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { isApiError } from "@/api/http";
import { useApi } from "@/app/connection";
import { usePushed } from "@/app/push";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { WORLD } from "@/lib/world";
import { newKey, priceText } from "../spend";

const DANMAKU = ["member", "danmaku"] as const;
const REFRESH_MS = 20_000;

/** What the last send came back with: a refusal is in the primary colour, a success is muted. */
type Note = { ok: boolean; text: string } | null;

/**
 * 彈幕: a member pays a few coins for one short line that crosses her stream. Shown only to a
 * member while the Core has danmaku on. The server says, in a sentence, why one cannot be sent
 * right now (`why`) and why a send was refused; both are shown as they are.
 */
export function DanmakuForm() {
  const api = useApi();
  const client = useQueryClient();
  const id = useId();
  const [text, setText] = useState("");
  const [note, setNote] = useState<Note>(null);
  // By push under a `PushProvider` (her going live opens the form at once), else polled.
  const pushed = usePushed("danmaku", null, DANMAKU);
  const view = useQuery({
    queryKey: DANMAKU,
    queryFn: ({ signal }) => api.rpc.wallet.danmakuView(undefined, { signal }),
    refetchInterval: pushed ? false : REFRESH_MS,
    retry: false,
  });
  const send = useMutation({
    mutationFn: (t: string) => api.rpc.wallet.danmaku({ headers: { "idempotency-key": newKey() }, body: { text: t } }),
    onSuccess: (r) => {
      if (r.accepted) setText("");
      setNote({ ok: r.accepted, text: r.message || (r.accepted ? "彈幕送出了" : `這則沒有送出,沒有扣${WORLD.currency}`) });
      void client.invalidateQueries({ queryKey: DANMAKU });
    },
    onError: (e) => {
      setNote({ ok: false, text: isApiError(e) && e.message ? e.message : "沒送出去,稍後再試" });
      void client.invalidateQueries({ queryKey: DANMAKU });
    },
  });

  const d = view.data;
  if (d?.open !== true) return null;

  const count = [...text.trim()].length;
  const over = count > d.max_chars;
  const blocked = d.why !== null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (count > 0 && !over && !blocked && !send.isPending) send.mutate(text.trim());
  };

  return (
    <form className="grid max-w-[28rem] gap-2" onSubmit={submit} data-testid="danmaku-form">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        發一則彈幕,從她的直播畫面右邊飄過
      </label>
      <div className="flex items-center gap-2">
        <Input id={id} value={text} maxLength={d.max_chars} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-note`} />
        <Button type="submit" variant="secondary" busy={send.isPending} disabled={count === 0 || over || blocked}>
          發彈幕 · {priceText(d.price, d.currency)}
        </Button>
      </div>
      <p className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground tabular-nums">
        <span aria-live="polite">
          {count}/{d.max_chars}
        </span>
        <span>
          每 {d.cooldown_s} 秒一則,今天 {d.sent_today}/{d.per_day} · 沒顯示出來的會自動退回
        </span>
      </p>
      {d.why && <p className="text-xs text-muted-foreground">{d.why}</p>}
      <p id={`${id}-note`} role="status" className={cn("text-[13px]", note && !note.ok ? "text-primary" : "text-muted-foreground")}>
        {note?.text ?? ""}
      </p>
    </form>
  );
}
