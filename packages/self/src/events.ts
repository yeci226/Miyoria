// The rule-event table (docs/design/v2-architecture.md §3.6): cheap, immediate meanings of what
// happens to her. One table, no LLM: an event kind goes in, a list of effects comes out
// (which emotion, how strong; toward the person; being with someone). The strengths are the
// shared `APPRAISAL_STRENGTH` steps; the emotion engine turns them into numbers (her
// temperament's gain, habituation, inhibition, the budget).
//
// Appraisal (what an interaction meant, the LLM) is the other input; it does not come here.

import {
  type AffectEventKind,
  APPRAISAL_STRENGTH,
  type AppraisalStrength,
  type DriveName,
  type EmotionName,
  type PersonEmotionName,
} from "@miyoria/types";

/** One effect of an event. */
export type Effect =
  /** Stirs an emotion (`amount` > 0) or calms it (< 0). */
  | {
      type: "emotion";
      emotion: EmotionName;
      amount: number;
      /** Also stirs / calms this emotion toward the person involved. */
      toward?: PersonEmotionName;
      /** Amount toward the person when it differs from `amount`. */
      towardAmount?: number;
    }
  /** Only toward the person involved (not her own emotion). */
  | { type: "toward"; emotion: PersonEmotionName; amount: number }
  /** Being with someone: pushes loneliness down (by half of `amount`). */
  | { type: "companionship"; amount: number }
  /** Satisfies (< 0) or frustrates (> 0) a drive. */
  | { type: "drive"; drive: DriveName; amount: number };

/** What the rules know about the moment. */
export interface RuleContext {
  /** 0..1, how much she cares about the person involved (0 when nobody). */
  care: number;
  /** The person is her crush (the highest attachment). */
  crush: boolean;
  /** Her display rules hide soft feelings. */
  tsundere: boolean;
  /** How much she had been missing the person (0..1), before they came back. */
  missed: number;
  /** 0..1, how much a social event counts (the LLM's `scale` of warm / cold). */
  scale: number;
  /**
   * How much a `gift` eases her hunger, when the giver says (food it already counted); default
   * 0.3 × `scale`.
   */
  hunger?: number;
}

export const NO_CONTEXT: RuleContext = {
  care: 0,
  crush: false,
  tsundere: false,
  missed: 0,
  scale: 1,
};

const S = APPRAISAL_STRENGTH;
const emo = (emotion: EmotionName, amount: number, rest: Partial<Effect> = {}): Effect =>
  ({ type: "emotion", emotion, amount, ...rest }) as Effect;
const drive = (d: DriveName, amount: number): Effect => ({ type: "drive", drive: d, amount });
const pick = (strength: AppraisalStrength): number => S[strength];

/** The effects of a rule event kind (§3.6 table). */
export function eventEffects(kind: AffectEventKind, c: RuleContext): Effect[] {
  switch (kind) {
    case "praised": {
      const out: Effect[] = [emo("joy", S.medium), drive("esteem", -0.15)];
      // Praise from her crush flusters her; a tsundere blushes a little at anyone's.
      if (c.crush) out.push(emo("shy", S.medium));
      else if (c.tsundere) out.push(emo("shy", S.weak));
      return out;
    }
    case "cared_arrived": {
      // Joy from weak to medium by how much she cares (and how much she missed them).
      const joy: AppraisalStrength =
        c.missed >= 0.6 ? "strong" : c.care >= 0.6 || c.missed >= 0.2 ? "medium" : "weak";
      const out: Effect[] = [
        emo("joy", pick(joy)),
        { type: "toward", emotion: "missing", amount: -S.medium },
        { type: "companionship", amount: S.weak },
      ];
      if (c.crush) out.push(emo("shy", S.weak));
      return out;
    }
    case "topic_ignored":
      return [emo("lonely", S.weak), emo("frustration", S.weak)];
    case "song_finished":
      return [emo("pride", S.weak), drive("esteem", -0.25), drive("attention", -0.1)];
    case "song_applauded":
      return [emo("pride", S.medium), emo("joy", S.weak), drive("esteem", -0.15)];
    case "interrupted":
      return [emo("frustration", S.weak), drive("esteem", 0.05)];
    case "ignored":
      return [emo("frustration", S.weak)];
    case "cared_close_with_other": {
      const strength: AppraisalStrength = c.care >= 0.6 || c.crush ? "medium" : "weak";
      return [emo("jealousy", pick(strength), { toward: "jealousy" })];
    }
    case "task_succeeded":
      return [emo("pride", S.weak), emo("joy", S.weak), drive("esteem", -0.1)];
    case "task_failed":
      return [emo("frustration", S.weak)];
    case "game_won":
      return [emo("joy", S.medium), emo("pride", S.medium), drive("esteem", -0.2)];
    case "game_lost":
      return [emo("frustration", S.medium), emo("anger", S.weak), drive("esteem", 0.1)];
  }
}

