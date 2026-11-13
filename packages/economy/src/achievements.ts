// Achievements and titles (docs/design/v4-plan.md §10). An achievement is a milestone of what the
// person already did (read off their ledger and collection), paid once: a `small` or a `big`
// reward (`achievement_small`, `achievement_big`) under the day's `achievement_cap`. Unlocking is a
// ledger row (reason `achievement`, ref the id, key `achv:<id>`), so it is paid once per person
// across all their accounts and survives restarts. When the day's cap is reached nothing is posted
// and the milestone is simply found again at the next check. She is told with a silent note (one
// per person and achievement); people see it where the earning that unlocked it is reported
// (notices.ts).
//
// A title is the name an achievement gives (a series' completed set gives its own), shown beside
// the person's wallet; titles from her shop come with the shop (shop.ts). Nothing here ranks
// anyone and no number or title reaches her feelings for the person (docs/design/v4-plan.md §15).

import type { CoinEntry } from "@miyoria/store";
import type { AccountRef } from "@miyoria/types";
import { type EconomyService, localDay, type Member } from "./economy.js";
import type { AchievementsView, AchievementUnlocked, AchievementView } from "./v2-types.js";

/** What an achievement is judged from. */
export interface Stats {
  checkins: number;
  /** The longest run of consecutive check-in days ever. */
  best_streak: number;
  feeds: number;
  songs: number;
  quests: number;
  games: number;
  draws: number;
  bets: number;
  commissions: number;
  room_funds: number;
  /** Distinct collectibles owned. */
  items: number;
  /** Ids of the series owned completely. */
  series: ReadonlySet<string>;
}

interface Def {
  id: string;
  label: string;
  title: string;
  size: "small" | "big";
  test: (s: Stats) => boolean;
}

const BASE: readonly Def[] = [
  {
    id: "first_checkin",
    label: "第一次簽到",
    title: "新面孔",
    size: "small",
    test: (s) => s.checkins >= 1,
  },
  {
    id: "streak_7",
    label: "連續簽到 7 天",
    title: "常客",
    size: "small",
    test: (s) => s.best_streak >= 7,
  },
  {
    id: "streak_30",
    label: "連續簽到 30 天",
    title: "全勤",
    size: "big",
    test: (s) => s.best_streak >= 30,
  },
  {
    id: "first_feed",
    label: "第一次餵她",
    title: "餵食員",
    size: "small",
    test: (s) => s.feeds >= 1,
  },
  {
    id: "feeds_20",
    label: "餵了她 20 次",
    title: "投餵大師",
    size: "big",
    test: (s) => s.feeds >= 20,
  },
  {
    id: "first_song",
    label: "第一首點的歌被她唱完",
    title: "點歌人",
    size: "small",
    test: (s) => s.songs >= 1,
  },
  {
    id: "songs_10",
    label: "點的歌被她唱完 10 次",
    title: "歌迷",
    size: "big",
    test: (s) => s.songs >= 10,
  },
  {
    id: "first_quest",
    label: "第一個每日任務",
    title: "跑腿",
    size: "small",
    test: (s) => s.quests >= 1,
  },
  {
    id: "quests_30",
    label: "完成 30 個每日任務",
    title: "任務達人",
    size: "big",
    test: (s) => s.quests >= 30,
  },
  {
    id: "first_game",
    label: "第一次一起玩遊戲",
    title: "玩家",
    size: "small",
    test: (s) => s.games >= 1,
  },
  {
    id: "games_20",
    label: "一起玩了 20 次",
    title: "派對咖",
    size: "big",
    test: (s) => s.games >= 20,
  },
  {
    id: "first_draw",
    label: "第一次抽收藏",
    title: "抽卡新手",
    size: "small",
    test: (s) => s.draws >= 1,
  },
  {
    id: "items_10",
    label: "集到 10 種收藏",
    title: "收藏家",
    size: "big",
    test: (s) => s.items >= 10,
  },
  {
    id: "first_bet",
    label: "第一次參加預測",
    title: "預言家",
    size: "small",
    test: (s) => s.bets >= 1,
  },
  {
    id: "first_commission",
    label: "第一次委託她",
    title: "委託人",
    size: "small",
    test: (s) => s.commissions >= 1,
  },
  {
    id: "first_room",
    label: "第一次一起布置她的房間",
    title: "室內設計",
    size: "small",
    test: (s) => s.room_funds >= 1,
  },
];

