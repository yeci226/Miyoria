// The "想做的事" list (§3.7): before each Plan, code ranks what she might want to do from her
// feelings (`AffectSnapshot.biases.wants`), her drives, how much she cares about people and who
// is online, each with the numbers behind it ("找 Owen 聊天(想念 0.6 × 在意 0.8,他在線)").
// She picks from it or proposes something else. Pure.

import {
  type AffectSnapshot,
  type Desire,
  EMOTION_LABELS,
  type Goal,
  type Handle,
  PERSON_EMOTION_NAMES,
  PERSON_EMOTION_OUTPUTS,
  type PersonCard,
} from "@miyoria/types";
import {
  type LifeOption,
  type LifeSituation,
  lifeActivity,
  lifeOptions,
  unfit,
} from "./life/activities.js";

/** Desires listed at most. */
export const MAX_DESIRES = 6;
/** Below this a desire is not listed. */
export const MIN_DESIRE = 0.15;

/** Where someone is, as far as Plan can tell. */
export type Whereabouts = "voice" | "online" | "offline";

export interface DesireInputs {
  affect: AffectSnapshot | null;
  /** Her cards, highest attachment first. */
  cards: readonly Pick<PersonCard, "handle" | "attachment" | "emotions" | "blocked">[];
  where(handle: Handle): Whereabouts;
  /** Her open goals, and the ids of those whose trigger fired just now. */
  goals: readonly Goal[];
  fired: ReadonlySet<string>;
  /** Capabilities she has (only those are suggested). */
  capabilities: ReadonlySet<string>;
  /** What she is doing (`game`, `singing`, ...), `null`: nothing in particular. */
  activity: string | null;
  /** She is in a voice channel. */
  inVoice: boolean;
  /** People at or above this attachment are the ones she cares about. */
  cared: number;
  /**
   * Her day so far and what fits now (v4 §8.2): wants like `explore` lead to a row of the
   * activity table. Without it they fall back to the plain capability (`web.search`).
   */
  life?: LifeSituation;
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
const round2 = (v: number) => Math.round(v * 100) / 100;

const WHERE_TEXT: Record<Whereabouts, string> = {
  voice: "他在語音裡",
  online: "他在線",
  offline: "他不在線",
};

/** How reachable someone is: being there counts fully, being away a little. */
const REACH: Record<Whereabouts, number> = { voice: 1, online: 1, offline: 0.3 };

/** The capability that reaches someone where they are. */
function reachFor(where: Whereabouts, caps: ReadonlySet<string>, inVoice: boolean): string | null {
  if (where === "voice" && !inVoice && caps.has("voice.join")) return "voice.join";
  if (where === "voice") return "chat.start";
  if (where === "online") return "chat.dm";
  return null;
}

/** The ranked desires, strongest first. */
export function rankDesires(i: DesireInputs): Desire[] {
  const out = new Map<string, Desire>();
  /** What her feelings toward someone leave of a wish about them (`distance` of the table). */
  const left = (person: Handle | null): number => {
    const felt = person === null ? undefined : i.cards.find((c) => c.handle === person)?.emotions;
    let share = 1;
    for (const name of PERSON_EMOTION_NAMES) {
      share *= 1 - PERSON_EMOTION_OUTPUTS[name].distance * clamp01(felt?.[name] ?? 0);
    }
    return share;
  };
  const add = (d: Desire) => {
    // Her own goals stay what she decided: a feeling only leans the wishes it caused.
    const share = d.goal === null ? left(d.person) : 1;
    const weight = round2(clamp01(d.weight) * share);
    if (weight < MIN_DESIRE) return;
    const key = `${d.want}|${d.person ?? ""}|${d.goal ?? ""}`;
    const prev = out.get(key);
    if (!prev || prev.weight < weight) out.set(key, { ...d, weight });
  };
  const card = (h: Handle | null) => (h === null ? undefined : i.cards.find((c) => c.handle === h));
  const has = (cap: string) => (i.capabilities.has(cap) ? cap : null);
  const a = i.affect;
  const lonely = a?.top.find((e) => e.name === "lonely")?.intensity ?? 0;
  /** A row of the activity table as a desire (`fit`: how much it varies her day). */
  const addLife = (want: string, o: LifeOption, weight: number, why: string) =>
    add({
      want,
      label: o.activity.label,
      weight: weight * (0.6 + 0.4 * o.fit),
      why: `${why},${o.why};${o.activity.does}`,
      person: null,
      capability: o.capability,
      goal: null,
    });
  /**
   * Wanting something new leads somewhere (2026-11-10: `explore` had no capability and she only
   * ever played or sang): the best fitting row, else the web, else just the wish.
   */
  const explore = (weight: number, why: string) => {
    const best = i.life ? lifeOptions(i.life, ["explore", "curiosity"])[0] : undefined;
    if (best) {
      addLife("explore", best, weight, why);
      return;
    }
    const web = i.life ? null : has("web.search");
    add({
      want: "explore",
      label: web === null ? "找點新鮮事" : "逛網路",
      weight,
      why,
      person: null,
      capability: web,
      goal: null,
    });
  };

  for (const w of a?.biases.wants ?? []) {
    switch (w.want) {
      case "chat_with":
      case "find_person": {
        // The person to go to: the one the bias names if reachable, else the closest one who is.
        const named = card(w.person);
        const reachable = i.cards.filter(
          (c) => !c.blocked && c.attachment >= i.cared && i.where(c.handle) !== "offline",
        );
        const target =
          named && i.where(named.handle) !== "offline" ? named : (reachable[0] ?? named);
        if (!target) {
          add({
            want: "chat_with",
            label: "找人聊天",
            weight: w.weight * 0.6,
            why: `${w.why}(${w.from ? EMOTION_LABELS[w.from] : "寂寞"} ${n1(Math.max(lonely, w.weight))}),但在意的人都不在線`,
            person: null,
            capability: has("chat.start"),
            goal: null,
          });
          break;
        }
        const where = i.where(target.handle);
        const missing = target.emotions.missing ?? 0;
        const feeling =
          w.want === "find_person"
            ? Math.max(missing, w.weight - 0.15)
            : Math.max(lonely, w.weight);
        const label = w.want === "find_person" ? "想念" : w.from ? EMOTION_LABELS[w.from] : "寂寞";
        add({
          want: w.want,
          label: `找 ${target.handle} 聊天`,
          weight: feeling * Math.max(target.attachment, 0.3) * REACH[where] + 0.2 * REACH[where],
          why: `${label} ${n1(feeling)} × 在意 ${n1(target.attachment)},${WHERE_TEXT[where]}`,
          person: target.handle,
          capability: reachFor(where, i.capabilities, i.inVoice),
          goal: null,
        });
        break;
      }
      case "play": {
        const why = `${w.why}(想玩 ${n1(a?.drives.play ?? 0)}、無聊 ${n1(a?.boredom ?? 0)})`;
        // §8.2: games have a share of her day; past it the wish to play leads elsewhere.
        const game = i.life ? unfit(lifeActivity("game"), i.life) : null;
        const over =
          game !== null && "reason" in game && i.activity !== "game" && has("game.start") !== null
            ? game.reason
            : null;
        if (over !== null) {
          add({
            want: "play",
            label: "玩遊戲",
            weight: w.weight * 0.3,
            why: `${why},但${over}`,
            person: null,
            capability: null,
            goal: null,
          });
          const other = i.life
            ? lifeOptions(i.life, ["play", "explore"]).find((o) => o.activity.id !== "game")
            : undefined;
          if (other) addLife("explore", other, w.weight * 0.8, "想玩但今天遊戲玩夠了");
          break;
        }
        add({
          want: "play",
          label: i.activity === "game" ? "繼續玩遊戲" : "玩遊戲",
          weight: w.weight,
          why,
          person: null,
          capability: i.activity === "game" ? null : has("game.start"),
          goal: null,
        });
        break;
      }
      case "stream":
        add({
          want: "stream",
          label: "開台",
          weight: w.weight,
          why: `${w.why}(想被注意 ${n1(a?.drives.attention ?? 0)})`,
          person: null,
          capability: has("stream.start"),
          goal: null,
        });
        break;
      case "rest": {
        add({
          want: "rest",
          label: i.inVoice ? "收台休息" : "休息一下",
          weight: w.weight,
          why: `${w.why}(想休息 ${n1(a?.drives.rest ?? 0)})`,
          person: null,
          capability: i.inVoice ? has("voice.leave") : null,
          goal: null,
        });
        // A quiet thing of her own that fits being tired (her diary in the evening).
        const quiet = i.life ? lifeOptions(i.life, ["rest"])[0] : undefined;
        if (quiet) addLife("calm", quiet, w.weight * 0.7, w.why);
        break;
      }
      case "explore":
        explore(w.weight, w.why);
        break;
      case "sing":
        add({
          want: "sing",
          label: "唱歌",
          weight: w.weight,
          why: w.why,
          person: null,
          capability: i.activity === "singing" ? null : has("sing.request"),
          goal: null,
        });
        break;
      default:
        add({
          want: w.want,
          label: w.want,
          weight: w.weight,
          why: w.why,
          person: w.person,
          capability: null,
          goal: null,
        });
    }
  }

  // People she cares about who are around (even without a strong feeling right now).
  const covered = new Set([...out.values()].flatMap((d) => (d.person === null ? [] : [d.person])));
  for (const c of i.cards.slice(0, 8)) {
    if (c.blocked || c.attachment < i.cared || covered.has(c.handle)) continue;
    const where = i.where(c.handle);
    if (where === "offline") continue;
    const missing = c.emotions.missing ?? 0;
    const social = a?.drives.social ?? 0;
    const pull = Math.max(missing, social);
    add({
      want: "chat_with",
      label: `找 ${c.handle} 聊天`,
      weight: 0.15 + pull * c.attachment + 0.2 * c.attachment,
      why: `${missing > 0.1 ? `想念 ${n1(missing)}` : `想聊天 ${n1(social)}`} × 在意 ${n1(c.attachment)},${WHERE_TEXT[where]}`,
      person: c.handle,
      capability: reachFor(where, i.capabilities, i.inVoice),
      goal: null,
    });
  }

  // Curiosity: something new, on the web, in code, in her notes (§8.1).
  const curiosity = a?.drives.curiosity ?? 0;
  if (curiosity > 0.4) explore(curiosity * 0.6, `好奇 ${n1(curiosity)}`);

  // Boredom: anything of her own that fits now and varies her day.
  const boredom = a?.boredom ?? 0;
  if (i.life && boredom > 0.5) {
    const taken = new Set([...out.values()].map((d) => d.capability));
    const pick = lifeOptions(i.life).find((o) => !taken.has(o.capability));
    if (pick) addLife("life", pick, boredom * 0.5, `無聊 ${n1(boredom)}`);
  }

  // Her own goals: fired ones first, the rest as things she meant to do.
  for (const g of i.goals) {
    const fired = i.fired.has(g.id);
    const where = g.person === null ? null : i.where(g.person);
    add({
      want: "goal",
      label: g.what,
      weight: fired ? 0.85 : g.trigger.kind === "whenever" ? 0.35 : 0.25,
      why: [
        fired ? "觸發條件到了" : "你之前定的目標",
        where === null ? null : WHERE_TEXT[where],
        g.why === "" ? null : g.why,
      ]
        .filter((s) => s !== null)
        .join(","),
      person: g.person,
      capability: where === null ? null : reachFor(where, i.capabilities, i.inVoice),
      goal: g.id,
    });
  }

  return [...out.values()]
    .sort((x, y) => y.weight - x.weight || (x.label < y.label ? -1 : 1))
    .slice(0, MAX_DESIRES);
}

/** `找 Owen 聊天(想念 0.6 × 在意 0.8,他在線)`. */
export function renderDesire(d: Desire): string {
  return `${d.label}(${d.why})`;
}
