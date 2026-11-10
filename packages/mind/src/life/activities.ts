// Her life of her own (docs/design/v4-plan.md §8.1, §8.2): the things she can do when nobody
// needs her, each tied to a capability, and who decides which one fits now.
//
// 2026-11-10: the owner's complaint was that she only plays games or sings and "is not
// autonomous". The cause (§2.8) was that her wants led nowhere else: `explore` had no capability
// at all, and nothing pushed her to the web, a diary or code. Every row here names the
// capabilities that do it; a row whose capability is not registered (the party games, the
// notebook and the diary are being built in other packages) is skipped, not imported, so it
// lights up the day its package registers it.
//
// Pure: the mind gathers the situation, this ranks. Owner rules, quiet hours and budgets stay
// above anything here (§8.4): a held capability, a budget that is not ok or a row over its share
// of her day is never suggested, and the share also stops her own Plan (`overShare`).

import type { LifeActivityId } from "@miyoria/types";

/** Who has to be around. */
export type PeopleNeed =
  /** With or without people. */
  | "any"
  /** Someone she can talk to is around (online or in voice). */
  | "someone"
  /** Two or more people in voice. */
  | "group";

export interface LifeActivity {
  id: LifeActivityId;
  /** 「逛網路」 */
  label: string;
  /** What she does (§8.1 她做什麼). */
  does: string;
  /** What it leaves (§8.1 留下什麼). */
  leaves: string;
  /** Capabilities that do it, preferred first; the first registered one is suggested. */
  capabilities: readonly string[];
  /** Wants (affect biases and drives) that lead here. */
  wants: readonly string[];
  people: PeopleNeed;
  /** Local hours `[from, to)` it fits (may wrap past midnight); `null`: any time. */
  hours: readonly [number, number] | null;
  /** The least energy it takes (0..1). */
  minEnergy: number;
  /** At most this share of her waking day (`[modules.mind] game_share` replaces it for games). */
  share: number;
  /** At most this many times a day; `null`: no count. */
  perDay: number | null;
  /** Not suggested again this long after she did it. */
  cooldownMins: number;
  /** Minutes one act of it counts for in her day (a search, a program, a diary entry). */
  actMinutes: number;
  /**
   * Suggested from the table. `false`: other desires already cover it (people she cares about,
   * singing for someone), it is only listed and logged.
   */
  generic: boolean;
}

/** Capability ids of things being built elsewhere (registered once their packages run). */
export const FUTURE_CAPABILITIES = {
  /**
   * PR 8's diary: registered by `reflect` once `[modules.reflect.diary] channel` is set
   * (packages/learning/src/diary.ts), off by default.
   */
  diary: "diary.write",
  /** The notebook of `@miyoria/memory` (§5, §8.1 筆記). */
  notebook: "notebook.write",
  /** Her persistent sandbox workspace (§8.3 item 2). */
  workspace: "workspace.write",
  /** A skill she saved (§8.3 item 3). */
  skill: "skill.run",
  /** A party game in voice (`@miyoria/party`, §9.1). */
  party: "party.start",
} as const;

