import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, CircleX, Download, Link2 } from "lucide-react";
import { useRef, useState } from "react";
import { isApiError } from "@/api/http";
import type { IssuedCard } from "@/api/types";
import { useApi } from "@/app/connection";
import { Logo } from "@/components/logo";
import { SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import { FRAME_NAME, cardFileName, cardPng, verifyUrl } from "./card";
import { HoloCard } from "./HoloCard";

/** `/card/<serial>`: the serial in the page path, or `null`. */
export function cardSerialIn(path: string): string | null {
  const m = /^\/card\/([^/?#]+)/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] ?? "");
  } catch {
    return null;
  }
}

const longDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

/** One fact about the card: its name above, the value below. */
function Fact({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-[13px] break-all" : "text-sm"}>{children}</dd>
    </div>
  );
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** What the card says, beside it: whether it is real, and everything on it in words. */
function Details({ card, svg }: { card: IssuedCard; svg: React.RefObject<SVGSVGElement | null> }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (!svg.current) return;
    setBusy(true);
    try {
      save(await cardPng(svg.current), cardFileName(card));
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(verifyUrl(card.serial));
      notify.ok("已複製這張卡的連結");
    } catch (e) {
      notify.error(e);
    }
  };
  const finish = [card.frame ? (FRAME_NAME[card.frame] ?? card.frame) : null, card.foil ? "閃卡" : null]
    .filter((s): s is string => s !== null)
    .join(" · ");
  const line = card.line ?? card.public_feeling;
  return (
    <div className="grid content-start gap-5">
      {card.voided_at ? (
        <div role="alert" className="flex gap-2.5">
          <CircleX aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="grid gap-0.5">
            <p className="text-sm font-semibold">這張卡已作廢</p>
            <p className="text-[13px] text-muted-foreground">
              {card.name} 在 {longDate(card.voided_at)}重抽了,這張不再有效
            </p>
          </div>
        </div>
      ) : (
        <div role="status" className="flex gap-2.5">
          <BadgeCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="grid gap-0.5">
            <p className="text-sm font-semibold">這張卡是真的</p>
            <p className="text-[13px] text-muted-foreground">
              她在 {longDate(card.issued_at)}發給 {card.name} 的第 {card.number} 張卡
            </p>
          </div>
        </div>
      )}

      {line && <p className="text-[15px] leading-relaxed">「{line}」</p>}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4">
        <Fact label="關係">{card.relationship ?? "初次見面"}</Fact>
        <Fact label="她叫你">{card.call_name ?? "—"}</Fact>
        <Fact label="好感">{card.affinity ?? "—"}</Fact>
        <Fact label="信任">{card.trust ?? "—"}</Fact>
        <Fact label="熟悉">{card.familiarity ?? "—"}</Fact>
        {card.stamp && <Fact label="她蓋的章">{card.stamp}</Fact>}
        {(card.fields ?? []).slice(0, 3).map((f) => (
          <Fact key={f.label} label={f.label}>
            {f.text}
          </Fact>
        ))}
        <Fact label="卡面">{finish || "一般"}</Fact>
        <Fact label="發卡日">{longDate(card.issued_at)}</Fact>
        <div className="col-span-2">
          <Fact label="編號" mono>
            {card.serial}
          </Fact>
        </div>
      </dl>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" busy={busy} onClick={() => void download()}>
          <Download aria-hidden />
          下載圖片
        </Button>
        <Button variant="outline" onClick={() => void copy()}>
          <Link2 aria-hidden />
          複製連結
        </Button>
      </div>
      <Button asChild variant="ghost">
        <a href="/">登入看她怎麼看你</a>
      </Button>
    </div>
  );
}

/**
 * Where a card's code leads, open to anyone: the card itself to turn in the light, whether it is
 * real, and what it says. Revoked and made-up serials look the same.
 */
export function CardVerify({ serial }: { serial: string }) {
  const api = useApi();
  const svg = useRef<SVGSVGElement>(null);
  const card = useQuery({
    queryKey: ["public", "card", serial],
    queryFn: ({ signal }) => api.publicCard(serial, { signal }),
    retry: (n, e) => !(isApiError(e) && (e.status === 404 || e.status === 429)) && n < 2,
  });
  const missing = isApiError(card.error) && card.error.status === 404;
  return (
    <div className="relative isolate flex min-h-svh flex-col items-center gap-8 px-4 py-8 md:justify-center md:py-12">
      <div aria-hidden className="card-veil" />
      <a href="/" className="flex items-center gap-2.5">
        <Logo className="size-5 text-primary" />
        <span className="text-[15px] font-semibold">Miyoria</span>
      </a>
      {card.isPending ? (
        <main className="glass-float w-full max-w-sm rounded-lg p-5">
          <SkeletonRows count={6} />
        </main>
      ) : card.data ? (
        <main className="grid w-full max-w-5xl items-center gap-8 md:grid-cols-[minmax(0,460px)_minmax(0,1fr)] md:gap-14">
          <HoloCard card={card.data} svgRef={svg} className="mx-auto w-full max-w-[460px]" />
          <section aria-label="卡片資訊" className="glass-float rounded-lg p-5 md:p-6">
            <Details card={card.data} svg={svg} />
          </section>
        </main>
      ) : (
        <main className="glass-float grid w-full max-w-sm gap-5 rounded-lg p-5">
          <div role="alert" className="flex gap-2.5">
            <CircleX aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="grid gap-0.5">
              <p className="text-sm font-semibold">{missing ? "這張卡不存在或已經作廢" : "現在沒辦法確認這張卡"}</p>
              <p className="font-mono text-[13px] break-all text-muted-foreground">{serial}</p>
            </div>
          </div>
          <Button asChild variant="outline">
            <a href="/">登入看她怎麼看你</a>
          </Button>
        </main>
      )}
    </div>
  );
}
