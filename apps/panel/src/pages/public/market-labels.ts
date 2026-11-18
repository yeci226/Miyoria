// The weekly market's states in words, shared by the member page's 市集 and the admin's 經濟 / 市集.

import type { LotteryResult, LotteryView, LotView, MyBids } from "@miyoria/contracts/api";

export const LOT_KIND: Record<LotView["kind"], string> = {
  frame: "只此一件的卡框",
  call_name: "這一週她怎麼叫你",
};

export const LOT_STATE: Record<LotView["state"], string> = {
  open: "出價中",
  closing: "結算中",
  naming: "等得標的人取名",
  applied: "名字用上了",
  done: "結束了",
  refunded: "已退回",
  cancelled: "取消了",
};

export const PICKED_BY: Record<LotView["picked_by"], string> = {
  owner: "你指定的",
  her: "她挑的",
  rotation: "輪流",
};

export const BID_STATE: Record<MyBids["bids"][number]["state"], string> = {
  leading: "領先中",
  outbid: "被超過",
  won: "得標",
  lost: "沒得標",
  cancelled: "取消了",
  refunded: "已退回",
};

export const WEEK_STATE: Record<LotteryView["state"] | LotteryResult["state"], string> = {
  open: "還沒開獎",
  drawing: "開獎中",
  drawn: "開過獎了",
  refunding: "退款中",
  refunded: "已退回",
};
