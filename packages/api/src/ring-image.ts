// The bond ring as a PNG for Discord (`/me profile`, `/admin person show`; docs/design/v5-heart.md
// §2.7): the same drawing as the panel's (`@miyoria/card-face`), through the same resvg path `og.ts`
// uses for the card. A picture is kept per spec, so the same ring is drawn once.

import { cardFontOptions } from "@miyoria/card-face/fonts";
import { renderBondRingSvg } from "@miyoria/card-face/render";
import type { BondRingImageSpec, BondRingImages } from "@miyoria/heart/person";
import { Resvg } from "@resvg/resvg-js";

/** Pixels across; the drawing is square. */
const SIZE = 360;
/** Pictures kept: a member's has about 200 possible rings, an admin's one per bond seen. */
const KEPT = 256;
/** The ring's colours are made for the panel's dark theme: a dark tile keeps it legible on Discord's light one. */
const BACKGROUND = "#17151c";
/** The label the drawing carries; a PNG has no use for it. */
const TITLE = "bond ring";

/** The text of a spec that makes the picture (what is the same is drawn once). */
export function ringKey(spec: BondRingImageSpec): string {
  const value = spec.value === undefined ? "" : String(Math.round(spec.value));
  return [spec.lap, spec.fraction, spec.full ? 1 : 0, spec.below, value].join("|");
}

/** The ring's SVG as a clear PNG. */
function draw(spec: BondRingImageSpec): Uint8Array {
  const svg = renderBondRingSvg({
    lap: spec.lap,
    fraction: spec.fraction,
    full: spec.full,
    below: spec.below,
    ...(spec.value === undefined ? {} : { value: spec.value }),
    title: TITLE,
  });
  return new Resvg(svg, {
    fitTo: { mode: "width", value: SIZE },
    background: BACKGROUND,
    // The bundled fonts only: the numbers are drawn the same on any machine.
    font: cardFontOptions(),
  })
    .render()
    .asPng();
}

/** Draws rings and keeps the last `KEPT`. */
export class RingImages implements BondRingImages {
  readonly #kept = new Map<string, Uint8Array>();

  async png(spec: BondRingImageSpec): Promise<Uint8Array> {
    const key = ringKey(spec);
    const hit = this.#kept.get(key);
    if (hit !== undefined) {
      // Most recently used last.
      this.#kept.delete(key);
      this.#kept.set(key, hit);
      return hit;
    }
    const png = draw(spec);
    this.#kept.set(key, png);
    if (this.#kept.size > KEPT) {
      const oldest = this.#kept.keys().next().value;
      if (oldest !== undefined) this.#kept.delete(oldest);
    }
    return png;
  }
}