const MAX_ROWS = 2_000;

/** The longest run of consecutive numbers in `days`. */
export function longestStreak(days: ReadonlySet<number>): number {
  let best = 0;
  for (const day of days) {
    if (days.has(day - 1)) continue;
    let n = 1;
    while (days.has(day + n)) n += 1;
    best = Math.max(best, n);
  }
  return best;
}

export class AchievementDesk {
  constructor(private readonly e: EconomyService) {}

  /** Every achievement there is: the fixed ones and one per series. */
  defs(): Def[] {
    const series: Def[] = this.e.config.collection_series.map((s) => ({
      id: `series:${s.id}`,
      label: `集齊「${s.label}」`,
      title: s.title,
      size: "big",
      test: (st: Stats) => st.series.has(s.id),
    }));
    return [...BASE, ...series];
  }

  async #stats(who: Member): Promise<Stats> {
    const ledger = this.e.ledger();
    const count = async (reasons: string[]): Promise<CoinEntry[]> =>
      ledger.entries(this.e.profile, who.wallet, { reasons, limit: MAX_ROWS });
    const offset = this.e.config.utc_offset_minutes;
    const days = new Set((await count(["checkin"])).map((r) => localDay(Date.parse(r.ts), offset)));
    const [feeds, songs, quests, plays, draws, bets, commissions, room] = await Promise.all([
      count(["feed"]),
      count(["song"]),
      count(["quest"]),
      count(["play"]),
      count(["draw"]),
      count(["bet"]),
      count(["commission"]),
      count(["room_fund"]),
    ]);
    const owned = await this.e.v2.collection.owned(who);
    return {
      checkins: days.size,
      best_streak: longestStreak(days),
      feeds: feeds.length,
      songs: songs.length,
      quests: quests.filter((r) => r.ref !== "all").length,
      games: plays.filter((r) => (r.ref ?? "").startsWith("game_")).length,
      draws: draws.length,
      bets: bets.length,
      commissions: commissions.length,
      room_funds: room.length,
      items: owned.items.size,
      series: owned.series,
    };
  }

  async #unlockedRows(who: Member): Promise<Map<string, CoinEntry>> {
    const rows = await this.e.ledger().entries(this.e.profile, who.wallet, {
      reasons: ["achievement"],
      limit: MAX_ROWS,
    });
    return new Map(rows.map((r) => [r.ref ?? "", r]));
  }

  /** Pays every achievement reached and not yet paid; returns the ones that were just now. */
  async evaluate(who: Member): Promise<AchievementUnlocked[]> {
    const c = this.e.config;
    const stats = await this.#stats(who);
    return this.e.serial(async () => {
      const have = await this.#unlockedRows(who);
      const fresh: AchievementUnlocked[] = [];
      for (const def of this.defs()) {
        if (have.has(def.id) || !def.test(stats)) continue;
        const amount = def.size === "big" ? c.achievement_big : c.achievement_small;
        const paid = await this.e.faucet(
          who,
          "achievement",
          amount,
          `achv:${def.id}`,
          def.id,
          { reasons: ["achievement"], limit: c.achievement_cap },
          false,
        );
        if (paid.status !== "paid") continue;
        fresh.push({ id: def.id, label: def.label, title: def.title, paid: paid.paid });
        this.e.tell(
          who,
          "economy.achievement",
          `economy:achv:${def.id}:${who.person.id}`,
          `${who.name}解鎖了成就「${def.label}」(稱號「${def.title}」)`,
        );
      }
      return fresh;
    });
  }

  async view(account: AccountRef): Promise<AchievementsView> {
    const who = await this.e.member(account);
    if (!who) return { achievements: [], titles: [] };
    await this.e.v2.afterEarn(who);
    const have = await this.#unlockedRows(who);
    const list: AchievementView[] = this.defs().map((d) => {
      const row = have.get(d.id);
      return {
        id: d.id,
        label: d.label,
        title: d.title,
        reward: d.size === "big" ? this.e.config.achievement_big : this.e.config.achievement_small,
        unlocked_at: row?.ts ?? null,
      };
    });
    const titles = [
      ...list.filter((a) => a.unlocked_at !== null).map((a) => a.title),
      ...(await this.e.v2.shopDesk.titles(who)),
    ];
    return { achievements: list, titles: [...new Set(titles)] };
  }
}
