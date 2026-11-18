// One line of words per part of a result, from its numbers. The same shape comes from Core
// (`KaraokeResult`) and from the browser's own score (`ScoreResult`), so both read alike.

import type { KaraokeResult } from "@miyoria/contracts/api";
import type { ScoreResult } from "@miyoria/play/karaoke/score";

/** A scored singing as the screens read it: Core's result or the browser's own. */
export type Scored = Pick<
  ScoreResult,
  "total" | "pitch" | "stability" | "rhythm" | "expression" | "facts"
> & {
  /** Core's phrases carry the lyric line (`null` without); the browser's do not. */
  phrases: (ScoreResult["phrases"][number] & { text?: string | null })[];
};

/** Core's result in that shape: the same `scoreSinging` numbers, with the lyric lines. */
export function coreScored(r: KaraokeResult): Scored {
  return r;
}

type Parts = Pick<Scored, "pitch" | "stability" | "rhythm" | "expression"> & {
  facts: Pick<Scored["facts"], "octave" | "offset_cents" | "coverage">;
};

export const PART_NAMES = {
  pitch: "音程",
  stability: "安定",
  rhythm: "節奏",
  expression: "表現",
} as const;

export const pct = (x: number) => `${Math.round(x * 100)}%`;

export function pitchLine(r: Parts): string {
  const out = [`命中 ${pct(r.pitch.hit)}`];
  const off = r.facts.offset_cents;
  if (off !== null && Math.abs(off) >= 15) {
    out.push(`整體偏${off < 0 ? "低" : "高"}約 ${Math.abs(off)} cents`);
  }
  if (r.facts.octave < 0) out.push(`低${octaves(r.facts.octave)}唱`);
  if (r.facts.octave > 0) out.push(`高${octaves(r.facts.octave)}唱`);
  return out.join(",");
}

const octaves = (n: number) => (Math.abs(n) === 1 ? "一個八度" : `${Math.abs(n)} 個八度`);

export function stabilityLine(r: Parts): string {
  const { wobble_cents: wobble, held } = r.stability;
  if (held === 0) return "這首沒有要拉住的長音";
  if (wobble === null) return "長音沒有唱到";
  return `長音平均晃動 ${Math.round(wobble)} cents(${held} 段)`;
}

export function rhythmLine(r: Parts): string {
  const x = r.rhythm;
  if (!x.calibrated) return "沒有校正延遲,節奏照音程給分";
  if (!x.measured || x.offset_ms === null) return "抓到的起音太少,節奏照音程給分";
  const ms = Math.abs(x.offset_ms);
  if (x.feel === "late") return `整體偏慢約 ${ms} ms`;
  if (x.feel === "early") return `整體偏快約 ${ms} ms`;
  return `拍子很準,平均差 ${ms} ms`;
}

export function expressionLine(r: Parts): string {
  const e = r.expression;
  const out: string[] = [];
  if (e.vibrato_s >= 0.1) out.push(`顫音 ${e.vibrato_s.toFixed(1)} 秒`);
  if (e.long_tones > 0) out.push(`長音 ${e.long_tones} 個`);
  if (e.scoops > 0) out.push(`往上滑進 ${e.scoops} 次`);
  if (e.falls > 0) out.push(`尾音下滑 ${e.falls} 次`);
  return out.length > 0 ? out.join(" · ") : "沒有抓到顫音或長音";
}

export interface PartLine {
  key: keyof typeof PART_NAMES;
  name: string;
  score: number;
  max: number;
  line: string;
}

const LINES: Record<keyof typeof PART_NAMES, (r: Parts) => string> = {
  pitch: pitchLine,
  stability: stabilityLine,
  rhythm: rhythmLine,
  expression: expressionLine,
};

/** The four parts in order, with their line. */
export function partLines(r: Parts): PartLine[] {
  return (Object.keys(PART_NAMES) as (keyof typeof PART_NAMES)[]).map((key) => ({
    key,
    name: PART_NAMES[key],
    score: r[key].score,
    max: r[key].max,
    line: LINES[key](r),
  }));
}

// ---- the official score ----------------------------------------------------------------------

/** What a check of the recording found, said to the singer. */
export const CHECK_LINES: Record<KaraokeResult["voice"]["checks"][number], string> = {
  quiet: "收到的聲音很小,分數可能不準",
  bleed: "間奏也收到了音高,可能是喇叭的伴奏,請戴耳機",
};

export interface VoiceView {
  /** Over the total: 「正式分數」 once the recording was scored, else 「預估」. */
  label: "正式分數" | "預估";
  /** The official score is being worked out (a dot and a line say so). */
  pending: boolean;
  /** One short line about the official score, or `null`. */
  note: string | null;
  /** The earlier estimate, shown small beside an official score. */
  estimate: number | null;
  /** What the checks found, in words. */
  checks: string[];
}

/**
 * How a result reads as to where its number came from. `uploadFailed`: this browser could not send
 * the recording; `waitedOut`: the official score was looked for long enough.
 */
export function voiceView(
  r: Pick<KaraokeResult, "source" | "voice">,
  o: { uploadFailed?: boolean; waitedOut?: boolean } = {},
): VoiceView {
  const checks = r.voice.checks.map((c) => CHECK_LINES[c]).filter(Boolean);
  if (r.source === "voice") {
    return { label: "正式分數", pending: false, note: null, estimate: r.voice.estimate_total, checks };
  }
  const state = r.voice.state;
  if (state === "failed" || ((state === "waiting" || state === "scoring") && o.uploadFailed)) {
    return { label: "預估", pending: false, note: "正式分數沒有算成,這次以預估為準", estimate: null, checks };
  }
  if (state === "waiting" || state === "scoring") {
    if (o.waitedOut) return { label: "預估", pending: false, note: "正式分數還沒算好,晚點回來看看", estimate: null, checks };
    return { label: "預估", pending: true, note: "正在算正式分數", estimate: null, checks };
  }
  return { label: "預估", pending: false, note: null, estimate: null, checks };
}

/** `3:05` */
export function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A total as it is shown: one decimal. */
export const score1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
