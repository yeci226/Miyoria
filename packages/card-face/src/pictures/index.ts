// `@miyoria/card-face/pictures`: the picture messages' templates as SVG (docs/design/v5-play.md
// §11.5). Pure and deterministic: the same data and backdrop give the same SVG. The api module
// draws them to PNG with resvg (`packages/api/src/pictures.ts`), which also prepares the backdrop.

import type { PictureDataMap, PictureKind } from "@miyoria/types";
import { type Drawn, SCALE, type Surface, toSvg, WIDTH } from "./draw.js";
import { TEMPLATES } from "./templates.js";

export { estimateAdvance, fitText, textWidth, wrap } from "./measure.js";
export { LONG_SAMPLES, PICTURE_SAMPLES } from "./samples.js";
export { FAMILIARITY_WORDS, TEMPLATES, TRUST_WORDS } from "./templates.js";
export { PANEL_TOKENS, SECONDARY_LINE, SURFACES } from "./tokens.js";
export type { Drawn, Surface };
export { SCALE, WIDTH };

/** Bump when a template's look changes, so cached pictures are drawn again. */
export const PICTURES_VERSION = "1";

/** A template laid out: what the renderer needs to prepare the backdrop and draw it. */
export interface PictureLayout {
  kind: PictureKind;
  width: number;
  height: number;
  surfaces: Surface[];
  alt: string;
  /** The SVG over a backdrop (a data URL at `width` × `height`, or `null` for the gradient). */
  svg(backdrop: string | null): string;
}

/** Lays out `kind` with `data`. Throws on data a template cannot draw. */
export function layoutPicture<K extends PictureKind>(kind: K, data: PictureDataMap[K]): PictureLayout {
  const template = TEMPLATES[kind] as (d: PictureDataMap[K]) => { drawn: Drawn; alt: string };
  const { drawn, alt } = template(data);
  return {
    kind,
    width: drawn.width,
    height: drawn.height,
    surfaces: drawn.surfaces,
    alt,
    svg: (backdrop) => toSvg(drawn, backdrop),
  };
}
