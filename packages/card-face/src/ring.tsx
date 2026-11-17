/** @jsxRuntime automatic */
/** @jsxImportSource react */
// The bond ring: the lap being filled as an inner ring, ten segments round it (one lit segment,
// one finished lap), a heart in the middle. One drawing for the admin page, the public page, the
// list rows and the PNG Discord shows. It needs only the lap and the fraction, never the raw bond.
// Geometry follows docs/design/mock/heart-ring.html.

import { ringOf } from "@miyoria/types/bond";
import type { CSSProperties, ReactElement } from "react";

/** Lucide "heart", the icon set the panel uses. */
const HEART =
  "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z";

const LAPS = 10;
const C = 80;
/** The segment ring. */
const SEG_R = 75;
const SEG_W = 4;
const SEG_GAP = 5;
/** The lap ring. */
const LAP_R = 58;
const LAP_W = 14;
/** The mark's lap ring is thicker so it reads at 28 px. */
const MARK_R = 66;
const MARK_W = 22;

/** Every colour the ring uses. */
export interface BondRingColors {
  /** The lap arc and the lit segments. */
  primary: string;
  /** The filled heart. */
  foreground: string;
  /** The number on a heart that is not filled. */
  mutedForeground: string;
  /** The lap ring's track. */
  track: string;
  /** The mark's (thicker) track. */
  markTrack: string;
  /** A segment not lit yet. */
  segment: string;
  /** The arc of a negative bond. */
  neutral: string;
  /** The outline heart (bond 0 or below). */
  outline: string;
  /** The number on the white heart. */
  ink: string;
}

/** CSS custom properties with fallbacks: the panel's themes apply. Not for resvg. */
export const THEME_COLORS: BondRingColors = {
  primary: "var(--primary, #f29dc4)",
  foreground: "var(--foreground, #f1f0f4)",
  mutedForeground: "var(--muted-foreground, #dedce4)",
  track: "rgba(255,255,255,.07)",
  markTrack: "rgba(255,255,255,.1)",
  segment: "rgba(255,255,255,.14)",
  neutral: "rgba(241,240,244,.38)",
  outline: "rgba(241,240,244,.45)",
  ink: "#1f1218",
};

/** Plain values only, for a renderer that does not resolve `var()` (resvg). */
export const STATIC_COLORS: BondRingColors = {
  primary: "#f29dc4",
  foreground: "#f1f0f4",
  mutedForeground: "#dedce4",
  track: "rgba(255,255,255,.07)",
  markTrack: "rgba(255,255,255,.1)",
  segment: "rgba(255,255,255,.14)",
  neutral: "rgba(241,240,244,.38)",
  outline: "rgba(241,240,244,.45)",
  ink: "#1f1218",
};

export interface BondRingProps {
  /** Laps finished, 0..9 (`ringOf(bond).lap`). */
  lap: number;
  /** How far the current lap is filled, 0..1. */
  fraction: number;
  /** For a negative bond, how far below 0 towards -100 (0..1); 0 otherwise. */
  below?: number;
  /** Bond 1000: all ten segments lit and the inner ring full. Derived from lap 9 and a full lap if left out. */
  full?: boolean;
  /** The bond number, written on the heart. Leave it out for the public page. */
  value?: number;
  /** "ring" (default) is the whole drawing, "mark" the small one for table rows. */
  size?: "ring" | "mark";
  /** The accessible name, in the caller's words (the tier name). Never gets the number. */
  title: string;
  /** Plain values for static rendering. Defaults to the theme's CSS variables. */
  colors?: BondRingColors;
}

/** The part of `ringOf`'s result the ring needs (`RingPosition` in `@miyoria/types`). */
export interface RingPositionLike {
  lap: number;
  fraction: number;
  below: number;
}

/**
 * The ring's props: from the bond (`<BondRing {...bondRingProps(bond)} title=… />`, the admin side,
 * `ringOf` from `@miyoria/types/bond`), or from a position someone else worked out (the public
 * page, which has the lap and the fraction and never the bond; `bond`, when given, only says
 * `full`). The number is not passed on: add `value` yourself on the admin page.
 */
export function bondRingProps(
  bond: number,
): Pick<BondRingProps, "lap" | "fraction" | "below" | "full">;
export function bondRingProps(
  position: RingPositionLike,
  bond?: number,
): Pick<BondRingProps, "lap" | "fraction" | "below" | "full">;
export function bondRingProps(
  from: number | RingPositionLike,
  bond?: number,
): Pick<BondRingProps, "lap" | "fraction" | "below" | "full"> {
  if (typeof from === "number") {
    const { lap, fraction, below } = ringOf(from);
    return { lap, fraction, below, full: from >= 1000 };
  }
  const { lap, fraction, below } = from;
  return { lap, fraction, below, full: bond === undefined ? undefined : bond >= 1000 };
}