/** Kinds of `social.event` (what someone did toward her) that are not praise. */
export type SocialKind =
  | "greeting"
  | "thanks"
  | "gift"
  | "friendly"
  | "apology"
  | "warm"
  | "cold"
  | "rude"
  | "insult"
  | "harassment"
  | "flirt_too_far";

/** The rule events `social.event` kinds become: `praise` is the `praised` event above. */
export function socialEffects(kind: string, c: RuleContext): Effect[] | null {
  const k = Math.min(Math.max(c.scale, 0), 1) || 1;
  const a = (strength: number) => strength * k;
  switch (kind) {
    case "greeting":
      return [emo("joy", a(S.weak))];
    case "thanks":
      return [
        emo("joy", a(S.medium)),
        emo("shy", a(S.weak)),
        emo("pride", a(S.weak)),
        { type: "toward", emotion: "gratitude", amount: a(S.weak) },
        drive("esteem", -0.05 * k),
      ];
    case "gift": {
      const out = [
        emo("joy", a(S.strong)),
        emo("gratitude", a(S.strong), { toward: "gratitude", towardAmount: a(S.strong) }),
      ];
      const fed = c.hunger ?? 0.3 * k;
      if (fed > 0) out.push(drive("hunger", -fed));
      return out;
    }
    case "friendly":
    case "warm":
      return [emo("joy", a(S.weak))];
    case "apology":
      return [
        emo("anger", -a(S.weak)),
        { type: "toward", emotion: "resentment", amount: -a(S.medium) },
      ];
    case "cold":
      return [
        emo("sorrow", a(S.weak)),
        { type: "toward", emotion: "resentment", amount: a(S.weak) },
      ];
    case "rude":
      return [
        emo("anger", a(S.medium)),
        { type: "toward", emotion: "resentment", amount: a(S.medium) },
      ];
    case "insult":
      return [
        emo("anger", a(S.strong)),
        emo("sorrow", a(S.weak)),
        { type: "toward", emotion: "resentment", amount: a(S.strong) },
        drive("esteem", 0.1 * k),
      ];
    case "harassment":
      return [
        emo("anger", a(S.strong)),
        emo("fear", a(S.medium)),
        emo("disgust", a(S.strong)),
        { type: "toward", emotion: "resentment", amount: a(S.strong) },
      ];
    case "flirt_too_far":
      return [
        emo("disgust", a(S.strong)),
        emo("anger", a(S.medium)),
        { type: "toward", emotion: "resentment", amount: a(S.medium) },
      ];
    // Her crush spoke to her.
    case "crush_spoke":
      return [emo("shy", a(S.weak))];
    // A promise to her kept or broken (read by the appraisal pass).
    case "promise_kept":
      return [emo("joy", a(S.weak)), { type: "toward", emotion: "gratitude", amount: a(S.medium) }];
    case "promise_broken":
      return [
        emo("sorrow", a(c.crush ? S.medium : S.weak)),
        { type: "toward", emotion: "resentment", amount: a(S.medium) },
      ];
    // A deal she kept her side of, and they did not pay (the economy's `broken_promise`).
    case "broken_promise":
      return [
        emo("anger", a(S.medium)),
        emo("sorrow", a(S.weak)),
        { type: "toward", emotion: "resentment", amount: a(S.strong) },
      ];
    // Her song was cut off (skipped or stopped); she does not know it was not about her singing.
    case "song_cut":
      return [emo("sorrow", a(S.weak)), emo("frustration", a(S.medium)), drive("esteem", 0.1)];
    // Her tokens were rationed (the LLM budget degraded).
    case "budget_rationed":
      return [emo("frustration", a(S.weak)), drive("hunger", 0.25)];
    default:
      return null;
  }
}

/**
 * How an absolute nudge from a game or an extension (`self.feel`, already a number, never from
 * the LLM) reads as a step: the nearest of the shared strengths.
 */
export function strengthOf(amount: number): AppraisalStrength {
  const a = Math.abs(amount);
  if (a >= 0.28) return "strong";
  if (a >= 0.15) return "medium";
  return "weak";
}