/** §8.1, in its order. */
export const LIFE_ACTIVITIES: readonly LifeActivity[] = [
  {
    id: "browse",
    label: "逛網路",
    does: "查有興趣的東西、看新聞、追動畫和遊戲消息",
    leaves: "筆記;之後聊天的話題",
    capabilities: ["web.search", "web.read"],
    wants: ["explore", "curiosity"],
    people: "any",
    hours: null,
    minEnergy: 0.15,
    share: 0.3,
    perDay: null,
    cooldownMins: 45,
    actMinutes: 5,
    generic: true,
  },
  {
    id: "diary",
    label: "寫日記",
    does: "寫今天的日記,偶爾寫週記",
    leaves: "日記頻道;「今天的她」",
    capabilities: [FUTURE_CAPABILITIES.diary],
    wants: ["rest", "explore"],
    people: "any",
    hours: [20, 3],
    minEnergy: 0,
    share: 0.2,
    perDay: 1,
    cooldownMins: 0,
    actMinutes: 15,
    generic: true,
  },
  {
    id: "code",
    label: "寫程式",
    does: "在沙箱做小專案:伺服器用的小工具、遊戲題庫、自己的腳本",
    leaves: "她自己的 repo;做好會炫耀",
    capabilities: [FUTURE_CAPABILITIES.workspace, FUTURE_CAPABILITIES.skill, "code.run"],
    wants: ["explore", "curiosity"],
    people: "any",
    hours: [9, 1],
    minEnergy: 0.4,
    share: 0.3,
    perDay: null,
    cooldownMins: 90,
    actMinutes: 15,
    generic: true,
  },
  {
    id: "practice",
    label: "練歌",
    does: "自己選一首歌先準備好",
    leaves: "新歌預告;歌單",
    capabilities: ["sing.request"],
    wants: ["sing", "attention"],
    people: "any",
    hours: [9, 24],
    minEnergy: 0.3,
    share: 0.2,
    perDay: 3,
    cooldownMins: 120,
    actMinutes: 10,
    generic: true,
  },
  {
    id: "game",
    label: "玩遊戲",
    does: "Minecraft,之後的 osu 和其他",
    leaves: "精華片段;遊戲裡的進度",
    capabilities: ["game.start"],
    wants: ["play"],
    people: "any",
    hours: null,
    minEnergy: 0.25,
    share: 0.35,
    perDay: null,
    cooldownMins: 30,
    actMinutes: 30,
    generic: true,
  },
  {
    id: "recap",
    label: "整理回憶",
    does: "把精華和好笑的對話整理成週報",
    leaves: "每週一則回顧",
    capabilities: [FUTURE_CAPABILITIES.notebook],
    wants: ["rest", "explore"],
    people: "any",
    hours: [14, 2],
    minEnergy: 0.2,
    share: 0.15,
    perDay: 1,
    cooldownMins: 0,
    actMinutes: 15,
    generic: true,
  },
  {
    id: "business",
    label: "經營",
    does: "開懸賞、辦募資、進貨小店",
    leaves: "公告",
    capabilities: ["economy.post_bounty", "economy.propose_goal"],
    wants: ["attention", "social"],
    people: "someone",
    hours: [10, 24],
    minEnergy: 0.3,
    share: 0.15,
    perDay: 2,
    cooldownMins: 180,
    actMinutes: 5,
    generic: true,
  },
  {
    id: "care",
    label: "關心人",
    does: "追問之前的事、生日、取得同意的私訊",
    leaves: "對話",
    capabilities: ["chat.start", "chat.dm"],
    wants: ["chat_with", "find_person", "social"],
    people: "someone",
    hours: [9, 1],
    minEnergy: 0,
    share: 1,
    perDay: null,
    cooldownMins: 0,
    actMinutes: 0,
    generic: false,
  },
  {
    id: "event",
    label: "辦活動",
    does: "約時間、公告、主持派對遊戲",
    leaves: "活動",
    capabilities: [FUTURE_CAPABILITIES.party],
    wants: ["play", "social", "attention"],
    people: "group",
    hours: [12, 1],
    minEnergy: 0.4,
    share: 0.3,
    perDay: 2,
    cooldownMins: 60,
    actMinutes: 30,
    generic: true,
  },
  {
    id: "sing",
    label: "唱歌",
    does: "唱歌給大家聽",
    leaves: "歌單",
    capabilities: ["sing.play"],
    wants: ["sing"],
    people: "any",
    hours: null,
    minEnergy: 0,
    share: 1,
    perDay: null,
    cooldownMins: 0,
    actMinutes: 4,
    generic: false,
  },
];

export function lifeActivity(id: LifeActivityId): LifeActivity {
  const found = LIFE_ACTIVITIES.find((a) => a.id === id);
  if (!found) throw new Error(`unknown life activity \`${id}\``);
  return found;
}

/** The row a capability belongs to (the first one listing it). */
export function activityOfCapability(capability: string): LifeActivity | null {
  return LIFE_ACTIVITIES.find((a) => a.generic && a.capabilities.includes(capability)) ?? null;
}

/** What she did of one row today. */
export interface LifeTally {
  count: number;
  /** Minutes it took (runs with a duration, else `count × actMinutes`). */
  minutes: number;
  /** When she last did it (epoch ms). */
  last: number | null;
}

export const NO_TALLY: LifeTally = { count: 0, minutes: 0, last: null };

/** Everything the choice depends on. */
export interface LifeSituation {
  now: number;
  /** Her local hour (0..23). */
  hour: number;
  /** Capabilities she has now (registered, not hers to never use). */
  capabilities: ReadonlySet<string>;
  /** Her energy (0..1). */
  energy: number;
  /** People she could talk to who are around. */
  people: number;
  /** People in voice (where she is, or the busiest channel). */
  voicePeople: number;
  /** Today per row. */
  done: ReadonlyMap<LifeActivityId, LifeTally>;
  /** How long she has been up today, minutes. */
  awakeMinutes: number;
  /** `[modules.mind] game_share`. */
  gameShare: number;
  /** Why she may not use `capability` on her own now (owner rules, holds), `null`: she may. */
  held(capability: string): string | null;
  /** The LLM budget is `ok` (else nothing optional is suggested). */
  budgetOk: boolean;
  /** What she is doing now (`game`, `singing`, `browse`), `null`: nothing in particular. */
  doing: string | null;
}

