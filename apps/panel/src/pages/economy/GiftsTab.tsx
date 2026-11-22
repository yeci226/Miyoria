// 經濟 / 禮物: free-form gifts as the owner sees them (docs/design/economy.md §16). Every gift with who
// gave it, the NT$ estimate and the price in coins, how it was priced and what she said, with 退款 on
// a charged one; then the names pinned to a price (in coins, or in NT$ that follows the rate) or
// blocked. Writes need `admin.economy.adjust`; the session does not say which nodes it holds, so a
// `403` is what tells, and the controls then say why.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import type { AdminGiftItem, GiftOverride, GiftPinRequest } from "@miyoria/contracts/api";
import { describeError, isApiError } from "@/api/http";
import { useApi } from "@/app/connection";
import { useCanWrite } from "@/app/session";
import { ConfirmDialog } from "@/components/confirm";
import { ModuleQuery } from "@/components/module-query";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { notify } from "@/lib/notify";
import { WORLD } from "@/lib/world";
import { GIFT_KIND, GIFT_KINDS, GIFT_STATUS_ADMIN, PRICED_BY, twdText } from "@/pages/public/gift-labels";

const MODULE = "禮物(economy 模組)";
const DENIED = "你的帳號沒有禮物的權限(需要 admin.economy.adjust)";
const NAME_MAX = 80;
const GIFTS = ["economy", "gifts"] as const;
const PRICES = [...GIFTS, "prices"] as const;

type Kind = (typeof GIFT_KINDS)[number];
/** What a pin is given in: coins stay as they are, NT$ follows the rate. */
type PinIn = "coins" | "twd";

const isDenied = (e: unknown) => isApiError(e) && e.status === 403;
const OFF = new Set(["unavailable", "not_provided", "unauthorized"]);
/** A stopped module or a missing route stays that way: no point asking every minute. */
const poll = (ms: number) => (q: { state: { error: Error | null } }) => (isApiError(q.state.error) && OFF.has(q.state.error.kind) ? false : ms);

/** The rate as it is, without trailing zeros (`1`, `0.5`). */
const rateText = (n: number) => n.toLocaleString("zh-TW", { maximumFractionDigits: 4 });

function useAdminGifts() {
  const api = useApi();
  return useQuery({ queryKey: GIFTS, queryFn: ({ signal }) => api.rpc.giftsAdmin.list(undefined, { signal }), refetchInterval: poll(30_000), retry: false });
}

function usePrices() {
  const api = useApi();
  return useQuery({ queryKey: PRICES, queryFn: ({ signal }) => api.rpc.giftsAdmin.prices(undefined, { signal }), refetchInterval: poll(60_000), retry: false });
}

const refundable = (g: AdminGiftItem) => g.status === "confirmed" || g.status === "accepted";

