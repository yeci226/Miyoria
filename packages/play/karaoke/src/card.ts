// Karaoke's card on the panel's system page (docs/design/v5-settings.md §3.2): whether members may
// sing, the songs ready and being prepared, and whether a song worker is there to prepare more.

import { CARD_MAX_FACTS, type ModuleCard, type ModuleCardFact } from "@miyoria/runtime/kernel";

export function karaokeCard(input: {
  open: boolean;
  ready: number;
  preparing: number;
  worker: boolean;
  comments: boolean;
  /** Rooms open now (step 4). */
  rooms?: number;
}): ModuleCard {
  const facts: ModuleCardFact[] = [
    { label: "會員頁", value: input.open ? "開放" : "關閉" },
    { label: "準備好的歌", value: input.ready, unit: "首" },
  ];
  if ((input.rooms ?? 0) > 0) facts.push({ label: "房間", value: input.rooms ?? 0, unit: "間" });
  if (input.preparing > 0) facts.push({ label: "準備中", value: input.preparing, unit: "首" });
  facts.push({ label: "準備歌的機器", value: input.worker ? "在" : "不在" });
  facts.push({ label: "她講評", value: input.comments ? "會" : "不會" });
  return { facts: facts.slice(0, CARD_MAX_FACTS) };
}