/** A row that fits now. */
export interface LifeOption {
  activity: LifeActivity;
  capability: string;
  /** 0..1: how well it fits her day (variety). */
  fit: number;
  /** Why, short (「今天還沒做過」). */
  why: string;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function inHours(hours: readonly [number, number] | null, hour: number): boolean {
  if (hours === null) return true;
  const [from, to] = hours;
  if (from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to % 24;
}

/** The share of her day a row may take. */
export function shareOf(activity: LifeActivity, gameShare: number): number {
  return activity.id === "game" ? gameShare : activity.share;
}

function hm(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} 分鐘`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} 小時` : `${h} 小時 ${m % 60} 分`;
}

/**
 * Why she has had enough of `activity` today (share of her waking day, times a day), `null`: she
 * has not. The variety rule of §8.2, games capped hardest.
 */
export function overShare(
  activity: LifeActivity,
  tally: LifeTally,
  awakeMinutes: number,
  gameShare: number,
): string | null {
  if (activity.perDay !== null && tally.count >= activity.perDay) {
    return `今天已經${activity.label} ${tally.count} 次了`;
  }
  const share = shareOf(activity, gameShare);
  if (share >= 1) return null;
  const allowed = Math.max(awakeMinutes, 60) * share;
  if (tally.minutes >= allowed) {
    return `今天${activity.label}已經 ${hm(tally.minutes)},超過今天的 ${Math.round(share * 100)}%`;
  }
  return null;
}

/** Why `activity` does not fit now, `null`: it does; `capability` is the one it would use. */
export function unfit(
  activity: LifeActivity,
  s: LifeSituation,
): { reason: string } | { capability: string } {
  const capability = activity.capabilities.find((c) => s.capabilities.has(c));
  if (capability === undefined) return { reason: "還不能做(功能沒開)" };
  const held = s.held(capability);
  if (held !== null) return { reason: held };
  if (!s.budgetOk && activity.actMinutes > 0) return { reason: "今天的額度吃緊" };
  if (!inHours(activity.hours, s.hour)) return { reason: "不是時候" };
  if (s.energy < activity.minEnergy) return { reason: "沒力氣" };
  if (activity.people === "someone" && s.people + s.voicePeople === 0) {
    return { reason: "沒有人在" };
  }
  if (activity.people === "group" && s.voicePeople < 2) return { reason: "語音裡不到兩個人" };
  if (activity.id === "game" && s.doing === "game") return { reason: "已經在玩了" };
  if (activity.id === "practice" && (s.doing === "singing" || s.doing === "game")) {
    return { reason: "GPU 在忙" };
  }
  const tally = s.done.get(activity.id) ?? NO_TALLY;
  const over = overShare(activity, tally, s.awakeMinutes, s.gameShare);
  if (over !== null) return { reason: over };
  if (tally.last !== null && s.now - tally.last < activity.cooldownMins * 60_000) {
    return { reason: "剛做過" };
  }
  return { capability };
}

/** How well a row that fits varies her day (0..1), and why. */
function fitOf(activity: LifeActivity, s: LifeSituation): { fit: number; why: string } {
  const tally = s.done.get(activity.id) ?? NO_TALLY;
  if (tally.count === 0) return { fit: 1, why: "今天還沒做過" };
  const share = shareOf(activity, s.gameShare);
  const used = share >= 1 ? 0 : tally.minutes / (Math.max(s.awakeMinutes, 60) * share);
  return {
    fit: round2(Math.max(0.2, 0.8 * (1 - used))),
    why: `今天做過 ${tally.count} 次`,
  };
}

/** Rows that fit now, best fit first (ties: table order); `wants`: only rows these lead to. */
export function lifeOptions(s: LifeSituation, wants?: readonly string[]): LifeOption[] {
  const out: LifeOption[] = [];
  for (const activity of LIFE_ACTIVITIES) {
    if (!activity.generic) continue;
    if (wants !== undefined && !activity.wants.some((w) => wants.includes(w))) continue;
    const verdict = unfit(activity, s);
    if ("reason" in verdict) continue;
    out.push({ activity, capability: verdict.capability, ...fitOf(activity, s) });
  }
  return out.sort((a, b) => b.fit - a.fit);
}

/** Every row with whether it fits now and why not, for the panel and tests. */
export function lifeTable(
  s: LifeSituation,
): { activity: LifeActivity; capability: string | null; reason: string | null }[] {
  return LIFE_ACTIVITIES.map((activity) => {
    const verdict = unfit(activity, s);
    return "reason" in verdict
      ? { activity, capability: null, reason: verdict.reason }
      : { activity, capability: verdict.capability, reason: null };
  });
}
