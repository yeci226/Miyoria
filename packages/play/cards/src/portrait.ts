// Her picture on a card (cards.md §6). A `CardPortrait` (`CardPortraitKey`) is given a card's
// parts, her expression and the pose's seed and answers a PNG, or `null` when it cannot (not there,
// failed); then the card falls back to one of the ten fixed portraits (`card-<pose>.local.webp` in
// the panel's folder), the one nearest her drawn expression (`portraitPose`).
//
// The module provides the Live2D one (`live2d.ts`) when `[modules.cards] portrait = "live2d"` and
// this machine can render: a 900×1200 PNG of her over the drawn background (`portrait-spec.ts`),
// opaque, the whole art of the card. Elsewhere nothing provides the port and every card uses the
// fallback. The drawn parts are printed on the card and its page as text either way.

import { serviceKey } from "@miyoria/types";
import type { DrawnPart } from "./draw.js";
import type { Expression } from "./expressions.js";

/** What a portrait is rendered from: exactly what the card keeps of its draw. */
export interface PortraitInput {
  parts: readonly DrawnPart[];
  expression: Expression;
  /** For the pose's small random offsets: the same seed gives the same picture. */
  seed: number;
}

export interface CardPortrait {
  /** Her picture for a card as a PNG; `null` when it cannot be rendered now. */
  render(input: PortraitInput): Promise<Uint8Array | null>;
}

export const CardPortraitKey = serviceKey<CardPortrait>("CardPortrait");

/**
 * The fixed portrait nearest each expression (the ten old poses: calm, smile, blush, heart,
 * squint, finger, hand, smug, sweat, cold). Those without a picture of their own take the closest
 * mood: 落淚 (moved) the blush, 圈圈眼 (flustered) the squint, 大牙 (a grin) the smile, 黑臉 the
 * cold look.
 */
export const PORTRAIT_POSES: Readonly<Record<string, string>> = {
  calm: "calm",
  smile: "smile",
  blush: "blush",
  heart_eyes: "heart",
  squint: "squint",
  smug: "smug",
  cold_sweat: "sweat",
  tears: "blush",
  swirl_eyes: "squint",
  black_face: "cold",
  fangs: "smile",
};

/** The fixed portrait for an expression; an unknown one: `calm`. */
export function portraitPose(expression: string): string {
  return PORTRAIT_POSES[expression] ?? "calm";
}
