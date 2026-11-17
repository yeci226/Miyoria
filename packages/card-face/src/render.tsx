/** @jsxRuntime automatic */
/** @jsxImportSource react */
// The card as SVG markup, for the Core (no DOM): the same drawing the panel shows.

import { renderToStaticMarkup } from "react-dom/server";
import { CardFace, type CardFaceProps } from "./index.js";
import { BondRing, type BondRingProps, STATIC_COLORS } from "./ring.js";

/** `<svg>…</svg>` of the card, standing on its own (pictures inlined by the caller). */
export function renderCardSvg(props: CardFaceProps): string {
  return renderToStaticMarkup(<CardFace {...props} />);
}

/** `<svg>…</svg>` of the bond ring with plain colours (no `var()`), ready for resvg. */
export function renderBondRingSvg(props: BondRingProps): string {
  return renderToStaticMarkup(<BondRing {...props} colors={props.colors ?? STATIC_COLORS} />);
}
