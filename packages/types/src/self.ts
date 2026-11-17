// Her inner state (docs/design/autonomy.md §4, §23): emotions (七情), drives (六欲), boredom,
// the policy she sets for herself and her agenda. How she feels about people is the heart's
// (`HeartKey`, `heart_person`). Provided by the `self` module as `SelfStateKey`; her mood stays
// with the `mood` module (which follows her emotions through `SelfState.affect`) and is only
// included in snapshots.

import type { PersonId } from "./ids.js";
import { type ContextKey, contextKeyString } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Mood } from "./social.js";
import type { Timestamp } from "./time.js";

export const DRIVE_NAMES = [
  "social",
  "play",
  "attention",
  "rest",
  "curiosity",
  "esteem",
  "hunger",
  "longing",
] as const;

/**
 * `social`: wants to interact with people; `play`: wants to play a game; `attention`: wants to
 * be noticed (stream, perform); `rest`: wants to rest; `curiosity`: wants something new;
 * `esteem`: wants to be acknowledged, to show off (singing, winning); `hunger`: her appetite for
 * 白飯 (tokens); `longing`: wants to be near her crush and noticed by them (fades without one).
 */
export type DriveName = (typeof DRIVE_NAMES)[number];

/** Each 0..1. Drives rise slowly on their own and drop when satisfied. */
export type Drives = Record<DriveName, number>;

// ---- emotions -------------------------------------------------------------------------------

/**
 * Her discrete emotions (七情 and a few more), each 0..1 with its own decay; they coexist.
 * 喜 joy, 怒 anger, 哀 sorrow, 懼 fear, 驚 surprise, 厭 disgust, 害羞 shy, 得意 pride, 嫉妒
 * jealousy, 寂寞 lonely, 想念 missing, 感激 gratitude, 愧疚 guilt, 不甘心 frustration.
 */
export const EMOTION_NAMES = [
  "joy",
  "anger",
  "sorrow",
  "fear",
  "surprise",
  "disgust",
  "shy",
  "pride",
  "jealousy",
  "lonely",
  "missing",
  "gratitude",
  "guilt",
  "frustration",
] as const;

export type EmotionName = (typeof EMOTION_NAMES)[number];

/** How each emotion reads (zh-TW). */
export const EMOTION_LABELS: Readonly<Record<EmotionName, string>> = {
  joy: "喜",
  anger: "怒",
  sorrow: "哀",
  fear: "懼",
  surprise: "驚",
  disgust: "厭",
  shy: "害羞",
  pride: "得意",
  jealousy: "嫉妒",
  lonely: "寂寞",
  missing: "想念",
  gratitude: "感激",
  guilt: "愧疚",
  frustration: "不甘心",
};

/** Emotions she feels toward one person: 想念, 嫉妒, 感激, 不爽. */
export const PERSON_EMOTION_NAMES = ["missing", "jealousy", "gratitude", "resentment"] as const;

export type PersonEmotionName = (typeof PERSON_EMOTION_NAMES)[number];

export const PERSON_EMOTION_LABELS: Readonly<Record<PersonEmotionName, string>> = {
  missing: "想念",
  jealousy: "嫉妒",
  gratitude: "感激",
  resentment: "不爽",
};

/** One emotion she feels now. */
export interface EmotionReading {
  name: EmotionName;
  /** 0..1, decayed to now. */
  intensity: number;
  /** What last stirred it (short, zh-TW; may contain names, so it is data in prompts). */
  cause: string;
  /** When it was last stirred. */
  at: Timestamp;
  /** Who it is about, when someone. */
  person: PersonId | null;
}

/**
 * What she lets show of what she feels (the profile's display rules): her lines and her
 * `<emo:…>` tags follow this, her inner monologue knows the felt emotion.
 */
export interface ShownEmotion {
  /** The felt emotion it comes from. */
  from: EmotionName;
  /** The `<emo:…>` tag it shows as. */
  tag: string;
  /** How it shows, in words (zh-TW). */
  style: string;
  /** She hides what she feels (what shows differs from what she feels). */
  masked: boolean;
}

/** Mood offsets her emotions push toward (added to the mood's target). */
export interface Affect {
  valence: number;
  arousal: number;
  energy: number;
}

/** One sample of her emotional state (for charts). */
export interface EmotionSample {
  at: Timestamp;
  emotions: Partial<Record<EmotionName, number>>;
  drives: Drives;
  mood: Mood | null;
}

/** How talkative she wants to be in one scope (0 = silent, 1 = very chatty). */
export interface Talkativeness {
  level: number;
  /** Expiry; `null` = until she changes it. */
  until: Timestamp | null;
  /** Her reason, in her own words. */
  why: string;
  set_at: Timestamp;
}

export interface SelfPolicy {
  /** By scope, see `talkativenessScopes`. Expired entries are removed. */
  talkativeness: Record<string, Talkativeness>;
  /** Willingness to start things on her own, 0..1. */
  initiative: number;
  initiative_why: string;
}

