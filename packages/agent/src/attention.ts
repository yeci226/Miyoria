// Attention: should she respond to this turn? (docs/design/v2-architecture.md §3.3, §3.9)
//
// Only the cheap prefilter and her own talkativeness live here:
//
// * the prefilter: the channel's mode, direct address (mention, reply, her name, a DM; in voice
//   a question right after she spoke or a one-on-one), someone answering what she just said,
//   and in voice someone still speaking (she does not join in over them);
// * someone who goes on talking with her (`conversing`): under the main line that turn is the
//   model's to answer or pass, with no score, share cap or dice in between;
// * who a line is for, beyond who it replies to (`saidToOthers`, `reactionOnly`): a reply to her
//   that opens by calling someone else, or talks about her to others, is about her, said to them;
//   a reply that is only a laugh or an emoji is a reaction for the room. Neither is direct: the
//   main line gets them as lines it may pass (`Aside`);
// * whether to join in: under the main line in text channels "a look" (v4 §7.2): something worth
//   a look (a topic of hers, a question left unanswered, someone she is close to, an image, a new
//   topic) opens a turn in which the model picks a rung of the response ladder, within the level's
//   share cap and a cap of looks per hour (`[modules.agent.rhythm]`). Otherwise (voice, V2) a cheap
//   salience score × her talkativeness (`talkFactor`), under the share cap; in the gray zone the
//   `fast` model is asked (in the turn itself).
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

import {
  type AccountRef,
  type IncomingMessage,
  imageType,
  sameAccount,
  timestampMs,
} from "@miyoria/types";
import type { Activeness, AttentionConfig, ChannelMode } from "./config.js";
import { type Ceiling, cappedTalk } from "./levels.js";
import type { HistoryEntry, Session } from "./session.js";
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

/**
 * Why a turn that is not direct was handed to the model (main line): it goes on talking with
 * her, it is about her but said to someone else, it only reacts to her line, or it is a look.
 */
export type Opened = "conversing" | "about_her" | "reaction" | "look";

export interface Assessment {
  direct: boolean;
  score: number;
  gate: Gate;
  reasons: string[];
  /** Multiplier for ambient probabilities decided later (after the LLM check): `talkFactor`. */
  ambientScale: number;
  /** Set when the turn was handed to the model without being direct (main line). */
  opened?: Opened | null;
}

/** Extra facts of voice contexts. */
export interface VoiceAttention {
  /** Someone other than her is speaking right now (she does not join in over them). */
  someoneSpeaking: boolean;
  /** A question this soon (ms) after she spoke addresses her. */
  questionWindowMs: number;
  /** People in the voice channel besides her (`null` = unknown). */
  others: number | null;
  /** Display names of the people in the voice channel besides her (`Session.voiceMembers`). */
  roster?: readonly string[];
}

