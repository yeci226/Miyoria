// 市集 on the member page (docs/design/v5-play.md §11.4): this week's auction and lottery, what they
// bid and bought. Everything is what `/api/member/market/*` answers; a refusal is the Core's own
// sentence under the button. A Core without the routes leaves the block out, the market module
// stopped is one line, and someone she does not know never gets this far (the wallet says so first).
//
// Each server has its own market (phase 6): someone in several picks which (`SpacePicker`, drawn
// only then), everyone else sees their own server's, so a single-server install looks as it did.

import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import type { AuctionView, LotteryView, LotView, MyTickets, NameRequest } from "@miyoria/contracts/api";
import { describeError, isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { OffLine } from "@/components/module-query";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtDateTime, fmtInt, fmtPct, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { WORLD } from "@/lib/world";
import { BID_STATE, LOT_STATE, WEEK_STATE } from "./market-labels";
import { SpacePicker, useMemberSpace } from "./member-space";
import { newKey, priceText, useWallet, WALLET } from "./spend";

const MARKET = ["member", "market"] as const;
const AUCTION = [...MARKET, "auction"] as const;
const BIDS = [...MARKET, "bids"] as const;
const LOTTERY = [...MARKET, "lottery"] as const;
const TICKETS = [...MARKET, "tickets"] as const;
/** Bids come in and the end can move: a little faster than the wallet. */
const AUCTION_POLL_MS = 30_000;
const POLL_MS = 60_000;
/** The newest bids shown under the form. */
const RECENT_BIDS = 5;
const LIST_MAX = 8;

/** An older Core has no such route, and a stopped module stays stopped: asking again will not change either. */
const retry = (n: number, e: Error) => !isNotProvided(e) && !(isApiError(e) && e.kind === "unavailable") && n < 2;
const poll = (ms: number) => (q: { state: { error: unknown } }) => (q.state.error ? false : ms);
/** `?space=` of the server the block is about; left out while unknown (the Core's default then). */
const spaceQuery = (space: string | null) => (space ? { space } : {});

/** This week's auction of `space`: shared with the song form, which offers the priority ticket while the market answers. */
export function useAuction(space: string | null = null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...AUCTION, space ?? ""],
    queryFn: ({ signal }) => api.rpc.market.auction({ query: spaceQuery(space) }, { signal }),
    refetchInterval: poll(AUCTION_POLL_MS),
    retry,
    enabled,
  });
}

function useLottery(space: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: [...LOTTERY, space ?? ""],
    queryFn: ({ signal }) => api.rpc.market.lottery({ query: spaceQuery(space) }, { signal }),
    refetchInterval: poll(POLL_MS),
    retry,
  });
}

function useMyBids(space: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: [...BIDS, space ?? ""],
    queryFn: ({ signal }) => api.rpc.market.bids({ query: spaceQuery(space) }, { signal }),
    refetchInterval: poll(POLL_MS),
    retry,
  });
}

function useMyTickets(space: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: [...TICKETS, space ?? ""],
    queryFn: ({ signal }) => api.rpc.market.tickets({ query: spaceQuery(space) }, { signal }),
    refetchInterval: poll(POLL_MS),
    retry,
  });
}

/** After a bid, a name or a ticket: the market's views and the wallet read again. */
function useRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: MARKET });
    void client.invalidateQueries({ queryKey: WALLET });
  };
}

