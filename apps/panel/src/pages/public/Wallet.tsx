// The coin wallet on someone's own page: the rail card (balance, check-in, feeding her) and the
// main-column blocks (shop, how to earn, recent). Everything is what `GET /api/member/wallet`
// answers; a Core without the route shows one line, and someone she does not know sees one line.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { FeedItem, FeedResult, ShopItem, SpendResult, WalletView } from "@miyoria/contracts/api";
import { isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { fmtInt, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { FRAME_SWATCH, frameName, isUniqueFrame } from "./card";
import { Board, Bounties, Fortune, FORTUNE, useFortuneToday } from "./Extras";
import { newKey, priceText, say, usePatchWallet, useWallet } from "./spend";

const SCREEN_MAX = 60;

export const STRANGER_LINE = "她還不認識你,先和她說說話吧";

const HUNGRY: Record<string, string> = { full: "吃飽了", ok: "還好", hungry: "有點餓", starving: "很餓" };
const FEED_LABEL: Record<string, string> = { rice: "一碗白飯", big_bowl: "鋼盆", dessert: "甜點" };
const FRAME_LABEL: Record<string, string> = { sakura: "櫻花", abyss: "深海", gold: "金框" };

// ---------------------------------------------------------------------------
// rail

function SpentChip({ amount }: { amount: number }) {
  return (
    <span aria-hidden className="wallet-spent pointer-events-none absolute -top-1 left-full ml-2 text-xs font-medium text-primary">
      −{fmtInt(amount)}
    </span>
  );
}

function WalletBody({ w }: { w: WalletView }) {
  const api = useApi();
  const { patch, refresh } = usePatchWallet();
  const [spent, setSpent] = useState<{ n: number; amount: number } | null>(null);
  const [fed, setFed] = useState<{ n: number; item: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const client = useQueryClient();
  const fortuneId = useId();
  // The fortune slip is a paid add-on of the check-in: asked with it, today's slip comes in its answer.
  const [withFortune, setWithFortune] = useState(false);
  const slipOffer = w.shop.find((s) => s.id === "fortune");
  // Offered until today's slip exists (and only where the Core answers for it).
  const slipDrawn = useFortuneToday().data;
  const slipOpen = slipOffer !== undefined && slipDrawn !== undefined && slipDrawn.fortune === null;
  const checkin = useMutation({
    mutationFn: (fortune: boolean) => api.rpc.wallet.checkin({ body: fortune ? { fortune: true } : {} }),
    onSuccess: (r) => {
      if (r.fortune) {
        const slip = r.fortune;
        client.setQueryData(FORTUNE, (old: { fortune: unknown; price: number } | undefined) => (old ? { ...old, fortune: slip } : old));
      }
      if (r.fortune_note) notify.info(r.fortune_note);
      patch((v) => ({
        ...v,
        balance: r.balance,
        streak: r.streak,
        checked_in_today: true,
        today_earned: v.today_earned + r.gained,
      }));
      setWithFortune(false);
      // A day checked in already buys the slip alone: `gained` is 0 then.
      if (r.gained > 0) notify.ok(`簽到了,+${fmtInt(r.gained)} ${w.currency}`);
      else if (r.fortune) notify.ok("今天的籤詩來了");
      void refresh();
    },
    onError: (e) => {
      notify.error(e);
      void refresh();
    },
  });

  const feed = useMutation({
    mutationFn: (item: FeedItem) => api.rpc.wallet.feed({ headers: { "idempotency-key": newKey() }, body: { item, count: 1 } }),
    onSuccess: (r: FeedResult, item) => {
      patch((v) => ({ ...v, balance: r.balance }));
      if (r.accepted) {
        notify.ok(r.message);
        clearTimeout(timer.current);
        setFed({ n: Date.now(), item });
        if (r.charged > 0) setSpent({ n: Date.now(), amount: r.charged });
        timer.current = setTimeout(() => {
          setFed(null);
          setSpent(null);
        }, 1400);
      } else {
        notify.info(r.message);
      }
      void refresh();
    },
    onError: (e) => {
      notify.error(e);
      void refresh();
    },
  });

  const checkinLine = w.earn.find((e) => e.reason === "checkin");
  const feeds = w.shop.filter((s) => s.kind === "feed");
  return (
    <div className="grid gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="relative flex min-w-0 items-baseline gap-1.5">
          <span className="text-xl font-semibold tabular-nums tracking-[-0.01em]">{fmtInt(w.balance)}</span>
          <span className="truncate text-[13px] text-muted-foreground">{w.currency}</span>
          {spent && <SpentChip key={spent.n} amount={spent.amount} />}
        </p>
        <span className="shrink-0 text-xs text-muted-foreground">今天 +{fmtInt(w.today_earned)}</span>
      </div>
      {w.hungry && <p className="text-[13px] text-muted-foreground">她現在:{HUNGRY[w.hungry] ?? w.hungry}</p>}
      <div className="grid gap-1.5">
        <Button variant="secondary" disabled={w.checked_in_today} busy={checkin.isPending} onClick={() => checkin.mutate(withFortune && slipOpen)}>
          {w.checked_in_today ? "今天已簽到" : `簽到${checkinLine ? ` +${fmtInt(checkinLine.amount)}` : ""}`}
        </Button>
        {slipOpen && !w.checked_in_today && (
          <div className="flex items-center gap-2">
            <Switch id={fortuneId} checked={withFortune} disabled={!slipOffer.available || checkin.isPending} onCheckedChange={setWithFortune} />
            <label htmlFor={fortuneId} className="text-xs text-muted-foreground">
              加買今日籤詩 · {priceText(slipOffer.price, w.currency)}
            </label>
          </div>
        )}
        {slipOpen && w.checked_in_today && (
          <Button
            variant="outline"
            disabled={!slipOffer.available || checkin.isPending}
            title={slipOffer.available ? undefined : (slipOffer.why ?? undefined)}
            busy={checkin.isPending}
            onClick={() => checkin.mutate(true)}
          >
            買今日籤詩 · {priceText(slipOffer.price, w.currency)}
          </Button>
        )}
        {w.streak > 0 && <p className="text-xs text-muted-foreground">連續簽到 {w.streak} 天</p>}
      </div>
      {feeds.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">餵她</p>
          <div className="grid grid-cols-3 gap-1.5">
            {feeds.map((s) => (
              <Button
                key={s.id}
                variant="outline"
                title={s.available ? undefined : (s.why ?? undefined)}
                disabled={!s.available || feed.isPending}
                onClick={() => feed.mutate(s.id as FeedItem)}
                className={cn(
                  "h-auto flex-col gap-0.5 px-1 py-2 whitespace-normal",
                  fed?.item === s.id && "wallet-press",
                )}
              >
                <span>{FEED_LABEL[s.id] ?? s.label}</span>
                <span className="text-xs font-normal text-muted-foreground tabular-nums">{fmtInt(s.price)}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Balance, check-in and feeding her: the top of the rail. */
export function WalletCard() {
  const wallet = useWallet();
  let body: React.ReactNode;
  if (wallet.isPending) body = <SkeletonRows count={3} />;
  else if (wallet.isError) {
    body = isNotProvided(wallet.error) ? (
      <EmptyLine>這個 Core 還沒有錢包</EmptyLine>
    ) : (
      <ErrorLine error={wallet.error} onRetry={() => void wallet.refetch()} />
    );
  } else if (!wallet.data.can_earn) body = <EmptyLine>{STRANGER_LINE}</EmptyLine>;
  else body = <WalletBody w={wallet.data} />;
  return (
    <Card aria-label="錢包">
      <CardHeader>
        <CardTitle>錢包</CardTitle>
      </CardHeader>
      {body}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// main column

/** One line on the stream's screen while she is live; she sees it and may read it out. */
function ScreenMessage({ item, currency }: { item: ShopItem; currency: string }) {
  const api = useApi();
  const { patch, refresh } = usePatchWallet();
  const [text, setText] = useState("");
  const id = useId();
  const count = [...text.trim()].length;
  const over = count > SCREEN_MAX;
  const send = useMutation({
    mutationFn: (t: string) => api.rpc.wallet.screen({ headers: { "idempotency-key": newKey() }, body: { text: t } }),
    onSuccess: (r: SpendResult) => {
      patch((v) => ({ ...v, balance: r.balance }));
      if (r.accepted) setText("");
      say(r);
      void refresh();
    },
    onError: (e) => notify.error(e),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (count > 0 && !over) send.mutate(text.trim());
  };
  return (
    <form className="grid content-start gap-2" onSubmit={submit}>
      <label htmlFor={id} className="text-xs text-muted-foreground">
        留言上大螢幕
      </label>
      <Input id={id} value={text} onChange={(e) => setText(e.target.value)} placeholder="她直播時才送得出去" />
      <div className="flex items-center justify-between gap-3">
        <span className={cn("text-xs tabular-nums", over ? "text-primary" : "text-muted-foreground")} aria-live="polite">
          {count}/{SCREEN_MAX}
        </span>
        <Button
          type="submit"
          variant="secondary"
          busy={send.isPending}
          disabled={count === 0 || over || !item.available}
          title={item.available ? undefined : (item.why ?? undefined)}
        >
          送上螢幕 · {priceText(item.price, currency)}
        </Button>
      </div>
      {!item.available && item.why && <p className="text-xs text-muted-foreground">{item.why}</p>}
    </form>
  );
}

/** A frame on the list: one the shop sells, or a one-of-a-kind one won at the weekly auction (never sold). */
interface FrameOffer {
  fid: string;
  label: string;
  /** `null`: not for sale. */
  price: number | null;
  available: boolean;
  why: string | null;
}

const shopFrame = (item: ShopItem): FrameOffer => {
  const fid = item.id.replace(/^frame:/, "");
  return { fid, label: FRAME_LABEL[fid] ?? item.label, price: item.price, available: item.available, why: item.why ?? null };
};

const wonFrame = (fid: string): FrameOffer => ({ fid, label: frameName(fid) ?? fid, price: null, available: false, why: null });

function FrameRow({ item, w }: { item: FrameOffer; w: WalletView }) {
  const api = useApi();
  const { patch, refresh } = usePatchWallet();
  const [asking, setAsking] = useState(false);
  const { fid, label } = item;
  const owned = w.frames.owned.includes(fid);
  const selected = w.frames.selected === fid;
  const run = useMutation({
    mutationFn: (req: { buy?: string; select?: string | null }) => api.rpc.wallet.frame({ headers: { "idempotency-key": newKey() }, body: req }),
    onSuccess: (r) => {
      patch((v) => ({ ...v, balance: r.balance, frames: { owned: r.owned, selected: r.selected } }));
      setAsking(false);
      void refresh();
    },
    onError: (e) => {
      notify.error(e);
      void refresh();
    },
  });
  return (
    <li className="grid gap-0.5 py-(--row-y)">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="h-5 w-3.5 shrink-0 rounded-[3px] border-2"
          style={{ borderColor: FRAME_SWATCH[fid] ?? "#ffffff66" }}
        />
        <span className="min-w-0 flex-1 text-sm">{label}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {selected ? "使用中" : owned ? "已擁有" : item.price === null ? "" : priceText(item.price, w.currency)}
        </span>
        {owned ? (
          <Button
            size="sm"
            variant="outline"
            aria-label={`${selected ? "卸下" : "使用"} ${label}`}
            busy={run.isPending}
            onClick={() => run.mutate({ select: selected ? null : fid })}
          >
            {selected ? "卸下" : "使用"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            aria-label={`購買 ${label}`}
            disabled={!item.available}
            onClick={() => setAsking(true)}
          >
            購買
          </Button>
        )}
      </div>
      {!owned && !item.available && item.why && <p className="text-xs text-muted-foreground">{item.why}</p>}
      <ConfirmDialog
        open={asking}
        title={`購買「${label}」框`}
        confirmLabel="購買"
        busy={run.isPending}
        onConfirm={() => run.mutate({ buy: fid })}
        onClose={() => setAsking(false)}
      >
        <p>
          {priceText(item.price ?? 0, w.currency)},之後抽的卡會用這個框。
        </p>
      </ConfirmDialog>
    </li>
  );
}

function Shop({ w }: { w: WalletView }) {
  const frames = [
    ...w.shop.filter((s) => s.kind === "frame").map(shopFrame),
    // A won one-of-a-kind frame is theirs alone and never in the shop: listed after the shop's.
    ...w.frames.owned.filter(isUniqueFrame).map(wonFrame),
  ];
  const screen = w.shop.find((s) => s.id === "screen_message");
  return (
    <Card aria-label="商店">
      <CardHeader>
        <CardTitle>商店</CardTitle>
      </CardHeader>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="grid content-start gap-5">
          {screen && <ScreenMessage item={screen} currency={w.currency} />}
        </div>
        <div className="grid content-start gap-5">
          {frames.length > 0 && (
            <div className="grid gap-1">
              <p className="text-xs text-muted-foreground">卡框</p>
              <ul className="divide-y divide-line-soft">
                {frames.map((f) => (
                  <FrameRow key={f.fid} item={f} w={w} />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function Earn({ w }: { w: WalletView }) {
  return (
    <Card aria-label="怎麼賺">
      <CardHeader>
        <CardTitle>怎麼賺</CardTitle>
      </CardHeader>
      {w.earn.length === 0 ? (
        <EmptyLine>今天沒有可以賺的</EmptyLine>
      ) : (
        <ul className="divide-y divide-line-soft">
          {w.earn.map((e) => (
            <li key={e.reason} className="flex items-baseline gap-3 py-(--row-y)">
              <span className="min-w-0 flex-1 text-sm">{e.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">+{fmtInt(e.amount)}</span>
              <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {fmtInt(e.earned_today)} / {fmtInt(e.cap)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Recent({ w }: { w: WalletView }) {
  return (
    <Card aria-label="最近">
      <CardHeader>
        <CardTitle>最近</CardTitle>
      </CardHeader>
      {w.recent.length === 0 ? (
        <EmptyLine>還沒有紀錄</EmptyLine>
      ) : (
        <ul className="divide-y divide-line-soft">
          {w.recent.map((l, i) => (
            <li key={`${l.ts}-${i}`} className="flex items-baseline gap-3 py-(--row-y)">
              <span className="min-w-0 flex-1 truncate text-sm">{l.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{fmtRelative(l.ts)}</span>
              <span className="w-12 shrink-0 text-right text-sm tabular-nums">
                {l.delta > 0 ? "+" : l.delta < 0 ? "−" : ""}
                {fmtInt(Math.abs(l.delta))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 商店, 籤詩, 排行榜, 目標, 懸賞, 怎麼賺 and 最近. Nothing at all for someone who cannot earn, or on a Core without a wallet. */
export function WalletMain() {
  const wallet = useWallet();
  const w = wallet.data;
  if (!w?.can_earn) return null;
  return (
    <>
      <Shop w={w} />
      <div className="grid items-start gap-(--stage-gap) lg:grid-cols-2">
        <Fortune />
        <Board />
      </div>
      <Bounties />
      <div className="grid gap-(--stage-gap) lg:grid-cols-2">
        <Earn w={w} />
        <Recent w={w} />
      </div>
    </>
  );
}
