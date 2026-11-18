// The card she gives someone, in the panel: the drawing itself is `@miyoria/card-face` (the Core
// renders the same one for the preview a link to a card unfurls with); this file adds what only the
// page does, inlining pictures and turning the SVG into the PNG people download.

import { useQuery } from "@tanstack/react-query";
import { type CardFaceProps, CardFace, W, H } from "@miyoria/card-face";
import { useState } from "react";
import type { IssuedCard } from "@miyoria/contracts/api";

export { AFFINITY, CardFace, FAMILIARITY, FRAME_NAME, FRAME_SWATCH, frameName, isUniqueFrame, TRUST } from "@miyoria/card-face";
export type { CardFaceProps };

/** Her pictures are the owner's renders of her model, kept out of git like the background. */
export const poseUrl = (pose: string) => `/card-${pose.replace(/[^a-z0-9-]/g, "")}.local.webp`;

/**
 * The picture of a card, from the Core: her rendered one, or the fixed portrait it stands in for
 * (the same one the link preview and `/me card` show). A card the Core will not show (voided) has
 * none there.
 */
export const artUrl = (serial: string) => `/api/public/card-art/${encodeURIComponent(serial)}.png`;

/** Where the code on a card leads: the page that checks it. */
export const verifyUrl = (serial: string) => `${window.location.origin}/card/${encodeURIComponent(serial)}`;

async function dataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) return null;
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** A picture as a data URL, or `null` when it cannot be had (missing, or no CORS). */
export function useInlined(url: string | null) {
  return useQuery({
    queryKey: ["inlined", url],
    queryFn: () => (url ? dataUrl(url) : null),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
  });
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === "" ? fallback : v;
}

/** The theme's two accents as literals, for an SVG that leaves the page. */
export function cardColors() {
  return { primary: cssVar("--primary", "#f29dc4"), secondary: cssVar("--secondary", "#7355e8") };
}

/**
 * A card's picture: where it is (`url`, for a mask) and inlined (`data`, for the `<svg>`). The
 * Core's, falling back to the fixed portrait of the card's pose when the Core has none to show.
 */
export function useCardArt(card: IssuedCard): { url: string | null; data: string | null } {
  const core = artUrl(card.serial);
  const fromCore = useInlined(core);
  const fixed = poseUrl(card.pose);
  const fromFixed = useInlined(!fromCore.isPending && !fromCore.data ? fixed : null);
  if (fromCore.data) return { url: core, data: fromCore.data };
  if (fromFixed.data) return { url: fixed, data: fromFixed.data };
  return { url: null, data: null };
}

/**
 * Whether a picture is opaque: her rendered picture is (its background is drawn), a fixed portrait
 * is cut out. Read from the top row of the picture scaled down to 8 x 8. `null` while unknown, or
 * where there is no canvas to read it with.
 */
async function opaqueOf(data: string): Promise<boolean | null> {
  const img = new Image();
  img.src = data;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, 8, 8);
  const row = ctx.getImageData(0, 0, 8, 1).data;
  for (let i = 3; i < row.length; i += 4) if ((row[i] ?? 0) < 250) return false;
  return true;
}

/** Whether the card's picture is opaque (see `opaqueOf`); keyed by where it came from. */
export function useArtOpaque(art: { url: string | null; data: string | null }): boolean | null {
  const q = useQuery({
    queryKey: ["art-opaque", art.url],
    queryFn: () => (art.data ? opaqueOf(art.data).catch(() => null) : null),
    enabled: art.data !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
  });
  return q.data ?? null;
}

/** The card with its pictures inlined, so the same `<svg>` can become a PNG. */
export function InlinedCard({ card, svgRef }: { card: IssuedCard; svgRef?: React.Ref<SVGSVGElement> }) {
  const art = useCardArt(card);
  const avatar = useInlined(card.avatar_url);
  const [colors] = useState(cardColors);
  return (
    <CardFace
      ref={svgRef}
      card={card}
      art={art.data}
      avatar={avatar.data ?? null}
      colors={colors}
      verifyUrl={verifyUrl(card.serial)}
      className="h-auto w-full"
    />
  );
}

/** The card as a PNG, twice its size: what is downloaded and shared. */
export async function cardPng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const markup = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("沒辦法產生圖片");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("沒辦法產生圖片"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const cardFileName = (card: IssuedCard) => `miyoria-card-${card.serial}.png`;

/** Saves a blob as a file. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The share sheet with the picture where the browser has one; otherwise the link to the check page
 * is copied. `true` when the link was copied (the caller says so).
 */
export async function shareCard(card: IssuedCard, blob: Blob): Promise<boolean> {
  const file = new File([blob], cardFileName(card), { type: "image/png" });
  const url = verifyUrl(card.serial);
  const data = { files: [file], title: "她給我的卡", url };
  if (navigator.canShare?.(data)) {
    try {
      await navigator.share(data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return false;
      throw e;
    }
    return false;
  }
  await navigator.clipboard.writeText(url);
  return true;
}