/** Loading, the error with a retry, or the data. */
function Loaded<T>({ query, rows = 3, children }: { query: UseQueryResult<T>; rows?: number; children: (data: T) => ReactNode }) {
  if (query.isPending) return <SkeletonRows count={rows} />;
  if (query.isError) return <ErrorLine error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid min-w-0 content-start gap-3">
      <h3 className="text-[13px] font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** Label over value, spaced, no cell walls. */
function Fact({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums" title={title}>
        {children}
      </dd>
    </div>
  );
}

/** The Core's sentence for what it would not do, under the button. */
function Refusal({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="text-[13px] text-primary">
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// the auction

function BidForm({ lot, currency, space }: { lot: LotView & { min_bid: number }; currency: string; space: string | null }) {
  const api = useApi();
  const refresh = useRefresh();
  const id = useId();
  // Prefilled with the smallest bid that would lead, until they type their own.
  const [typed, setTyped] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const text = typed ?? String(lot.min_bid);
  const n = Number(text);
  const ok = text.trim() !== "" && Number.isInteger(n) && n > 0;
  const bid = useMutation({
    mutationFn: (amount: number) => api.rpc.market.bid({ query: spaceQuery(space), body: { amount } }),
    onMutate: () => setRefused(null),
    onSuccess: (r) => {
      setTyped(null);
      notify.ok(r.extended ? `出價 ${priceText(r.amount, currency)},結束時間延後了` : `出價 ${priceText(r.amount, currency)}`);
      refresh();
    },
    onError: (e) => {
      setRefused(describeError(e));
      refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ok) bid.mutate(n);
  };
  return (
    <form className="grid gap-2" onSubmit={submit}>
      <label htmlFor={id} className="text-xs text-muted-foreground">
        出價(至少 {priceText(lot.min_bid, currency)},每次至少加 {fmtInt(lot.step)})
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          className="min-w-0 flex-1 tabular-nums"
          aria-invalid={!ok}
          value={text}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button type="submit" variant="secondary" busy={bid.isPending} disabled={!ok}>
          出價
        </Button>
      </div>
      <Refusal text={refused} />
      <p className="text-xs text-muted-foreground">出價會先押住,被超過就馬上還你;得標的錢會燒掉。</p>
    </form>
  );
}

/** The winner of a name lot gives the name, or gives the lot up for a full refund. */
function NameForm({ lot, currency, space }: { lot: LotView; currency: string; space: string | null }) {
  const api = useApi();
  const refresh = useRefresh();
  const id = useId();
  const [name, setName] = useState("");
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (body: NameRequest) => api.rpc.market.name({ query: spaceQuery(space), body }),
    onMutate: () => setRefused(null),
    onSuccess: (r) => {
      setAsking(false);
      setName("");
      if (r.call_name) notify.ok(`她這一週會叫你「${r.call_name}」`);
      else notify.ok(`已經退回 ${priceText(r.refunded, currency)}`);
      refresh();
    },
    onError: (e) => {
      setAsking(false);
      setRefused(describeError(e));
      refresh();
    },
  });
  const trimmed = name.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (trimmed !== "") run.mutate({ name: trimmed });
  };
  return (
    <form className="grid gap-2" onSubmit={submit}>
      <label htmlFor={id} className="text-xs text-muted-foreground">
        你得標了,這一週要她怎麼叫你{lot.name_due ? `(${fmtRelative(lot.name_due)}前)` : ""}
      </label>
      <div className="flex gap-2">
        <Input id={id} maxLength={40} className="min-w-0 flex-1" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="secondary" busy={run.isPending && !asking} disabled={trimmed === "" || run.isPending}>
          就叫這個
        </Button>
      </div>
      <Refusal text={refused} />
      <Button variant="outline" disabled={run.isPending} onClick={() => setAsking(true)}>
        不要了
      </Button>
      <ConfirmDialog
        open={asking}
        title="不要這個名字了"
        confirmLabel="不要了"
        busy={run.isPending}
        onConfirm={() => run.mutate({ give_up: true })}
        onClose={() => setAsking(false)}
      >
        <p>押著的{currency}會全部還你,這一週她照原本的叫法。</p>
      </ConfirmDialog>
    </form>
  );
}

function Lot({ view, space }: { view: AuctionView & { lot: LotView }; space: string | null }) {
  const { lot, mine, currency } = view;
  const open = lot.state === "open" && lot.min_bid !== null;
  const ends = fmtRelative(lot.ends_at);
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{lot.name}</span>
          <span className="text-xs text-muted-foreground">{LOT_STATE[lot.state] ?? lot.state}</span>
        </p>
        {lot.detail && <p className="text-[13px] text-muted-foreground">{lot.detail}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        {lot.winner ? (
          <Fact label="得標">
            {lot.winner.name} · {fmtInt(lot.winner.price)}
          </Fact>
        ) : (
          <Fact label="最高出價" title={lot.top?.name}>
            {lot.top ? `${fmtInt(lot.top.amount)} · ${lot.top.name}` : "還沒有人出價"}
          </Fact>
        )}
        <Fact label={open ? "結束" : "結束於"} title={fmtDateTime(lot.ends_at)}>
          {ends}
          {lot.extended && <span className="font-normal text-muted-foreground"> · 延長過</span>}
        </Fact>
        <Fact label="出價">
          {fmtInt(lot.bids)} 次 · {fmtInt(lot.bidders)} 人
        </Fact>
        {mine && (
          <Fact label="你的出價">
            {fmtInt(mine.amount)} · {mine.won ? "得標" : mine.leading ? "領先中" : "被超過"}
          </Fact>
        )}
      </dl>
      {lot.state === "applied" && lot.call_name && lot.winner && (
        <p className="text-[13px]">
          她這一週叫 {lot.winner.name}「{lot.call_name}」{lot.applied_until ? `,到 ${fmtDateTime(lot.applied_until)}` : ""}
        </p>
      )}
      {mine?.won && lot.kind === "frame" && <p className="text-[13px]">這個卡框是你的了,在商店的卡框那邊換上。</p>}
      {lot.state === "naming" && mine?.won && lot.kind === "call_name" && <NameForm lot={lot} currency={currency} space={space} />}
      {open && view.running && <BidForm key={lot.id} lot={{ ...lot, min_bid: lot.min_bid as number }} currency={currency} space={space} />}
      {view.history.length > 0 && (
        <div className="grid gap-1">
          <p className="text-xs text-muted-foreground">最近的出價</p>
          <ul className="divide-y divide-line-soft">
            {view.history.slice(0, RECENT_BIDS).map((b, i) => (
              <li key={`${b.at}-${i}`} className="flex items-baseline gap-3 py-(--row-y)">
                <span className="min-w-0 flex-1 truncate text-sm">{b.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{fmtRelative(b.at)}</span>
                <span className="w-16 shrink-0 text-right text-sm tabular-nums">{fmtInt(b.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Auction({ query, space }: { query: UseQueryResult<AuctionView>; space: string | null }) {
  return (
    <Part title="這一週的拍賣">
      <Loaded query={query}>
        {(v) => {
          if (!v.running && v.lot === null) return <EmptyLine>拍賣現在沒有開</EmptyLine>;
          if (v.lot === null) {
            return (
              <div className="grid gap-0.5">
                <EmptyLine>這一週沒有拍賣</EmptyLine>
                {v.next && v.next.plan !== "skip" && (
                  <p className="text-xs text-muted-foreground">下一場 {fmtDateTime(v.next.opens_at)} 開始</p>
                )}
              </div>
            );
          }
          return <Lot view={{ ...v, lot: v.lot }} space={space} />;
        }}
      </Loaded>
    </Part>
  );
}

// ---------------------------------------------------------------------------
// the lottery

function Draw({ last, currency }: { last: NonNullable<LotteryView["last"]>; currency: string }) {
  const when = last.drawn_at ? fmtDateTime(last.drawn_at) : null;
  return (
    <p className="text-[13px] text-muted-foreground">
      上一期{when ? `(${when})` : ""}:
      {last.state === "refunded" || last.winner === null ? (
        "人數不夠沒有開,全額退回"
      ) : (
        <>
          <span className="font-medium text-foreground">{last.winner}</span> 中了 {priceText(last.prize, currency)},共 {fmtInt(last.tickets)} 張、
          {fmtInt(last.buyers)} 人
        </>
      )}
    </p>
  );
}

function Lottery({ space }: { space: string | null }) {
  const api = useApi();
  const refresh = useRefresh();
  const lottery = useLottery(space);
  const [refused, setRefused] = useState<string | null>(null);
  const buy = useMutation({
    // One fresh key per press: a retry of the same request is charged once, a second press is a second purchase.
    mutationFn: (count: number) =>
      api.rpc.market.buy({ query: spaceQuery(space), headers: { "idempotency-key": newKey() }, body: { count } }),
    onMutate: () => setRefused(null),
    onSuccess: (r) => {
      notify.ok(`買了 ${fmtInt(r.count)} 張,這一週你有 ${fmtInt(r.mine)} 張`);
      refresh();
    },
    onError: (e) => {
      setRefused(describeError(e));
      refresh();
    },
  });
  return (
    <Part title="這一週的樂透">
      <Loaded query={lottery}>
        {(l) => {
          if (!l.running) return <EmptyLine>樂透現在沒有開</EmptyLine>;
          const have = l.mine?.tickets ?? 0;
          const left = Math.max(0, l.per_person - have);
          const open = l.state === "open";
          const why = !open ? WEEK_STATE[l.state] : left === 0 ? "這一週你買滿了" : undefined;
          return (
            <div className="grid gap-3">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
                <Fact label="一張">{priceText(l.price, l.currency)}</Fact>
                <Fact label="你的彩券">
                  {fmtInt(have)} / {fmtInt(l.per_person)} 張
                </Fact>
                <Fact label="開獎" title={fmtDateTime(l.draw_at)}>
                  {open ? fmtRelative(l.draw_at) : WEEK_STATE[l.state]}
                </Fact>
                <Fact label="獎池">{priceText(l.pot, l.currency)}</Fact>
                <Fact label={`中獎拿(${fmtPct(l.prize_share)})`}>{priceText(Math.floor(l.pot * l.prize_share), l.currency)}</Fact>
                <Fact label="賣出">
                  {fmtInt(l.tickets)} 張 · {fmtInt(l.buyers)} 人
                </Fact>
              </dl>
              <div className="grid grid-cols-2 gap-2">
                {[1, 5].map((count) => (
                  <Button
                    key={count}
                    variant={count === 1 ? "secondary" : "outline"}
                    busy={buy.isPending && buy.variables === count}
                    disabled={buy.isPending || why !== undefined || left < count}
                    title={why ?? (left < count ? `這一週你還能買 ${left} 張` : undefined)}
                    onClick={() => buy.mutate(count)}
                  >
                    買 {count} 張 · {priceText(l.price * count, l.currency)}
                  </Button>
                ))}
              </div>
              <Refusal text={refused} />
              <p className="text-xs text-muted-foreground">
                開獎時少於 {fmtInt(l.min_buyers)} 個人買就不開,全額退回。開獎前不公開誰買了。
              </p>
              {l.last && <Draw last={l.last} currency={l.currency} />}
            </div>
          );
        }}
      </Loaded>
    </Part>
  );
}

// ---------------------------------------------------------------------------
// what they did

function BidsList({ currency, space }: { currency: string; space: string | null }) {
  const bids = useMyBids(space);
  return (
    <Part title="你的出價">
      <Loaded query={bids} rows={2}>
        {(b) =>
          b.bids.length === 0 ? (
            <EmptyLine>你還沒有出過價</EmptyLine>
          ) : (
            <ul className="divide-y divide-line-soft">
              {b.bids.slice(0, LIST_MAX).map((x) => (
                <li key={`${x.lot}-${x.at}`} className="flex items-baseline gap-3 py-(--row-y)">
                  <span className="min-w-0 flex-1 truncate text-sm" title={fmtDateTime(x.at)}>
                    {x.name}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums">{priceText(x.amount, currency)}</span>
                  <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">{BID_STATE[x.state] ?? x.state}</span>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </Part>
  );
}

function ticketResult(w: MyTickets["weeks"][number], currency: string): string {
  if (w.state === "drawn") return w.won ? `中了 ${priceText(w.prize, currency)}` : "沒中";
  return WEEK_STATE[w.state] ?? w.state;
}

function TicketsList({ currency, space }: { currency: string; space: string | null }) {
  const tickets = useMyTickets(space);
  return (
    <Part title="你的彩券">
      <Loaded query={tickets} rows={2}>
        {(t) =>
          t.weeks.length === 0 ? (
            <EmptyLine>你還沒有買過彩券</EmptyLine>
          ) : (
            <ul className="divide-y divide-line-soft">
              {t.weeks.slice(0, LIST_MAX).map((w) => (
                <li key={w.week} className="flex items-baseline gap-3 py-(--row-y)">
                  <span className="min-w-0 flex-1 truncate text-sm tabular-nums">{fmtDateTime(w.draw_at)} 開獎</span>
                  <span className="shrink-0 text-sm tabular-nums">{fmtInt(w.tickets)} 張</span>
                  <span className="shrink-0 text-right text-xs text-muted-foreground">{ticketResult(w, currency)}</span>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </Part>
  );
}

/** The weekly market: this week's auction and lottery, then their own bids and tickets. */
export function Market() {
  const wallet = useWallet();
  // Their server's market; the parts below wait until it is known, so nothing is asked twice.
  const own = useMemberSpace();
  const space = own.space;
  const auction = useAuction(space, !own.loading);
  if (wallet.data && !wallet.data.can_earn) return null;
  if (auction.isError && isNotProvided(auction.error)) return null;
  const off = auction.isError && isApiError(auction.error) && auction.error.kind === "unavailable";
  const currency = auction.data?.currency ?? wallet.data?.currency ?? WORLD.currency;
  return (
    <Card aria-label="市集">
      <CardHeader>
        <CardTitle>市集</CardTitle>
      </CardHeader>
      <SpacePicker value={space} spaces={own.spaces} onChange={own.setSpace} />
      {off ? (
        <OffLine title="市集現在沒有開" onRetry={() => void auction.refetch()} />
      ) : auction.isError ? (
        // Anything else that failed fails for every part alike: one line, not four.
        <ErrorLine error={auction.error} onRetry={() => void auction.refetch()} />
      ) : (
        <div className="grid gap-8">
          <div className="grid items-start gap-8 lg:grid-cols-2 lg:gap-x-(--stage-gap)">
            <Auction query={auction} space={space} />
            <Lottery space={space} />
          </div>
          <div className="grid items-start gap-8 lg:grid-cols-2 lg:gap-x-(--stage-gap)">
            <BidsList currency={currency} space={space} />
            <TicketsList currency={currency} space={space} />
          </div>
        </div>
      )}
    </Card>
  );
}
