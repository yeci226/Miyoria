// 送她禮物 on the member page (docs/design/economy.md §16): they name anything, the Core estimates it
// in NT$ and turns that into coins, and nothing is charged until they press 確認, the same two steps as on Discord. She takes
// it or gives it back in full. A fixed food (白飯, 鋼盆, 甜點) is fed at once, as the wallet does.
// Below: what they gave her and what she said. A Core without the routes leaves the block out, the
// economy stopped is one line, and someone she does not know never gets this far.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Heart, ImageIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { FeedItem, GiftQuoteView, GiftViewItem, PublicGiftItem } from "@miyoria/contracts/api";
import { describeError, isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { OffLine } from "@/components/module-query";
import { EmptyLine, ErrorLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fmtDateTime, fmtInt, fmtRelative } from "@/lib/format";
import { GIFT_STATUS, giftDate, giftPrice } from "./gift-labels";
import { newKey, priceText, say, usePatchWallet, useWallet } from "./spend";

export const MY_GIFTS = ["member", "gifts"] as const;
const POLL_MS = 60_000;
/** What a name may be on the page; the Core takes up to 80 and says no on its own terms. */
export const GIFT_NAME_MAX = 24;
const LIST_MAX = 8;

/** An older Core has no such route, and a stopped module stays stopped: asking again will not change either. */
const retry = (n: number, e: Error) => !isNotProvided(e) && !(isApiError(e) && (e.kind === "unavailable" || e.status === 403)) && n < 2;

/** The Core's own sentence for what it would not do (a 402, 409, 429, 503 carry one). */
export function sentence(e: unknown): string {
  if (isApiError(e) && (e.kind === "http" || e.kind === "unavailable" || e.kind === "not_found") && e.message) return e.message;
  return describeError(e);
}

function useMyGifts() {
  const api = useApi();
  return useQuery({
    queryKey: MY_GIFTS,
    queryFn: ({ signal }) => api.rpc.gifts.mine(undefined, { signal }),
    refetchInterval: (q) => (q.state.error ? false : POLL_MS),
    retry,
  });
}

/** True once `iso` has passed; turns over on its own at that moment. */
function usePassed(iso: string): boolean {
  const at = new Date(iso).getTime();
  const [passed, setPassed] = useState(() => Date.now() >= at);
  useEffect(() => {
    const left = at - Date.now();
    if (left <= 0) {
      setPassed(true);
      return;
    }
    setPassed(false);
    // A timer cannot wait longer than about 24.8 days; a quote never lives that long.
    const t = setTimeout(() => setPassed(true), Math.min(left, 2_000_000_000));
    return () => clearTimeout(t);
  }, [at]);
  return passed;
}

function Fact({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? "col-span-2 grid min-w-0 gap-0.5" : "grid min-w-0 gap-0.5"}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** The quote to confirm: nothing is charged before 確認. */
function Quote({
  quote,
  busy,
  onConfirm,
  onCancel,
}: {
  quote: GiftQuoteView;
  busy: "confirm" | "cancel" | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const expired = usePassed(quote.expires_at);
  const short = quote.balance_after < 0;
  return (
    <section aria-label="報價" className="grid gap-3 border-t border-border pt-3">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium break-words">{quote.item}</span>
        <span className="text-xs text-muted-foreground">
          {quote.kind_word}
          {quote.band && ` · ${quote.band}`}
        </span>
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <Fact label="價錢" wide>
          {giftPrice(quote.price, quote.twd, quote.currency)}
        </Fact>
        <Fact label="送出後剩">{priceText(quote.balance_after, quote.currency)}</Fact>
      </dl>
      {quote.big && (
        <p className="text-[13px]">
          這是一份大禮:{priceText(quote.price, quote.currency)},送出後只剩 {priceText(quote.balance_after, quote.currency)}。
        </p>
      )}
      {quote.fallback && quote.note && <p className="text-xs text-muted-foreground">{quote.note}</p>}
      <p className="text-xs text-muted-foreground">收不收由她決定,她不收會全額退回。</p>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          busy={busy === "confirm"}
          disabled={expired || short || busy !== null}
          title={expired ? "這個報價過期了" : short ? `${quote.currency}不夠` : undefined}
          onClick={onConfirm}
        >
          確認
        </Button>
        <Button variant="outline" busy={busy === "cancel"} disabled={busy !== null} onClick={onCancel}>
          取消
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" title={fmtDateTime(quote.expires_at)}>
        {expired ? "這個報價過期了,再問一次價" : short ? `${quote.currency}不夠,你有 ${fmtInt(quote.balance)}` : `${fmtRelative(quote.expires_at)}前確認`}
      </p>
    </section>
  );
}

function GiftForm() {
  const api = useApi();
  const client = useQueryClient();
  const { patch, refresh } = usePatchWallet();
  const id = useId();
  const [name, setName] = useState("");
  const [quote, setQuote] = useState<GiftQuoteView | null>(null);
  // `free`: it failed before anything could be charged (asking the price, or a name refused).
  const [refused, setRefused] = useState<{ text: string; free: boolean } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const fail = (e: unknown, free = false) => setRefused({ text: sentence(e), free });
  const reload = () => {
    void client.invalidateQueries({ queryKey: MY_GIFTS });
    void refresh();
  };
  const begin = () => {
    setRefused(null);
    setSaid(null);
  };

  const feed = useMutation({
    mutationFn: (item: FeedItem) => api.rpc.wallet.feed({ headers: { "idempotency-key": newKey() }, body: { item, count: 1 } }),
    onSuccess: (r) => {
      patch((v) => ({ ...v, balance: r.balance }));
      if (r.accepted) setName("");
      say(r);
      void refresh();
    },
    onError: (e) => {
      fail(e);
      void refresh();
    },
  });

  const ask = useMutation({
    // One fresh key per press: a retry of the same request answers the same quote.
    mutationFn: (text: string) => api.rpc.gifts.quote({ headers: { "idempotency-key": newKey() }, body: { name: text } }),
    onMutate: begin,
    onSuccess: (r) => {
      if (r.status === "quote" && r.quote) {
        setQuote(r.quote);
        void client.invalidateQueries({ queryKey: MY_GIFTS });
      } else if (r.status === "fixed" && r.item) {
        // One of the fixed foods: fed straight away, as the wallet's buttons do.
        feed.mutate(r.item);
      } else {
        setRefused({ text: r.message ?? "這個送不了", free: true });
      }
    },
    onError: (e) => fail(e, true),
  });

  const confirm = useMutation({
    mutationFn: (gift: string) => api.rpc.gifts.confirm({ params: { id: gift } }),
    onMutate: begin,
    onSuccess: (r) => {
      patch((v) => ({ ...v, balance: r.balance }));
      setQuote(null);
      setName("");
      setSaid("送出了,等她回應");
      reload();
    },
    onError: (e) => {
      fail(e);
      reload();
    },
  });

  const cancel = useMutation({
    mutationFn: (gift: string) => api.rpc.gifts.cancel({ params: { id: gift } }),
    onMutate: begin,
    onSuccess: () => {
      setQuote(null);
      setSaid("取消了,沒有扣錢");
      reload();
    },
    onError: (e) => {
      fail(e);
      reload();
    },
  });

  const text = name.trim();
  const asking = ask.isPending || feed.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text !== "" && !asking && quote === null) ask.mutate(text);
  };
  const busy = confirm.isPending ? "confirm" : cancel.isPending ? "cancel" : null;
  return (
    <div className="grid gap-3">
      <form className="grid gap-2" onSubmit={submit}>
        <label htmlFor={id} className="text-xs text-muted-foreground">
          要送她什麼
        </label>
        <div className="flex gap-2">
          <Input
            id={id}
            placeholder="一杯珍奶"
            maxLength={GIFT_NAME_MAX}
            autoComplete="off"
            className="min-w-0 flex-1"
            value={name}
            disabled={quote !== null}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" variant="secondary" busy={asking} disabled={text === "" || quote !== null}>
            問價
          </Button>
        </div>
      </form>
      {quote && (
        <Quote
          quote={quote}
          busy={busy}
          onConfirm={() => confirm.mutate(quote.id)}
          onCancel={() => cancel.mutate(quote.id)}
        />
      )}
      {refused && (
        <p role="alert" className="text-[13px] text-primary">
          {refused.text}
          {refused.free && <span className="ml-1.5 text-muted-foreground">沒有扣錢</span>}
        </p>
      )}
      {said && (
        <p role="status" className="text-[13px]">
          {said}
        </p>
      )}
    </div>
  );
}

/** A kept gift as a picture to save or show. */
function PictureDialog({ gift, onClose }: { gift: GiftViewItem | null; onClose: () => void }) {
  const api = useApi();
  const id = gift?.id ?? "";
  const picture = useQuery({
    queryKey: [...MY_GIFTS, id, "picture"],
    queryFn: ({ signal }) => api.rpc.gifts.picture({ params: { id } }, { signal }),
    enabled: gift !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const src = picture.data?.png ? `data:image/png;base64,${picture.data.png}` : null;
  return (
    <Dialog open={gift !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-4 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{gift?.item}</DialogTitle>
          <DialogDescription className="sr-only">她收下的禮物的圖</DialogDescription>
        </DialogHeader>
        {picture.isPending ? (
          <SkeletonRows count={3} />
        ) : picture.isError ? (
          <ErrorLine error={picture.error} onRetry={() => void picture.refetch()} />
        ) : src ? (
          <div className="grid gap-3">
            <img src={src} alt={picture.data.alt} className="w-full rounded-md" />
            <Button asChild variant="outline">
              <a href={src} download={`禮物-${gift?.item ?? "gift"}.png`}>
                <Download aria-hidden />
                存下圖片
              </a>
            </Button>
          </div>
        ) : (
          <EmptyLine>{picture.data.alt || "這份禮物沒有圖"}</EmptyLine>
        )}
      </DialogContent>
    </Dialog>
  );
}

function GiftRow({ gift, currency, onPicture }: { gift: GiftViewItem; currency: string; onPicture: () => void }) {
  return (
    <li className="grid gap-0.5 py-(--row-y)">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm" title={fmtDateTime(gift.created_at)}>
          {gift.item}
        </span>
        {gift.favourite && (
          <span className="flex shrink-0 items-center text-primary" title="她最喜歡的">
            <Heart aria-hidden className="size-3 fill-current" />
            <span className="sr-only">她最喜歡的</span>
          </span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">{GIFT_STATUS[gift.status] ?? gift.status}</span>
        {gift.status === "accepted" && (
          <Button variant="ghost" size="icon-sm" className="-my-1 shrink-0" aria-label={`${gift.item} 的圖`} onClick={onPicture}>
            <ImageIcon aria-hidden />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">{giftPrice(gift.price, gift.twd, currency)}</p>
      {gift.line && <p className="text-[13px] text-muted-foreground">「{gift.line}」</p>}
    </li>
  );
}

function GiftList({ gifts, currency }: { gifts: GiftViewItem[]; currency: string }) {
  const [all, setAll] = useState(false);
  const [shown, setShown] = useState<GiftViewItem | null>(null);
  if (gifts.length === 0) return <EmptyLine>你還沒有送過她東西</EmptyLine>;
  const list = all ? gifts : gifts.slice(0, LIST_MAX);
  return (
    <>
      <ul className="divide-y divide-line-soft">
        {list.map((g) => (
          <GiftRow key={g.id} gift={g} currency={currency} onPicture={() => setShown(g)} />
        ))}
      </ul>
      {gifts.length > LIST_MAX && (
        <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setAll((v) => !v)}>
          {all ? "收起來" : `顯示全部 ${fmtInt(gifts.length)} 件`}
        </Button>
      )}
      <PictureDialog gift={shown} onClose={() => setShown(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// her collection, for everyone

const PUBLIC_GIFTS = ["public", "gifts"] as const;

function ReceivedRow({ gift }: { gift: PublicGiftItem }) {
  return (
    <li className="grid gap-0.5 py-(--row-y)">
      <div className="flex items-baseline gap-2">
        {gift.favourite && (
          <span className="flex shrink-0 items-center self-center text-primary" title="她最喜歡的">
            <Heart aria-hidden className="size-3 fill-current" />
            <span className="sr-only">她最喜歡的</span>
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{gift.item}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{giftDate(gift.at)}</span>
      </div>
      {(gift.line || gift.from) && (
        <p className="text-[13px] text-muted-foreground">
          {gift.line && <>「{gift.line}」</>}
          {gift.from && <span className="ml-1.5 whitespace-nowrap">— {gift.from}</span>}
        </p>
      )}
    </li>
  );
}

/** 她收到的東西: her favourites first, then what came in lately. A giver only where the Core names one. */
export function GiftsReceived() {
  const api = useApi();
  const q = useQuery({
    queryKey: PUBLIC_GIFTS,
    queryFn: ({ signal }) => api.rpc.giftsPublic.collection(undefined, { signal }),
    refetchInterval: (s) => (s.state.error ? false : POLL_MS),
    retry,
  });
  if (q.isError && (isNotProvided(q.error) || (isApiError(q.error) && q.error.kind === "unavailable"))) return null;
  return (
    <Card aria-label="她收到的東西">
      <CardHeader>
        <CardTitle>她收到的東西</CardTitle>
      </CardHeader>
      <QueryView
        query={q}
        skeleton={<SkeletonRows count={3} />}
        isEmpty={(d) => d.favourites.length === 0 && d.recent.length === 0}
        empty="她還沒有收到東西"
      >
        {(d) => {
          const fav = new Set(d.favourites.map((g) => g.id));
          const rest = d.recent.filter((g) => !fav.has(g.id));
          return (
            <ul aria-label="她收到的東西" className="divide-y divide-line-soft">
              {d.favourites.map((g) => (
                <ReceivedRow key={g.id} gift={{ ...g, favourite: true }} />
              ))}
              {rest.map((g) => (
                <ReceivedRow key={g.id} gift={g} />
              ))}
            </ul>
          );
        }}
      </QueryView>
    </Card>
  );
}

/** 送她禮物: the form while gifts are open, then what they gave her. */
export function GiftsCard() {
  const wallet = useWallet();
  const gifts = useMyGifts();
  if (wallet.data && !wallet.data.can_earn) return null;
  if (gifts.isError && (isNotProvided(gifts.error) || (isApiError(gifts.error) && gifts.error.status === 403))) return null;
  const off = gifts.isError && isApiError(gifts.error) && gifts.error.kind === "unavailable";
  return (
    <Card aria-label="送她禮物">
      <CardHeader>
        <CardTitle>送她禮物</CardTitle>
      </CardHeader>
      {gifts.isPending ? (
        <SkeletonRows count={3} />
      ) : off ? (
        <OffLine title="禮物現在沒有開" onRetry={() => void gifts.refetch()} />
      ) : gifts.isError ? (
        <ErrorLine error={gifts.error} onRetry={() => void gifts.refetch()} />
      ) : (
        <div className="grid gap-4">
          {gifts.data.open ? <GiftForm /> : <p className="text-[13px] text-muted-foreground">現在不收禮物</p>}
          <p className="text-xs text-muted-foreground">禮物改變不了她對你的感覺,只是一份心意。</p>
          <section aria-label="你送她的東西" className="grid gap-1">
            <h3 className="text-[13px] font-medium text-muted-foreground">你送她的東西</h3>
            <GiftList gifts={gifts.data.gifts} currency={gifts.data.currency} />
          </section>
        </div>
      )}
    </Card>
  );
}
