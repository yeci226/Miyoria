// Pure helpers of the affect layer that more than one package needs (docs/design/v2-architecture.md
// §3.6): the time-of-day energy curve, the mood derived from drives + emotions + that curve,
// and the one renderer of mood and of people for prompts.
//
// Mood is not stored: `deriveMood` is its only definition. The renderers are the canonical ones:
// the prompt compiler (`agent`) and the legacy `mood` contributor use them instead of keeping
// their own thresholds.

import type { AffectSnapshot, PersonCard } from "./affect.js";
import type { Affect, Drives, EmotionReading } from "./self.js";
import { EMOTION_LABELS } from "./self.js";
import type { Mood } from "./social.js";

/**
 * Bus topic of a bond change the affect module applied to the numbers the social module owns
 * (`AffectBondPayload`); the social module applies it (capped, small) to the relationship.
 */
export const AFFECT_BOND_TOPIC = "affect.bond";

/** Payload of `AFFECT_BOND_TOPIC`. */
export interface AffectBondPayload {
  person: string;
  affinity: number;
  trust: number;
  familiarity: number;
  why: string;
}

/** Sleepiness per local hour (0 = awake, 1 = deepest night), interpolated. */
const NIGHT_SHAPE = [
  0.5, 0.7, 0.85, 0.95, 1.0, 0.9, 0.65, 0.35, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.05, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.1, 0.2, 0.35,
] as const;

function shapeAt(i: number): number {
  return NIGHT_SHAPE[((i % 24) + 24) % 24] ?? 0;
}

/** Sleepiness at a fractional local hour (0..24). */
export function nightShape(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const i = Math.floor(h);
  const frac = h - i;
  const cur = shapeAt(i);
  return cur + (shapeAt(i + 1) - cur) * frac;
}

const clamp = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : Math.max(lo, 0);

/** Her local hour (0..24) at `nowMs`. */
export function localHour(nowMs: number, utcOffsetMinutes: number): number {
  const offset = Math.abs(utcOffsetMinutes) < 24 * 60 ? utcOffsetMinutes : 0;
  const minuteOfDay = ((Math.floor((nowMs + offset * 60_000) / 60_000) % 1440) + 1440) % 1440;
  return minuteOfDay / 60;
}

/** Energy by the clock alone: the baseline lowered by the night's sleepiness (0..1). */
export function circadianEnergy(
  baselineEnergy: number,
  nowMs: number,
  utcOffsetMinutes: number,
  nightDip: number,
): number {
  const dip = clamp(nightDip, 0, 1) * nightShape(localHour(nowMs, utcOffsetMinutes));
  return clamp(baselineEnergy * (1 - dip), 0, 1);
}

/** What `deriveMood` reads. */
export interface MoodInputs {
  /** The profile's resting mood. */
  baseline: Mood;
  /** Offsets her emotions push toward (`SelfState.affect`). */
  emotions: Affect;
  drives: Drives;
  /** 0..1 */
  boredom: number;
  nowMs: number;
  utcOffsetMinutes: number;
  /** How much energy drops at the deepest point of the night (0..1). */
  nightDip: number;
  /** How much her emotions move the mood (0 = only baseline, rhythm and drives). */
  emotionWeight: number;
}

const above = (v: number, level: number) => (v > level ? (v - level) / (1 - level) : 0);

/**
 * The mood from the three layers: the baseline shaped by the time of day, plus what her
 * emotions push toward, minus what unmet drives weigh. The same inputs always give the same
 * mood; nothing is stored or nudged.
 */
export function deriveMood(i: MoodInputs): Mood {
  const dip = clamp(i.nightDip, 0, 1) * nightShape(localHour(i.nowMs, i.utcOffsetMinutes));
  const w = Math.max(i.emotionWeight, 0);
  const circadian = clamp(i.baseline.energy * (1 - dip), 0, 1);
  // Unmet wants (company, being noticed, acknowledged, fed) weigh on her.
  const d = i.drives;
  const wanting = Math.max(
    above(d.social, 0.6),
    above(d.attention, 0.6),
    above(d.esteem, 0.6),
    above(d.hunger, 0.6),
  );
  const bored = above(i.boredom, 0.6);
  // Tiredness beyond what the hour explains (a small margin is just the day's wear).
  const extraRest = Math.max(d.rest - (1 - circadian) - 0.15, 0);
  return {
    valence: clamp(
      i.baseline.valence + i.emotions.valence * w - 0.25 * wanting - 0.1 * bored,
      -1,
      1,
    ),
    arousal: clamp(
      i.baseline.arousal * (1 - 0.5 * dip) + i.emotions.arousal * w + 0.1 * wanting,
      0,
      1,
    ),
    energy: clamp(circadian + i.emotions.energy * w - 0.35 * extraRest, 0, 1),
  };
}

/** One line about the mood (`"心情不錯、有點累"`): the only place its thresholds live. */
export function moodLine(m: Mood): string {
  let v: string;
  if (m.valence >= 0.5) v = "心情很好";
  else if (m.valence >= 0.2) v = "心情不錯";
  else if (m.valence > -0.2) v = "心情普通";
  else if (m.valence > -0.5) v = "有點不爽";
  else v = "心情很差";
  let e: string;
  if (m.energy < 0.3) e = "很睏";
  else if (m.energy < 0.5) e = "有點累";
  else if (m.energy > 0.85) e = "精神很好";
  else e = "精神還可以";
  let a = "";
  if (m.arousal > 0.75) a = "、情緒有點激動";
  else if (m.arousal < 0.25) a = "、很平靜";
  return `${v}、${e}${a}`;
}

/** How strong an emotion reads in words (no numbers in prompts). */
export function intensityWord(v: number): string {
  if (v >= 0.65) return "強";
  if (v >= 0.4) return "中";
  return "淡";
}

/** `害羞(中)、喜(淡)`. */
export function emotionsLine(top: readonly EmotionReading[]): string {
  return top.map((e) => `${EMOTION_LABELS[e.name]}(${intensityWord(e.intensity)})`).join("、");
}

/**
 * The mood for a prompt: the one mood line and the strongest 2-3 emotions. `""` never: the
 * mood line is always there.
 */
export function renderAffectMood(snapshot: Pick<AffectSnapshot, "mood_line" | "top">): string {
  const lines = [`你現在${snapshot.mood_line}。`];
  if (snapshot.top.length > 0) {
    const first = snapshot.top[0];
    const why = first && first.cause !== "" ? `(最明顯的是因為:${first.cause})` : "";
    lines.push(`心裡比較明顯的感受:${emotionsLine(snapshot.top)}${why}。`);
  }
  return lines.join("\n");
}

const MAX_FEELING_LINE = 80;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

/**
 * One line for a person: `- Owen:好朋友;她覺得他很可靠、有點在意`. The handle, the one-word
 * label of the shared scale and her feeling sentence (when she has one). The feeling is her
 * own text but about someone else's data: prompts put it in the data section.
 */
export function renderPersonLine(card: Pick<PersonCard, "handle" | "label" | "feeling">): string {
  const feeling = clip(card.feeling, MAX_FEELING_LINE);
  return feeling === ""
    ? `- ${card.handle}:${card.label}`
    : `- ${card.handle}:${card.label};${feeling}`;
}

/** One line per person, in the order given. */
export function renderPeople(cards: readonly Pick<PersonCard, "handle" | "label" | "feeling">[]) {
  return cards.map(renderPersonLine);
}
