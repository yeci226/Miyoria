// The fortune slip she writes (今日籤詩), printed the way a temple slip is: cream paper, a vermilion
// double border, the rank stamped in a block at the head, the title and the four lines of the poem
// in ruled columns read right to left, her fields in a ruled table, a line of her own and a seal.
// The same SVG is on the page and in the PNG they download, so colours are literals and nothing in
// it leans on the page.

import { Download } from "lucide-react";
import { forwardRef, useRef, useState } from "react";
import type { FortuneField, IssuedFortune } from "@/api/types";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

const W = 420;
const H = 860;
/** Brush script for everything written on the slip; a serif where no Kai face is installed. */
const KAI = '"DFKai-SB", "標楷體", "BiauKai", "Kaiti TC", "STKaiti", "KaiTi", "Noto Serif TC", "Songti TC", serif';
const LATIN = '"Geist Variable", "Segoe UI", sans-serif';
/** Paper, the vermilion it is printed in, and the ink it is written in. */
const PAPER = "#f3ead6";
const VERMILION = "#bf3326";
const INK = "#2b241c";
/** Inner edge of the printed border; everything sits inside it. */
const EDGE = 24;

/** The six ranks, best first (`packages/api/src/fortune.ts`). */
export const FORTUNE_RANKS = ["大吉", "吉", "中吉", "小吉", "末吉", "凶"] as const;

/** What the Core limits, repeated so a long text cannot break the slip. */
const MAX_TITLE = 8;
const MAX_POEM_LINE = 7;
const MAX_FIELDS = 3;

const cut = (text: string, max: number) => [...text.trim()].slice(0, max).join("");

/** The block the rank is stamped in: deep vermilion for 大吉, vermilion, then brick, and ink for 凶. */
export function rankInk(rank: string): string {
  switch (rank) {
    case "大吉":
      return "#a81f17";
    case "吉":
    case "中吉":
      return VERMILION;
    case "凶":
      return "#2f2b36";
    default:
      return "#a8573f";
  }
}

const DIGITS = "〇一二三四五六七八九";

/** `2026-11-08` as it is printed on a slip: 二〇二六年十一月八日. */
export function slipDate(date: string): string {
  const [y = "", m = "", d = ""] = date.split("-");
  const small = (n: number) =>
    n < 10 ? (DIGITS[n] ?? "") : `${n >= 20 ? DIGITS[Math.floor(n / 10)] : ""}十${n % 10 ? DIGITS[n % 10] : ""}`;
  const year = [...y].map((c) => DIGITS[Number(c)] ?? c).join("");
  return `${year}年${small(Number(m))}月${small(Number(d))}日`;
}

