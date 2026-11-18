// What the card pages share: the words for a card's kind, slot and rarity, the rarity tag, and the
// card's picture as a small thumbnail. Used by the member page (卡冊) and the admin person sheet.

import type { CardPart, IssuedCard } from "@miyoria/contracts/api";
import { ImageOff } from "lucide-react";
import { useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { artUrl, poseUrl } from "../card";

export type Rarity = NonNullable<IssuedCard["rarity"]>;
export type Slot = CardPart["slot"];
/** A card's kind; `legacy` is an older member card, which has none. */
export type Kind = NonNullable<IssuedCard["kind"]> | "legacy";

export const RARITIES: readonly Rarity[] = ["N", "R", "SR", "SSR"];
export const SLOTS: readonly Slot[] = ["hand", "accessory", "outfit", "pose", "background"];

/** The Core's own slot names (`SLOT_NAMES` in the cards plugin); the odds table also sends them. */
export const SLOT_LABEL: Record<Slot, string> = {
  hand: "手",
  accessory: "配件",
  outfit: "服裝",
  pose: "姿勢",
  background: "背景",
};

export const KIND_LABEL: Record<Kind, string> = {
  daily: "每日卡",
  milestone: "里程碑卡",
  keepsake: "紀念卡",
  drop: "掉落的卡",
  legacy: "舊卡",
};

export const KINDS: readonly Kind[] = ["daily", "milestone", "keepsake", "drop", "legacy"];

export const kindOf = (card: IssuedCard): Kind => card.kind ?? "legacy";

export const isRarity = (v: unknown): v is Rarity => typeof v === "string" && (RARITIES as readonly string[]).includes(v);

/**
 * Rarity in the panel's two accents and neutrals, rising in weight: N a quiet tag, R a neutral tag
 * with bright text, SR the primary as text, SSR solid primary. Always the letters too.
 */
const RARITY_VARIANT: Record<Rarity, BadgeVariant> = { N: "outline", R: "secondary", SR: "brand", SSR: "default" };

export function RarityBadge({ rarity, className }: { rarity: string; className?: string }) {
  const variant = isRarity(rarity) ? RARITY_VARIANT[rarity] : "outline";
  return (
    <Badge variant={variant} className={cn("w-9 font-mono tracking-normal", className)}>
      {rarity}
    </Badge>
  );
}

/** `2026.11.17`, in the viewer's zone: the date as the card prints it. */
export const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso.slice(0, 10)
    : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * The card's picture, small: the Core's (her rendered one, or the fixed portrait it stands in for),
 * then the fixed portrait from the panel's own folder, then a quiet blank. Never the whole card:
 * a list of fifty SVG cards would be fifty QR codes.
 */
export function CardThumb({ card, className }: { card: IssuedCard; className?: string }) {
  const sources = [artUrl(card.serial), poseUrl(card.pose)];
  const [at, setAt] = useState(0);
  const src = sources[at];
  return (
    <span
      className={cn(
        "relative block aspect-[3/4] overflow-hidden rounded-[5px] bg-well [text-shadow:none]",
        card.voided_at && "opacity-40 grayscale",
        className,
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setAt((n) => n + 1)}
          className="size-full object-cover"
        />
      ) : (
        <span className="grid size-full place-items-center text-muted-foreground">
          <ImageOff aria-hidden className="size-4" />
        </span>
      )}
    </span>
  );
}