export type AgendaStatus = "open" | "done" | "expired" | "dropped";

/** Something she is doing or means to do ("等 Owen 上線問他報告結果"). */
export interface AgendaItem {
  id: string;
  text: string;
  why: string;
  person: PersonId | null;
  context: ContextKey | null;
  created_at: Timestamp;
  /** Earliest time it makes sense; `null` = any time. */
  due: Timestamp | null;
  /** It no longer matters after this; `null` = never expires. */
  expires_at: Timestamp | null;
  status: AgendaStatus;
  /** When it was done, dropped or expired. */
  closed_at: Timestamp | null;
  /**
   * An action it needs failed: not retried, and not brought up in conversations, until the
   * situation changes (missing in old records = not blocked).
   */
  blocked?: AgendaBlock | null;
}

/** Why an open agenda item is on hold. */
export interface AgendaBlock {
  /** The capability that failed (`game.start`). */
  capability: string;
  /** Why, in short (the action's error). */
  reason: string;
  at: Timestamp;
}

export interface SelfSnapshot {
  at: Timestamp;
  /** From the `mood` module; `null` while it is not running. */
  mood: Mood | null;
  /** 0..1, rises when nothing happens. */
  boredom: number;
  drives: Drives;
  policy: SelfPolicy;
  /** Open items first (by due time), then recently closed ones. */
  agenda: AgendaItem[];
  /** What she feels, strongest first (only noticeable ones); absent from old producers. */
  emotions?: EmotionReading[];
  /** What she shows of it; `null` when nothing stands out. */
  shown?: ShownEmotion | null;
}

export interface TalkativenessInput {
  level: number;
  /** Absolute expiry. Takes precedence over `forMs`. */
  until?: Timestamp | null;
  /** Expiry relative to now. */
  forMs?: number | null;
  why: string;
}

export interface AgendaInput {
  text: string;
  why?: string;
  person?: PersonId | null;
  context?: ContextKey | null;
  due?: Timestamp | null;
  expiresAt?: Timestamp | null;
}

/** The talkativeness that applies somewhere, and the scope it was set for. */
export interface EffectiveTalkativeness extends Talkativeness {
  scope: string;
}

/** Provided by the `self` module. Getters answer from memory; setters persist in the background. */
export interface SelfState {
  snapshot(): SelfSnapshot;
  drives(): Drives;
  boredom(): number;
  /** Adds `delta` to drives (and boredom); positive = more wanted, negative = satisfied. */
  adjust(delta: Partial<Drives> & { boredom?: number }, reason: string): void;

  /** The most specific unexpired setting for `context` (see `talkativenessScopes`). */
  talkativeness(context: ContextKey | null): EffectiveTalkativeness | null;
  setTalkativeness(scope: string, input: TalkativenessInput): Talkativeness;
  clearTalkativeness(scope: string): boolean;
  initiative(): number;
  setInitiative(level: number, why: string): void;

  /** Open items, soonest due first. */
  agenda(): AgendaItem[];
  addAgenda(input: AgendaInput): AgendaItem;
  completeAgenda(id: string): AgendaItem | null;
  dropAgenda(id: string): AgendaItem | null;
  /** Puts an open item on hold (see `AgendaItem.blocked`); `null` when it is not open. */
  blockAgenda(id: string, block: { capability: string; reason: string }): AgendaItem | null;
  /** Lifts the hold of an item; `null` when it is not open or not blocked. */
  unblockAgenda(id: string): AgendaItem | null;

  /** What she feels, strongest first, at or above `min` (default: the noticeable ones). */
  emotions(min?: number): EmotionReading[];
  /**
   * Stirs (`amount` > 0) or calms (`amount` < 0) an emotion; the profile's temperament scales
   * how fast it rises. `person`: who it is about.
   */
  feel(emotion: EmotionName, amount: number, cause: string, person?: PersonId | null): void;
  /** What she shows of her strongest emotion (display rules); `null` when nothing stands out. */
  shown(): ShownEmotion | null;
  /** Mood offsets of her current emotions; never reads the mood (the mood reads this). */
  affect(): Affect;
  /** Recent samples of her emotions, drives and mood, oldest first. */
  history(): EmotionSample[];
}

export const SelfStateKey = serviceKey<SelfState>("SelfState");

/** Scope that applies everywhere. */
export const GLOBAL_SCOPE = "*";

/**
 * Scopes that apply to `context`, most specific first: the context itself
 * (`discord:<guild>:<channel>` / `discord:<guild>:voice:<channel>`), its guild
 * (`discord:<guild>`), its kind (`voice` / `text`) and `*`.
 */
export function talkativenessScopes(context: ContextKey | null): string[] {
  if (context === null) return [GLOBAL_SCOPE];
  const out = [contextKeyString(context)];
  if (context.scope !== null) out.push(`${context.platform}:${context.scope}`);
  out.push(context.kind === "voice" ? "voice" : "text", GLOBAL_SCOPE);
  return out;
}
