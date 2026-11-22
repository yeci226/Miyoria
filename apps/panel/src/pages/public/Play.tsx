// Economy 2.0 on the member page (docs/design/v5-architecture.md §9.4, v5-play.md §4.2): today's
// three quests in the rail, and the predictions in the main column. Everything is what
// `/api/member/quests` and `/api/member/predictions` answer. Nothing here ticks a quest or settles
// a prediction: a game, a song, she or the owner does. A Core without the routes or the economy
// leaves the blocks out, and someone she does not know gets neither (the wallet already says why).
// Predictions are per server: the ones of a server of theirs (a choice of which with two or more),
// and only that server's members may bet; the coins are the one wallet.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import type { PredictionView } from "@miyoria/contracts/api";
import { describeError, isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { fmtInt, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { useOwnSpace } from "./board-scope";
import { SpacePicker } from "./member-space";
import { newKey, priceText, useWallet, WALLET } from "./spend";

export const QUESTS = ["member", "quests"] as const;
const POLL_MS = 60_000;

/** An older Core has no such route, and a stopped module stays stopped: asking again will not change either. */
const gone = (e: unknown) => isNotProvided(e) || (isApiError(e) && e.kind === "unavailable");

export function useQuests() {
  const api = useApi();
  return useQuery({
    queryKey: QUESTS,
    queryFn: ({ signal }) => api.rpc.wallet.quests(undefined, { signal }),
    refetchInterval: (q) => (q.state.error ? false : POLL_MS),
    retry: (n, e) => !gone(e) && n < 2,
  });
}

const OPEN_DOT = "[&>span]:bg-transparent [&>span]:ring-[1.5px] [&>span]:ring-inset [&>span]:ring-muted-foreground/70";

/** Today's three quests: what each is, how it gets done, and what they paid. */
export function QuestsCard() {
  const q = useQuests();
  if (q.isError && gone(q.error)) return null;
  if (q.isSuccess && q.data.quests.length === 0) return null;
  return (
    <Card aria-label="今天的任務">
      <CardHeader>
        <CardTitle>今天的任務</CardTitle>
      </CardHeader>
      {q.isPending ? (
        <SkeletonRows count={3} />
      ) : q.isError ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <ul className="divide-y divide-line-soft">
            {q.data.quests.map((x) => (
              <li key={x.id} className="flex items-start gap-3 py-(--row-y)">
                <Dot tone={x.done ? "success" : "neutral"} className={x.done ? "mt-1.5" : `mt-1.5 ${OPEN_DOT}`} />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className={x.done ? "text-sm text-muted-foreground" : "text-sm"}>{x.label}</span>
                  <span className="text-xs text-muted-foreground">{x.hint}</span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{x.done ? "完成" : `+${fmtInt(q.data.reward)}`}</span>
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-muted-foreground tabular-nums">
            三個都完成再加 {fmtInt(q.data.bonus)}
            {q.data.bonus_done ? "(已拿到)" : ""} · 今天 {fmtInt(q.data.earned_today)} / {fmtInt(q.data.cap)} {q.data.currency}
          </p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// predictions

export const PREDICTIONS = ["member", "predictions"] as const;

function usePredictions(space: string | undefined, ready: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...PREDICTIONS, space ?? null],
    queryFn: ({ signal }) => api.rpc.wallet.predictions({ query: { space } }, { signal }),
    enabled: ready,
    refetchInterval: (q) => (q.state.error ? false : 30_000),
    retry: (n, e) => !gone(e) && n < 2,
  });
}

const STATUS: Record<PredictionView["status"], string> = {
  open: "可以押",
  closed: "截止了,等結果",
  resolved: "結果出來了",
  cancelled: "取消了,都退回了",
};

const OUTCOME: Record<string, string> = { won: "猜中", lost: "沒猜中", refunded: "退回了", open: "等結果" };

/** A stake on one option of an open prediction: one per person, fresh key per press. */
function StakeForm({ p, currency }: { p: PredictionView; currency: string }) {
  const api = useApi();
  const client = useQueryClient();
  const id = useId();
  const [option, setOption] = useState<string | null>(null);
  const [typed, setTyped] = useState("10");
  const [refused, setRefused] = useState<string | null>(null);
  const n = Number(typed);
  const ok = option !== null && typed.trim() !== "" && Number.isInteger(n) && n > 0;
  const bet = useMutation({
    mutationFn: (v: { option: string; amount: number }) =>
      api.rpc.wallet.bet({
        headers: { "idempotency-key": newKey() },
        body: { prediction: p.id, option: v.option, amount: v.amount },
      }),
    onMutate: () => setRefused(null),
    onSuccess: (r) => {
      notify.ok(`押了「${r.option}」${priceText(r.amount, currency)}`);
      void client.invalidateQueries({ queryKey: PREDICTIONS });
      void client.invalidateQueries({ queryKey: WALLET });
    },
    onError: (e) => setRefused(describeError(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ok && option !== null) bet.mutate({ option, amount: n });
  };
  return (
    <form className="grid gap-2" onSubmit={submit}>
      <Segmented label={`${p.question} 押哪個`} value={option} options={p.options.map((o) => ({ value: o.label, label: o.label }))} onChange={setOption} />
      <div className="flex gap-2">
        <label htmlFor={id} className="sr-only">
          押多少
        </label>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          className="min-w-0 flex-1 tabular-nums"
          aria-invalid={typed.trim() !== "" && !(Number.isInteger(n) && n > 0)}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button type="submit" variant="secondary" busy={bet.isPending} disabled={!ok}>
          押
        </Button>
      </div>
      {refused && (
        <p role="alert" className="text-[13px] text-primary">
          {refused}
        </p>
      )}
    </form>
  );
}

function Prediction({ p, currency, now }: { p: PredictionView; currency: string; now: number }) {
  const how = p.settled_by?.note ?? p.settles.label;
  return (
    <li className="grid gap-3 border-b border-line-soft py-4 first:pt-1 last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="min-w-0 text-sm font-medium break-words">{p.question}</h3>
        <span className="text-[13px] text-muted-foreground">{STATUS[p.status]}</span>
        <span className="ml-auto text-[13px] text-muted-foreground tabular-nums">
          {p.status === "open" ? `${fmtRelative(p.closes_at, now)}截止 · ` : ""}共 {priceText(p.total, currency)}
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground">{how}</p>
      <ul className="divide-y divide-line-soft">
        {p.options.map((o) => (
          <li key={o.label} className="flex items-baseline gap-3 py-(--row-y)">
            <span className={p.winner === o.label ? "min-w-0 flex-1 text-sm font-semibold" : "min-w-0 flex-1 text-sm"}>
              {o.label}
              {p.winner === o.label && " · 結果"}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {fmtInt(o.staked)} · {fmtInt(o.backers)} 人{o.multiplier === null ? "" : ` · 1 賠 ${o.multiplier}`}
            </span>
          </li>
        ))}
      </ul>
      {p.my_bet ? (
        <p className="text-[13px] tabular-nums">
          你押了「{p.my_bet.option}」{priceText(p.my_bet.amount, currency)} · {OUTCOME[p.my_bet.outcome] ?? p.my_bet.outcome}
          {p.my_bet.outcome === "won" || p.my_bet.outcome === "refunded" ? `,拿回 ${priceText(p.my_bet.payout, currency)}` : ""}
        </p>
      ) : (
        p.status === "open" && <StakeForm p={p} currency={currency} />
      )}
    </li>
  );
}

/**
 * The predictions open now and the ones settled lately: how each settles, the stakes, their own,
 * and a stake on an open one. Nothing when there are none.
 */
export function Predictions() {
  const wallet = useWallet();
  const own = useOwnSpace();
  const q = usePredictions(own.space, !own.loading);
  if (wallet.data && !wallet.data.can_earn) return null;
  if (q.isError && gone(q.error)) return null;
  // Usually there are none: nothing shows until there is something to show.
  if (q.isPending || (q.isSuccess && q.data.predictions.length === 0 && own.spaces.length <= 1)) return null;
  const now = q.dataUpdatedAt > 0 ? q.dataUpdatedAt : Date.now();
  return (
    <Card aria-label="預測">
      <CardHeader>
        <CardTitle>預測</CardTitle>
      </CardHeader>
      <SpacePicker value={own.space ?? null} spaces={own.spaces} onChange={own.setSpace} />
      {q.isError ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.predictions.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">這個伺服器現在沒有預測</p>
      ) : (
        <>
          <ul aria-label="預測的題目" className="grid">
            {q.data.predictions.map((p) => (
              <Prediction key={p.id} p={p} currency={q.data.currency} now={now} />
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">猜中的人平分大家押的,抽一點燒掉;沒人猜中、取消或看不出結果就全部退回。</p>
        </>
      )}
    </Card>
  );
}
