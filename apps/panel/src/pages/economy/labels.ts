// What a ledger reason reads as. The first five are the Core's `EarnReason`; the others are the
// reasons economy 2.0 added (`labelV2` in `packages/economy/src/v2.ts`) and the ones the health
// table counts (`ISSUED_REASONS` / `RECOVERED_REASONS` in `health.ts`).

import type { EarnReason } from "@/api/types";

export const EARN_REASON_LABEL: Record<EarnReason, string> = {
  checkin: "每日簽到",
  talked: "和她說話",
  voice: "在語音陪她",
  song: "點的歌她唱完了",
  her_gift: "她送的",
  // economy 2.0
  quest: "每日任務",
  play: "一起玩",
  achievement: "達成成就",
};

/** Reasons that spend or move coins, for the rows of a ledger. */
export const SPEND_REASON_LABEL: Record<string, string> = {
  feed: "餵她",
  letter: "寫信給她",
  expression: "送她表情",
  screen_message: "留言上大螢幕",
  dedication: "歌曲獻詞",
  transfer_fee: "轉帳手續費",
  bet: "押預測",
  bet_win: "預測猜中了",
  draw: "抽收藏",
  card_daily: "每日卡",
  card_refund: "每日卡退回",
  room: "一起佈置她的房間",
  shop: "她的小店",
  shop_pay: "小店的收入",
  commission: "委託她",
  commission_pay: "委託做完了",
  // the weekly market
  song_priority: "點歌優先券",
  song_priority_refund: "優先券退回",
  lottery_ticket: "樂透彩券",
  lottery_refund: "彩券退回",
  lottery_prize: "樂透中獎",
  auction_hold: "拍賣出價押住",
  auction_release: "拍賣押款還回",
  auction_won: "拍賣得標",
  danmaku: "直播彈幕",
  danmaku_refund: "彈幕沒顯示,退回",
};

/** A ledger reason in words; an unknown one stays as it is. */
export const reasonLabel = (reason: string): string => (EARN_REASON_LABEL as Record<string, string>)[reason] ?? SPEND_REASON_LABEL[reason] ?? reason;

/** What the health table counts as issued (nothing was spent for it) and as recovered. */
export const ISSUED_REASONS = ["checkin", "talked", "voice", "song", "her_gift", "quest", "play", "achievement"] as const;
export const RECOVERED_REASONS = ["feed", "screen_message", "dedication", "draw", "shop", "room", "commission", "transfer_fee", "card_daily", "danmaku"] as const;

export const PREDICTION_STATUS_LABEL = {
  open: "可以下注",
  closed: "截止,等結果",
  resolved: "已結算",
  cancelled: "取消,已退還",
} as const;

/** Who settled a prediction. */
export const SETTLED_BY_LABEL: Record<string, string> = {
  auto: "自動結算",
  her: "她結算",
  admin: "管理員結算",
  expired: "到期退回",
};
