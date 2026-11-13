// The newer places to spend on the member page (docs/design/economy.md §13): today's fortune slip,
// sending coins to a friend, the sponsor board, her crowdfunding goal and her bounties. A Core
// without a route leaves its block out; someone she does not know never gets this far (the
// wallet says so first).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dices } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { isNotProvided } from "@/api/http";
import type { BountyView, GoalView } from "@/api/types";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { fmtInt, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { FortuneSlip } from "./FortuneSlip";
import { newKey, priceText, usePatchWallet, useWallet } from "./spend";

const FORTUNE = ["member", "fortune"] as const;
const BOARD = ["public", "board"] as const;
const GOALS = ["member", "goals"] as const;
const BOUNTIES = ["member", "bounties"] as const;
const POLL_MS = 60_000;
/** A transfer is at most this many coins; the Core says no above its own limit. */
export const TRANSFER_MAX = 50;

/** An older Core has no such route: asking again will not change that. */
const retry = (n: number, e: Error) => !isNotProvided(e) && n < 2;

// ---------------------------------------------------------------------------
// fortune

/** Today's slip, or a button to draw one: once a day, she writes it. */
export function Fortune() {
  const api = useApi();
  const client = useQueryClient();
  const { patch, refresh } = usePatchWallet();
  const currency = useWallet().data?.currency ?? "幣";
  const today = useQuery({
    queryKey: FORTUNE,
    queryFn: ({ signal }) => api.memberFortune({ signal }),
    retry,
  });
  const draw = useMutation({
    mutationFn: () => api.memberDrawFortune(newKey()),
    onSuccess: (r) => {
      client.setQueryData(FORTUNE, (old: typeof today.data) => (old ? { ...old, fortune: r.fortune } : old));
      patch((v) => ({ ...v, balance: r.balance }));
      void refresh();
    },
    onError: (e) => {
      notify.error(e);
      void refresh();
    },
  });
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
            <div className="grid justify-items-start gap-2">
              <p className="text-[13px] text-muted-foreground">每天一張,是她現在為你寫的。</p>
              <Button variant="secondary" busy={draw.isPending} onClick={() => draw.mutate()}>
                <Dices aria-hidden />
                抽籤 · {priceText(t.price, currency)}
              </Button>
            </div>
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
  const send = useMutation({
    mutationFn: () => api.memberTransfer(to.trim(), n, newKey()),
    onSuccess: (r) => {
      setAsking(false);
      setAmount("");
      patch((v) => ({ ...v, balance: r.balance }));
      notify.ok(`已轉 ${fmtInt(r.sent)} ${w?.currency ?? ""}給 ${r.to}`);
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
        <p className="text-xs text-muted-foreground">只能轉給她認識的人,每天有上限。</p>
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
          把 {priceText(n, w.currency)} 轉給 ID {to.trim()}。轉出後無法收回。
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
    queryFn: ({ signal }) => api.publicBoard({ signal }),
    refetchInterval: POLL_MS,
    retry,
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.memberBoard(on),
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
// goals and bounties

const ENDED: Record<GoalView["status"], string> = {
  open: "進行中",
  reached: "達成了",
  expired: "沒湊到,已退回",
  cancelled: "她取消了,已退回",
};

function Progress({ raised, target }: { raised: number; target: number }) {
  const pct = target > 0 ? Math.min(100, Math.round((raised / target) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label="募資進度"
      aria-valuemin={0}
      aria-valuemax={target}
      aria-valuenow={Math.min(raised, target)}
      className="h-1.5 overflow-hidden rounded-[2px] bg-muted"
    >
      <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  );
}

function OpenGoal({ goal, currency }: { goal: GoalView; currency: string }) {
  const api = useApi();
  const client = useQueryClient();
  const { patch, refresh } = usePatchWallet();
  const [amount, setAmount] = useState("");
  const id = useId();
  const n = Number(amount);
  const ok = Number.isInteger(n) && n >= 1;
  const pledge = useMutation({
    mutationFn: () => api.memberPledge(goal.id, n, newKey()),
    onSuccess: (r) => {
      setAmount("");
      patch((v) => ({ ...v, balance: r.balance }));
      notify.ok(r.reached ? "目標達成了" : `投了 ${priceText(r.pledged, currency)}`);
      void client.invalidateQueries({ queryKey: GOALS });
      void refresh();
    },
    onError: (e) => {
      notify.error(e);
      void client.invalidateQueries({ queryKey: GOALS });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ok) pledge.mutate();
  };
  return (
    <div className="grid gap-2.5">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-medium">{goal.title}</h3>
        <p className="text-[13px]">她答應:{goal.promise}</p>
      </div>
      <Progress raised={goal.raised} target={goal.target} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {fmtInt(goal.raised)} / {fmtInt(goal.target)} {currency}
        </span>
        <span>{fmtRelative(goal.deadline)}截止</span>
      </div>
      {goal.my_pledge > 0 && (
        <p className="text-xs text-muted-foreground">你已經投了 {priceText(goal.my_pledge, currency)}</p>
      )}
      <form className="flex items-end gap-2" onSubmit={submit}>
        <div className="grid min-w-0 flex-1 gap-1">
          <label htmlFor={id} className="text-xs text-muted-foreground">
            投多少
          </label>
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            className="tabular-nums"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" busy={pledge.isPending} disabled={!ok}>
          投入
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">錢先放在託管,湊滿才給她,沒湊滿會退回。</p>
    </div>
  );
}

/** The goal she has open, and the ones that ended lately. */
export function Goals() {
  const api = useApi();
  const currency = useWallet().data?.currency ?? "幣";
  const goals = useQuery({
    queryKey: GOALS,
    queryFn: ({ signal }) => api.memberGoals({ signal }),
    refetchInterval: POLL_MS,
    retry,
  });
  if (goals.isError && isNotProvided(goals.error)) return null;
  return (
    <Card aria-label="她的目標">
      <CardHeader>
        <CardTitle>她的目標</CardTitle>
      </CardHeader>
      <QueryView query={goals} skeleton={<SkeletonRows count={3} />}>
        {({ goals: list }) => {
          const open = list.filter((g) => g.status === "open");
          const ended = list.filter((g) => g.status !== "open");
          return (
            <div className="grid gap-4">
              {open.length === 0 && <EmptyLine>她現在沒有提目標</EmptyLine>}
              {open.map((g) => (
                <OpenGoal key={g.id} goal={g} currency={currency} />
              ))}
              {ended.length > 0 && (
                <ul className="divide-y divide-line-soft">
                  {ended.map((g) => (
                    <li key={g.id} className="flex items-baseline gap-3 py-(--row-y)">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{g.title}</span>
                      <span
                        className={cn(
                          "shrink-0 text-xs",
                          g.status === "reached" ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {ENDED[g.status]}
                        {g.status === "reached" && g.fulfilled && ",她做到了"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        }}
      </QueryView>
    </Card>
  );
}

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
    queryFn: ({ signal }) => api.memberBounties({ signal }),
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