/** The lap arc: a round-capped dash from 12 o'clock, a plain full circle once the lap is full. */
function Band(props: {
  r: number;
  w: number;
  frac: number;
  color: string;
  reverse?: boolean;
}): ReactElement {
  const { r, w, frac, color, reverse } = props;
  const c = 2 * Math.PI * r;
  const round = frac < 1;
  const cap = w / 2;
  const dash = round ? Math.max(c * frac - cap * 2, 0.01) : c * frac;
  // The round cap eats half a width at each end, so the arc starts that far round.
  const start = round ? -90 + (cap / c) * 360 : -90;
  const transform = reverse
    ? `rotate(-90 ${C} ${C}) scale(1 -1) translate(0 -${C * 2})`
    : `rotate(${start} ${C} ${C})`;
  return (
    <circle
      cx={C}
      cy={C}
      r={r}
      fill="none"
      strokeWidth={w}
      strokeLinecap={round ? "round" : undefined}
      strokeDasharray={`${dash} ${c}`}
      transform={transform}
      style={{ stroke: color }}
    />
  );
}

/** How many segments are lit. */
export function litSegments(lap: number, full: boolean): number {
  return full ? LAPS : Math.max(0, Math.min(Math.floor(lap), LAPS - 1));
}

/** The bond ring (or its small mark): an SVG that scales to the box it is put in. */
export function BondRing(props: BondRingProps): ReactElement {
  const { lap, value, size = "ring", title, colors = THEME_COLORS } = props;
  const below = props.below ?? 0;
  const fraction = Math.max(0, Math.min(props.fraction, 1));
  const full = props.full ?? (lap >= LAPS - 1 && fraction >= 1);
  const negative = below > 0;
  const frac = full ? 1 : fraction;
  const lit = litSegments(lap, full);
  const outline = negative || (!full && lap <= 0 && frac <= 0);
  const mark = size === "mark";
  const r = mark ? MARK_R : LAP_R;
  const w = mark ? MARK_W : LAP_W;
  const heartFill: CSSProperties = outline
    ? { fill: "none", stroke: colors.outline }
    : { fill: colors.foreground, stroke: colors.foreground };

  const circ = 2 * Math.PI * SEG_R;
  const seg = circ / LAPS;
  const segments: ReactElement[] = [];
  if (!mark) {
    for (let i = 0; i < LAPS; i++) {
      const turn = -90 + i * 36 + ((SEG_GAP / 2 + 2) / circ) * 360;
      segments.push(
        <circle
          key={i}
          data-segment={i < lit ? "lit" : "off"}
          cx={C}
          cy={C}
          r={SEG_R}
          fill="none"
          strokeWidth={SEG_W}
          strokeLinecap="round"
          strokeDasharray={`${seg - SEG_GAP - 4} ${circ}`}
          transform={`rotate(${turn} ${C} ${C})`}
          style={{ stroke: i < lit ? colors.primary : colors.segment }}
        />,
      );
    }
  }

  let number: ReactElement | null = null;
  if (!mark && value !== undefined) {
    const text = String(Math.round(value)).replace("-", "−");
    number = (
      <text
        x={C}
        y={79}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={text.length >= 4 ? 15 : text.length === 3 ? 17.5 : 19}
        fontWeight={650}
        style={{
          fill: value <= 0 ? colors.mutedForeground : colors.ink,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {text}
      </text>
    );
  }

  return (
    <svg
      viewBox="0 0 160 160"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
      data-bond-ring={size}
    >
      {segments}
      <circle
        cx={C}
        cy={C}
        r={r}
        fill="none"
        strokeWidth={w}
        style={{ stroke: mark ? colors.markTrack : colors.track }}
      />
      {negative ? (
        <Band r={r} w={w} frac={below} color={colors.neutral} reverse />
      ) : frac > 0 ? (
        <Band r={r} w={w} frac={frac} color={colors.primary} />
      ) : null}
      <g transform={mark ? "translate(80 82) scale(3) translate(-12 -12)" : "translate(80 81) scale(2.5) translate(-12 -12)"}>
        <path
          d={HEART}
          strokeWidth={mark ? undefined : 1.6}
          strokeLinejoin={mark ? undefined : "round"}
          style={mark ? { fill: outline ? "none" : colors.foreground, stroke: outline ? colors.outline : "none" } : heartFill}
        />
      </g>
      {number}
    </svg>
  );
}