function GiftsTable({
  gifts,
  denied,
  onRefund,
}: {
  gifts: AdminGiftItem[];
  denied: boolean;
  onRefund: (g: AdminGiftItem) => void;
}) {
  return (
    <Table aria-label="最近的禮物">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-24 md:w-36">時間</TableHead>
          <TableHead className="min-w-[5rem] md:w-32">誰送的</TableHead>
          <TableHead className="min-w-[7rem]">東西</TableHead>
          <TableHead className="w-32 text-right">估價 → 價錢</TableHead>
          <TableHead className="min-w-[4.5rem] md:w-24">狀態</TableHead>
          <TableHead className="hidden w-24 md:table-cell">定價</TableHead>
          <TableHead className="hidden min-w-[10rem] lg:table-cell">她說的</TableHead>
          <TableHead className="w-16">
            <span className="sr-only">動作</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {gifts.map((g) => (
          <TableRow key={g.id}>
            <TableCell className="text-[13px] whitespace-normal text-muted-foreground tabular-nums md:whitespace-nowrap">{fmtDateTime(g.created_at)}</TableCell>
            <TableCell className="whitespace-normal break-words">
              {g.giver}
              <p className="text-xs text-muted-foreground">{g.source === "web" ? "網頁" : "Discord"}</p>
            </TableCell>
            <TableCell className="whitespace-normal break-words">
              {g.item}
              {g.kind && <span className="ml-1.5 text-xs text-muted-foreground">{GIFT_KIND[g.kind]}</span>}
              {g.reason && <p className="text-xs text-muted-foreground">{g.reason}</p>}
            </TableCell>
            <TableCell className="text-right whitespace-normal tabular-nums md:whitespace-nowrap">
              {g.twd !== null && <span className="text-muted-foreground">{twdText(g.twd)} → </span>}
              {fmtInt(g.price)}
            </TableCell>
            <TableCell className="whitespace-normal">
              {GIFT_STATUS_ADMIN[g.status] ?? g.status}
              {g.favourite && <p className="text-xs text-primary">她最喜歡</p>}
              {g.refunded_by && <p className="text-xs text-muted-foreground">{g.refunded_by}</p>}
            </TableCell>
            <TableCell className="hidden text-muted-foreground md:table-cell">{PRICED_BY[g.priced_by] ?? g.priced_by}</TableCell>
            <TableCell className="hidden whitespace-normal break-words text-muted-foreground lg:table-cell">{g.line ? `「${g.line}」` : "—"}</TableCell>
            <TableCell className="text-right">
              {refundable(g) && (
                <Button
                  size="sm"
                  variant="outline"
                  writes
                  disabled={denied}
                  title={denied ? DENIED : undefined}
                  aria-label={`退款 ${g.item}(${g.giver})`}
                  onClick={() => onRefund(g)}
                >
                  退款
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Recent({ denied, onDenied }: { denied: boolean; onDenied: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const q = useAdminGifts();
  // What is asked stays while the dialog closes, so its words do not blank out mid-fade.
  const [asking, setAsking] = useState<AdminGiftItem | null>(null);
  const [open, setOpen] = useState(false);
  const refund = useMutation({
    mutationFn: (id: string) => api.rpc.giftsAdmin.refund({ params: { id } }),
    onSettled: () => qc.invalidateQueries({ queryKey: GIFTS }),
  });
  const run = () => {
    if (!asking) return;
    refund.mutate(asking.id, {
      onSuccess: () => {
        notify.ok(`已退回 ${fmtInt(asking.price)} ${q.data?.currency ?? ""}給 ${asking.giver}`);
        setOpen(false);
      },
      onError: (err) => {
        if (isDenied(err)) onDenied();
        // 409: nothing left to give back; the list read again shows why.
        if (isDenied(err) || (isApiError(err) && err.status === 409)) setOpen(false);
        notify.error(err);
      },
    });
  };
  return (
    <Card aria-label="最近的禮物">
      <CardHeader>
        <CardTitle>最近的禮物</CardTitle>
      </CardHeader>
      <ModuleQuery query={q} module={MODULE} isEmpty={(d) => d.gifts.length === 0} empty="還沒有人送過禮物">
        {(d) => (
          <GiftsTable
            gifts={d.gifts}
            denied={denied}
            onRefund={(g) => {
              setAsking(g);
              setOpen(true);
            }}
          />
        )}
      </ModuleQuery>
      <ConfirmDialog
        open={open}
        title={asking ? `退款「${asking.item}」` : "退款"}
        confirmLabel="退款"
        busy={refund.isPending}
        onConfirm={run}
        onClose={() => setOpen(false)}
      >
        {asking && (
          <p>
            把 {fmtInt(asking.price)} {q.data?.currency ?? ""}全部還給 {asking.giver}。會記在稽核紀錄裡。
          </p>
        )}
      </ConfirmDialog>
    </Card>
  );
}

const SOURCE: Record<GiftOverride["source"], string> = { model: "模型估的", pinned: "指定", blocked: "封鎖" };

const PIN_IN: { value: PinIn; label: string }[] = [
  { value: "coins", label: `${WORLD.currency}價錢` },
  { value: "twd", label: "台幣估價" },
];

function OverridesTable({ overrides, denied, busy, onRemove }: { overrides: GiftOverride[]; denied: boolean; busy: string | null; onRemove: (name: string) => void }) {
  return (
    <Table aria-label="指定與封鎖">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="min-w-[7rem]">名字</TableHead>
          <TableHead className="hidden w-20 md:table-cell">種類</TableHead>
          <TableHead className="w-24 text-right">台幣</TableHead>
          <TableHead className="w-24 text-right">{`指定${WORLD.currency}`}</TableHead>
          <TableHead className="min-w-[5rem] text-right">現在的價錢</TableHead>
          <TableHead className="hidden w-20 md:table-cell">來源</TableHead>
          <TableHead className="hidden w-36 lg:table-cell">誰 · 時間</TableHead>
          <TableHead className="w-16">
            <span className="sr-only">動作</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {overrides.map((o) => (
          <TableRow key={o.item_key}>
            <TableCell className="whitespace-normal break-words">{o.item}</TableCell>
            <TableCell className="hidden text-muted-foreground md:table-cell">{o.kind ? GIFT_KIND[o.kind] : "—"}</TableCell>
            <TableCell className="text-right text-muted-foreground tabular-nums">{o.twd !== null ? twdText(o.twd) : "—"}</TableCell>
            <TableCell className="text-right text-muted-foreground tabular-nums">{o.coins !== null ? fmtInt(o.coins) : "—"}</TableCell>
            <TableCell className="text-right whitespace-normal tabular-nums">
              {o.source === "blocked" ? "封鎖" : o.price !== null ? fmtInt(o.price) : "—"}
              {o.refuse && <p className="text-xs text-muted-foreground">{o.refuse}</p>}
            </TableCell>
            <TableCell className="hidden text-muted-foreground md:table-cell">{SOURCE[o.source]}</TableCell>
            <TableCell className="hidden text-[13px] text-muted-foreground tabular-nums lg:table-cell">
              {o.by ? `${o.by} · ` : ""}
              {fmtDateTime(o.at)}
            </TableCell>
            <TableCell className="text-right">
              {o.source !== "model" && (
                <Button
                  size="sm"
                  variant="outline"
                  writes
                  disabled={denied}
                  title={denied ? DENIED : undefined}
                  busy={busy === o.item}
                  aria-label={`拿掉 ${o.item}`}
                  onClick={() => onRemove(o.item)}
                >
                  拿掉
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Overrides({ currency, denied, onDenied }: { currency: string; denied: boolean; onDenied: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const q = usePrices();
  const canWrite = useCanWrite();
  const ids = { name: useId(), kind: useId(), amount: useId() };
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [pinIn, setPinIn] = useState<PinIn>("coins");
  const [amount, setAmount] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const off = denied || !canWrite;
  const done = () => qc.invalidateQueries({ queryKey: PRICES });
  const fail = (err: unknown) => {
    if (isDenied(err)) onDenied();
    setRefused(describeError(err));
  };
  const pin = useMutation({
    mutationFn: (body: GiftPinRequest) => api.rpc.giftsAdmin.pin({ body }),
    onMutate: () => setRefused(null),
    onSuccess: (r, body) => {
      setName("");
      setAmount("");
      notify.ok(body.block ? `「${r.item}」封鎖了` : `「${r.item}」指定好了`);
      void done();
    },
    onError: fail,
  });
  const unpin = useMutation({
    mutationFn: (n: string) => api.rpc.giftsAdmin.unpin({ body: { name: n } }),
    onMutate: () => setRefused(null),
    onSuccess: (r, n) => {
      notify.ok(r.removed ? `「${n}」拿掉了` : `「${n}」本來就沒有設定`);
      void done();
    },
    onError: fail,
  });
  const text = name.trim();
  const n = Number(amount);
  const amountOk = amount.trim() !== "" && Number.isInteger(n) && n >= 1;
  const canPin = text !== "" && kind !== "" && amountOk;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canPin || off) return;
    const k = kind as Kind;
    pin.mutate(pinIn === "coins" ? { name: text, kind: k, coins: n } : { name: text, kind: k, twd: n });
  };
  return (
    <Card aria-label="指定價錢與封鎖">
      <CardHeader>
        <CardTitle>指定價錢與封鎖</CardTitle>
      </CardHeader>
      <ModuleQuery query={q} module={MODULE} isEmpty={(d) => d.overrides.length === 0} empty="還沒有指定或封鎖的名字">
        {(d) => (
          <OverridesTable
            overrides={d.overrides}
            denied={denied}
            busy={unpin.isPending ? (unpin.variables ?? null) : null}
            onRemove={(item) => unpin.mutate(item)}
          />
        )}
      </ModuleQuery>
      <form className="grid gap-3" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <div className="grid gap-2">
            <Label htmlFor={ids.name}>名字</Label>
            <Input id={ids.name} maxLength={NAME_MAX} autoComplete="off" value={name} disabled={off} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.kind}>種類</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as Kind)} disabled={off}>
              <SelectTrigger id={ids.kind} className="w-full">
                <SelectValue placeholder="選一種" />
              </SelectTrigger>
              <SelectContent>
                {GIFT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {GIFT_KIND[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid gap-2">
          <Segmented<PinIn> label="價錢用什麼指定" value={pinIn} options={PIN_IN} onChange={setPinIn} disabled={off} size="md" className="justify-self-start" />
          <div className="flex items-center gap-2">
            <Label htmlFor={ids.amount} className="sr-only">
              {pinIn === "coins" ? `價錢(${currency})` : "台幣估價(NT$)"}
            </Label>
            <Input
              id={ids.amount}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              className="w-32 tabular-nums"
              aria-invalid={amount !== "" && !amountOk}
              value={amount}
              disabled={off}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="text-[13px] text-muted-foreground">{pinIn === "coins" ? currency : "NT$"}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="secondary"
            writes
            busy={pin.isPending && !pin.variables?.block}
            disabled={!canPin || denied || pin.isPending}
            title={denied ? DENIED : undefined}
          >
            指定價錢
          </Button>
          <Button
            variant="outline"
            writes
            busy={pin.isPending && pin.variables?.block === true}
            disabled={text === "" || denied || pin.isPending}
            title={denied ? DENIED : undefined}
            onClick={() => pin.mutate({ name: text, block: true })}
          >
            封鎖這個名字
          </Button>
        </div>
        {refused && (
          <p role="alert" className="text-[13px] text-primary">
            {refused}
          </p>
        )}
        <p className="text-xs text-muted-foreground">指定之後這個名字照這個價錢算,不再問模型;封鎖之後送不出去。</p>
      </form>
    </Card>
  );
}

/** Every free-form gift, newest first, then the names pinned or blocked. */
export function GiftsTab() {
  const q = useAdminGifts();
  const [denied, setDenied] = useState(false);
  const deny = () => setDenied(true);
  const running = !q.isError;
  const currency = q.data?.currency ?? WORLD.currency;
  return (
    <div className="grid gap-(--stage-gap)">
      {denied && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {DENIED}
        </p>
      )}
      {q.data && (
        <p className="text-xs text-muted-foreground">
          匯率是 1 {currency} = NT${rateText(q.data.twd_per_coin)};台幣估價和以台幣指定的價錢跟著匯率變,以{currency}指定的不變。
        </p>
      )}
      <Recent denied={denied} onDenied={deny} />
      {running && <Overrides currency={currency} denied={denied} onDenied={deny} />}
    </div>
  );
}
