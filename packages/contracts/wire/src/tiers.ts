// The one relationship scale's names (docs/design/v5-heart.md §2.7: "分級名稱和門檻只留一份"). The
// list is kept here, below every other package, so that the API contract's enum is made from it;
// `@miyoria/types` re-exports it with the ladder, the ring and the bands built on it, and every
// reader takes the names from there.

/** Every name of the scale, from the bottom up. */
export const RELATIONSHIP_LABELS = [
  "很討厭",
  "討厭",
  "陌生人",
  "認識",
  "朋友",
  "好朋友",
  "摯友",
  "知心",
  "知己",
  "至交",
  "莫逆之交",
  "心有靈犀",
  "形影不離",
  "宛若家人",
  "生死之交",
  "命運相連",
  "無可取代",
  "心之所歸",
  "永恆羈絆",
] as const;

export type RelationshipLabel = (typeof RELATIONSHIP_LABELS)[number];

/**
 * Each named tier of the ladder but the top is split in three stages (owner decision H10), written
 * after the name with a space: 「知心 I」「知心 II」「知心 III」. 陌生人, 討厭, 很討厭 and 永恆羈絆
 * have none.
 */
export const TIER_STAGE_NUMERALS = ["I", "II", "III"] as const;

/** A stage of a tier: which third of the tier's span the bond is in. */
export type TierStage = 1 | 2 | 3;

/** The tiers past 摯友, lowest first: `[lowest bond, name]`. */
export const BOND_TIER_FLOORS: readonly (readonly [number, RelationshipLabel])[] = [
  [120, "知心"],
  [150, "知己"],
  [190, "至交"],
  [240, "莫逆之交"],
  [300, "心有靈犀"],
  [370, "形影不離"],
  [450, "宛若家人"],
  [540, "生死之交"],
  [640, "命運相連"],
  [750, "無可取代"],
  [870, "心之所歸"],
  [1000, "永恆羈絆"],
];
