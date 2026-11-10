import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dices, Download, ExternalLink, Share2, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import type { IssuedCard, WalletView } from "@/api/types";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { cardFileName, cardPng, verifyUrl } from "./card";
import { HoloCard } from "./HoloCard";

const CARDS = ["member", "cards"] as const;
const WALLET = ["member", "wallet"] as const;

/** One fresh key per click: a retry of the same request is charged once. */
function newKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** A choice that is on or off. */
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "h-7 rounded-md border px-2.5 text-xs transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        on ? "border-primary bg-primary/15 text-foreground" : "border-border bg-control text-muted-foreground hover:bg-control-hover",
      )}
    >
      {children}
    </button>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Share sheet with the picture where the browser has one; otherwise the link to the check page. */
async function share(card: IssuedCard, blob: Blob) {
  const file = new File([blob], cardFileName(card), { type: "image/png" });
  const url = verifyUrl(card.serial);
  const data = { files: [file], title: "她給我的卡", url };
  if (navigator.canShare?.(data)) {
    try {
      await navigator.share(data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      throw e;
    }
    return;
  }
  await navigator.clipboard.writeText(url);
  notify.ok("已複製這張卡的驗證連結");
}

/** Their newest card, a new one on request (a few a day), and the ways to take it with them. */
export function CardSection() {
  const api = useApi();
  const client = useQueryClient();
  const svg = useRef<SVGSVGElement>(null);
  const cards = useQuery({ queryKey: CARDS, queryFn: ({ signal }) => api.memberCards({ signal }) });
  // What they pay for on the next card: a picture of their own choosing, a foil finish.
  const [pose, setPose] = useState<string | null>(null);
  const [foil, setFoil] = useState(false);
  const done = (card: IssuedCard, counts: boolean) => {
    client.setQueryData(CARDS, (old: typeof cards.data) =>
      old ? { ...old, latest: card, today: old.today + (counts ? 1 : 0) } : old,
    );
    void client.invalidateQueries({ queryKey: CARDS });
    void client.invalidateQueries({ queryKey: WALLET });
  };
  const issue = useMutation({
    mutationFn: () => {
      const paid = pose !== null || foil;
      const req = { ...(pose !== null ? { pose } : {}), ...(foil ? { foil: true } : {}) };
      return api.memberIssueCard(req, paid ? newKey() : undefined);
    },
    onSuccess: (card) => {
      setPose(null);
      setFoil(false);
      done(card, true);
    },
    onError: (e) => notify.error(e),
  });
  const reroll = useMutation({
    mutationFn: () => api.memberRerollCard(newKey()),
    onSuccess: (card) => {
      setAskingReroll(false);
      done(card, false);
    },
    onError: (e) => notify.error(e),
  });
  const [askingReroll, setAskingReroll] = useState(false);
  const currency = client.getQueryData<WalletView>(WALLET)?.currency ?? "幣";
  const [busy, setBusy] = useState<"download" | "share" | null>(null);
  const run = async (what: "download" | "share", card: IssuedCard) => {
    if (!svg.current) return;
    setBusy(what);
    try {
      const blob = await cardPng(svg.current);
      if (what === "download") download(blob, cardFileName(card));
      else await share(card, blob);
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
          const prices = c.prices ?? { pose: null, foil: null, reroll: null };
          const poses = prices.pose !== null ? (c.poses ?? []) : [];
          const cost = (pose !== null ? (prices.pose ?? 0) : 0) + (foil ? (prices.foil ?? 0) : 0);
          const rerolls = c.rerolls_left ?? 0;
          return (
            <div className="grid gap-3">
              {c.latest ? (
                <HoloCard card={c.latest} svgRef={svg} sway={false} zoom={1.03} />
              ) : (
                <EmptyLine>還沒有卡,抽一張看看她怎麼看你</EmptyLine>
              )}
              {left > 0 && (poses.length > 0 || prices.foil !== null) && (
                <div className="grid gap-2.5">
                  {poses.length > 0 && (
                    <div className="grid gap-1.5">
                      <p className="text-xs text-muted-foreground">
                        指定立繪 · 另付 {prices.pose} {currency}
                      </p>
                      <div role="group" aria-label="指定立繪" className="flex flex-wrap gap-1.5">
                        <Chip on={pose === null} onClick={() => setPose(null)}>
                          由她挑
                        </Chip>
                        {poses.map((p) => (
                          <Chip key={p.id} on={pose === p.id} onClick={() => setPose(p.id)}>
                            {p.label}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  )}
                  {prices.foil !== null && (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        閃卡加工 · 另付 {prices.foil} {currency}
                      </p>
                      <Chip on={foil} onClick={() => setFoil(!foil)}>
                        閃卡
                      </Chip>
                    </div>
                  )}
                </div>
              )}
              <Button busy={issue.isPending} disabled={left === 0} onClick={() => issue.mutate()}>
                <Sparkles aria-hidden />
                {left === 0
                  ? "今天的卡抽完了"
                  : `抽一張新卡(今天還有 ${left} 張${cost > 0 ? `,${cost} ${currency}` : ""})`}
              </Button>
              {c.latest && prices.reroll !== null && rerolls > 0 && (
                <Button variant="outline" onClick={() => setAskingReroll(true)}>
                  <Dices aria-hidden />
                  重抽這張({prices.reroll} {currency},今天還能 {rerolls} 次)
                </Button>
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
      <ConfirmDialog
        open={askingReroll}
        title="重抽這張卡"
        confirmLabel="重抽"
        busy={reroll.isPending}
        onConfirm={() => reroll.mutate()}
        onClose={() => setAskingReroll(false)}
      >
        <p>舊卡會作廢,驗證頁會顯示已作廢。要花 {cards.data?.prices?.reroll ?? 0} {currency}。</p>
      </ConfirmDialog>
    </Card>
  );
}
