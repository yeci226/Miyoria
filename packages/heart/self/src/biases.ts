// How her feelings lean her behaviour (docs/design/v3-architecture.md §12): weighted offsets, not
// switches. Her turns and initiative read them; the Floor and the Arbiter keep the limits. Pure.
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
  PERSON_EMOTION_OUTPUTS,
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
  /** Who stirred them, when someone she cares about. */
  causes?: Partial<Record<EmotionName, Handle>>;
  drives: Drives;
  boredom: number;
  valence: number;
  /**
   * The people she cares about (the heart's 在意, at or above the threshold), most first, with how
   * much she misses each (the heart's longing, 0..1).
   */
  people: readonly { handle: Handle; longing: number }[];
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
  const closest = i.people[0] ?? null;
  const about = (want: EmotionWant, name: EmotionName): Handle | null => {
    if (want.toward === null) return null;
    const cause = i.causes?.[name];
    return cause ?? closest?.handle ?? null;
  };
  for (const name of EMOTION_NAMES) {
    const level = i.emotions[name] ?? 0;
    const want = EMOTION_OUTPUTS[name].want;
    if (want === null || level < BACKGROUND) continue;
    add(want.want, want.base + want.gain * level, about(want, name), want.why, name);
  }
  // Missing someone she cares about: the one she misses most (the heart's longing).
  const missing = PERSON_EMOTION_OUTPUTS.missing.want;
  let held: { handle: Handle; v: number } | null = null;
  for (const p of i.people)
    if (p.longing > (held?.v ?? 0)) held = { handle: p.handle, v: p.longing };
  if (missing !== null && held !== null) {
    add(
      missing.want,
      missing.base + missing.gain * held.v,
      held.handle,
      `想念${held.handle}`,
      "missing",
    );
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
