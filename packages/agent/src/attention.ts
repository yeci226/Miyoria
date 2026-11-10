// Attention: should she respond to this turn? (docs/design/v2-architecture.md §3.3, §3.9)
//
// Only the cheap prefilter and her own talkativeness live here:
//
// * the prefilter: the channel's mode, direct address (mention, reply, her name, a DM; in voice
//   a question right after she spoke or a one-on-one), someone answering what she just said,
//   and in voice someone still speaking (she does not join in over them);
// * whether to join in: a cheap salience score × her talkativeness (`talkFactor`), under the
//   share cap (her share of recent messages); in the gray zone the `fast` model is asked (in
//   the turn itself).
//
// Her talkativeness is hers: what she set for the context (`SelfState`), shifted by lessons and
// her feelings (`AffectSnapshot.biases`, in the turn), with a floor; without one, the channel
// level's default, moved by the configured activeness. In text channels the owner's level
// (`quiet` / `normal` / `lively`, `levels.ts`) caps it and adds a minimum score and a lower share
// limit.
//
// The other multipliers (affinity, energy, activeness factors, the voice ambient factor and
// interrupt scale) and every cooldown are gone: how often she starts something on her own is
// the Arbiter's (`[modules.arbiter]`), and her feelings already moved her talkativeness.

import { type IncomingMessage, timestampMs } from "@miyoria/types";
import type { Activeness, AttentionConfig, ChannelMode } from "./config.js";
import { type Ceiling, cappedTalk } from "./levels.js";
import type { Session } from "./session.js";
import {
  accountId,
  fixed,
  isAlphanumeric,
  isAsciiAlphanumeric,
  isWhitespace,
  signed,
} from "./util.js";

/** Source of uniform randomness in `[0, 1)` for the final decision. */
export interface RandomSource {
  nextF32(): number;
}

const MASK64 = (1n << 64n) - 1n;

/** Small deterministic generator (SplitMix64), identical to the Rust one. */
export class SeededRandom implements RandomSource {
  #state: bigint;

  /** `seed` is a u64 (number or bigint). */
  constructor(seed: number | bigint) {
    this.#state = BigInt(seed) & MASK64;
  }

  static fromEntropy(): SeededRandom {
    const nanos = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
    return new SeededRandom((nanos ^ 0x9e37_79b9_7f4a_7c15n) & MASK64);
  }

  nextF32(): number {
    this.#state = (this.#state + 0x9e37_79b9_7f4a_7c15n) & MASK64;
    let z = this.#state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK64;
    z ^= z >> 31n;
    return Number(z >> 40n) / (1 << 24);
  }
}

/** What the prefilter and the score concluded. */
export type Gate =
  | { kind: "ignore" }
  /** Respond with this probability. */
  | { kind: "sample"; probability: number }
  /** Gray zone: ask the `fast` model, otherwise sample with the score. */
  | { kind: "ask_llm" };

export interface Assessment {
  direct: boolean;
  score: number;
  gate: Gate;
  reasons: string[];
  /** Multiplier for ambient probabilities decided later (after the LLM check): `talkFactor`. */
  ambientScale: number;
}

/** Extra facts of voice contexts. */
export interface VoiceAttention {
  /** Someone other than her is speaking right now (she does not join in over them). */
  someoneSpeaking: boolean;
  /** A question this soon (ms) after she spoke addresses her. */
  questionWindowMs: number;
  /** People in the voice channel besides her (`null` = unknown). */
  others: number | null;
}

/** The talkativeness she set for a context (0 = silent, 0.5 = as usual, 1 = very chatty). */
export interface TalkLevel {
  level: number;
  /** The scope it was set for (for the decision trace). */
  scope: string;
}

/** At or below this talkativeness she does not join in at all. */
export const SILENT_TALKATIVENESS = 0.05;

/** Her talkativeness while she set none and no level applies (voice, DMs). */
export const USUAL_TALKATIVENESS = 0.5;

/**
 * How the configured activeness moves her default talkativeness (the old ×0.5 / ×1 / ×1.6 of the
 * ambient probability, expressed on the talkativeness scale: `talkFactor` of the shifted level).
 */
export const ACTIVENESS_SHIFT: Readonly<Record<Activeness, number>> = {
  low: -0.25,
  medium: 0,
  high: 0.17,
};

