// The fonts a card is drawn with when it becomes a PNG on the Core (resvg), bundled so that no
// machine depends on its system fonts: Noto Sans TC (SIL Open Font License 1.1, `fonts/OFL.txt`) at
// 400 and 700, the static instances of its variable font (resvg does not apply font variations).
// The panel draws in the browser and keeps its own fonts; this is for Node only.

import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../fonts/", import.meta.url));

/** The family name the bundled files have. */
export const CARD_FONT_FAMILY = "Noto Sans TC";

/** The bundled font files, for resvg's `font.fontFiles` (with `loadSystemFonts: false`). */
export const CARD_FONT_FILES: readonly string[] = [
  join(DIR, "NotoSansTC-Regular.ttf"),
  join(DIR, "NotoSansTC-Bold.ttf"),
];

/** resvg's `font` options that draw with the bundled fonts only. */
export function cardFontOptions(): {
  loadSystemFonts: false;
  fontFiles: string[];
  defaultFontFamily: string;
  sansSerifFamily: string;
  monospaceFamily: string;
} {
  return {
    loadSystemFonts: false,
    fontFiles: [...CARD_FONT_FILES],
    defaultFontFamily: CARD_FONT_FAMILY,
    sansSerifFamily: CARD_FONT_FAMILY,
    monospaceFamily: CARD_FONT_FAMILY,
  };
}
