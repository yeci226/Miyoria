/** @jsxRuntime automatic */
/** @jsxImportSource react */
// The member card as an SVG, drawn from what the Core issued. One drawing, two users: the panel
// shows it (and turns it into the PNG people download), and the Core renders it to a PNG for the
// preview a link to the card unfurls with. Pictures come in as data URLs and colours as literals,
// so the SVG stands on its own wherever it is turned into pixels.

import { forwardRef } from "react";
import { encode } from "uqr";

/** What a card draws: the fields of an issued card (`IssuedCard` in the panel and the API). */
export interface CardData {
  serial: string;
  issued_at: string;
  name: string;
  number: number;
  call_name: string | null;
  relationship: string | null;
  affinity: string | null;
  trust: string | null;
  familiarity: string | null;
  public_feeling: string | null;
  line?: string | null;
  stamp?: string | null;
  fields?: { label: string; text: string }[];
  frame?: string | null;
  foil?: boolean;
}

/** The Core's bands (`packages/api/src/member.ts`), lowest first. */
export const AFFINITY = ["很差", "不太好", "普通", "不錯", "很好", "非常好"] as const;
export const TRUST = ["還不信任", "有點信任", "信任", "很信任"] as const;
export const FAMILIARITY = ["陌生", "見過幾次", "有點熟", "熟", "很熟"] as const;

export const W = 630;
export const H = 880;
const PAD = 36;
/** The lower half, where the words sit. */
const INK = "#0c0e16";
const FONT =
  '"Geist Variable", "PingFang TC", "Microsoft JhengHei UI", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
const MONO = '"Geist Mono", ui-monospace, Consolas, monospace';

/** Punctuation that never starts a line: it hangs past the measure instead (「…。」 kept whole). */
const CLOSING = /[」』）)】〉》。,，、．.!！?？:：;；…~～]/;

/** CJK runs about one em per character, Latin about half: enough to break lines by hand. */
function wrap(text: string, em: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  let width = 0;
  for (const ch of text.replace(/\s+/g, " ").trim()) {
    const w = /[\u0000-ɏ]/.test(ch) ? 0.55 : 1;
    if (width + w > em && !(CLOSING.test(ch) && width <= em + 1)) {
      out.push(line);
      line = "";
      width = 0;
      if (out.length === lines) break;
    }
    line += ch;
    width += w;
  }
  if (out.length < lines && line !== "") out.push(line);
  else if (out.length === lines) out[lines - 1] = `${(out[lines - 1] ?? "").slice(0, -1)}…`;
  return out;
}

const issuedDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso.slice(0, 10)
    : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};