/** Ambient probability multiplier of a talkativeness: ×0.25 at 0, ×1 at 0.5, ×4 at 1. */
export function talkFactor(level: number): number {
  return 4 ** (2 * clamp01(level) - 1);
}

export interface AttentionInput {
  config: AttentionConfig;
  mode: ChannelMode;
  /** Moves her default talkativeness (while she set none). */
  activeness: Activeness;
  /** Her own talkativeness for this context (with lessons and feelings); `null`: she set none. */
  talkativeness?: TalkLevel | null;
  /** The owner's level for this text channel (`ceilingFor`); `null`: none (voice, tests). */
  ceiling?: Ceiling | null;
  names: readonly string[];
  /** The profile's interests; matched like `config.keywords`. */
  interests: readonly string[];
  maxShare: number;
  session: Session;
  /** The messages that make up this turn (already in the session history). */
  inputs: readonly IncomingMessage[];
  /** Epoch ms. */
  now: number;
  /** Set for voice contexts. */
  voice: VoiceAttention | null;
}

/**
 * Her talkativeness with the floor (docs/design/v2-architecture.md §3.9): lessons and moods may
 * lower it, but not below `floor`, unless she herself set exactly 0 for the place.
 */
export function flooredTalk(
  merged: TalkLevel | null,
  own: TalkLevel | null,
  floor: number,
): TalkLevel | null {
  if (merged === null || own?.level === 0 || merged.level >= floor) return merged;
  return { level: floor, scope: `${merged.scope} (floor)` };
}

function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

/**
 * The talkativeness attention works with: hers (capped by the level), or the level's default
 * (else "as usual") moved by activeness, never above the level's maximum.
 */
export function effectiveTalk(input: AttentionInput): TalkLevel {
  const own = input.talkativeness ?? null;
  const ceiling = input.ceiling ?? null;
  if (own !== null) {
    return ceiling === null ? own : { level: cappedTalk(ceiling, own.level), scope: own.scope };
  }
  const base = (ceiling?.defaultTalk ?? USUAL_TALKATIVENESS) + ACTIVENESS_SHIFT[input.activeness];
  const level = clamp01(ceiling === null ? base : Math.min(base, ceiling.maxTalk));
  return { level, scope: `default (activeness ${input.activeness})` };
}

/** Multiplier for ambient probabilities: `talkFactor` of her effective talkativeness. */
export function ambientScale(input: AttentionInput): number {
  return talkFactor(effectiveTalk(input).level);
}

/** Ambient probability after `ambientScale`, clamped. */
export function ambientProbability(input: AttentionInput, p: number): number {
  return clamp01(p * ambientScale(input));
}

/** Why a message addresses her directly, if it does. */
export function directReason(msg: IncomingMessage, names: readonly string[]): string | null {
  const kind = msg.id.context.kind;
  if (kind === "dm") return "dm";
  if (msg.mentions_self) return "mention";
  if (msg.reply_to_self) return "reply";
  // Transcripts space and punctuate names arbitrarily ("deep seek chan"), so voice compares
  // letters and digits only.
  const voice = kind === "voice";
  const normalize = (s: string): string => {
    const lower = s.toLowerCase();
    return voice ? [...lower].filter(isAlphanumeric).join("") : lower;
  };
  const text = normalize(msg.text);
  const found = names.find((n) => {
    const name = normalize(n);
    return name !== "" && text.includes(name);
  });
  if (found !== undefined) return `name \`${found}\``;
  const heard = voice ? vocativeName(msg.text, names) : null;
  return heard === null ? null : `name \`${heard.name}\` (heard \`${heard.word}\`)`;
}

/**
 * Speech recognition mangles short English names ("miyo" → "mo", "meo"). A Latin word that
 * opens an utterance on its own ("mo,你好", "meo 你在嗎") and sounds like one of her Latin names —
 * same first letter, at most two letters off — is taken as calling her. Only the opening word,
 * so "mode" or "more" inside a sentence never counts.
 */
