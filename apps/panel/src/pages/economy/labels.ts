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
  bet: "押預測",
  bet_win: "預測猜中了",
  draw: "抽收藏",
  room: "一起佈置她的房間",
  shop: "她的小店",
  shop_pay: "小店的收入",
  commission: "委託她",
  commission_pay: "委託做完了",
};

/** A ledger reason in words; an unknown one stays as it is. */
export const reasonLabel = (reason: string): string => (EARN_REASON_LABEL as Record<string, string>)[reason] ?? SPEND_REASON_LABEL[reason] ?? reason;

/** What the health table counts as issued (nothing was spent for it) and as recovered. */
export const ISSUED_REASONS = ["checkin", "talked", "voice", "song", "her_gift", "quest", "play", "achievement"] as const;
export const RECOVERED_REASONS = ["feed", "letter", "expression", "screen_message", "dedication", "draw", "shop", "room", "commission"] as const;

export const COMMISSION_KIND_LABEL: Record<string, string> = {
  poem: "寫詩",
  name: "取名",
  tool: "小工具",
  song: "唱歌",
  voice: "錄一句話",
};

export const PREDICTION_STATUS_LABEL = {
  open: "可以下注",
  closed: "截止,等結果",
  resolved: "已結算",
  cancelled: "取消,已退還",
} as const;
