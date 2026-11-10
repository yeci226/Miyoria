// Economy 2.0 (docs/design/v4-plan.md §10) as one object the service owns: every desk below shares
// the service's ledger, its turns and its caps. Nothing here changes a balance without a ledger row.

import { errorMessage } from "@miyoria/kernel";
import type { CoinEntry } from "@miyoria/store";
import type { AccountRef } from "@miyoria/types";
import { AchievementDesk } from "./achievements.js";
import { Collection } from "./collection.js";
import { CommissionDesk } from "./commissions.js";
import type { EconomyConfig, Rarity } from "./config.js";
import type { EconomyService, Member } from "./economy.js";
import { Health } from "./health.js";
import { PartyRewardDesk } from "./party.js";
import { PlayDesk } from "./play.js";
import { PredictionDesk } from "./predictions.js";
import { QuestDesk } from "./quests.js";
import { RoomDesk } from "./room.js";
import { ShopDesk } from "./shop.js";
import type {
  AchievementsView,
  AlbumView,
  BetResult,
  CommissionKind,
  CommissionResult,
  CommissionView,
  DrawResult,
  Economy2,
  GiveItemResult,
  HealthView,
  OddsRow,
  PredictionView,
  QuestId,
  QuestResult,
  QuestsView,
  ResolveResult,
  RoomFundResult,
  RoomView,
  ShopBuyResult,
  ShopView,
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
    case "draw":
      return "抽收藏";
    case "room":
      return "一起佈置她的房間";
    case "shop":
      return "她的小店";
    case "shop_pay":
      return "小店的收入";
    case "commission":
      return "委託她";
    case "commission_pay":
      return "委託做完了";
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
  readonly collection: Collection;
  readonly achievement: AchievementDesk;
  readonly prediction: PredictionDesk;
  readonly commissionDesk: CommissionDesk;
  readonly roomDesk: RoomDesk;
  readonly shopDesk: ShopDesk;
  readonly healthDesk: Health;

  constructor(readonly e: EconomyService) {
    this.play = new PlayDesk(e);
    this.party = new PartyRewardDesk(e);
    this.quest = new QuestDesk(e);
    this.collection = new Collection(e);
    this.achievement = new AchievementDesk(e);
    this.prediction = new PredictionDesk(e);
    this.commissionDesk = new CommissionDesk(e);
    this.roomDesk = new RoomDesk(e);
    this.shopDesk = new ShopDesk(e);
    this.healthDesk = new Health(e);
  }

  get currency(): string {
    return this.e.config.currency;
  }

  /** What may have become true after coins were earned: milestones. Never throws. */
  async afterEarn(who: Member): Promise<void> {
    try {
      await this.achievement.evaluate(who);
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "cannot check achievements");
    }
  }

  /** Settles what ran out: predictions nobody called, stakes a crash left halfway. */
  async sweep(): Promise<void> {
    await this.prediction.sweep();
    await this.commissionDesk.sweep();
  }

  /** A quest done for someone already known; a failure is logged, never thrown at the caller. */
  async questDone(who: Member, quest: QuestId): Promise<void> {
    try {
      await this.quest.complete(who, quest);
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error), quest }, "cannot tick a quest");
    }
  }

  quests(account: AccountRef): Promise<QuestsView> {
    return this.quest.view(account);
  }

  completeQuest(account: AccountRef, quest: QuestId, topic?: string): Promise<QuestResult> {
    return this.quest.completeFor(account, quest, topic);
  }

  album(account: AccountRef): Promise<AlbumView> {
    return this.collection.album(account);
  }

  odds(): OddsRow[] {
    return this.collection.odds();
  }

  rarityOdds(): { rarity: Rarity; percent: number }[] {
    return this.collection.rarityOdds();
  }

  rollRarity(): Rarity {
    return this.collection.rollRarity();
  }

  draw(account: AccountRef, key: string): Promise<DrawResult> {
    return this.collection.draw(account, key);
  }

  giveItem(from: AccountRef, to: AccountRef, item: string, key: string): Promise<GiveItemResult> {
    return this.collection.give(from, to, item, key);
  }

  recordCard(account: AccountRef, serial: string, traits: readonly string[]): Promise<number> {
    return this.collection.recordCard(account, serial, traits);
  }

  achievements(account: AccountRef): Promise<AchievementsView> {
    return this.achievement.view(account);
  }

  predictions(account: AccountRef | null): Promise<PredictionView[]> {
    return this.prediction.view(account);
  }

  openPrediction(req: {
    question: string;
    options: readonly string[];
    minutes: number;
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

  commissionMenu(): { kind: CommissionKind; label: string; price: number }[] {
    return this.commissionDesk.menu();
  }

  commission(
    account: AccountRef,
    kind: CommissionKind,
    brief: string,
    key: string,
  ): Promise<CommissionResult> {
    return this.commissionDesk.ask(account, kind, brief, key);
  }

  commissions(account: AccountRef): Promise<CommissionView[]> {
    return this.commissionDesk.mine(account);
  }

  commissionsWaiting(): Promise<CommissionView[]> {
    return this.commissionDesk.waiting();
  }

  deliverCommission(ref: string, text: string): Promise<CommissionView> {
    return this.commissionDesk.deliver(ref, text);
  }

  declineCommission(ref: string, why: string): Promise<CommissionView> {
    return this.commissionDesk.decline(ref, why);
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

  shop(account: AccountRef): Promise<ShopView> {
    return this.shopDesk.view(account);
  }

  buyFromShop(account: AccountRef, item: string, key: string): Promise<ShopBuyResult> {
    return this.shopDesk.buy(account, item, key);
  }

  health(): Promise<HealthView> {
    return this.healthDesk.view();
  }
}