export function vocativeName(
  text: string,
  names: readonly string[],
): { name: string; word: string } | null {
  const m = /^\s*([a-z]{2,10})(?=[\s,，、.。!！?？~～]|$)/i.exec(text);
  const word = m?.[1]?.toLowerCase();
  if (word === undefined) return null;
  for (const n of names) {
    const name = n.toLowerCase();
    if (!/^[a-z]{3,12}$/.test(name) || name[0] !== word[0]) continue;
    if (Math.abs(name.length - word.length) > 2) continue;
    if (editDistance(word, name) <= Math.min(2, name.length - 2)) return { name: n, word };
  }
  return null;
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/** A question asked within the voice question window after she spoke. */
function questionAfterHer(input: AttentionInput): string | null {
  const voice = input.voice;
  if (voice === null) return null;
  const last = input.session.lastSelfAt();
  if (last === null) return null;
  const hit = input.inputs
    .filter((m) => isQuestion(m.text.toLowerCase()))
    .some((m) => {
      const gap = timestampMs(m.ts) - last;
      return gap >= -voice.questionWindowMs && gap <= voice.questionWindowMs;
    });
  return hit ? "question right after she spoke" : null;
}

export function assess(input: AttentionInput): Assessment {
  // Someone answering what she just said: never shut out by her quiet setting or the level.
  const replying = followsHer(input);
  const cfg = input.config;
  const reasons = [`mode ${input.mode}`];
  let why: string | null = null;
  for (const m of input.inputs) {
    why = directReason(m, input.names);
    if (why !== null) break;
  }
  why ??= questionAfterHer(input);
  // Alone with one person in voice: whatever they say is said to her.
  if (why === null && input.voice?.others === 1) why = "one-on-one in voice";
  if (why !== null) reasons.push(`direct: ${why}`);
  const score = salience(input, why !== null, reasons);
  const direct = why !== null;
  const raw = effectiveTalk(input);
  // Her quiet setting is about joining in, not about answering: at least "as usual" then.
  const talk =
    replying && raw.level < USUAL_TALKATIVENESS
      ? { level: USUAL_TALKATIVENESS, scope: `${raw.scope}, replying` }
      : raw;
  const scale = talkFactor(talk.level);
  const done = (gate: Gate): Assessment => ({ direct, score, gate, reasons, ambientScale: scale });

  switch (input.mode) {
    case "off":
      return done({ kind: "ignore" });
    case "always":
      return done({ kind: "sample", probability: 1 });
    case "mention-only":
    case "quiet":
    case "normal":
    case "lively":
      if (direct) {
        return done({ kind: "sample", probability: clamp01(cfg.direct_probability) });
      }
      if (input.mode === "mention-only") {
        reasons.push("not addressed");
        return done({ kind: "ignore" });
      }
  }

  const own = input.talkativeness ?? null;
  const ceiling = input.ceiling ?? null;
  if (replying) reasons.push("replying to her: skips her quiet setting");
  if (ceiling !== null) reasons.push(`level ${ceiling.mode}`);
  const capped = own !== null && ceiling !== null && own.level > ceiling.maxTalk;
  reasons.push(
    capped && ceiling
      ? `talkativeness ${fixed(own.level, 2)} (${own.scope}) capped to ${fixed(ceiling.maxTalk, 2)}`
      : `talkativeness ${fixed(talk.level, 2)} (${talk.scope})`,
  );
  if (talk.level <= SILENT_TALKATIVENESS) {
    reasons.push("she wants to stay quiet here");
    return done({ kind: "ignore" });
  }
  if (input.voice?.someoneSpeaking && !replying) {
    reasons.push("someone is speaking");
    return done({ kind: "ignore" });
  }
  const share = input.session.selfShare(cfg.recent_window);
  const maxShare = Math.min(input.maxShare, ceiling?.maxShare ?? 1);
  if (share > maxShare) {
    reasons.push(`anti-spam: her share ${fixed(share, 2)} > ${fixed(maxShare, 2)}`);
    return done({ kind: "ignore" });
  }
  const grayLow = Math.max(cfg.gray_low, ceiling?.minScore ?? 0);
  const grayHigh = Math.max(cfg.gray_high, grayLow);
  if (score < grayLow) {
    reasons.push(`score ${fixed(score, 2)} < ${fixed(grayLow, 2)}`);
    return done({ kind: "ignore" });
  }
  const probability = clamp01(score * scale);
  if (score >= grayHigh) return done({ kind: "sample", probability });
  if (cfg.llm_check) {
    reasons.push("gray zone: asking fast model");
    return done({ kind: "ask_llm" });
  }
  return done({ kind: "sample", probability });
}

/** Someone in this turn answers what she just said (see `answersHer`). */
function followsHer(input: AttentionInput): boolean {
  return answersHer(input.session, input.inputs, input.now);
}

/**
 * Someone is answering what she just said: she spoke among the last three history entries
 * other than `inputs` (which are already in the history; her reply may have landed between
 * them), within the last 3 minutes.
 */
export function answersHer(
  session: Session,
  inputs: readonly IncomingMessage[],
  now: number,
): boolean {
  const ids = new Set(inputs.map((m) => m.id.id));
  const history = session.history();
  // Inputs without an id match in the history are its last entries (as recorded).
  const known = history.filter((e) => e.id !== null && ids.has(e.id)).length;
  const rest = history
    .slice(0, history.length - (inputs.length - known))
    .filter((e) => e.id === null || !ids.has(e.id));
  const her = rest
    .reverse()
    .slice(0, 3)
    .find((e) => e.isSelf);
  return her !== undefined && Math.trunc((now - her.ts) / 1000) < 180;
}

function salience(input: AttentionInput, direct: boolean, reasons: string[]): number {
  let score = 0.05;
  const add = (weight: number, why: string): void => {
    score += weight;
    reasons.push(`${why} ${signed(weight, 2)}`);
  };
  if (direct) add(0.6, "direct");
  const texts = input.inputs.map((m) => m.text.toLowerCase());
  if (texts.some(isQuestion)) add(0.15, "question");
  const keyword = [...input.config.keywords, ...input.interests].find((k) =>
    texts.some((t) => mentionsTopic(t, k)),
  );
  if (keyword !== undefined) add(0.2, `topic \`${keyword}\``);

  if (followsHer(input)) add(0.35, "follow-up to her");
  const last = input.session.lastSelfAt();
  if (last === null) add(0.05, "has not spoken yet");
  else if (Math.trunc((input.now - last) / 60_000) >= 30) add(0.05, "quiet for a while");
  if (input.inputs.length > 1) add(0.05, "several messages");
  const people = new Set(
    input.session
      .recent(10)
      .filter((e) => !e.isSelf)
      .map((e) => accountId(e.account)),
  );
  if (people.size <= 2) add(0.1, "small group");
  return clamp01(score);
}

/**
 * `text` (lower-cased) mentions `topic`. ASCII words such as `AI` must stand alone, so they do
 * not match inside `said`; other topics match anywhere.
 */
export function mentionsTopic(text: string, topic: string): boolean {
  const t = topic.trim().toLowerCase();
  if (t === "") return false;
  if (![...t].every(isAsciiAlphanumeric)) return text.includes(t);
  for (let i = text.indexOf(t); i !== -1; i = text.indexOf(t, i + t.length)) {
    const before = [...text.slice(0, i)].at(-1);
    const after = [...text.slice(i + t.length, i + t.length + 2)][0];
    if (!isAsciiAlphanumeric(before) && !isAsciiAlphanumeric(after)) return true;
  }
  return false;
}

const QUESTION_WORDS = [
  "什麼",
  "怎麼",
  "幹嘛",
  "為什麼",
  "為啥",
  "誰",
  "哪裡",
  "哪個",
  "how ",
  "what ",
  "why ",
];

export function isQuestion(text: string): boolean {
  const chars = [...text];
  while (chars.length > 0) {
    const c = chars.at(-1) as string;
    if (isWhitespace(c) || "~～!！。.…".includes(c)) chars.pop();
    else break;
  }
  const t = chars.join("");
  return (
    t.includes("?") ||
    t.endsWith("嗎") ||
    t.endsWith("呢") ||
    t.endsWith("吧") ||
    QUESTION_WORDS.some((w) => t.includes(w))
  );
}

/** Samples the final decision; the roll is `null` when the outcome was certain. */
export function decide(probability: number, random: RandomSource): [boolean, number | null] {
  if (probability >= 1) return [true, null];
  if (probability <= 0) return [false, null];
  const roll = random.nextF32();
  return [roll < probability, roll];
}
