// How her feelings lean her behaviour (docs/design/v3-architecture.md §12): weighted offsets, not
// switches. Plan decides what she does; the Floor and the Arbiter keep the limits. Pure.
//
// What each emotion does is `EMOTION_OUTPUTS` (packages/types/src/affect-outputs.ts). Here the
// weights become numbers, with what her drives add:
//
// | play / boredom high           | wants a game; attention high + good mood: wants to stream |
// | rest high                     | wants to wind down, says less                            |
// | esteem high                   | wants to show what she can do                            |

import {
  type AffectBiases,
  type Drives,
  EMOTION_NAMES,
  EMOTION_OUTPUTS,
  type EmotionName,
  type EmotionOutputs,
  type EmotionWant,
  type Handle,
  PERSON_EMOTION_NAMES,
  PERSON_EMOTION_OUTPUTS,
  type PersonCard,
} from "@miyoria/types";

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const above = (v: number, level: number) => (v > level ? (v - level) / (1 - level) : 0);

/** Most a bias moves talkativeness / initiative. */
export const MAX_BIAS = 0.4;
/** Wishes lighter than this are not listed. */
export const MIN_WANT = 0.25;
/** Below this an emotion is background (a tsundere's pride sits at 0.12 and leans nothing). */
const BACKGROUND = 0.15;

export interface BiasInputs {
  /** Emotion intensities now (absent = 0). */
  emotions: Partial<Record<EmotionName, number>>;
  /** Who stirred them, when someone with a card. */
  causes?: Partial<Record<EmotionName, Handle>>;
  drives: Drives;
  boredom: number;
  valence: number;
  /** People by attachment, highest first. */
  cards: readonly Pick<PersonCard, "handle" | "attachment" | "emotions" | "blocked">[];
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** The strongest pull up plus the strongest pull down of one weight of the table. */
function lean(i: BiasInputs, weight: (row: EmotionOutputs) => number): number {
  let up = 0;
  let down = 0;
  for (const name of EMOTION_NAMES) {
    const pull = weight(EMOTION_OUTPUTS[name]) * above(i.emotions[name] ?? 0, BACKGROUND);
    up = Math.max(up, pull);
    down = Math.min(down, pull);
  }
  return up + down;
}

/** The weighted biases her feelings imply. */
export function computeBiases(i: BiasInputs): AffectBiases {
  const tired = above(i.drives.rest, 0.6);
  const talkativeness = clamp(lean(i, (r) => r.talk) - 0.25 * tired, -MAX_BIAS, MAX_BIAS);
  const initiative = clamp(lean(i, (r) => r.initiative) - 0.2 * tired, -MAX_BIAS, MAX_BIAS);

  const wants = new Map<string, AffectBiases["wants"][number]>();
  const add = (
    want: string,
    weight: number,
    person: Handle | null,
    why: string,
    from?: EmotionName,
  ) => {
    const w = clamp(weight, 0, 1);
    if (w < MIN_WANT) return;
    const key = `${want}|${person ?? ""}`;
    const stronger = wants.get(key);
    if (stronger && stronger.weight >= w) return;
    wants.set(key, {
      want,
      weight: round(w),
      person,
      why,
      ...(from === undefined ? {} : { from }),
    });
  };
  const closest = i.cards.find((c) => !c.blocked && c.attachment > 0) ?? null;
  const about = (want: EmotionWant, name: EmotionName): Handle | null => {
    if (want.toward === null) return null;
    const cause = i.causes?.[name];
    const named = cause === undefined ? undefined : i.cards.find((c) => c.handle === cause);
    return named && !named.blocked ? named.handle : (closest?.handle ?? null);
  };
  for (const name of EMOTION_NAMES) {
    const level = i.emotions[name] ?? 0;
    const want = EMOTION_OUTPUTS[name].want;
    if (want === null || level < BACKGROUND) continue;
    add(want.want, want.base + want.gain * level, about(want, name), want.why, name);
  }
  // A feeling toward someone in particular: the person it is strongest for.
  for (const name of PERSON_EMOTION_NAMES) {
    const want = PERSON_EMOTION_OUTPUTS[name].want;
    if (want === null) continue;
    let held: { handle: Handle; v: number } | null = null;
    for (const c of i.cards) {
      const v = c.emotions[name] ?? 0;
      if (!c.blocked && v > (held?.v ?? 0)) held = { handle: c.handle, v };
    }
    if (held === null) continue;
    const why = name === "missing" ? `想念${held.handle}` : want.why;
    add(want.want, want.base + want.gain * held.v, held.handle, why, name as EmotionName);
  }
  const play = Math.max(i.drives.play, above(i.boredom, 0.3));
  if (play > 0.4) add("play", 0.25 + above(play, 0.4), null, "想玩遊戲、有點無聊");
  // Wanting attention and in a good mood: wants to go live.
  const stream = i.drives.attention * (i.valence > 0.2 ? 1 : 0.5);
  if (stream > 0.4) add("stream", 0.25 + above(stream, 0.4), null, "想被注意、心情不錯就想開台");
  if (i.drives.rest > 0.4) add("rest", 0.25 + above(i.drives.rest, 0.4), null, "累了,想收台休息");
  if (i.drives.esteem > 0.4) add("sing", 0.25 + above(i.drives.esteem, 0.4), null, "想表現一下");
  const real = [...wants.values()];
  real.sort((a, b) => b.weight - a.weight || (a.want < b.want ? -1 : 1));
  return { talkativeness: round(talkativeness), initiative: round(initiative), wants: real };
}

/** The biases of a snapshot-like state (for the panel). */
export function describeBiases(b: AffectBiases): string {
  const parts: string[] = [];
  if (Math.abs(b.talkativeness) >= 0.05) {
    parts.push(`話量 ${b.talkativeness > 0 ? "+" : ""}${b.talkativeness.toFixed(2)}`);
  }
  if (Math.abs(b.initiative) >= 0.05) {
    parts.push(`主動 ${b.initiative > 0 ? "+" : ""}${b.initiative.toFixed(2)}`);
  }
  for (const w of b.wants.slice(0, 3)) {
    parts.push(`${w.want}${w.person ? `(${w.person})` : ""} ${w.weight.toFixed(2)}`);
  }
  return parts.join("、");
}