/** CJK runs about one em per character, Latin about half: enough to break lines by hand. */
function wrap(text: string, em: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  let width = 0;
  for (const ch of text.replace(/\s+/g, " ").trim()) {
    const w = /[\u0000-ɏ]/.test(ch) ? 0.55 : 1;
    if (width + w > em) {
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

/** One character per line, top to bottom, centred on `x`. */
function Vertical({
  text,
  x,
  y,
  size,
  step,
  fill,
  weight = 400,
  opacity = 1,
}: {
  text: string;
  x: number;
  y: number;
  size: number;
  step: number;
  fill: string;
  weight?: number;
  opacity?: number;
}) {
  return (
    <g fontSize={size} fontWeight={weight} fill={fill} opacity={opacity} textAnchor="middle">
      {[...text].map((ch, i) => (
        <text key={i} x={x} y={y + i * step}>
          {ch}
        </text>
      ))}
    </g>
  );
}

const dotted = (date: string) => date.replace(/-/g, ".");

export interface FortuneFaceProps {
  fortune: IssuedFortune;
  className?: string;
}

/** Short fibres for one 64 px tile of paper: x, y, length, angle. */
const FIBRES: [number, number, number, number][] = [
  [6, 9, 7, 20],
  [30, 4, 5, -35],
  [50, 14, 9, 70],
  [14, 30, 6, -10],
  [40, 34, 8, 40],
  [58, 46, 5, -60],
  [8, 52, 9, 85],
  [27, 58, 6, 15],
  [46, 60, 4, -20],
  [22, 18, 3, 50],
];

/** Column centres, right to left: the title, then the four lines of the poem. */
const COLUMN_W = (W - EDGE * 2) / 5;
const COLUMNS_RIGHT = W - EDGE;
const columnX = (i: number) => COLUMNS_RIGHT - COLUMN_W / 2 - i * COLUMN_W;
const BODY_TOP = 200;
const BODY_BOTTOM = 520;

/** The slip. `ref` reaches the `<svg>`, for turning it into a PNG. */
export const FortuneFace = forwardRef<SVGSVGElement, FortuneFaceProps>(function FortuneFace(
  { fortune, className },
  ref,
) {
  const id = fortune.id.replace(/[^A-Za-z0-9]/g, "").slice(-12) || "slip";
  const block = rankInk(fortune.rank);
  const title = cut(fortune.title, MAX_TITLE);
  const poem = fortune.poem.slice(0, 4).map((l) => cut(l, MAX_POEM_LINE));
  const fields: FortuneField[] = fortune.fields.slice(0, MAX_FIELDS);
  const line = fortune.line ? wrap(`「${fortune.line}」`, 16, 3) : [];
  const label = [
    `${dotted(fortune.date)} 今日籤`,
    `${fortune.rank}「${title}」`,
    poem.join(","),
    ...fields.map((f) => `${f.label}:${f.text}`),
    fortune.line ? `她說「${fortune.line}」` : null,
  ]
    .filter((s): s is string => s !== null && s !== "")
    .join(",");
  const rankChars = [...fortune.rank];
  const rankSize = 54;
  const blockW = rankChars.length * (rankSize + 10) + 34;
  const titleStep = [...title].length > 6 ? 34 : 40;
  const fieldsTop = 556;
  const lineTop = fieldsTop + fields.length * 40 + (fields.length > 0 ? 44 : 4);
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
      fontFamily={KAI}
    >
      <defs>
        <clipPath id={`clip-${id}`}>
          <rect width={W} height={H} rx={6} />
        </clipPath>
        <radialGradient id={`age-${id}`} cx="0.5" cy="0.45" r="0.75">
          <stop offset="0.55" stopColor="#8a6a3a" stopOpacity="0" />
          <stop offset="1" stopColor="#8a6a3a" stopOpacity="0.2" />
        </radialGradient>
        <pattern id={`fibre-${id}`} width="64" height="64" patternUnits="userSpaceOnUse">
          {FIBRES.map(([x, y, l, a]) => (
            <path
              key={`${x}-${y}`}
              d={`M${x} ${y}l${(l * Math.cos((a * Math.PI) / 180)).toFixed(2)} ${(l * Math.sin((a * Math.PI) / 180)).toFixed(2)}`}
              stroke="#9c8358"
              strokeWidth={0.6}
              strokeLinecap="round"
            />
          ))}
        </pattern>
      </defs>
      <g clipPath={`url(#clip-${id})`}>
        <rect width={W} height={H} fill={PAPER} />
        <rect width={W} height={H} fill={`url(#fibre-${id})`} opacity={0.35} />
        <rect width={W} height={H} fill={`url(#age-${id})`} />

        {/* the printed border: a heavy rule and a hairline inside it */}
        <rect x={16} y={16} width={W - 32} height={H - 32} fill="none" stroke={VERMILION} strokeWidth={2.6} />
        <rect x={EDGE - 2} y={EDGE - 2} width={W - (EDGE - 2) * 2} height={H - (EDGE - 2) * 2} fill="none" stroke={VERMILION} strokeWidth={0.9} />

        {/* head: what the slip is and its day */}
        <text x={W / 2} y={62} fontSize={22} letterSpacing={12} textAnchor="middle" fill={VERMILION}>
          今日籤詩
        </text>
        <text x={W / 2} y={86} fontSize={13} letterSpacing={2} textAnchor="middle" fill={INK} opacity={0.75}>
          {slipDate(fortune.date)}
        </text>

        {/* the rank, stamped in its block */}
        <rect x={(W - blockW) / 2} y={102} width={blockW} height={78} fill={block} />
        <rect x={(W - blockW) / 2 + 4} y={106} width={blockW - 8} height={70} fill="none" stroke={PAPER} strokeOpacity={0.55} strokeWidth={0.8} />
        {rankChars.map((ch, i) => (
          <text
            key={i}
            x={W / 2 + (i - (rankChars.length - 1) / 2) * (rankSize + 10)}
            y={160}
            fontSize={rankSize}
            textAnchor="middle"
            fill={PAPER}
          >
            {ch}
          </text>
        ))}

        {/* the ruled body: title and poem in columns, read right to left */}
        <line x1={EDGE} x2={W - EDGE} y1={BODY_TOP} y2={BODY_TOP} stroke={VERMILION} strokeWidth={1.4} />
        <line x1={EDGE} x2={W - EDGE} y1={BODY_TOP + 4} y2={BODY_TOP + 4} stroke={VERMILION} strokeWidth={0.6} />
        {[1, 2, 3, 4].map((i) => (
          <line
            key={i}
            x1={COLUMNS_RIGHT - i * COLUMN_W}
            x2={COLUMNS_RIGHT - i * COLUMN_W}
            y1={BODY_TOP + 4}
            y2={BODY_BOTTOM}
            stroke={VERMILION}
            strokeOpacity={i === 1 ? 0.9 : 0.45}
            strokeWidth={i === 1 ? 1.1 : 0.7}
          />
        ))}
        <Vertical text={title} x={columnX(0)} y={BODY_TOP + 46} size={28} step={titleStep} fill={VERMILION} />
        {poem.map((l, i) => (
          <Vertical key={i} text={l} x={columnX(i + 1)} y={BODY_TOP + 46} size={27} step={42} fill={INK} />
        ))}
        <line x1={EDGE} x2={W - EDGE} y1={BODY_BOTTOM} y2={BODY_BOTTOM} stroke={VERMILION} strokeWidth={0.6} />
        <line x1={EDGE} x2={W - EDGE} y1={BODY_BOTTOM + 4} y2={BODY_BOTTOM + 4} stroke={VERMILION} strokeWidth={1.4} />

        {/* her fields, a ruled table */}
        {fields.map((f, i) => {
          const y = fieldsTop + i * 40;
          return (
            <g key={i}>
              <text x={48} y={y + 24} fontSize={16}>
                <tspan fill={VERMILION}>{cut(f.label, 4)}</tspan>
                <tspan x={124} fill={INK}>
                  {wrap(f.text, 15, 1)[0]}
                </tspan>
              </text>
              <line x1={112} x2={112} y1={y + 4} y2={y + 36} stroke={VERMILION} strokeOpacity={0.45} strokeWidth={0.7} />
              <line x1={40} x2={W - 40} y1={y + 40} y2={y + 40} stroke={VERMILION} strokeOpacity={0.35} strokeWidth={0.7} strokeDasharray="2 3" />
            </g>
          );
        })}

        {/* a line of her own */}
        {line.map((l, i) => (
          <text key={i} x={48} y={lineTop + i * 28} fontSize={18} fill={INK}>
            {l}
          </text>
        ))}

        {/* the seal, pressed at a slight tilt, and her name */}
        <g transform={`translate(${W - 76} ${H - 84}) rotate(-5)`}>
          <rect x={-26} y={-26} width={52} height={52} rx={3} fill={VERMILION} opacity={0.92} />
          <rect x={-22} y={-22} width={44} height={44} rx={1.5} fill="none" stroke={PAPER} strokeWidth={1.2} opacity={0.85} />
          <text y={11} fontSize={30} textAnchor="middle" fill={PAPER}>
            籤
          </text>
        </g>
        <text x={48} y={H - 64} fontSize={11} fontFamily={LATIN} letterSpacing={5} fill={INK} opacity={0.6}>
          MIYORIA
        </text>
      </g>
    </svg>
  );
});

/** The slip as a PNG, twice its size: what is downloaded and shared. */
export async function fortunePng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
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

export const fortuneFileName = (f: IssuedFortune) => `miyoria-fortune-${f.date}.png`;

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A slip with a button to download it as a picture. */
export function FortuneSlip({ fortune, className }: { fortune: IssuedFortune; className?: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (!svg.current) return;
    setBusy(true);
    try {
      save(await fortunePng(svg.current), fortuneFileName(fortune));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : "沒辦法產生圖片");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <FortuneFace ref={svg} fortune={fortune} className="h-auto w-full max-w-[360px] rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.45)]" />
      <Button variant="outline" busy={busy} onClick={() => void download()}>
        <Download aria-hidden />
        下載
      </Button>
    </div>
  );
}
