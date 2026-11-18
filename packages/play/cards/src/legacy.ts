// The collectibles of the old "draw a collectible" (抽收藏, the economy's `collection.ts`, removed
// in phase 5): what people already own is kept, copied once from `economy_docs` (kind `item`) into
// `cards_legacy`, and shown in the dex as the closed series 舊收藏. Nothing can be drawn into it any
// more and nothing in it can be given away.
//
// Copied rather than read where it was: the old catalogue (`collection_series`) and the documents
// table were the economy's and both are going away, while the dex is this plugin's; a copy keyed by
// the old document id is idempotent, so the copy runs on every start and takes nothing twice.
//
// The names are the old default catalogue's: a document holds only the item's id. An id the old
// catalogue did not have (a configured series, a shop collectible) keeps its id as its name.

/** The closed series the old collectibles are shown as. */
export const LEGACY_SERIES = { id: "legacy", name: "舊收藏" } as const;

/** The old default catalogue: id → name, rarity, series. */
export const LEGACY_ITEMS: Readonly<
  Record<string, { name: string; rarity: string; series: string }>
> = {
  glasses_black: { name: "黑框眼鏡", rarity: "N", series: "眼鏡系列" },
  glasses_round: { name: "圓框眼鏡", rarity: "R", series: "眼鏡系列" },
  glasses_monocle: { name: "單片眼鏡", rarity: "SR", series: "眼鏡系列" },
  glasses_star: { name: "星星眼鏡", rarity: "SSR", series: "眼鏡系列" },
  hand_none: { name: "空著手", rarity: "N", series: "手上的東西" },
  hand_foxtail: { name: "狗尾草", rarity: "N", series: "手上的東西" },
  hand_finger: { name: "豎食指", rarity: "R", series: "手上的東西" },
  hand_pot: { name: "大鋼盆", rarity: "SR", series: "手上的東西" },
  bg_dusk: { name: "黃昏漸層", rarity: "N", series: "背景系列" },
  bg_water: { name: "水面", rarity: "R", series: "背景系列" },
  bg_stars: { name: "星點", rarity: "R", series: "背景系列" },
  bg_night: { name: "夜空", rarity: "SR", series: "背景系列" },
  bg_aurora: { name: "極光", rarity: "SSR", series: "背景系列" },
};

/** One old collectible a person has (copies of the same item counted together). */
export interface LegacyItem {
  item: string;
  name: string;
  rarity: string;
  series: string | null;
  count: number;
  first_at: string;
}
