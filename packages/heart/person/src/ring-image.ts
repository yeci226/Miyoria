// The bond ring as a picture (docs/design/v5-heart.md §2.7): `/me profile` and `/admin person
// show` attach it as a PNG. Drawing needs the SVG renderer and resvg, which the api package has,
// so the heart only asks for it through this key; without one the commands answer in text.

import { serviceKey } from "@miyoria/types";

/** What to draw. */
export interface BondRingImageSpec {
  /** The lap being filled, 0..9. */
  lap: number;
  /** How full that lap is, 0..1. */
  fraction: number;
  /** All ten laps are full. */
  full: boolean;
  /** How far below 0 the bond is, 0..1; 0 for a bond of 0 or more. */
  below: number;
  /** The bond written on the heart; leave it out for a member's picture (no number). */
  value?: number;
}

/** Draws the ring. */
export interface BondRingImages {
  /** A PNG of the ring. A picture is made once for the same spec. */
  png(spec: BondRingImageSpec): Promise<Uint8Array>;
}

export const BondRingImagesKey = serviceKey<BondRingImages>("BondRingImages");
