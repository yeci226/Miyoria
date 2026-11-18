// A card's draw as a picture to render (docs/design/cards.md §3–§6): its parts and expression,
// looked up in `portrait-looks.ts`, become what the renderer holds the model in (motions,
// parameters, expression files), how much of her the picture shows, and the background drawn
// behind her. The seed adds small offsets to the pose (a head turned a few degrees more, the eyes
// a little aside, the camera a touch closer), so two cards with the same parts still differ, and
// the same card always gets the same picture. Pure: no renderer, no files.

import { type DrawnPart, seededRandom } from "./draw.js";
import type { Expression } from "./expressions.js";
import { backgroundSvg } from "./portrait-backgrounds.js";
import {
  BASE_LOOK,
  EXPRESSION_LOOKS,
  FRAMINGS,
  type Framing,
  type ModelLook,
  PART_LOOKS,
} from "./portrait-looks.js";

/** The picture's size: the card's art box is 3:4 (`packages/card-face`). */
export const PORTRAIT_WIDTH = 900;
export const PORTRAIT_HEIGHT = 1200;

/** Where the framed band of her sits in the picture: from 3% to 47% of its height, above the words. */
const BAND_TOP = 0.03;
const BAND_BOTTOM = 0.47;

/** Seconds of physics before the frame is taken. */
const SETTLE_SECS = 2;

/** What the renderer draws: the card studio's pose spec without the model's URL. */
export interface PortraitSpec {
  motions: string[];
  set: Record<string, number>;
  expressions: string[];
  add: Record<string, number>;
  /** An SVG behind her; `null`: a clear background. */
  background: string | null;
  width: number;
  height: number;
  zoom: number;
  centerX: number;
  centerY: number;
  settle: number;
}

/** What a picture is drawn from (`PortraitInput` without the rest a card keeps). */
export interface PortraitDraw {
  parts: readonly Pick<DrawnPart, "id">[];
  expression: Pick<Expression, "id">;
  seed: number;
}

/** The small offsets the seed adds to every pose: degrees for the head, -1..1 for the eyes. */
export const SEED_OFFSETS = {
  AngleX: 5,
  AngleY: 4,
  AngleZ: 4,
  ParamEyeBallX: 0.15,
  ParamEyeBallY: 0.1,
} as const;

/** The ranges those parameters have on the model. */
const LIMITS: Readonly<Record<string, readonly [number, number]>> = {
  AngleX: [-30, 30],
  AngleY: [-30, 30],
  AngleZ: [-30, 30],
  ParamEyeBallX: [-1, 1],
  ParamEyeBallY: [-1, 1],
};

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** The looks of a draw, in the order they are applied: base, parts by slot, then the expression. */
function looksOf(draw: PortraitDraw): { looks: ModelLook[]; framings: Framing[] } {
  const looks: ModelLook[] = [BASE_LOOK];
  const framings: Framing[] = ["bust"];
  for (const part of draw.parts) {
    const look = PART_LOOKS[part.id];
    if (look?.shown !== "model") continue;
    looks.push(look);
    if (look.framing) framings.push(look.framing);
  }
  looks.push(EXPRESSION_LOOKS[draw.expression.id] ?? EXPRESSION_LOOKS.calm ?? {});
  return { looks, framings };
}

/** The background of a draw: its first part shown as one. */
function backgroundOf(draw: PortraitDraw) {
  for (const part of draw.parts) {
    const look = PART_LOOKS[part.id];
    if (look?.shown === "background") return look.background;
  }
  return null;
}

/** The picture to render for a card's draw. */
export function portraitSpec(draw: PortraitDraw): PortraitSpec {
  const random = seededRandom(draw.seed >>> 0);
  const offset = (max: number) => (random() * 2 - 1) * max;
  const { looks, framings } = looksOf(draw);
  const motions: string[] = [];
  const expressions: string[] = [];
  const set: Record<string, number> = {};
  const add: Record<string, number> = {};
  for (const look of looks) {
    motions.push(...(look.motions ?? []));
    Object.assign(set, look.set ?? {});
    expressions.push(...(look.expressions ?? []));
    for (const [id, v] of Object.entries(look.add ?? {})) add[id] = (add[id] ?? 0) + v;
  }
  for (const [id, max] of Object.entries(SEED_OFFSETS)) {
    set[id] = round(clamp((set[id] ?? 0) + offset(max), LIMITS[id] ?? [-30, 30]));
  }
  // The band every part needs to be seen: the highest top and the lowest bottom.
  const top = Math.max(...framings.map((f) => FRAMINGS[f].top));
  const bottom = Math.min(...framings.map((f) => FRAMINGS[f].bottom));
  const span = (top - bottom) / (BAND_BOTTOM - BAND_TOP);
  const zoom = (2 / span) * (1 + offset(0.03));
  const height = 2 / zoom;
  const centerY = top + BAND_TOP * height - height / 2;
  const centerX = offset(0.02);
  const background = backgroundOf(draw);
  return {
    motions: [...new Set(motions)],
    set,
    expressions: [...new Set(expressions)],
    add,
    background:
      background === null
        ? null
        : backgroundSvg(background, draw.seed, PORTRAIT_WIDTH, PORTRAIT_HEIGHT),
    width: PORTRAIT_WIDTH,
    height: PORTRAIT_HEIGHT,
    zoom: round(zoom),
    centerX: round(centerX),
    centerY: round(centerY),
    settle: SETTLE_SECS,
  };
}
