// The panel's design tokens for the pictures (apps/panel/DESIGN.md,櫻花 theme at the defaults).
// The panel keeps them as CSS variables in `apps/panel/src/index.css`; resvg resolves no `var()`,
// so they are mirrored here as plain values. `test/pictures-tokens.test.ts` reads the CSS and fails
// when one of the mirrored values drifts from it. Values the CSS mixes at run time
// (`--secondary-line` is `color-mix(in oklab, --secondary 62%, white)`) are the mix worked out once.

/** Each mirrored token and the CSS variable it comes from (checked by the test). */
export const PANEL_TOKENS = {
  background: { css: "--background", value: "#0b0d12" },
  foreground: { css: "--foreground", value: "#f1f0f4" },
  primary: { css: "--primary", value: "#f29dc4" },
  primaryInk: { css: "--primary-foreground", value: "#1f1218" },
  secondary: { css: "--secondary", value: "#7355e8" },
  control: { css: "--control", value: "rgba(255, 255, 255, 0.1)" },
  border: { css: "--border", value: "rgba(255, 255, 255, 0.11)" },
  lineStrong: { css: "--line-strong", value: "rgba(255, 255, 255, 0.2)" },
  lineSoft: { css: "--line-soft", value: "rgba(255, 255, 255, 0.06)" },
  chart1: { css: "--chart-1", value: "#d9609a" },
  chart2: { css: "--chart-2", value: "#8a68ee" },
  chart3: { css: "--chart-3", value: "#c9c8d1" },
  chart4: { css: "--chart-4", value: "#b4427f" },
  chart5: { css: "--chart-5", value: "#6b4ee0" },
  chartQuiet: { css: "--chart-quiet", value: "rgba(255, 255, 255, 0.22)" },
  chartFaint: { css: "--chart-faint", value: "rgba(255, 255, 255, 0.1)" },
  chartGrid: { css: "--chart-grid", value: "rgba(255, 255, 255, 0.07)" },
  chartAxis: { css: "--chart-axis", value: "rgba(255, 255, 255, 0.18)" },
  sheetFill: { css: "--sheet", value: "rgba(9, 10, 16, 0.105)" },
  dockFill: { css: "--dock", value: "rgba(9, 9, 15, 0.31)" },
  wellFill: { css: "--well", value: "rgba(4, 5, 10, 0.29)" },
  /** Secondary text on the content surface (`.glass-sheet`). */
  sheetMuted: { css: ".glass-sheet --muted-foreground", value: "#dedce4" },
  /** Secondary text on the frame (`.glass-dock`). */
  dockMuted: { css: ".glass-dock --muted-foreground", value: "#cfcdd6" },
} as const;

type TokenName = keyof typeof PANEL_TOKENS;

/** Plain values by name. */
export const T: { readonly [K in TokenName]: (typeof PANEL_TOKENS)[K]["value"] } =
  Object.fromEntries(Object.entries(PANEL_TOKENS).map(([k, v]) => [k, v.value])) as never;

/** `--secondary-line`: `color-mix(in oklab, #7355e8 62%, white)`. */
export const SECONDARY_LINE = "#a29af5";

/**
 * The surfaces the pictures draw (DESIGN.md "Surfaces", the defaults): the picture behind at
 * brightness .66 and saturate 1.08, then the content glass (`.glass-sheet`) and the frame glass
 * (`.glass-dock`) over it, each a blur of what is behind with its own brightness and saturation.
 */
export const SURFACES = {
  picture: { brightness: 0.66, saturate: 1.08, blur: 0 },
  sheet: { brightness: 0.68, saturate: 1.5, blur: 7, fill: T.sheetFill },
  dock: { brightness: 0.78, saturate: 1.4, blur: 14, fill: T.dockFill },
} as const;

export type SurfaceKind = "sheet" | "dock";

/** The panel's 暮色 gradient, for a Core without the picture. */
export const DUSK_STOPS = [
  { offset: 0, color: "#3b4a66" },
  { offset: 0.45, color: "#2e3350" },
  { offset: 1, color: "#4a3350" },
] as const;

/** The type scale (DESIGN.md "Type"): ticks, small, label, body, block title, headline. */
export const TYPE = { tick: 11, small: 12, label: 13, body: 14, title: 15, headline: 24 } as const;

/** Spacing (DESIGN.md "Layout"): the page's padding and the gap between blocks. */
export const SPACE = { page: 28, stage: 32, rowY: 9 } as const;

/** Text shadow on the content glass (`0 1px 2px rgba(0,0,0,.7)`) and on the frame (.55). */
export const TEXT_SHADOW = { sheet: 0.7, dock: 0.55 } as const;
