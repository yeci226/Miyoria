// What each emotion does (docs/design/v3-architecture.md §12): an emotion is only worth keeping if
// something consumes it. This is the one table of that, to be read and tuned here:
//
// * `tag`: the `<emo:…>` she shows it as when nothing masks it. The Stage poses her face with it
//   (`affect.changed`, packages/stage/src/link/forward.ts) and a line with no tag of its own is
//   said in it (`VoiceSink`).
// * `voice`: the clips of the TTS voice bank that fit, best first (`VoiceProfile.referenceFor`).
//   Emotions that share a `tag` share this: a line carries the tag, not the emotion. The worker
//   ends the chain: a clip it does not have is `neutral`, then the plain reference.
// * `talk`: how much of her own unasked lines she wants, on the Floor budget.
// * `initiative`: how soon she thinks about what to do next (Plan's heartbeat).
// * `want`: what she wants to do because of it, on Plan's list of things she might do.
//
// `talk` and `initiative` are weights per unit of intensity, and the strongest up and the strongest
// down of each count, not their sum: one feeling never adds up with another into a flood. What
// they become is `computeBiases` (packages/self/src/biases.ts), bounded by its `MAX_BIAS` and by
// the Floor's own limits. Display rules may hide an emotion's `tag` (packages/self/src/display.ts):
// that is what she shows, and what she feels still moves `talk`, `initiative` and `want`.
//
// None of this touches a rule: emotions change how she speaks and what she wants, never what she
// may do. Nothing here reaches Directive, the Floor's interrupt levels or the claim gate
// (packages/core/test/emotion-guardrails.test.ts).

import type { EmotionName, PersonEmotionName } from "./self.js";

/** What she wants to do because of a feeling. */
export interface EmotionWant {
  /** The wish on Plan's list (`chat_with`, `find_person`, `play`, `sing`, `explore`). */
  want: string;
  /** Weight of the wish: `base` plus `gain` per unit of intensity. */
  base: number;
  gain: number;
  /** Who it is about: who stirred it (else the person closest to her), or that person. */
  toward: "cause" | "closest" | null;
  /** Why, in her words. */
  why: string;
}

export interface EmotionOutputs {
  tag: string;
  voice: readonly string[];
  talk: number;
  initiative: number;
  want: EmotionWant | null;
}

const wish = (want: string, base: number, gain: number, why: string): EmotionWant => ({
  want,
  base,
  gain,
  toward: null,
  why,
});
const chat = (toward: "cause" | "closest", gain: number, why: string): EmotionWant => ({
  want: "chat_with",
  base: 0,
  gain,
  toward,
  why,
});

/** `surprised` has no clip in the bank she was designed with: the nearest one until it has. */
const STARTLED = ["surprised", "embarrassed"] as const;

export const EMOTION_OUTPUTS: Readonly<Record<EmotionName, EmotionOutputs>> = {
  joy: {
    tag: "happy",
    voice: ["happy"],
    talk: 0.6,
    initiative: 0.5,
    want: wish("sing", 0.15, 0.9, "想表現一下"),
  },
  anger: {
    tag: "angry",
    voice: ["angry"],
    talk: -0.2,
    initiative: -0.2,
    want: wish("play", 0, 0.6, "有氣想發洩"),
  },
  sorrow: {
    tag: "sad",
    voice: ["sad"],
    talk: -0.6,
    initiative: -0.6,
    want: chat("closest", 0.8, "難過,想有人陪"),
  },
  fear: {
    tag: "surprised",
    voice: STARTLED,
    talk: -0.3,
    initiative: -0.4,
    want: chat("closest", 0.7, "害怕,想有人在"),
  },
  surprise: { tag: "surprised", voice: STARTLED, talk: 0.2, initiative: 0, want: null },
  disgust: {
    tag: "annoyed",
    voice: ["annoyed"],
    talk: -0.3,
    initiative: -0.3,
    want: wish("explore", 0, 0.6, "想換件事做"),
  },
  shy: { tag: "embarrassed", voice: ["embarrassed"], talk: -0.25, initiative: -0.2, want: null },
  pride: {
    tag: "smug",
    voice: ["smug"],
    talk: 0.6,
    initiative: 0.5,
    want: wish("sing", 0.15, 0.9, "想表現一下"),
  },
  jealousy: {
    tag: "annoyed",
    voice: ["annoyed"],
    talk: -0.15,
    initiative: 0.1,
    want: chat("cause", 0.8, "在意對方,想讓對方看過來"),
  },
  lonely: {
    tag: "sad",
    voice: ["sad"],
    talk: 0,
    initiative: 0.1,
    want: chat("closest", 1, "寂寞,想找人聊天"),
  },
  missing: {
    tag: "sad",
    voice: ["sad"],
    talk: -0.1,
    initiative: 0.1,
    want: { want: "find_person", base: 0.15, gain: 1, toward: "cause", why: "想念對方" },
  },
  gratitude: {
    tag: "happy",
    voice: ["happy"],
    talk: 0.2,
    initiative: 0.2,
    want: chat("cause", 0.7, "想跟對方道謝"),
  },
  guilt: {
    tag: "embarrassed",
    voice: ["embarrassed"],
    talk: -0.2,
    initiative: 0.1,
    want: chat("cause", 0.7, "過意不去,想補償"),
  },
  frustration: {
    tag: "angry",
    voice: ["angry"],
    talk: -0.6,
    initiative: -0.6,
    want: wish("play", 0, 0.7, "不甘心,想再來一次"),
  },
};

/** What a feeling toward one person does. */
export interface PersonEmotionOutputs {
  /** What she wants to do about them (`toward` and `why` as in `EmotionWant`). */
  want: EmotionWant | null;
  /** How much of any wish about them it takes away per unit of intensity (0..1). */
  distance: number;
}

export const PERSON_EMOTION_OUTPUTS: Readonly<Record<PersonEmotionName, PersonEmotionOutputs>> = {
  missing: { want: EMOTION_OUTPUTS.missing.want, distance: 0 },
  jealousy: { want: EMOTION_OUTPUTS.jealousy.want, distance: 0 },
  gratitude: { want: EMOTION_OUTPUTS.gratitude.want, distance: 0 },
  resentment: { want: null, distance: 0.7 },
};

/**
 * The clips that fit a line said in `tag` (or written with an emotion's own name), best first.
 * A tag no emotion shows as (`neutral`, `thinking`) is its own and only clip.
 */
export function voiceClips(tag: string): readonly string[] {
  const name = tag.trim().toLowerCase();
  const own = Object.hasOwn(EMOTION_OUTPUTS, name)
    ? EMOTION_OUTPUTS[name as EmotionName]
    : Object.values(EMOTION_OUTPUTS).find((row) => row.tag === name);
  return own?.voice ?? [name];
}
