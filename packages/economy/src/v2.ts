// Economy 2.0 (docs/design/v4-plan.md §10) as one object the service owns: every desk below shares
// the service's ledger, its turns and its caps. Nothing here changes a balance without a ledger row.

import { errorMessage } from "@miyoria/runtime/kernel";
import type { AccountRef, ContextKey } from "@miyoria/types";
import { AchievementDesk } from "./achievements.js";
import type { EconomyConfig } from "./config.js";
import type { EconomyService, Member } from "./economy.js";
import { Health } from "./health.js";
import { PartyRewardDesk } from "./party.js";
import { PlayDesk } from "./play.js";
import { PredictionDesk } from "./predictions.js";
import { QuestDesk } from "./quests.js";
import type { CoinEntry } from "./records.js";
import { RoomDesk } from "./room.js";
import type {
  AchievementsView,
  AchievementUnlocked,
  BetResult,
  Economy2,
  HealthView,
  PredictionSourceKind,
  PredictionView,
  QuestId,
  QuestResult,
  QuestsView,
  ResolveResult,
  RoomFundResult,
  RoomView,
} from "./v2-types.js";

const ACTIVITY_LABEL: Readonly<Record<string, string>> = {
  game_join: "加入遊戲",
  game_finish: "玩完一場遊戲",
  game_win: "贏了遊戲",
  sing_along: "跟她一起唱",
  headpat: "摸摸她",
  web_reaction: "網頁上的互動",
  prediction_join: "參加預測",
};

/** What a ledger row of economy 2.0 reads as in a wallet; `null` for reasons it does not own. */
export function labelV2(r: CoinEntry, _config: EconomyConfig): string | null {
  switch (r.reason) {
    case "play":
      return (r.ref !== null && ACTIVITY_LABEL[r.ref]) || "一起玩";
    case "achievement":
      return "達成成就";
    case "bet":
      return "押預測";
    case "bet_win":
      return "預測猜中了";
    case "room":
      return "一起佈置她的房間";
    case "quest":
      return r.ref === "all" ? "今天的任務全部完成" : "每日任務";
    default:
      return null;
  }
}

export class V2 implements Economy2 {
  readonly play: PlayDesk;
  /** What party games pay when one ends (party.ts). */
  readonly party: PartyRewardDesk;
  readonly quest: QuestDesk;
  readonly achievement: AchievementDesk;
  readonly prediction: PredictionDesk;
  readonly roomDesk: RoomDesk;
  readonly healthDesk: Health;

  constructor(readonly e: EconomyService) {
    this.play = new PlayDesk(e);
    this.party = new PartyRewardDesk(e);
    this.quest = new QuestDesk(e);
    this.achievement = new AchievementDesk(e);
    this.prediction = new PredictionDesk(e);
    this.roomDesk = new RoomDesk(e);
    this.healthDesk = new Health(e);
  }

  get currency(): string {
    return this.e.config.currency;
  }

  /**
   * What may have become true after coins were earned: milestones. Returns the achievements
   * unlocked just now, for whoever reports the earning to show. Never throws.
   */
  async afterEarn(who: Member): Promise<AchievementUnlocked[]> {
    try {
      return await this.achievement.evaluate(who);
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "cannot check achievements");
      return [];
    }
  }

  /**
   * Settles what ran out: predictions nobody called, stakes a crash left halfway; and deletes the
   * quest picks of days long gone.
   */
  async sweep(): Promise<void> {
    await this.prediction.sweep();
    try {
      await this.quest.prune();
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "cannot prune the old quest picks");
    }
  }

  /**
   * A quest done for someone already known; `null` when it failed (logged, never thrown at the
   * caller).
   */
  async questDone(who: Member, quest: QuestId): Promise<QuestResult | null> {
    try {
      return await this.quest.complete(who, quest);
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error), quest }, "cannot tick a quest");
      return null;
    }
  }

  quests(account: AccountRef, opts: { pick?: boolean } = {}): Promise<QuestsView> {
    return this.quest.view(account, opts);
  }

  completeQuest(account: AccountRef, quest: QuestId, topic?: string): Promise<QuestResult> {
    return this.quest.completeFor(account, quest, topic);
  }

  achievements(account: AccountRef): Promise<AchievementsView> {
    return this.achievement.view(account);
  }

  predictions(account: AccountRef | null, spaces?: readonly string[]): Promise<PredictionView[]> {
    return this.prediction.view(account, spaces);
  }

  openPrediction(req: {
    question: string;
    options: readonly string[];
    minutes: number;
    settle_by?: PredictionSourceKind | null;
    context?: ContextKey | null;
  }): Promise<PredictionView> {
    return this.prediction.open(req);
  }

  placeBet(
    account: AccountRef,
    ref: string,
    option: string | number,
    amount: number,
    key: string,
  ): Promise<BetResult> {
    return this.prediction.bet(account, ref, option, amount, key);
  }

  resolvePrediction(ref: string, option: string | number): Promise<ResolveResult> {
    return this.prediction.resolve(ref, option);
  }

  cancelPrediction(ref: string): Promise<ResolveResult> {
    return this.prediction.cancel(ref);
  }

  resolvePredictionByAdmin(
    ref: string,
    option: string | number,
    who: string,
  ): Promise<ResolveResult> {
    return this.prediction.resolveByAdmin(ref, option, who);
  }

  cancelPredictionByAdmin(ref: string, who: string): Promise<ResolveResult> {
    return this.prediction.cancelByAdmin(ref, who);
  }

  room(): Promise<RoomView[]> {
    return this.roomDesk.view();
  }

  fundRoom(
    account: AccountRef,
    item: string,
    amount: number,
    key: string,
  ): Promise<RoomFundResult> {
    return this.roomDesk.fund(account, item, amount, key);
  }

  health(): Promise<HealthView> {
    return this.healthDesk.view();
  }
}
