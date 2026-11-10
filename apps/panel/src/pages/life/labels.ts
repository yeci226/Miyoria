import type { LifeActivityId } from "@/api/v4-types";

/** The rows of §8.1, as the Core's table names them. */
export const ACTIVITY_LABEL: Record<LifeActivityId, string> = {
  browse: "逛網路",
  diary: "寫日記",
  code: "寫程式",
  practice: "練歌",
  game: "玩遊戲",
  recap: "整理回憶",
  business: "經營",
  care: "關心人",
  event: "辦活動",
  sing: "唱歌",
};

export const activityLabel = (id: string): string => ACTIVITY_LABEL[id as LifeActivityId] ?? id;

export const PEOPLE_LABEL = { any: "有沒有人都行", someone: "要有人在", group: "語音要兩人以上" } as const;

/** `20 到 3 點`; `null`: any time. */
export function hoursText(hours: [number, number] | null): string {
  if (hours === null || hours[0] === hours[1]) return "整天";
  return `${hours[0]} 到 ${hours[1]} 點`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** `45 分鐘`, `1 小時 20 分`. */
export function fmtMinutes(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} 分鐘`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} 小時` : `${h} 小時 ${m % 60} 分`;
}
