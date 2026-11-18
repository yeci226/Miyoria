import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, Share2, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import type { IssuedCard, WalletView } from "@miyoria/contracts/api";
import { describeError } from "@/api/http";
import { useApi } from "@/app/connection";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtInt } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { cardFileName, cardPng, saveBlob, shareCard, verifyUrl } from "./card";
import { HoloCard } from "./HoloCard";
import { newKey } from "./spend";

const CARDS = ["member", "cards"] as const;
const WALLET = ["member", "wallet"] as const;

/** A choice that is on or off. */
export function Chip({
  on,
  onClick,
  disabled,
  children,
  className,
  label,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  /** Its accessible name, when the text alone is not it. */
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-7 rounded-md border px-2.5 text-xs transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45",
        on ? "border-primary bg-primary/15 text-foreground" : "border-border bg-control text-muted-foreground hover:bg-control-hover",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Label over value, at the rail's size. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** Their newest card, a new one on request (a few a day), and the ways to take it with them. */
export function CardSection() {
  const api = useApi();
  const client = useQueryClient();
  const svg = useRef<SVGSVGElement>(null);
  const cards = useQuery({ queryKey: CARDS, queryFn: ({ signal }) => api.rpc.member.cards(undefined, { signal }) });
  // What they pay for on top of the next card: a foil finish.
  const [foil, setFoil] = useState(false);
  // The Core's sentence for the last card it would not give (no coins, none left today, ...).
  const [refused, setRefused] = useState<string | null>(null);
  const done = (card: IssuedCard) => {
    client.setQueryData(CARDS, (old: typeof cards.data) =>
      old ? { ...old, latest: card, today: old.today + 1 } : old,
    );
    // The list, the dex and the pity under 卡冊 refresh with it.
    void client.invalidateQueries({ queryKey: CARDS });
    void client.invalidateQueries({ queryKey: WALLET });
  };
  const issue = useMutation({
    // A daily card is paid (the first of the day too), so every click carries its own key.
    mutationFn: () =>
      api.rpc.member.issueCard({ body: foil ? { foil: true } : {}, headers: { "idempotency-key": newKey() } }),
    onMutate: () => setRefused(null),
    onSuccess: (card) => {
      setFoil(false);
      done(card);
    },
    onError: (e) => {
      setRefused(describeError(e));
      void client.invalidateQueries({ queryKey: CARDS });
    },
  });
  const currency = client.getQueryData<WalletView>(WALLET)?.currency ?? "幣";
  const [busy, setBusy] = useState<"download" | "share" | null>(null);
  const run = async (what: "download" | "share", card: IssuedCard) => {
    if (!svg.current) return;
    setBusy(what);
    try {
      const blob = await cardPng(svg.current);
      if (what === "download") saveBlob(blob, cardFileName(card));
      else if (await shareCard(card, blob)) notify.ok("已複製這張卡的驗證連結");
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card aria-label="她給你的卡">
      <CardHeader>
        <CardTitle>她給你的卡</CardTitle>
      </CardHeader>
      <QueryView query={cards} skeleton={<SkeletonRows count={3} />}>
        {(c) => {
          const left = Math.max(0, c.per_day - c.today);
          const prices = c.prices ?? { card: null, foil: null };
          const cost = (prices.card ?? 0) + (foil ? (prices.foil ?? 0) : 0);
          // Known before asking: the Core would say no anyway.
          const short = c.balance !== null && cost > 0 && c.balance < cost;
          return (
            <div className="grid gap-3">
              {c.latest ? (
                <HoloCard card={c.latest} svgRef={svg} sway={false} zoom={1.03} />
              ) : (
                <EmptyLine>還沒有卡,抽一張看看她怎麼看你</EmptyLine>
              )}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                {prices.card !== null && (
                  <Fact label="一張">
                    {fmtInt(prices.card)} {currency}
                  </Fact>
                )}
                <Fact label="今天還能抽">
                  {left} / {c.per_day} 張
                </Fact>
                {c.balance !== null && (
                  <Fact label="你有">
                    {fmtInt(c.balance)} {currency}
                  </Fact>
                )}
                {c.pity && (
                  <Fact label="保底">{c.pity.until === 0 ? "下一張 SR 以上" : `再 ${c.pity.until} 張`}</Fact>
                )}
              </dl>
              {left > 0 && prices.foil !== null && (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    閃卡加工 · 另付 {prices.foil} {currency}
                  </p>
                  <Chip on={foil} onClick={() => setFoil(!foil)}>
                    閃卡
                  </Chip>
                </div>
              )}
              <Button busy={issue.isPending} disabled={left === 0 || short} onClick={() => issue.mutate()}>
                <Sparkles aria-hidden />
                {left === 0
                  ? "今天的卡抽完了"
                  : `抽一張新卡(今天還有 ${left} 張${cost > 0 ? `,${cost} ${currency}` : ""})`}
              </Button>
              {(refused || (short && left > 0)) && (
                <p role="alert" className="text-[13px] text-primary">
                  {refused ?? `${currency}不夠,這張要 ${fmtInt(cost)}`}
                </p>
              )}
              {c.latest && (
                <Button asChild variant="outline">
                  <a href={verifyUrl(c.latest.serial)} target="_blank" rel="noopener">
                    <ExternalLink aria-hidden />
                    打開數位卡面
                  </a>
                </Button>
              )}
              {c.latest && (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    busy={busy === "download"}
                    onClick={() => c.latest && void run("download", c.latest)}
                  >
                    <Download aria-hidden />
                    下載
                  </Button>
                  <Button
                    variant="outline"
                    busy={busy === "share"}
                    onClick={() => c.latest && void run("share", c.latest)}
                  >
                    <Share2 aria-hidden />
                    分享
                  </Button>
                </div>
              )}
            </div>
          );
        }}
      </QueryView>
    </Card>
  );
}
