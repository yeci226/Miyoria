// Her expression on a card (docs/design/cards.md §2.2, owner decision P3 in v5-play.md §10.2): the
// relationship decides it, never the rarity or a payment. Each tier has a group of expressions and
// the draw picks one of the group; the special ones (落淚, 圈圈眼, 黑臉 and the like) belong to
// relationships, not to rare cards. 黑臉 only ever shows for someone she dislikes (a negative bond:
// 討厭, 很討厭), and nobody she dislikes gets 愛心眼.

import type { RelationshipLabel } from "@miyoria/types";

/** One expression of her model (the parameter set the renderer turns it into is its own). */
export interface Expression {
  id: string;
  name: string;
}

export const EXPRESSIONS = {
  calm: { id: "calm", name: "平靜" },
  smile: { id: "smile", name: "微笑" },
  blush: { id: "blush", name: "臉紅" },
  heart_eyes: { id: "heart_eyes", name: "愛心眼" },
  squint: { id: "squint", name: "> <眼" },
  smug: { id: "smug", name: "屑屑眼" },
  cold_sweat: { id: "cold_sweat", name: "流冷汗" },
  tears: { id: "tears", name: "落淚" },
  swirl_eyes: { id: "swirl_eyes", name: "圈圈眼" },
  black_face: { id: "black_face", name: "黑臉" },
  fangs: { id: "fangs", name: "大牙" },
} as const satisfies Record<string, Expression>;

type Id = keyof typeof EXPRESSIONS;

const NEGATIVE: readonly Id[] = ["black_face", "cold_sweat", "smug"];
const CLOSE: readonly Id[] = ["blush", "squint", "heart_eyes", "tears", "fangs", "swirl_eyes"];

/** The group of each tier. From 知心 up (the tiers a shared memory anchors) it is one group. */
const GROUPS: Readonly<Record<RelationshipLabel, readonly Id[]>> = {
  很討厭: ["black_face", "cold_sweat"],
  討厭: NEGATIVE,
  陌生人: ["calm", "smile"],
  認識: ["calm", "smile", "smug", "cold_sweat"],
  朋友: ["smile", "smug", "fangs", "swirl_eyes"],
  好朋友: ["smile", "fangs", "swirl_eyes", "blush", "squint"],
  摯友: ["blush", "squint", "fangs", "swirl_eyes", "heart_eyes"],
  知心: CLOSE,
  知己: CLOSE,
  至交: CLOSE,
  莫逆之交: CLOSE,
  心有靈犀: CLOSE,
  形影不離: CLOSE,
  宛若家人: CLOSE,
  生死之交: CLOSE,
  命運相連: CLOSE,
  無可取代: CLOSE,
  心之所歸: CLOSE,
  永恆羈絆: CLOSE,
};

/** The expressions a card for someone of `tier` may show; a tier it does not know: a stranger's. */
export function expressionsFor(tier: string): readonly Expression[] {
  const ids = GROUPS[tier as RelationshipLabel] ?? GROUPS.陌生人;
  return ids.map((id) => EXPRESSIONS[id]);
}
