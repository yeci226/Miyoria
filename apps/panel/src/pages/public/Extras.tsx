// The newer places to spend on the member page (docs/design/economy.md §13): today's fortune slip
// (drawn with the check-in, see Wallet.tsx),
// sending coins to a friend, the sponsor board and her bounties. A Core
// without a route leaves its block out; someone she does not know never gets this far (the
// wallet says so first).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { isNotProvided } from "@/api/http";
import type { BountyView } from "@miyoria/contracts/api";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { QueryView, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { fmtInt, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { FortuneSlip } from "./FortuneSlip";
import { newKey, priceText, usePatchWallet, useWallet } from "./spend";

/** The query of today's slip: the check-in puts the slip it drew here. */
export const FORTUNE = ["member", "fortune"] as const;
const BOARD = ["public", "board"] as const;
const BOUNTIES = ["member", "bounties"] as const;
const POLL_MS = 60_000;
/** A transfer is at most this many coins; the Core says no above its own limit. */
export const TRANSFER_MAX = 50;

/** What the sender pays on top of `amount` at the Core's rate: rounded up, at least 1, none at 0. */
export function transferFee(amount: number, rate: number): number {
  if (rate <= 0) return 0;
  return Math.max(1, Math.ceil(Number((amount * rate).toFixed(6))));
}

/** An older Core has no such route: asking again will not change that. */
const retry = (n: number, e: Error) => !isNotProvided(e) && n < 2;

// ---------------------------------------------------------------------------
// fortune

/** Today's slip and what one costs; the wallet's check-in buys it and puts it here. */
export function useFortuneToday() {
  const api = useApi();
  return useQuery({
    queryKey: FORTUNE,
    queryFn: ({ signal }) => api.rpc.fortune.today(undefined, { signal }),
    retry,
  });
}

/** Today's slip; there is a button for none: it is drawn with the check-in (an add-on of it). */
export function Fortune() {
  const currency = useWallet().data?.currency ?? "幣";
  const today = useFortuneToday();
  if (today.isError && isNotProvided(today.error)) return null;
  return (
    <Card aria-label="今日籤詩">
      <CardHeader>
        <CardTitle>今日籤詩</CardTitle>
      </CardHeader>
      <QueryView query={today} skeleton={<SkeletonRows count={2} />}>
        {(t) =>
          t.fortune ? (
            <FortuneSlip fortune={t.fortune} />
          ) : (
            <p className="text-[13px] text-muted-foreground">
              每天一張,是她現在為你寫的。簽到時可以加買({priceText(t.price, currency)}),簽過到了也能只買籤詩,在錢包那邊。
            </p>
          )
        }
      </QueryView>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// transfer

/** Coins to a friend she knows, by their Discord user id. Asked before it leaves. */
export function Transfer() {
  const api = useApi();
  const { patch, refresh } = usePatchWallet();
  const wallet = useWallet();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [asking, setAsking] = useState(false);
  const toId = useId();
  const amountId = useId();
  const hintId = useId();
  const w = wallet.data;
  const n = Number(amount);
  const idOk = /^[0-9]{1,25}$/.test(to.trim());
  const amountOk = Number.isInteger(n) && n >= 1 && n <= TRANSFER_MAX;
  const fee = transferFee(n, w?.transfer_fee ?? 0);
  const send = useMutation({
    mutationFn: () => api.rpc.wallet.transfer({ headers: { "idempotency-key": newKey() }, body: { to_discord_id: to.trim(), amount: n } }),
    onSuccess: (r) => {
      setAsking(false);
      setAmount("");
      patch((v) => ({ ...v, balance: r.balance }));
      notify.ok(`已轉 ${fmtInt(r.sent)} ${w?.currency ?? ""}給 ${r.to},手續費 ${fmtInt(r.fee)}`);
      void refresh();
    },
    onError: (e) => {
      setAsking(false);
      notify.error(e);
      void refresh();
    },
  });
  if (!w?.can_earn) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (idOk && amountOk) setAsking(true);
  };
  return (
    <Card aria-label="轉給朋友">
      <CardHeader>
        <CardTitle>轉給朋友</CardTitle>
      </CardHeader>
      <form className="grid gap-2" onSubmit={submit}>
        <label htmlFor={toId} className="text-xs text-muted-foreground">
          對方的 Discord 使用者 ID
        </label>
        <Input
          id={toId}
          inputMode="numeric"
          autoComplete="off"
          aria-describedby={hintId}
          aria-invalid={to !== "" && !idOk}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          Discord 設定 → 進階 → 開啟開發者模式,再對著對方按右鍵「複製使用者 ID」。
        </p>
        <label htmlFor={amountId} className="text-xs text-muted-foreground">
          數量(最多 {TRANSFER_MAX})
        </label>
        <Input
          id={amountId}
          type="number"
          inputMode="numeric"
          min={1}
          max={TRANSFER_MAX}
          step={1}
          className="tabular-nums"
          aria-invalid={amount !== "" && !amountOk}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!idOk || !amountOk}>
          轉出
        </Button>
        <p className="text-xs text-muted-foreground">
          只能轉給她認識的人,每天有上限。另收{fmtInt(Math.round(w.transfer_fee * 100))}% 手續費(至少 1),由你付,不會到任何人手上。
        </p>
      </form>
      <ConfirmDialog
        open={asking}
        title="轉出魚幣"
        confirmLabel="轉出"
        busy={send.isPending}
        onConfirm={() => send.mutate()}
        onClose={() => setAsking(false)}
      >
        <p>
          把 {priceText(n, w.currency)} 轉給 ID {to.trim()},另付手續費 {priceText(fee, w.currency)}(燒掉),共扣{" "}
          {priceText(n + fee, w.currency)}。轉出後無法收回。
        </p>
      </ConfirmDialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// board

/** The sponsor board and the choice to be on it. Nothing at all on a Core without the route. */
export function Board() {
  const api = useApi();
  const client = useQueryClient();
  const { patch } = usePatchWallet();
  const wallet = useWallet();
  const id = useId();
  const board = useQuery({
    queryKey: BOARD,
    queryFn: ({ signal }) => api.rpc.public.board(undefined, { signal }),
    refetchInterval: POLL_MS,
    retry,
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.rpc.wallet.board({ body: { on } }),
    onSuccess: (r) => {
      patch((v) => ({ ...v, on_board: r.on_board }));
      notify.ok(r.on_board ? "你上榜了" : "你已經退出榜單");
      void client.invalidateQueries({ queryKey: BOARD });
    },
    onError: (e) => notify.error(e),
  });
  if (board.isError && isNotProvided(board.error)) return null;
  const on = wallet.data?.on_board;
  return (
    <Card aria-label="贊助排行榜">
      <CardHeader>
        <CardTitle>贊助排行榜</CardTitle>
      </CardHeader>
      {on !== undefined && (
        <div className="flex items-start gap-3">
          <Switch
            id={id}
            checked={on}
            disabled={toggle.isPending}
            onCheckedChange={(v) => toggle.mutate(v)}
            className="mt-0.5"
          />
          <div className="grid min-w-0 gap-0.5">
            <label htmlFor={id} className="text-sm">
              上贊助排行榜
            </label>
            <p className="text-xs text-muted-foreground">花過錢就預設在榜上。只顯示你近 30 天花在她身上的錢,不顯示餘額,隨時可以退出。</p>
          </div>
        </div>
      )}
      <QueryView
        query={board}
        skeleton={<SkeletonRows count={3} />}
        isEmpty={(b) => b.entries.length === 0}
        empty="還沒有人上榜"
      >
        {(b) => (
          <ul className="divide-y divide-line-soft">
            {b.entries.map((e) => (
              <li key={`${e.rank}-${e.name}`} className="flex items-baseline gap-3 py-(--row-y)">
                <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">{e.rank}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
                <span className="shrink-0 text-sm tabular-nums">{fmtInt(e.spent)}</span>
              </li>
            ))}
          </ul>
        )}
      </QueryView>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// bounties

function BountyRow({ b, currency }: { b: BountyView; currency: string }) {
  return (
    <li className="grid gap-0.5 py-(--row-y)">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 text-sm">{b.task}</span>
        <span className="shrink-0 text-sm font-medium tabular-nums">+{priceText(b.reward, currency)}</span>
      </div>
      <p className="text-xs text-muted-foreground">{fmtRelative(b.expires_at)}截止</p>
    </li>
  );
}

/** What she is paying for, from her own purse. */
export function Bounties() {
  const api = useApi();
  const currency = useWallet().data?.currency ?? "幣";
  const bounties = useQuery({
    queryKey: BOUNTIES,
    queryFn: ({ signal }) => api.rpc.agency.bounties(undefined, { signal }),
    refetchInterval: POLL_MS,
    retry,
  });
  if (bounties.isError && isNotProvided(bounties.error)) return null;
  return (
    <Card aria-label="她的懸賞">
      <CardHeader>
        <CardTitle>她的懸賞</CardTitle>
      </CardHeader>
      <QueryView
        query={bounties}
        skeleton={<SkeletonRows count={2} />}
        isEmpty={(r) => r.bounties.length === 0}
        empty="她現在沒有貼懸賞"
      >
        {(r) => (
          <>
            <ul className="divide-y divide-line-soft">
              {r.bounties.map((b) => (
                <BountyRow key={b.id} b={b} currency={currency} />
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">做到了就去和她說,有沒有完成由她判定。</p>
          </>
        )}
      </QueryView>
    </Card>
  );
}