/** What a look (v4 §7.2) needs to know besides the turn itself (text channels, main line). */
export interface LookFacts {
  /** Looks she took in this channel in the last hour. */
  used: number;
  /** `[modules.agent.rhythm] looks_per_hour`: the cap at the `normal` level, as usual. */
  perHour: number;
  /** A question standing this long (s) with nobody answering is worth a look. */
  questionSecs: number;
  /** A gap this long (ms) before the turn's first line: a new topic. */
  topicGapMs: number;
  /** Someone she is close to who speaks in this turn (for the trace), if anyone. */
  close: string | null;
  /**
   * The coordinator saw the turn's question stand `questionSecs` by its own clock (a platform's
   * timestamps may be skewed from it).
   */
  stood?: boolean;
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
  /**
   * The model may answer `<silence/>` (the main line): a turn that goes on talking with her
   * (`conversing`) is left to it instead of the score and the share cap.
   */
  modelMayPass?: boolean;
  /** Text channels under the main line: what a look needs (`null`: no looks, the score decides). */
  look?: LookFacts | null;
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

/**
 * Why a message addresses her directly, if it does. `roster`: the other people in a voice
 * channel (display names), whose names an utterance may open with.
 *
 * Being a reply to her is not enough (2026-11-10: someone replied to her line with "@someone-else
 * she keeps skipping like a broken record, six times now", the log said `addressed_to_her` and she
 * answered it): a reply that is said to someone else (`saidToOthers`) or is only a reaction for
 * the room (`reactionOnly`) does not address her, and neither does her name inside a line said to
 * someone else. A line that @-mentions her and others together is still to her.
 */
export function directReason(
  msg: IncomingMessage,
  names: readonly string[],
  roster: readonly string[] = [],
): string | null {
  const kind = msg.id.context.kind;
  if (kind === "dm") return "dm";
  if (msg.mentions_self) return "mention";
  const elsewhere = saidToOthers(msg, names, roster);
  if (msg.reply_to_self) return elsewhere === null && !reactionOnly(msg) ? "reply" : null;
  if (elsewhere !== null) return null;
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

/**
 * In voice, the participant an utterance opens by calling (`roster`: display names of the others),
 * if it calls one of them and not her. Latin names are matched like hers (`vocativeName`: speech
 * recognition mangles them); other names (Chinese, Japanese) must open the utterance as they are.
 */
export function openingCall(
  text: string,
  roster: readonly string[],
  names: readonly string[],
): string | null {
  if (vocativeName(text, names) !== null) return null;
  const head = letters(text);
  if (names.some((n) => letters(n) !== "" && head.startsWith(letters(n)))) return null;
  const latin = vocativeName(text, roster);
  if (latin !== null) return latin.name;
  for (const n of roster) {
    const name = letters(n);
    // Only names with more than ASCII in them: an ASCII prefix like "mo" would match "more".
    if ([...name].length >= 2 && !/^[a-z0-9]+$/.test(name) && head.startsWith(name)) return n;
  }
  return null;
}

/** Lower-cased letters and digits of `s` (how transcripts are compared). */
function letters(s: string): string {
  return [...s.toLowerCase()].filter(isAlphanumeric).join("");
}

/** `text` speaks of her in the third person: one of her names, 她, she / her. */
export function aboutHerInThirdPerson(text: string, names: readonly string[]): boolean {
  const lower = text.toLowerCase();
  if (names.some((n) => n.trim() !== "" && lower.includes(n.trim().toLowerCase()))) return true;
  return /她/.test(text) || /\b(?:she|her|hers|this bot|the bot)\b/i.test(text);
}

/**
 * Whom a message is said to, when its words say it is someone other than her: it opens with an
 * @-mention of someone else, it @-mentions only others and talks about her in the third person,
 * or (voice) it opens by calling another participant (`openingCall`). `null`: nothing says so.
 * A message that @-mentions her is never said to others, whoever else it mentions.
 */
export function saidToOthers(
  msg: IncomingMessage,
  names: readonly string[],
  roster: readonly string[] = [],
): string | null {
  if (msg.mentions_self) return null;
  const others = msg.mentions_others ?? [];
  const first = others[0]?.display_name ?? "別人";
  if (msg.opens_with_other_mention === true) return first;
  if (msg.id.context.kind === "voice") {
    const called = openingCall(msg.text, roster, names);
    if (called !== null) return called;
  }
  return others.length > 0 && aboutHerInThirdPerson(msg.text, names) ? first : null;
}

/** Laughter and cheers that are a reaction, not something said (letters only, lower-cased). */
const REACTION_WORDS =
  /^(?:l+o+l+|lmf?a+o+|rofl|x+d+|w{2,}|草+|笑死(?:我了)?|哈+|呵+|嘻+|嘿+|23{2,}|6{3,}|好耶+|讚+)+$/;

/**
 * The message is only a reaction for the room: laughter ("LOL", 「哈哈哈」, 「笑死」), emoji or a
 * sticker, with nothing asked and nothing attached.
 */
export function reactionOnly(msg: IncomingMessage): boolean {
  if (msg.attachments.length > 0 || (msg.forwarded?.length ?? 0) > 0) return false;
  if (/[?？]/.test(msg.text)) return false;
  const stripped = msg.text
    .replace(/<a?:[\w~-]+:\d+>/g, "")
    .replace(/:[\w~-]+:/g, "")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|⃣/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
  if (stripped === "") return msg.text.trim() !== "" || (msg.stickers?.length ?? 0) > 0;
  return REACTION_WORDS.test(stripped);
}

/** A line answering her line that is not said to her (the main line may pass on it). */
export type Aside =
  /** About her, said to someone else (`to`). */
  | { kind: "about_her"; to: string }
  /** Only a reaction for the room. */
  | { kind: "reaction" };

/**
 * Whether `msg`, a reply to her or a line that follows hers (`followsHer`), is not said to her:
 * in text, about her but said to someone else (a voice line that calls someone else is simply
 * theirs); anywhere, only a reaction. `null` for lines that address her and for the rest.
 */
export function asideOf(
  msg: IncomingMessage,
  names: readonly string[],
  roster: readonly string[],
  followsHer: boolean,
): Aside | null {
  if (!msg.reply_to_self && !followsHer) return null;
  if (directReason(msg, names, roster) !== null) return null;
  if (msg.id.context.kind !== "voice") {
    const to = saidToOthers(msg, names, roster);
    if (to !== null) return { kind: "about_her", to };
  }
  return reactionOnly(msg) ? { kind: "reaction" } : null;
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
  const roster = voice.roster ?? [];
  const hit = input.inputs
    // A question that opens by calling someone else is theirs, however soon after her.
    .filter(
      (m) => isQuestion(m.text.toLowerCase()) && saidToOthers(m, input.names, roster) === null,
    )
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
  const roster = input.voice?.roster ?? [];
  let why: string | null = null;
  for (const m of input.inputs) {
    why = directReason(m, input.names, roster);
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
  const done = (gate: Gate, opened: Opened | null = null): Assessment => ({
    direct,
    score,
    gate,
    reasons,
    ambientScale: scale,
    ...(opened === null ? {} : { opened }),
  });

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
  const mayPass = input.modelMayPass === true;
  const look = mayPass && input.voice === null ? (input.look ?? null) : null;
  // Looks taken in the last hour against the cap of this level and her talkativeness.
  const lookCap =
    look === null ? 0 : Math.round(look.perHour * (ceiling?.looks ?? 1) * talkFactor(talk.level));
  if (mayPass) {
    const asides = input.inputs.map((m) => asideOf(m, input.names, roster, replying));
    const about = asides.find((a) => a?.kind === "about_her");
    // 2026-11-10: a reply to her opening with "@someone-else she keeps skipping…" was answered
    // as if said to her. It is about her: hers to join, but she is told whom it is said to.
    if (about?.kind === "about_her") {
      reasons.push(`about her, said to ${about.to}: hers to join or pass`);
      return done({ kind: "sample", probability: 1 }, "about_her");
    }
    if (asides.length > 0 && asides.every((a) => a?.kind === "reaction")) {
      // A laugh at her line needs no answer: the model sees it and may pass or react, and it
      // counts as a look, so a lively room does not buy a model call per laugh.
      if (look !== null && look.used >= lookCap) {
        reasons.push(`a reaction to her line; looks spent (${look.used}/${lookCap} this hour)`);
        return done({ kind: "ignore" });
      }
      reasons.push("a reaction to her line: hers to answer or pass");
      return done({ kind: "sample", probability: 1 }, "reaction");
    }
  }
  // 2026-11-07 to 11-10: of 1,803 follow-ups she did not answer, the share cap stopped 1,489 (two
  // people going back and forth put her near 0.5) and the level's minimum score 253. Whether a
  // line is still meant for her is read off its words, so the model decides: it may pass.
  if (
    replying &&
    mayPass &&
    conversing(input.session, input.inputs, input.now, input.names, roster)
  ) {
    reasons.push("talking with her: hers to answer or pass");
    return done({ kind: "sample", probability: 1 }, "conversing");
  }
  const share = input.session.selfShare(cfg.recent_window);
  const maxShare = Math.min(input.maxShare, ceiling?.maxShare ?? 1);
  if (share > maxShare) {
    reasons.push(`anti-spam: her share ${fixed(share, 2)} > ${fixed(maxShare, 2)}`);
    return done({ kind: "ignore" });
  }
  // 2026-11-07 to 11-10: unaddressed, she joined 11 times in 4,964 (0.2%): every text channel was
  // `quiet`, and a dice roll under its minimum score decided. Under the main line something worth
  // a look opens a turn and she picks the rung (nothing, an emoji, a short line, joining in).
  if (look !== null) {
    const worth = lookTriggers(input, look);
    if (worth.length === 0) {
      reasons.push("nothing worth a look");
      return done({ kind: "ignore" });
    }
    if (look.used >= lookCap) {
      reasons.push(
        `worth a look (${worth.join(", ")}); looks spent (${look.used}/${lookCap} this hour)`,
      );
      return done({ kind: "ignore" });
    }
    reasons.push(`a look: ${worth.join(", ")} (${look.used + 1}/${lookCap} this hour)`);
    return done({ kind: "sample", probability: 1 }, "look");
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

/** Someone in this turn takes up what she just said (`followsHerLine`). */
function followsHer(input: AttentionInput): boolean {
  return followsHerLine(
    input.session,
    input.inputs,
    input.now,
    input.names,
    input.voice?.roster ?? [],
  );
}

/**
 * Someone is answering what she just said: she spoke among the last three history entries
 * other than `inputs` (which are already in the history; her reply may have landed between
 * them), within the last 3 minutes. Her cards are left out (`conversation`).
 */
export function answersHer(
  session: Session,
  inputs: readonly IncomingMessage[],
  now: number,
): boolean {
  const her = conversation(session, inputs)
    .reverse()
    .slice(0, 3)
    .find((e) => e.isSelf);
  return her !== undefined && Math.trunc((now - her.ts) / 1000) < FOLLOW_UP_SECS;
}

/**
 * `answersHer`, and the turn is hers to take up: it says so (a reply to her, an @-mention, her
 * name), or its speaker is someone her latest lines answered, or they answered nobody (she
 * started it herself, so anyone may go on with her).
 *
 * 2026-11-10: a line right after hers was taken as said to her whoever wrote it. 「高科」 written to
 * someone else got 「高科就高雄科技大學啊…」 and 「靠杯我不是在跟你說話」; a line to the room got an
 * answer ending 「不過我剛才問的是 Sakana2486，不是問你」. Of 304 times she spoke through the
 * `conversing` gate that evening, in 137 the speaker was not the one she had just answered.
 */
export function followsHerLine(
  session: Session,
  inputs: readonly IncomingMessage[],
  now: number,
  names: readonly string[] = [],
  roster: readonly string[] = [],
): boolean {
  if (!answersHer(session, inputs, now)) return false;
  if (callsHerOut(inputs, names, roster)) return true;
  const speaker = inputs.at(-1)?.author.account;
  const her = herLines(conversation(session, inputs));
  if (speaker === undefined || her === null) return false;
  return her.answered === null || her.answered.some((a) => sameAccount(a, speaker));
}

/** A line of `inputs` says it is for her: a reply to her, an @-mention, her name, a DM. */
function callsHerOut(
  inputs: readonly IncomingMessage[],
  names: readonly string[],
  roster: readonly string[],
): boolean {
  return inputs.some(
    (m) => m.reply_to_self || m.mentions_self || directReason(m, names, roster) !== null,
  );
}

/** A line this long after hers no longer follows it. */
const FOLLOW_UP_SECS = 180;

/** The history without `inputs` (which are already in it), oldest first. */
function earlier(session: Session, inputs: readonly IncomingMessage[]): HistoryEntry[] {
  const ids = new Set(inputs.map((m) => m.id.id));
  const history = session.history();
  // Inputs without an id match in the history are its last entries (as recorded).
  const known = history.filter((e) => e.id !== null && ids.has(e.id)).length;
  return history
    .slice(0, history.length - (inputs.length - known))
    .filter((e) => e.id === null || !ids.has(e.id));
}

/**
 * `earlier` without her cards: notices, receipts and panels posted in her name (song prep
 * 「開始準備…」, 「投票跳過…」, coin receipts) are not lines she said. 2026-11-10: 15 turns the
 * `conversing` gate opened came right after one of them, as if the next speaker answered her.
 */
function conversation(session: Session, inputs: readonly IncomingMessage[]): HistoryEntry[] {
  return earlier(session, inputs).filter((e) => !(e.isSelf && e.card === true));
}

/** Her latest lines in a row (indices into the history they came from) and whom they answered. */
interface HerLines {
  first: number;
  last: number;
  /** The people they answered; `null`: nobody, she started it herself. */
  answered: AccountRef[] | null;
}

/** Her latest lines in `rest` (`conversation`), if she said anything. */
function herLines(rest: readonly HistoryEntry[]): HerLines | null {
  const last = rest.findLastIndex((e) => e.isSelf);
  if (last < 0) return null;
  // Her reply may be several messages.
  let first = last;
  while (first > 0 && rest[first - 1]?.isSelf === true) first -= 1;
  return { first, last, answered: answeredBy(rest, first, last) };
}

/**
 * Whom her lines `rest[first..last]` answered. Her turn wrote it down (`answering`: its focus);
 * for a line known only from the platform, whom it replies to or @-mentions, else who spoke right
 * before it (within `FOLLOW_UP_SECS`). `null`: nobody, she started it.
 */
function answeredBy(
  rest: readonly HistoryEntry[],
  first: number,
  last: number,
): AccountRef[] | null {
  const lines = rest.slice(first, last + 1);
  const out: AccountRef[] = [];
  const add = (a: AccountRef): void => {
    if (!out.some((o) => sameAccount(o, a))) out.push(a);
  };
  const known = lines.filter((e) => e.answering !== undefined);
  if (known.length > 0) {
    for (const e of known) for (const a of e.answering ?? []) add(a);
    return out.length > 0 ? out : null;
  }
  for (const e of lines) {
    const to =
      e.replyTo === null
        ? undefined
        : (rest.find((x) => x.id === e.replyTo) ?? e.parents.find((p) => p.id === e.replyTo));
    if (to !== undefined && !to.isSelf) add(to.account);
    for (const a of e.mentions ?? []) add(a);
  }
  if (out.length > 0) return out;
  const before = rest[first - 1];
  const start = rest[first];
  if (
    before !== undefined &&
    start !== undefined &&
    !before.isSelf &&
    start.ts - before.ts < FOLLOW_UP_SECS * 1000
  ) {
    return [before.account];
  }
  return null;
}

/**
 * This turn goes on talking with her, which is narrower than `followsHerLine`: her lines are
 * the last thing said before it (cards left out), or one other line came between. Right after
 * her lines, the speaker must be someone they answered, or they answered nobody (she started
 * it); with one line between, the one they answered, or whoever took up her opening going on.
 * A line that says it is for her (a reply to her, an @-mention, her name) always is; a reply to
 * someone else's message never.
 *
 * Narrow on purpose: every such turn costs a call and may make her speak. Once two lines passed
 * without her, the conversation went on without her and the score decides again. Someone else
 * speaking right after she answered one person takes the look and the score like any line
 * (2026-11-10, `followsHerLine`).
 */
export function conversing(
  session: Session,
  inputs: readonly IncomingMessage[],
  now: number,
  names: readonly string[] = [],
  roster: readonly string[] = [],
): boolean {
  const speaker = inputs.at(-1)?.author.account;
  if (speaker === undefined) return false;
  if (inputs.some((m) => (m.reply_to ?? null) !== null && !m.reply_to_self)) return false;
  // Words that say it is for someone else win over coming right after her (`saidToOthers`).
  if (inputs.some((m) => saidToOthers(m, names, roster) !== null)) return false;
  const rest = conversation(session, inputs);
  const her = herLines(rest);
  const line = her === null ? undefined : rest[her.last];
  if (her === null || line === undefined || her.last < rest.length - 2) return false;
  if (Math.trunc((now - line.ts) / 1000) >= FOLLOW_UP_SECS) return false;
  if (callsHerOut(inputs, names, roster)) return true;
  const theirs = her.answered?.some((a) => sameAccount(a, speaker)) ?? false;
  if (her.last === rest.length - 1) return her.answered === null || theirs;
  const between = rest[rest.length - 1];
  return (
    theirs ||
    (her.answered === null && between !== undefined && sameAccount(between.account, speaker))
  );
}

/** Openings that change the subject. */
const NEW_TOPIC = /^\s*(?:話說|對了|換個話題|說到這|順便問|btw\b|by the way)/i;

/**
 * What in this turn is worth a look (v4 §7.2), for the trace; empty: nothing. A topic of hers, a
 * question that stood `questionSecs` with nobody answering (the coordinator looks again then),
 * someone she is close to, an image or sticker, a new topic (an opening that changes the subject,
 * or the first line after a long gap).
 */
export function lookTriggers(input: AttentionInput, look: LookFacts): string[] {
  const out: string[] = [];
  const texts = input.inputs.map((m) => m.text.toLowerCase());
  const topic = [...input.config.keywords, ...input.interests].find((k) =>
    texts.some((t) => mentionsTopic(t, k)),
  );
  if (topic !== undefined) out.push(`topic \`${topic}\``);
  const last = input.inputs.at(-1);
  const newest = input.session.history().at(-1);
  if (
    last !== undefined &&
    isQuestion(last.text.toLowerCase()) &&
    saidToOthers(last, input.names) === null &&
    newest !== undefined &&
    newest.id === last.id.id &&
    (look.stood === true || input.now - timestampMs(last.ts) >= look.questionSecs * 1000)
  ) {
    out.push("a question nobody answered");
  }
  if (look.close !== null) out.push(`close to ${look.close}`);
  if (
    input.inputs.some(
      (m) => m.attachments.some((a) => imageType(a) !== null) || (m.stickers?.length ?? 0) > 0,
    )
  ) {
    out.push("an image");
  }
  const first = input.inputs[0];
  const before = first === undefined ? undefined : earlier(input.session, input.inputs).at(-1);
  if (
    first !== undefined &&
    (NEW_TOPIC.test(first.text) ||
      (before !== undefined && timestampMs(first.ts) - before.ts >= look.topicGapMs))
  ) {
    out.push("a new topic");
  }
  return out;
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