function Qr({ text, x, y, size }: { text: string; x: number; y: number; size: number }) {
  const qr = encode(text, { ecc: "M", border: 0 });
  const cell = size / qr.size;
  let d = "";
  qr.data.forEach((row, r) => {
    row.forEach((on, c) => {
      if (on)
        d += `M${(x + c * cell).toFixed(2)} ${(y + r * cell).toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
    });
  });
  return <path d={d} fill="#0b0d14" shapeRendering="crispEdges" />;
}

function Meter({
  x,
  y,
  width,
  at,
  steps,
  primary,
}: {
  x: number;
  y: number;
  width: number;
  at: number;
  steps: number;
  primary: string;
}) {
  const gap = 3;
  const w = (width - gap * (steps - 1)) / steps;
  return (
    <g>
      {Array.from({ length: steps }, (_, i) => (
        <rect
          key={i}
          x={x + i * (w + gap)}
          y={y}
          width={w}
          height={6}
          rx={2}
          fill={i <= at ? primary : "rgba(255,255,255,0.16)"}
        />
      ))}
    </g>
  );
}

function BandColumn({
  x,
  label,
  value,
  scale,
  primary,
}: {
  x: number;
  label: string;
  value: string | null;
  scale: readonly string[];
  primary: string;
}) {
  const at = value === null ? -1 : scale.indexOf(value);
  const width = 170;
  return (
    <g>
      <text x={x} y={636} fontSize={13} fill="rgba(255,255,255,0.6)">
        {label}
      </text>
      <text x={x} y={660} fontSize={18} fontWeight={600} fill="#f1f0f4">
        {value ?? "—"}
      </text>
      {at >= 0 && (
        <Meter x={x} y={672} width={width} at={at} steps={scale.length} primary={primary} />
      )}
    </g>
  );
}

/** Her stamp: a seal pressed at a tilt beside the title, in the primary colour. */
function Stamp({ text, x, y, primary }: { text: string; x: number; y: number; primary: string }) {
  const size = 19;
  const width = [...text].reduce((w, ch) => w + (/[\u0000-ɏ]/.test(ch) ? 0.6 : 1), 0) * size + 26;
  return (
    <g transform={`translate(${x - width / 2} ${y}) rotate(-8)`} opacity={0.94}>
      <rect
        x={-width / 2}
        y={-22}
        width={width}
        height={44}
        rx={7}
        fill="rgba(12,14,22,0.35)"
        stroke={primary}
        strokeWidth={2.5}
      />
      <rect
        x={-width / 2 + 4}
        y={-18}
        width={width - 8}
        height={36}
        rx={4}
        fill="none"
        stroke={primary}
        strokeOpacity={0.55}
      />
      <text
        y={7}
        fontSize={size}
        fontWeight={700}
        textAnchor="middle"
        letterSpacing={2}
        fill={primary}
      >
        {text}
      </text>
    </g>
  );
}

/** Lines of words the lower half holds above the footer, and how far the rest moves up for them. */
const QUOTE_Y = 718;
const QUOTE_STEP = 25;
const FIELD_STEP = 26;
const FIELDS_END = 784;

/**
 * Frames they can buy: a colour per id for the little swatch in the shop. The card draws the
 * real thing in `Frame`. An id the panel does not know falls back to the plain border.
 */
export const FRAME_SWATCH: Record<string, string> = {
  sakura: "#f4b6cf",
  abyss: "#2f8fb5",
  gold: "#d9aa3c",
};

/** The frames' names as the shop sells them (`DEFAULT_FRAMES` in `packages/economy`), for the card's page. */
export const FRAME_NAME: Record<string, string> = {
  sakura: "櫻花框",
  abyss: "深海框",
  gold: "金框",
};

/**
 * How wide a bought frame is. Bought frames are a band of material along the edge, the way printed
 * collectible cards frame their art, not a line: everything on the card sits at `PAD`, so the band
 * and what lives in it stay clear of the words.
 */
const BAND = 18;

/** Fixed glitter positions for one 48 px tile: x, y, size, opacity. A star when size > 1.6. */
const GLITTER: [number, number, number, number][] = [
  [4, 6, 1, 0.9],
  [15, 3, 2.6, 1],
  [27, 9, 0.8, 0.7],
  [38, 4, 1.2, 0.8],
  [44, 15, 2, 0.9],
  [9, 18, 1.4, 0.6],
  [21, 22, 0.9, 0.9],
  [33, 26, 3, 1],
  [3, 31, 2.2, 0.85],
  [14, 37, 0.8, 0.6],
  [26, 41, 1.3, 0.9],
  [41, 36, 0.9, 0.7],
  [46, 45, 1.8, 0.8],
  [19, 46, 0.7, 0.5],
];

/** The foil glitter printed across a band, the way printed collectible cards sparkle at the edge. */
function Glitter({ id, tint }: { id: string; tint: string }) {
  return (
    <>
      <defs>
        <pattern id={`glitter-${id}`} width="48" height="48" patternUnits="userSpaceOnUse">
          {GLITTER.map(([x, y, s, o]) =>
            s > 1.6 ? (
              <path
                key={`${x}-${y}`}
                d={`M${x} ${y - s * 1.6}L${x + s * 0.3} ${y - s * 0.3}L${x + s * 1.6} ${y}L${x + s * 0.3} ${y + s * 0.3}L${x} ${y + s * 1.6}L${x - s * 0.3} ${y + s * 0.3}L${x - s * 1.6} ${y}L${x - s * 0.3} ${y - s * 0.3}Z`}
                fill={tint}
                opacity={o}
              />
            ) : (
              <circle key={`${x}-${y}`} cx={x} cy={y} r={s * 0.6} fill={tint} opacity={o} />
            ),
          )}
        </pattern>
      </defs>
      <path d={BAND_PATH} fillRule="evenodd" fill={`url(#glitter-${id})`} />
    </>
  );
}
const RADIUS = 26;

/** A rounded rectangle inset by `i` from the card's edge, as a path. */
function rrect(i: number): string {
  const r = Math.max(RADIUS - i, 4);
  const x0 = i;
  const y0 = i;
  const x1 = W - i;
  const y1 = H - i;
  return (
    `M${x0 + r} ${y0}H${x1 - r}A${r} ${r} 0 0 1 ${x1} ${y0 + r}V${y1 - r}A${r} ${r} 0 0 1 ${x1 - r} ${y1}` +
    `H${x0 + r}A${r} ${r} 0 0 1 ${x0} ${y1 - r}V${y0 + r}A${r} ${r} 0 0 1 ${x0 + r} ${y0}Z`
  );
}

/** The band itself: the card's outline less the opening the art shows through. */
const BAND_PATH = `${rrect(0)}${rrect(BAND)}`;

/**
 * The edges every band shares: a dark rim outside, and inside a shadow the band casts on the art with
 * a lit lip above it, so the band reads as raised rather than painted on.
 */
function BandEdges({ rim, lip }: { rim: string; lip: string }) {
  return (
    <g fill="none">
      <path d={rrect(0.75)} stroke={rim} strokeWidth={1.5} />
      <path d={rrect(BAND + 1.5)} stroke="#000000" strokeOpacity={0.45} strokeWidth={3} />
      <path d={rrect(BAND - 0.5)} stroke={lip} strokeWidth={1} />
    </g>
  );
}

/** A five-petal cherry blossom, each petal notched at its tip; `r` is its radius. */
function Blossom({
  x,
  y,
  r,
  rot,
  fill,
  stroke,
}: {
  x: number;
  y: number;
  r: number;
  rot: number;
  fill: string;
  stroke: string;
}) {
  const petal = `M0 0C${-r * 0.5} ${-r * 0.3} ${-r * 0.52} ${-r * 0.92} ${-r * 0.16} ${-r}L0 ${-r * 0.84}L${r * 0.16} ${-r}C${r * 0.52} ${-r * 0.92} ${r * 0.5} ${-r * 0.3} 0 0Z`;
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      {[0, 72, 144, 216, 288].map((a) => (
        <path
          key={a}
          d={petal}
          transform={`rotate(${a})`}
          fill={fill}
          stroke={stroke}
          strokeWidth={0.8}
          strokeLinejoin="round"
        />
      ))}
      <circle r={r * 0.2} fill="#e0668f" />
      {[0, 72, 144, 216, 288].map((a) => (
        <circle
          key={a}
          r={r * 0.06}
          cx={0}
          cy={-r * 0.34}
          transform={`rotate(${a + 36})`}
          fill="#c84d77"
        />
      ))}
    </g>
  );
}

/**
 * The foil finish: a faint holographic wash, a fine diagonal grain and one soft glint that crosses
 * the card now and then (not at all under prefers-reduced-motion; the PNG keeps it still).
 */
function Foil({ id }: { id: string }) {
  return (
    <g pointerEvents="none">
      <style>
        {`@keyframes myr-foil-glint{0%,60%{transform:translateX(0)}100%{transform:translateX(${W + 360}px)}}
@media (prefers-reduced-motion: no-preference){.myr-foil-glint{animation:myr-foil-glint 7s ease-in-out infinite}}`}
      </style>
      <defs>
        <linearGradient
          id={`holo-${id}`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2={W}
          y2={H}
        >
          <stop offset="0" stopColor="#ff9bd2" />
          <stop offset="0.22" stopColor="#ffd9a0" />
          <stop offset="0.44" stopColor="#a4ffd0" />
          <stop offset="0.66" stopColor="#9bd6ff" />
          <stop offset="0.88" stopColor="#c7a1ff" />
          <stop offset="1" stopColor="#ff9bd2" />
        </linearGradient>
        <linearGradient id={`glint-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <pattern
          id={`grain-${id}`}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(35)"
        >
          <rect width="1" height="6" fill="#ffffff" />
        </pattern>
      </defs>
      <rect
        width={W}
        height={H}
        fill={`url(#holo-${id})`}
        opacity={0.14}
        style={{ mixBlendMode: "screen" }}
      />
      <rect width={W} height={H} fill={`url(#grain-${id})`} opacity={0.045} />
      <g className="myr-foil-glint">
        <rect
          x={-300}
          y={-40}
          width={220}
          height={H + 80}
          fill={`url(#glint-${id})`}
          transform="skewX(-16)"
        />
      </g>
    </g>
  );
}

/** The border of the card, drawn over the picture. Literal colours only: it is exported to PNG. */
function Frame({ frame, id }: { frame: string | null | undefined; id: string }) {
  if (frame === "sakura") {
    // Pearl pink, blossoms printed faintly across the band, and one blossom at two opposite corners.
    return (
      <g>
        <defs>
          <linearGradient
            id={`sakura-${id}`}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2={W}
            y2={H}
          >
            <stop offset="0" stopColor="#fde4ee" />
            <stop offset="0.35" stopColor="#f5b9cf" />
            <stop offset="0.65" stopColor="#f9d1e0" />
            <stop offset="1" stopColor="#e993b5" />
          </linearGradient>
          <pattern
            id={`sakura-print-${id}`}
            width="34"
            height="34"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(12)"
          >
            <Blossom x={8} y={8} r={5.5} rot={0} fill="#ffffff" stroke="none" />
            <Blossom x={25} y={25} r={4} rot={30} fill="#ffffff" stroke="none" />
          </pattern>
        </defs>
        <path d={BAND_PATH} fillRule="evenodd" fill={`url(#sakura-${id})`} />
        <path d={BAND_PATH} fillRule="evenodd" fill={`url(#sakura-print-${id})`} opacity={0.5} />
        <Glitter id={id} tint="#ffffff" />
        <BandEdges rim="#b85a83" lip="#fff6fa" />
        <Blossom x={W - 21} y={21} r={14} rot={8} fill="#fff3f7" stroke="#d87aa0" />
        <Blossom x={21} y={H - 21} r={14} rot={-20} fill="#fff3f7" stroke="#d87aa0" />
      </g>
    );
  }
  if (frame === "abyss") {
    // Deep water: light from the surface at the top, darker downward, swell lines along the band and
    // bubbles rising inside it on the right.
    const bubbles: [number, number, number][] = [
      [W - 9, 560, 2.4],
      [W - 10, 492, 3.2],
      [W - 8.5, 410, 4],
      [W - 9.5, 312, 5],
      [W - 9, 214, 3.8],
      [W - 9.5, 150, 2.6],
      [9, H - 170, 2.8],
      [9.5, H - 240, 4.2],
      [9, H - 318, 3],
    ];
    return (
      <g>
        <defs>
          <linearGradient
            id={`abyss-${id}`}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2={W * 0.4}
            y2={H}
          >
            <stop offset="0" stopColor="#3fb8c8" />
            <stop offset="0.2" stopColor="#1a74a0" />
            <stop offset="0.6" stopColor="#103a6e" />
            <stop offset="1" stopColor="#071636" />
          </linearGradient>
          <pattern id={`swell-${id}`} width="28" height="7" patternUnits="userSpaceOnUse">
            <path d="M0 4.5Q7 1.5 14 4.5T28 4.5" fill="none" stroke="#bff6f8" strokeWidth={0.9} />
          </pattern>
        </defs>
        <path d={BAND_PATH} fillRule="evenodd" fill={`url(#abyss-${id})`} />
        <path d={BAND_PATH} fillRule="evenodd" fill={`url(#swell-${id})`} opacity={0.22} />
        <Glitter id={id} tint="#bdf8ff" />
        <BandEdges rim="#04122b" lip="#8eeef2" />
        {bubbles.map(([cx, cy, r]) => (
          <g key={`${cx}-${cy}`}>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="#d9fdff"
              fillOpacity={0.14}
              stroke="#d9fdff"
              strokeOpacity={0.85}
              strokeWidth={0.9}
            />
            <circle
              cx={cx - r * 0.35}
              cy={cy - r * 0.35}
              r={r * 0.28}
              fill="#ffffff"
              fillOpacity={0.9}
            />
          </g>
        ))}
      </g>
    );
  }
  if (frame === "gold") {
    // Brushed gold with an engraved line down the middle of the band, and stepped corner plates
    // that stay inside the band's corner.
    const plate = `M${BAND - 2} ${BAND - 2}H${BAND + 30}V${BAND + 4}H${BAND + 4}V${BAND + 30}H${BAND - 2}Z`;
    const corners: [number, number][] = [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    return (
      <g>
        <defs>
          <linearGradient
            id={`gold-${id}`}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2={W}
            y2={H}
          >
            <stop offset="0" stopColor="#fff0b5" />
            <stop offset="0.18" stopColor="#d7a93f" />
            <stop offset="0.38" stopColor="#8a5f17" />
            <stop offset="0.55" stopColor="#f4d77c" />
            <stop offset="0.72" stopColor="#b8862a" />
            <stop offset="0.88" stopColor="#f0cf6a" />
            <stop offset="1" stopColor="#7d5413" />
          </linearGradient>
          <pattern
            id={`brush-${id}`}
            width="3"
            height="3"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(-45)"
          >
            <rect width="3" height="0.8" fill="#ffffff" />
          </pattern>
        </defs>
        <path d={BAND_PATH} fillRule="evenodd" fill={`url(#gold-${id})`} />
        <path d={BAND_PATH} fillRule="evenodd" fill={`url(#brush-${id})`} opacity={0.08} />
        <Glitter id={id} tint="#fffbe6" />
        <path
          d={rrect(BAND / 2 - 0.5)}
          fill="none"
          stroke="#5c3d0c"
          strokeOpacity={0.75}
          strokeWidth={0.9}
        />
        <path
          d={rrect(BAND / 2 + 0.6)}
          fill="none"
          stroke="#fff3c4"
          strokeOpacity={0.7}
          strokeWidth={0.7}
        />
        <BandEdges rim="#5a3b0a" lip="#fff1bd" />
        {corners.map(([fx, fy]) => (
          <g
            key={`${fx}${fy}`}
            transform={`translate(${fx < 0 ? W : 0} ${fy < 0 ? H : 0}) scale(${fx} ${fy})`}
          >
            <path
              d={plate}
              fill={`url(#gold-${id})`}
              stroke="#5a3b0a"
              strokeWidth={1}
              strokeLinejoin="miter"
            />
            <path
              d={`M${BAND + 1} ${BAND + 1}H${BAND + 27}M${BAND + 1} ${BAND + 1}V${BAND + 27}`}
              stroke="#fff3c4"
              strokeOpacity={0.75}
              strokeWidth={0.8}
            />
          </g>
        ))}
      </g>
    );
  }
  return (
    <g>
      <rect
        x={1.5}
        y={1.5}
        width={W - 3}
        height={H - 3}
        rx={25}
        fill="none"
        stroke={`url(#foil-${id})`}
        strokeWidth={3}
      />
      <rect
        x={10}
        y={10}
        width={W - 20}
        height={H - 20}
        rx={19}
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.12}
      />
    </g>
  );
}

export interface CardFaceProps {
  card: CardData;
  /** Her picture, inlined; `null` draws the card without it. */
  art: string | null;
  /** Their avatar, inlined; `null` draws their initial. */
  avatar: string | null;
  colors: { primary: string; secondary: string };
  /** Where the code on the card leads: the page that checks it. */
  verifyUrl: string;
  className?: string;
}

/** The card. `ref` reaches the `<svg>`, for turning it into a PNG. */
export const CardFace = forwardRef<SVGSVGElement, CardFaceProps>(function CardFace(
  { card, art, avatar, colors, verifyUrl, className },
  ref,
) {
  const known = card.relationship !== null;
  const title = card.relationship ?? "初次見面";
  // What she wrote as she issued it; older cards carry the line her reflection wrote instead.
  const feeling = card.line ?? card.public_feeling ?? (known ? null : "她還不認識你");
  const lines = feeling ? wrap(`「${feeling}」`, 26, 3) : [];
  const fields = (card.fields ?? []).slice(0, 3);
  // Her fields sit under the quote and end above the footer; what is above moves up to make room.
  const quoteBlock = lines.length > 0 ? (lines.length - 1) * QUOTE_STEP + 34 : 0;
  const lift =
    fields.length === 0
      ? 0
      : Math.max(0, quoteBlock + (fields.length - 1) * FIELD_STEP - (FIELDS_END - QUOTE_Y));
  const fieldsTop = QUOTE_Y - lift + quoteBlock;
  const titleY = (known && card.call_name ? 566 : 590) - lift;
  const initial = [...card.name.trim()][0] ?? "?";
  const id = card.serial.replace(/[^A-Z0-9]/gi, "");
  const label = [
    `${card.name} 的卡,${title}`,
    card.call_name ? `她叫你${card.call_name}` : null,
    card.foil ? "閃卡" : null,
    card.stamp ? `蓋了「${card.stamp}」` : null,
    feeling ? `她說「${feeling}」` : null,
    ...fields.map((f) => `${f.label}:${f.text}`),
    `編號 ${card.serial}`,
  ]
    .filter((s): s is string => s !== null)
    .join(",");
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role="img"
      aria-label={label}
      className={className}
      fontFamily={FONT}
    >
      <defs>
        <clipPath id={`clip-${id}`}>
          <rect width={W} height={H} rx={26} />
        </clipPath>
        <linearGradient id={`bg-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a1f36" />
          <stop offset="1" stopColor="#0b0d14" />
        </linearGradient>
        <linearGradient id={`fade-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={INK} stopOpacity="0" />
          <stop offset="0.5" stopColor={INK} stopOpacity="0.7" />
          <stop offset="0.85" stopColor={INK} stopOpacity="0.97" />
          <stop offset="1" stopColor={INK} stopOpacity="1" />
        </linearGradient>
        <radialGradient id={`glow-a-${id}`}>
          <stop offset="0" stopColor={colors.secondary} stopOpacity="0.45" />
          <stop offset="1" stopColor={colors.secondary} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`glow-b-${id}`}>
          <stop offset="0" stopColor={colors.primary} stopOpacity="0.28" />
          <stop offset="1" stopColor={colors.primary} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`foil-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={colors.primary} />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.7" />
          <stop offset="1" stopColor={colors.secondary} />
        </linearGradient>
        <linearGradient id={`sheen-${id}`} x1="0" y1="0" x2="1" y2="0.6">
          <stop offset="0.3" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.45" stopColor="#ffffff" stopOpacity="0.09" />
          <stop offset="0.6" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`avatar-${id}`}>
          <circle cx={PAD + 18} cy={820} r={18} />
        </clipPath>
      </defs>
      <g clipPath={`url(#clip-${id})`}>
        <rect width={W} height={H} fill={`url(#bg-${id})`} />
        <circle cx={W * 0.8} cy={170} r={330} fill={`url(#glow-a-${id})`} />
        <circle cx={W * 0.1} cy={440} r={300} fill={`url(#glow-b-${id})`} />
        {art && (
          <image
            href={art}
            x={-15}
            y={-6}
            width={W + 30}
            height={(W + 30) * (4 / 3)}
            preserveAspectRatio="xMidYMin slice"
          />
        )}
        <rect y={340 - lift} width={W} height={270} fill={`url(#fade-${id})`} />
        <rect y={609 - lift} width={W} height={H - 609 + lift} fill={INK} />
        <rect width={W} height={H} fill={`url(#sheen-${id})`} />
        {card.foil && <Foil id={id} />}

        <text
          x={PAD}
          y={56}
          fontSize={15}
          fontWeight={600}
          letterSpacing={5}
          fill="#ffffff"
          opacity={0.9}
        >
          MIYORIA
        </text>
        <text
          x={W - PAD}
          y={56}
          fontSize={15}
          fontFamily={MONO}
          textAnchor="end"
          fill="#ffffff"
          opacity={0.85}
        >
          No.{String(card.number).padStart(3, "0")}
        </text>

        <text x={PAD} y={titleY} fontSize={46} fontWeight={700} fill="#ffffff" letterSpacing={1}>
          {title}
        </text>
        {known && card.call_name && (
          <text x={PAD} y={600 - lift} fontSize={18} fill="rgba(255,255,255,0.72)">
            她叫你{" "}
            <tspan fill="#ffffff" fontWeight={600}>
              {card.call_name}
            </tspan>
          </text>
        )}
        {card.stamp && (
          <Stamp text={card.stamp} x={W - PAD} y={titleY - 16} primary={colors.primary} />
        )}

        <g transform={`translate(0 ${-lift})`}>
          <BandColumn
            x={PAD}
            label="好感"
            value={card.affinity}
            scale={AFFINITY}
            primary={colors.primary}
          />
          <BandColumn
            x={PAD + 194}
            label="信任"
            value={card.trust}
            scale={TRUST}
            primary={colors.primary}
          />
          <BandColumn
            x={PAD + 388}
            label="熟悉"
            value={card.familiarity}
            scale={FAMILIARITY}
            primary={colors.primary}
          />
        </g>

        {lines.map((l, i) => (
          <text
            key={i}
            x={PAD}
            y={QUOTE_Y - lift + i * QUOTE_STEP}
            fontSize={16}
            fill="rgba(255,255,255,0.86)"
          >
            {l}
          </text>
        ))}
        {fields.map((f, i) => (
          <text key={i} x={PAD} y={fieldsTop + i * FIELD_STEP} fontSize={15}>
            <tspan fill="rgba(255,255,255,0.6)" fontSize={13}>
              {wrap(f.label, 6, 1)[0]}
            </tspan>
            <tspan x={PAD + 84} fill="#f1f0f4">
              {wrap(f.text, 24, 1)[0]}
            </tspan>
          </text>
        ))}

        {avatar ? (
          <image
            href={avatar}
            x={PAD}
            y={802}
            width={36}
            height={36}
            clipPath={`url(#avatar-${id})`}
            preserveAspectRatio="xMidYMid slice"
          />
        ) : (
          <g>
            <circle cx={PAD + 18} cy={820} r={18} fill="rgba(255,255,255,0.14)" />
            <text
              x={PAD + 18}
              y={826}
              fontSize={16}
              fontWeight={600}
              textAnchor="middle"
              fill="#ffffff"
            >
              {initial}
            </text>
          </g>
        )}
        <text x={PAD + 48} y={816} fontSize={15} fontWeight={600} fill="#ffffff">
          {wrap(card.name, 16, 1)[0]}
        </text>
        <text x={PAD + 48} y={836} fontSize={12} fontFamily={MONO} fill="rgba(255,255,255,0.6)">
          {issuedDate(card.issued_at)} · {card.serial}
        </text>

        <rect x={W - PAD - 104} y={742} width={104} height={104} rx={10} fill="#ffffff" />
        <Qr text={verifyUrl} x={W - PAD - 96} y={750} size={88} />
      </g>
      <Frame frame={card.frame} id={id} />
    </svg>
  );
});
