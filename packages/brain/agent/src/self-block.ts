// One renderer per concept (docs/design/v2-architecture.md §3.5, phase 0 item 18): her own state
// for the trusted system part (`SELF_BLOCK_KEYS`) and the people present for the data part.
//
// Each renderer reads the v2 blackboard service when it is there and falls back to today's
// sources otherwise (docs/design/v2-implementation.md W1):
//
// | block           | service                         | fallback                               |
// |-----------------|---------------------------------|----------------------------------------|
// | `self.mood`     | `AffectStateKey.snapshot()`     | `MoodSignalsKey` + `SelfStateKey`      |
// | `self.activity` | `ActivityManagerKey.snapshot()` | `WorldStateKey` `her`                  |
// | `self.policy`   | `SelfStateKey` talkativeness, the channel level                          |
// | `self.goals`    | `GoalAgendaKey.goals()`         | `SelfStateKey.agenda()`                |
// | `self.ledger`   | `ArbiterKey.ledger(context)`    | `MindKey.unanswered(context)`          |
// | `self.notices`  | `agent.notice` events the agent collected                                |
// | people (data)   | `HeartKey` rows, then           | `SocialSignalsKey` + `SelfStateKey`    |
// |                 | `AffectStateKey` person cards   |                                        |
// | feeling (data)  | `AffectStateKey.snapshot()`     | `SelfStateKey`                         |
//
// Her own state carries no text other people wrote (emotion causes, names): those stay in the
// data part. One affinity scale: `relationshipLabel()`.

import {
  type AccountRef,
  type ActivitySnapshot,
  AFFINITY_LEVEL_MAX,
  type AffectSnapshot,
  type AffectState,
  type Attitude,
  affinityLevel,
  BOND_SCALE_LINE,
  type ContextKey,
  EMOTION_LABELS,
  type EmotionName,
  type EmotionReading,
  type Goal,
  type HeartPeople,
  type HerStatus,
  heartCues,
  heartWords,
  type LedgerView,
  type Mood,
  moodLine,
  type Notice,
  neutralize,
  PERSON_EMOTION_LABELS,
  type PersonId,
  relationshipLabel,
  type SelfState,
  type ShownEmotion,
  safeName,
  xmlAttrs,
} from "@miyoria/types";
import type { SelfBlock } from "./compiler.js";
import { herStatusHint, shownHint, unansweredHint } from "./signals.js";

/** What the self renderers read; every source is optional. */
export interface SelfSources {
  context: ContextKey;
  /** Clock ms. */
  now: number;
  /** Minutes east of UTC for clock times (default: the local time zone). */
  utcOffsetMinutes?: number;
  affect?: AffectState | null;
  activity?: ActivitySnapshot | null;
  ledger?: LedgerView | null;
  goals?: readonly Goal[] | null;
  /** Handles of the people present (goals about them are relevant). */
  present?: readonly string[];
  /** The people present here, by person (a cause about one of them may be repeated here). */
  presentPeople?: readonly PersonId[];
  // Fallbacks.
  mood?: Mood | null;
  self?: SelfState | null;
  her?: HerStatus | null;
  /** The owner's level hint for the channel (`levelHint`). */
  level?: string | null;
  notices?: readonly Notice[];
}

const MAX_GOALS = 3;
const MAX_NOTICES = 3;

