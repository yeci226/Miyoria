// The parts a card is drawn from (docs/design/cards.md §3–§5, docs/design/v5-play.md §2): the
// slots, the rarities, the series and their titles, and the catalogue the `cards_parts` table is
// seeded with (`migrations.ts`, migration 1 and the later catalogue changes; a test keeps the two
// together).
//
// A part is one thing on the picture: what is in her hand, an accessory, the outfit, the pose, the
// background. The expression is not a part: the relationship decides it (`expressions.ts`), never
// the rarity or the price. Backgrounds are procedural for now (her colours, light spots, stars,
// water, the night sky), named here and drawn later; the owner's own pictures join the catalogue
// as new rows.
//
// A `blank` part is "nothing there" (an empty hand, no accessory): it is drawn like any other part
// so the odds stay one table, but it is not collected. A `drop_only` part comes only from a card
// dropped in a channel (v5-play §6.2), never from a bought card.

/** The rarities, lowest first. */
export const RARITIES = ["N", "R", "SR", "SSR"] as const;
export type Rarity = (typeof RARITIES)[number];

/** Where a rarity sits: N 0 .. SSR 3. */
export function rarityRank(rarity: Rarity): number {
  return RARITIES.indexOf(rarity);
}

/** Whether `rarity` is SR or better (what the pity counts). */
export function isRare(rarity: Rarity): boolean {
  return rarityRank(rarity) >= rarityRank("SR");
}

export function isRarity(value: unknown): value is Rarity {
  return typeof value === "string" && (RARITIES as readonly string[]).includes(value);
}

/** The slots of a card, in the order a draw fills them. */
export const SLOTS = ["hand", "accessory", "outfit", "pose", "background"] as const;
export type Slot = (typeof SLOTS)[number];

export function isSlot(value: unknown): value is Slot {
  return typeof value === "string" && (SLOTS as readonly string[]).includes(value);
}

/** What a slot is called on the member page. */
export const SLOT_NAMES: Readonly<Record<Slot, string>> = {
  hand: "手",
  accessory: "配件",
  outfit: "服裝",
  pose: "姿勢",
  background: "背景",
};

/** One row of the catalogue (`cards_parts`). */
export interface Part {
  /** `<slot>.<name>`, stable: cards, the dex and wishlists name parts by it. */
  id: string;
  slot: Slot;
  rarity: Rarity;
  /** The series it counts toward; `null`: none. */
  series: string | null;
  /** Its name on the card and the member page. */
  name: string;
  /** Its weight among the parts of its slot a draw may pick (> 0). */
  weight: number;
  /** A disabled part is never drawn and does not count toward its series. */
  enabled: boolean;
  /** Only a channel drop can give it. */
  drop_only: boolean;
  /** "Nothing there": drawn, shown, but not collected. */
  blank: boolean;
}

/** A series of parts: collecting every enabled part of it earns the title. */
export interface Series {
  id: string;
  name: string;
  /** The title a person earns for completing it. */
  title: string;
}

export const SERIES: readonly Series[] = [
  { id: "glasses", name: "眼鏡系列", title: "眼鏡控" },
  { id: "hands", name: "手勢系列", title: "看得懂她的手勢" },
  { id: "curios", name: "怪東西系列", title: "怪東西收藏家" },
  { id: "wardrobe", name: "衣櫃系列", title: "她的衣櫃管理員" },
  { id: "poses", name: "姿勢系列", title: "每個角度都看過" },
  { id: "colours", name: "顏色系列", title: "她的顏色" },
  { id: "sky", name: "天空系列", title: "摘星的人" },
  { id: "water", name: "水邊系列", title: "水邊的人" },
];

/** The series of `id`; `null` when there is none. */
export function seriesOf(id: string): Series | null {
  return SERIES.find((s) => s.id === id) ?? null;
}

function part(
  id: string,
  rarity: Rarity,
  series: string | null,
  name: string,
  options: { weight?: number; blank?: boolean; drop_only?: boolean; enabled?: boolean } = {},
): Part {
  const slot = id.slice(0, id.indexOf(".")) as Slot;
  return {
    id,
    slot,
    rarity,
    series,
    name,
    weight: options.weight ?? 1,
    enabled: options.enabled ?? true,
    drop_only: options.drop_only ?? false,
    blank: options.blank ?? false,
  };
}

/**
 * The catalogue as the migrations leave it (cards.md §3–§5): migration 1 seeds it, migration 9
 * disables 短裙 (it drew the same picture as 平常的衣服; cards that have it keep it, so it stays a
 * row). N: the basic angles, no accessory or the plain glasses, the plain outfit, her colours; R
 * adds hand gestures, outfit changes, the rarer poses and backgrounds; SR the rare accessories and
 * special backgrounds; SSR special backgrounds and an accessory set.
 */
export const SEED_PARTS: readonly Part[] = [
  part("hand.none", "N", null, "空手", { blank: true }),
  part("hand.finger", "R", "hands", "豎食指"),
  part("hand.chest", "R", "hands", "撫胸"),
  part("hand.foxtail", "R", "hands", "狗尾草"),

  part("accessory.none", "N", null, "無配件", { weight: 2, blank: true }),
  part("accessory.glasses", "N", "glasses", "黑框眼鏡"),
  part("accessory.tail", "R", "curios", "尾巴"),
  part("accessory.monocle", "SR", "glasses", "單片眼鏡"),
  part("accessory.basin", "SR", "curios", "大鋼盆"),
  part("accessory.monocle_tail", "SSR", "curios", "單片眼鏡和尾巴"),

  part("outfit.usual", "N", "wardrobe", "平常的衣服"),
  part("outfit.long_skirt", "R", "wardrobe", "長裙"),
  part("outfit.short_skirt", "R", "wardrobe", "短裙", { enabled: false }),
  part("outfit.shoes", "R", "wardrobe", "換一雙鞋"),
  part("outfit.top", "R", "wardrobe", "胸口的衣服"),

  part("pose.front", "N", "poses", "正面"),
  part("pose.tilt_left", "N", "poses", "歪頭(左)"),
  part("pose.tilt_right", "N", "poses", "歪頭(右)"),
  part("pose.look_up", "N", "poses", "抬頭"),
  part("pose.lean_in", "R", "poses", "湊近"),
  part("pose.shy", "R", "poses", "害羞低頭"),
  part("pose.sway", "R", "poses", "搖擺"),
  part("pose.turn_left", "R", "poses", "側身回頭(左)"),
  part("pose.turn_right", "R", "poses", "側身回頭(右)"),

  part("background.gradient_pink", "N", "colours", "她的顏色・粉"),
  part("background.gradient_blue", "N", "colours", "她的顏色・藍"),
  part("background.bokeh", "N", "colours", "光斑"),
  part("background.bokeh_night", "R", "colours", "夜裡的光斑"),
  part("background.stars", "R", "sky", "星點"),
  part("background.water", "R", "water", "水面"),
  part("background.night_sky", "SR", "sky", "夜空"),
  part("background.moon_water", "SR", "water", "月下的水面"),
  part("background.meteor", "SSR", "sky", "流星夜空"),
  part("background.aurora", "SSR", "sky", "極光"),
  part("background.fireworks", "SR", null, "頻道裡的煙火", { drop_only: true }),
];

/** The parts a bought card may be drawn from: enabled, not drop-only. */
export function drawPool(catalogue: readonly Part[]): Part[] {
  return catalogue.filter((p) => p.enabled && !p.drop_only);
}
