// One of their cards, large: the card to turn in the light beside everything on it in words (the
// parts with their rarity, her expression, the date, the code), and what only its owner sees
// (what it cost, whether the pity decided it, which wished parts it brought), all from the list.

import { CircleX, Download, ExternalLink, Heart, Link2 } from "lucide-react";
import { useRef, useState } from "react";
import type { ListedCard } from "@miyoria/contracts/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtInt } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cardFileName, cardPng, frameName, saveBlob, shareCard, verifyUrl } from "../card";
import { HoloCard } from "../HoloCard";
import { KIND_LABEL, kindOf, RarityBadge, SLOT_LABEL, shortDate } from "./labels";

function Fact({ label, children, mono, wide }: { label: string; children: React.ReactNode; mono?: boolean; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2 grid gap-0.5" : "grid min-w-0 gap-0.5"}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-[13px] break-all" : "text-sm"}>{children}</dd>
    </div>
  );
}

function Details({ card, svg, currency }: { card: ListedCard; svg: React.RefObject<SVGSVGElement | null>; currency: string }) {
  const wished = new Set(card.wished);
  const [busy, setBusy] = useState<"download" | "share" | null>(null);
  const run = async (what: "download" | "share") => {
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
  const finish = [card.frame ? (frameName(card.frame) ?? card.frame) : null, card.foil ? "閃卡" : null]
    .filter((s): s is string => s !== null)
    .join(" · ");
  const line = card.line ?? card.public_feeling;
  const kind = kindOf(card);
  const price = card.price > 0 ? `${fmtInt(card.price)} ${currency}` : "不用錢";
  return (
    <div className="grid min-w-0 content-start gap-5">
      {card.voided_at && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <CircleX aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          這張卡在 {shortDate(card.voided_at)} 作廢了
        </p>
      )}
      {line && <p className="text-[15px] leading-relaxed">「{line}」</p>}

      {card.parts.length > 0 && (
        <section aria-label="抽到的部件" className="grid gap-1">
          <h3 className="text-[13px] font-medium">抽到的部件</h3>
          <ul className="divide-y divide-line-soft">
            {card.parts.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-(--row-y)">
                <span className="w-10 shrink-0 text-xs text-muted-foreground">{SLOT_LABEL[p.slot]}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                {wished.has(p.id) && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-primary">
                    <Heart aria-hidden className="size-3" />
                    願望
                  </span>
                )}
                <RarityBadge rarity={p.rarity} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4">
        <Fact label="表情">{card.expression ?? "—"}</Fact>
        <Fact label="關係">{card.relationship ?? "初次見面"}</Fact>
        <Fact label="發卡日">{shortDate(card.issued_at)}</Fact>
        <Fact label="第幾張">第 {card.number} 張</Fact>
        <Fact label="卡面">{finish || "一般"}</Fact>
        {kind === "daily" && <Fact label="花了">{price}</Fact>}
        {card.pity_hit && <Fact label="保底">這張由保底決定</Fact>}
        <Fact label="編號" mono wide>
          {card.serial}
        </Fact>
      </dl>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" busy={busy === "download"} onClick={() => void run("download")}>
          <Download aria-hidden />
          下載圖片
        </Button>
        <Button variant="outline" busy={busy === "share"} onClick={() => void run("share")}>
          <Link2 aria-hidden />
          分享
        </Button>
        <Button asChild variant="ghost" className="col-span-2">
          <a href={verifyUrl(card.serial)} target="_blank" rel="noopener">
            <ExternalLink aria-hidden />
            打開數位卡面
          </a>
        </Button>
      </div>
    </div>
  );
}

/** The dialog for one card; `card` null closes it. */
export function CardDialog({ card, currency, onClose }: { card: ListedCard | null; currency: string; onClose: () => void }) {
  const svg = useRef<SVGSVGElement>(null);
  return (
    <Dialog open={card !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-6 sm:max-w-4xl">
        {card && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {card.rarity && <RarityBadge rarity={card.rarity} />}
                {KIND_LABEL[kindOf(card)]}
                <span className="font-mono text-[13px] font-normal text-muted-foreground">
                  No.{String(card.number).padStart(3, "0")}
                </span>
              </DialogTitle>
            </DialogHeader>
            <div className="grid items-start gap-6 md:grid-cols-[minmax(0,380px)_minmax(0,1fr)] md:gap-8">
              <HoloCard card={card} portrait={card.portrait} svgRef={svg} className="mx-auto w-full max-w-[380px]" />
              <Details card={card} svg={svg} currency={currency} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
