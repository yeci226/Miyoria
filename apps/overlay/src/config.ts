// Overlay settings from the query string, e.g.
//   /overlay/?show=subtitles,queue&cps=16&scale=1.1&ws=ws://192.168.1.20:7884/overlay/ws
//   /overlay/?layer=backdrop&layout=sing   (the background under the scene's sources)
import { DEFAULT_CPS } from "./typewriter.js";

export const SECTIONS = ["subtitles", "emotion", "status", "queue", "wave", "activity", "gifts", "screen", "touches"] as const;
export type Section = (typeof SECTIONS)[number];

/** Which layer of the scene this page is: the overlay on top, or the background under everything. */
export const LAYERS = ["overlay", "backdrop"] as const;
export type Layer = (typeof LAYERS)[number];

/** Scene layouts: `sing` frames the song video top left and leaves the bottom right to her. */
export const LAYOUTS = ["default", "sing"] as const;
export type Layout = (typeof LAYOUTS)[number];

export interface OverlayConfig {
  ws: string;
  show: ReadonlySet<Section>;
  /** Typewriter speed, code points per second. */
  cps: number;
  /** UI scale; 1 = sized for 1080p. */
  scale: number;
  /** Show a "feed offline" marker (never shown on air by default). */
  debug: boolean;
  /** Play a scripted feed instead of connecting (for design work and OBS previews). */
  demo: boolean;
  layer: Layer;
  layout: Layout;
}

/** Same host that served the page, so the overlay works from another PC; falls back to the Stage default. */
export function defaultWsUrl(loc: Pick<Location, "protocol" | "host" | "pathname"> | undefined): string {
  if (!loc || !/^https?:$/.test(loc.protocol) || !loc.host) return "ws://127.0.0.1:7884/overlay/ws";
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  const dir = loc.pathname.replace(/[^/]*$/, ""); // keep the mount path, drop index.html
  return `${scheme}://${loc.host}${dir.endsWith("/") ? dir : `${dir}/`}ws`;
}

function num(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function pick<T extends string>(raw: string | null, options: readonly T[]): T {
  const v = raw?.trim().toLowerCase();
  return (options as readonly string[]).includes(v ?? "") ? (v as T) : (options[0] as T);
}

function flag(raw: string | null): boolean {
  if (raw === null) return false;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

export function parseConfig(search: string, loc?: Pick<Location, "protocol" | "host" | "pathname">): OverlayConfig {
  const q = new URLSearchParams(search);
  const wanted = q.get("show");
  let show = new Set<Section>(SECTIONS);
  if (wanted !== null) {
    const picked = wanted
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is Section => (SECTIONS as readonly string[]).includes(s));
    // `show=` with nothing valid in it would produce an empty overlay; treat it as the default.
    if (picked.length > 0) show = new Set(picked);
  }
  const ws = q.get("ws")?.trim();
  return {
    ws: ws && /^wss?:\/\//i.test(ws) ? ws : defaultWsUrl(loc),
    show,
    cps: num(q.get("cps"), DEFAULT_CPS, 2, 200),
    scale: num(q.get("scale"), 1, 0.4, 3),
    debug: flag(q.get("debug")),
    demo: flag(q.get("demo")),
    layer: pick(q.get("layer"), LAYERS),
    layout: pick(q.get("layout"), LAYOUTS),
  };
}
