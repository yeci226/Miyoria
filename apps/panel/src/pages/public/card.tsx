// The card she gives someone, in the panel: the drawing itself is `@miyoria/card-face` (the Core
// renders the same one for the preview a link to a card unfurls with); this file adds what only the
// page does, inlining pictures and turning the SVG into the PNG people download.

import { useQuery } from "@tanstack/react-query";
import { type CardFaceProps, CardFace, W, H } from "@miyoria/card-face";
import { useState } from "react";
import type { IssuedCard } from "@/api/types";

export { AFFINITY, CardFace, FAMILIARITY, FRAME_NAME, FRAME_SWATCH, TRUST } from "@miyoria/card-face";
export type { CardFaceProps };

/** Her pictures are the owner's renders of her model, kept out of git like the background. */
export const poseUrl = (pose: string) => `/card-${pose.replace(/[^a-z0-9-]/g, "")}.local.webp`;

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

/** The card with its pictures inlined, so the same `<svg>` can become a PNG. */
export function InlinedCard({ card, svgRef }: { card: IssuedCard; svgRef?: React.Ref<SVGSVGElement> }) {
  const art = useInlined(poseUrl(card.pose));
  const avatar = useInlined(card.avatar_url);
  const [colors] = useState(cardColors);
  return (
    <CardFace
      ref={svgRef}
      card={card}
      art={art.data ?? null}
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