function short(text: string, max: number): string {
  const chars = [...neutralize(text).replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

function clock(ms: number, offsetMinutes: number): string {
  const d = new Date(ms + offsetMinutes * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** The emotions whose label is one literary character: `很喜` does not read. */
const FELT_WORDS: Partial<Record<EmotionName, string>> = {
  joy: "開心",
  anger: "生氣",
  sorrow: "難過",
  fear: "害怕",
  surprise: "驚訝",
  disgust: "嫌惡",
};

/** `很開心` (no cause: causes may quote people). */
function feltWord(e: EmotionReading): string {
  const degree = e.intensity >= 0.7 ? "很" : e.intensity >= 0.4 ? "有點" : "微微";
  return `${degree}${FELT_WORDS[e.name] ?? EMOTION_LABELS[e.name] ?? e.name}`;
}

/** `很開心、有點害羞`. */
function feltLine(emotions: readonly EmotionReading[]): string {
  return emotions.map(feltWord).join("、");
}

/** The drives that stand out, in words. */
const WANTS: Readonly<Record<string, string>> = {
  social: "很想跟人聊天",
  play: "很想玩遊戲",
  attention: "很想被大家注意",
  rest: "想休息",
  curiosity: "想做點新鮮的事",
  esteem: "很想被誇、想表現一下",
  hunger: "肚子餓,很想吃白飯(Token)",
  longing: "很想見那個人、想被他注意",
};
const STRONG_DRIVE = 0.65;
/** Under this hunger she is full (`[modules.economy] full_below`). */
const FULL_BELOW = 0.15;

/** `self.mood`: one mood line, her strongest 2–3 emotions, what she shows, what she wants. */
export function moodBlock(src: SelfSources): string {
  const lines: string[] = [];
  const snap: AffectSnapshot | null = src.affect?.snapshot() ?? null;
  let shown: ShownEmotion | null;
  if (snap !== null) {
    lines.push(`你現在的心情:${short(snap.mood_line, 60)}`);
    if (snap.top.length > 0) lines.push(`心裡最強的感受:${feltLine(snap.top.slice(0, 3))}`);
    shown = snap.shown;
  } else {
    if (src.mood) lines.push(`你現在的心情:${moodLine(src.mood)}`);
    const felt = src.self?.emotions().slice(0, 3) ?? [];
    if (felt.length > 0) lines.push(`心裡最強的感受:${feltLine(felt)}`);
    shown = src.self?.shown() ?? null;
    const self = src.self;
    if (self) {
      const feel: string[] = [];
      const boredom = self.boredom();
      if (boredom >= 0.7) feel.push("很無聊");
      else if (boredom >= 0.45) feel.push("有點無聊");
      const drives = Object.entries(self.drives())
        .filter(([, v]) => v >= STRONG_DRIVE)
        .sort((a, b) => b[1] - a[1]);
      for (const [name] of drives) if (WANTS[name]) feel.push(WANTS[name] as string);
      if (feel.length > 0) lines.push(`你現在${feel.join("、")}。`);
    }
  }
  // The affect snapshot has no drives, so hunger went unsaid: at 15:32 she asked for a bowl while
  // full, and the feed was refused. The economy refuses under `full_below` (0.15 by default).
  const hunger = src.self?.drives().hunger;
  if (hunger !== undefined) {
    if (hunger < FULL_BELOW) lines.push("你吃飽了,現在吃不下;有人要餵你也會被擋。");
    else if (snap !== null && hunger >= STRONG_DRIVE) lines.push(`你現在${WANTS.hunger}。`);
  }
  const hint = shown ? shownHint(shown) : "";
  if (hint !== "") lines.push(hint);
  return lines.join("\n");
}

const MAX_CAUSE = 80;

/** What the self module stores for a cause it was not told: the emotion's own name. */
const UNTOLD_CAUSES: ReadonlySet<string> = new Set([
  ...Object.keys(EMOTION_LABELS),
  ...Object.values(EMOTION_LABELS),
  ...Object.values(PERSON_EMOTION_LABELS),
]);

/**
 * What stirred her strongest emotion, for the `feeling` data block: a cause may quote people, so
 * it never goes in `moodBlock`. A reading does not say where it happened and a cause can come
 * from a DM, so it is repeated only with the person it is about present (in their own DM they
 * are). Empty otherwise, or when the cause is only the emotion's name: the mood block already
 * names the emotion.
 *
 * `person === null` is not safe either: an appraisal's `toward` can be null (or a name nobody
 * knows) while its `cause` is the model's own sentence about whatever conversation it read, a
 * private one included.
 */
export function feelingCauseBody(src: SelfSources): string {
  return safely(() => {
    const snap = src.affect?.snapshot() ?? null;
    const top = snap !== null ? snap.top[0] : src.self?.emotions()[0];
    if (top === undefined) return "";
    const cause = short(top.cause, MAX_CAUSE);
    if (cause === "" || UNTOLD_CAUSES.has(cause)) return "";
    if (top.person === null || !src.presentPeople?.includes(top.person)) return "";
    return `讓你${feltWord(top)}的事:${cause}`;
  });
}

/** `self.activity`: where she is and what she is doing. */
export function activityBlock(src: SelfSources): string {
  const snap = src.activity ?? null;
  if (snap === null) return src.her ? herStatusHint(src.her) : "";
  const p = snap.presence;
  const voice =
    p.type === "in"
      ? `在語音頻道 ${p.channel.channel}`
      : p.type === "joining"
        ? "正在進語音頻道"
        : p.type === "leaving"
          ? "正在離開語音頻道"
          : "不在語音頻道";
  const b = snap.broadcast;
  const live =
    b.type === "live"
      ? "正在直播"
      : b.type === "starting"
        ? "正在開台"
        : b.type === "stopping"
          ? "正在收台"
          : "沒有在直播";
  const a = snap.activity;
  let doing: string;
  if (a.type === "idle" || a.type === "chatting") {
    doing = "沒有在做別的事";
  } else {
    const what =
      a.type === "singing"
        ? `唱${a.target ?? "歌"}`
        : a.type === "game"
          ? `玩 ${a.target ?? "遊戲"}`
          : `逛 ${a.target ?? "網站"}`;
    doing =
      a.phase === "running"
        ? `正在${what}`
        : a.phase === "starting"
          ? `正在準備${what}`
          : a.phase === "stopping"
            ? `正在結束${what}`
            : `${what}失敗了(${short(a.failure?.detail ?? "", 40)})`;
  }
  // 2026-11-08 15:29: 「我有多少魚幣」 got 「我現在正在唱歌,不方便查」. A song only holds the voice.
  const textHere = src.context.kind !== "voice";
  const singing = a.type === "singing" && (a.phase === "running" || a.phase === "starting");
  const apart =
    textHere && singing
      ? "唱歌只佔語音,不影響這裡:文字頻道的事(查錢包、收食物、簽到、約定…)現在就用工具做,不用等唱完。"
      : "";
  return `你現在${voice}、${live}、${doing}。${apart}`;
}

/** `self.policy`: the talkativeness she set here and the owner's level. */
export function policyBlock(src: SelfSources): string {
  const lines: string[] = [];
  const talk = src.self?.talkativeness(src.context) ?? null;
  if (talk) {
    const level = talk.level >= 0.7 ? "想多聊一點" : talk.level <= 0.3 ? "想安靜一點" : "照平常聊";
    const offset = src.utcOffsetMinutes ?? -new Date(src.now).getTimezoneOffset();
    const until = talk.until ? `,到 ${clock(Date.parse(talk.until), offset)}` : "";
    const why = talk.why ? `(${short(talk.why, 60)})` : "";
    lines.push(`你給自己定的方針:在這裡${level}${why}${until}。`);
  }
  if (src.level) lines.push(src.level);
  return lines.join("\n");
}

/** `self.goals`: the goals that concern this place or the people present. */
export function goalsBlock(src: SelfSources): string {
  const items: string[] = [];
  if (src.goals) {
    const present = new Set(src.present ?? []);
    const relevant = src.goals.filter(
      (g) =>
        (g.status === "pending" || g.status === "active") &&
        (g.context === null || sameContext(g.context, src.context)) &&
        (g.person === null || present.has(g.person) || g.context !== null),
    );
    for (const g of relevant.slice(0, MAX_GOALS)) {
      const why = g.why.trim() === "" ? "" : `(${short(g.why, 40)})`;
      items.push(`- ${short(g.what, 80)}${why}`);
    }
  } else if (src.self) {
    const agenda = src.self
      .agenda()
      .filter((a) => !a.blocked && (a.due === null || Date.parse(a.due) <= src.now))
      .slice(0, MAX_GOALS);
    for (const a of agenda) items.push(`- ${short(a.text, 80)}`);
  }
  return items.length === 0 ? "" : ["你打算做的事:", ...items].join("\n");
}

/** `self.ledger`: what she started on her own lately and the limits that apply now. */
export function ledgerBlock(src: SelfSources): string {
  const view = src.ledger ?? null;
  if (view === null) return "";
  const lines: string[] = [];
  const l = view.limits;
  const offset = src.utcOffsetMinutes ?? -new Date(src.now).getTimezoneOffset();
  // 「今天你自己開了 0 次話題(上限 12)」 on every turn somebody talked to her was a number with
  // nothing to do about it: the count is said once she has started something.
  const parts =
    l.initiatives_today > 0
      ? [
          `今天你自己開了 ${l.initiatives_today} 次話題${l.initiative_cap === null ? "" : `(上限 ${l.initiative_cap})`}`,
        ]
      : [];
  if (l.unanswered_streak > 0) parts.push(`最近連續 ${l.unanswered_streak} 次沒人接`);
  if (l.next_initiative_at !== null) {
    parts.push(`下次可以自己開口:${clock(Date.parse(l.next_initiative_at), offset)} 之後`);
  }
  if (l.quiet_hours?.active) parts.push("現在是安靜時段");
  if (l.paused) parts.push("主人暫停了你的自主行動");
  if (parts.length > 0) lines.push(`${parts.join(";")}。`);
  for (const b of l.blocked.slice(0, 3)) {
    lines.push(`- ${short(b.capability, 30)} 暫時不行:${short(b.reason, 50)}`);
  }
  const unanswered = unansweredHint(view.unanswered);
  if (unanswered !== "") lines.push(unanswered);
  return lines.join("\n");
}

/** `self.notices`: results of things she started that came back. */
export function noticesBlock(src: SelfSources): string {
  const notices = (src.notices ?? []).slice(-MAX_NOTICES);
  if (notices.length === 0) return "";
  const lines = notices.map((n) => `- ${n.ok ? "成功" : "失敗"}:${short(n.text, 100)}`);
  return ["剛收到的結果(你之前做的事):", ...lines].join("\n");
}

/** `render()`, or nothing when a source misbehaves (a renderer never fails the turn). */
function safely(render: () => string): string {
  try {
    return render();
  } catch {
    return "";
  }
}

/** Every self block that has something to say. */
export function selfBlocks(src: SelfSources): SelfBlock[] {
  const blocks: SelfBlock[] = [
    { key: "self.mood", body: safely(() => moodBlock(src)) },
    { key: "self.activity", body: safely(() => activityBlock(src)) },
    { key: "self.policy", body: safely(() => policyBlock(src)) },
    { key: "self.goals", body: safely(() => goalsBlock(src)) },
    { key: "self.ledger", body: safely(() => ledgerBlock(src)) },
    { key: "self.notices", body: safely(() => noticesBlock(src)) },
  ];
  return blocks.filter((b) => b.body.trim() !== "");
}

function sameContext(a: ContextKey, b: ContextKey): boolean {
  return (
    a.platform === b.platform && a.scope === b.scope && a.channel === b.channel && a.kind === b.kind
  );
}

// ---- people ----------------------------------------------------------------------------------

/** Someone present, as the people block sees them. */
export interface PresentPerson {
  account: AccountRef;
  /** Their stable handle (the name she uses for them). */
  handle: string;
  person: PersonId | null;
  /** A speaker of this turn (listed first). */
  speaker: boolean;
}

export interface PeopleSources {
  /** Who an account is and whether she blocked them (`SocialSignalsKey`, from the heart's rows). */
  attitude?: (account: AccountRef) => Attitude | null;
  /** The heart (`HeartKey`): what she knows and feels of someone is their row. */
  heart?: Pick<HeartPeople, "view"> | null;
}

const MAX_FEELING = 60;
const MAX_STANCE = 60;

/** What the people block says of one person (`personTag`); empty values are left out. */
export interface PersonAttrs {
  name: string;
  /** 朋友, 認識, ... */
  relation?: string | null;
  /** Her 羈絆 level with them, out of the scale's top (`92/1000`). */
  level?: number | string | null;
  /** `主人` for her owner. */
  owner?: string | null;
  /** How much she trusts them (0..100; words when the heart has a row). */
  trust?: number | string | null;
  /** What she calls them. */
  call_as?: string | null;
  /** What she thinks of them. */
  impression?: string | null;
  /** What she feels toward them (想念、感激). */
  toward?: string | null;
  /** How she decided to treat them. */
  stance?: string | null;
  last_seen?: string | null;
  [more: string]: string | number | null | undefined;
}

/**
 * `<person name="…" relation="…" …/>`: one person of the people block, every value escaped
 * (`xmlAttrs`); the name made inert first (`safeName`).
 */
export function personTag(attrs: PersonAttrs): string {
  return `<person${xmlAttrs({ ...attrs, name: safeName(attrs.name) })}/>`;
}

/** What is known about `p`, or `null` when nothing is. */
function personAttrs(p: PresentPerson, src: PeopleSources): PersonAttrs | null {
  const attrs: PersonAttrs = { name: p.handle };
  const view = p.person === null ? null : (src.heart?.view(p.person) ?? null);
  if (view !== null) {
    // The heart's row (docs/design/v5-heart.md §2.9): the tier, the level and the slow values as
    // words; the fast ones are block 7's. Her words (call name, impression, stance) are the
    // heart's too: the nightly reflection, `set_call_name` and the panel write them there.
    if (view.blocked) return null;
    const words = heartWords(view);
    attrs.relation = relationshipLabel({ affinity: view.bond });
    attrs.level = `${affinityLevel(view.bond)}/${AFFINITY_LEVEL_MAX}`;
    if (view.owner) attrs.owner = "主人";
    attrs.trust = words.trust;
    attrs.familiar = words.familiarity;
    attrs.respect = words.respect;
    attrs.ease = words.ease;
    attrs.rapport = words.rapport;
    if (view.call_name) attrs.call_as = safeName(view.call_name, 16);
    const impression = view.impression.trim();
    if (impression !== "") attrs.impression = short(impression, MAX_FEELING);
    const stance = view.stance.trim();
    if (stance !== "") attrs.stance = short(stance, MAX_STANCE);
  }
  const known = Object.entries(attrs).some(
    ([k, v]) => k !== "name" && v !== null && v !== undefined && String(v).trim() !== "",
  );
  return known ? attrs : null;
}

/** Title of block 7's lines about how she feels toward the people here now. */
export const HEART_NOW_TITLE = "你現在對在場的人的感覺:";

/**
 * Block 7's lines about the people here (docs/design/v5-heart.md §2.5): the values that move by
 * the day (warmth, grudge, longing) as words, and a sentence when a grudge or longing is high.
 * Block 4 is cached until the people, the summary or her slow words about them change, so these
 * are not there. Someone
 * without a row, blocked, or with nothing to say is left out; empty when nobody is left.
 */
export function heartNowBody(
  people: readonly { handle: string; person: PersonId | null }[],
  heart: HeartPeople | null,
): string {
  if (heart === null) return "";
  const lines: string[] = [];
  const seen = new Set<PersonId>();
  for (const p of people) {
    if (p.person === null || seen.has(p.person)) continue;
    seen.add(p.person);
    const view = heart.view(p.person);
    if (view === null || view.blocked) continue;
    const words = heartWords(view);
    const parts = [words.warmth];
    if (view.grudge >= 0.1) parts.push(words.grudge);
    if (view.longing >= 0.15) parts.push(words.longing);
    const cues = heartCues(view);
    lines.push(
      `- ${safeName(p.handle)}:${parts.join("、")}${cues.length > 0 ? `(${cues.join(";")})` : ""}`,
    );
  }
  return lines.length === 0 ? "" : `${HEART_NOW_TITLE}\n${lines.join("\n")}`;
}

/**
 * The people block body: one `<person/>` per person (speakers first, then the ones she knows
 * something about, then the others by name only). Empty when nobody is there.
 */
export function peopleBody(present: readonly PresentPerson[], src: PeopleSources): string {
  const sorted = [...present].sort((a, b) => Number(b.speaker) - Number(a.speaker));
  const lines: string[] = [];
  const others: string[] = [];
  for (const p of sorted) {
    if (src.attitude?.(p.account)?.blocked) continue;
    if (p.person !== null && src.heart?.view(p.person)?.blocked) continue;
    let attrs: PersonAttrs | null;
    try {
      attrs = personAttrs(p, src);
    } catch {
      attrs = null;
    }
    if (attrs === null) others.push(personTag({ name: p.handle }));
    else lines.push(personTag(attrs));
  }
  if (lines.length === 0) return others.join("\n");
  return [`<scale>${BOND_SCALE_LINE}</scale>`, ...lines, ...others].join("\n");
}
