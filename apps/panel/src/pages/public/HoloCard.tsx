// The card as a thing in the hand: it tilts toward the pointer (or a finger dragged across it),
// grows a little under the pointer, and catches light. A glare follows the pointer on every card;
// a foil card has a rainbow and glitter on the background that move and flash as it turns, and
// only a faint sheen on her, so she stays as drawn (on her rendered picture, which is opaque, the
// foil is a holographic sheen over the whole picture, brightest in its light parts); a bought frame's band has its own light (a
// sheen along gold, caustics in the abyss, a pink shimmer on sakura). With no pointer on it the card sways slowly so the light still moves on a phone. Under
// prefers-reduced-motion it lies still. The layers sit over the same SVG the PNG is made from, so
// the picture they download is the card without the light.

import { useEffect, useRef } from "react";
import type { IssuedCard } from "@miyoria/contracts/api";
import { cn } from "@/lib/utils";
import { artUrl, InlinedCard, useArtOpaque, useCardArt } from "./card";

/** Frames that have a light of their own in `index.css` (`.holo-band-<id>`). */
const LIT_FRAMES = new Set(["sakura", "abyss", "gold"]);

/** How far the card turns at the edge of its box, in degrees. */
const MAX_TILT = 14;
/** How much of the gap to the target is closed each frame. */
const EASE = 0.12;

interface Pose {
  /** Pointer across the card, 0 to 1. */
  x: number;
  y: number;
  /** 0 at rest, 1 while the pointer is on the card. */
  on: number;
  /** Size, 1 at rest. */
  s: number;
}

const REST: Pose = { x: 0.5, y: 0.5, on: 0, s: 1 };

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Writes a pose to the element as the CSS variables the layers read. */
function apply(el: HTMLElement, p: Pose) {
  const dx = p.x - 0.5;
  const dy = p.y - 0.5;
  el.style.setProperty("--rx", `${(-dy * 2 * MAX_TILT).toFixed(2)}deg`);
  el.style.setProperty("--ry", `${(dx * 2 * MAX_TILT).toFixed(2)}deg`);
  el.style.setProperty("--mx", `${(p.x * 100).toFixed(2)}%`);
  el.style.setProperty("--my", `${(p.y * 100).toFixed(2)}%`);
  el.style.setProperty("--px", `${(p.x * 100).toFixed(2)}`);
  el.style.setProperty("--py", `${(p.y * 100).toFixed(2)}`);
  el.style.setProperty("--hyp", Math.min(1, Math.hypot(dx, dy) * 2).toFixed(3));
  el.style.setProperty("--on", p.on.toFixed(3));
  el.style.setProperty("--s", p.s.toFixed(4));
}

export function HoloCard({
  card,
  portrait,
  svgRef,
  zoom = 1.05,
  sway = true,
  className,
}: {
  card: IssuedCard;
  /**
   * Which picture the Core says the card has (`live`: her rendered one, opaque; `fixed`: a
   * cut-out portrait), as its list sends it; without it, read from the picture itself.
   */
  portrait?: "live" | "fixed";
  svgRef?: React.Ref<SVGSVGElement>;
  /** Size under the pointer. */
  zoom?: number;
  /** Sway slowly while nothing is on the card. */
  sway?: boolean;
  className?: string;
}) {
  const art = useCardArt(card);
  const box = useRef<HTMLDivElement>(null);
  const target = useRef<Pose>({ ...REST });
  const now = useRef<Pose>({ ...REST });
  const pointing = useRef(false);
  const frame = useRef(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    apply(el, REST);
    if (reducedMotion()) return;
    const started = performance.now();
    const tick = (t: number) => {
      if (!pointing.current && sway) {
        // A slow figure of eight, small enough to read as breathing, large enough to move the light.
        const k = (t - started) / 1000;
        target.current = { x: 0.5 + Math.sin(k * 0.7) * 0.22, y: 0.5 + Math.sin(k * 0.9 + 1) * 0.16, on: 0.55, s: 1 };
      }
      const a = now.current;
      const b = target.current;
      a.x += (b.x - a.x) * EASE;
      a.y += (b.y - a.y) * EASE;
      a.on += (b.on - a.on) * EASE;
      a.s += (b.s - a.s) * EASE;
      apply(el, a);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [sway]);

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    pointing.current = true;
    target.current = {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      on: 1,
      s: zoom,
    };
  };
  const leave = () => {
    pointing.current = false;
    target.current = { ...REST };
  };

  const lit = card.frame && LIT_FRAMES.has(card.frame) ? card.frame : null;
  // A cut-out portrait masks the foil off her; her rendered picture is opaque, so the foil is a
  // sheen printed over the whole picture instead (`index.css`, `[data-art="opaque"]`).
  const read = useArtOpaque(portrait === undefined ? art : { url: null, data: null });
  // The Core's word holds for the picture the Core sent, not the panel's own fallback portrait.
  const opaque = portrait === undefined ? read : portrait === "live" && art.url === artUrl(card.serial);
  return (
    <div className={cn("holo-stage", className)}>
      <div
        ref={box}
        className={cn("holo-card", card.voided_at && "opacity-40 grayscale")}
        data-art={opaque ? "opaque" : "cutout"}
        style={(art.url && !opaque ? { "--art": `url("${art.url}")` } : {}) as React.CSSProperties}
        onPointerMove={move}
        onPointerDown={move}
        onPointerLeave={leave}
        onPointerCancel={leave}
        onPointerUp={(e) => {
          if (e.pointerType !== "mouse") leave();
        }}
      >
        <InlinedCard card={card} svgRef={svgRef} />
        {card.foil && (
          <>
            <div aria-hidden className="holo-layer holo-foil" />
            <div aria-hidden className="holo-layer holo-glitter" />
            <div aria-hidden className="holo-layer holo-sheen" />
          </>
        )}
        {lit && <div aria-hidden className={cn("holo-layer holo-band", `holo-band-${lit}`)} />}
        <div aria-hidden className="holo-layer holo-glare" />
      </div>
    </div>
  );
}
