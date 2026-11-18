// Overlay settings from the query string, e.g.
//   /overlay/?show=subtitles,queue&cps=16&scale=1.1&ws=ws://192.168.1.20:7884/overlay/ws
//   /overlay/?layer=backdrop&layout=sing   (the background under the scene's sources)
//   /overlay/?danmaku_band=0.04-0.30       (where the danmaku lanes run, fractions of the frame height)
//   /overlay/?layout=karaoke&karaoke_ruby=reading   (the karaoke scene's page, readings on the lyrics)
import type { ReadingMode } from "@miyoria/play/karaoke/lyrics";
import { DEFAULT_CPS } from "./typewriter.js";

export const SECTIONS = [
  "subtitles",
  "emotion",
  "status",
  "queue",
  "wave",
  "activity",
  "gifts",
  "screen",
  "touches",
  "danmaku",
  "karaoke",
] as const;
export type Section = (typeof SECTIONS)[number];

/** Which layer of the scene this page is: the overlay on top, or the background under everything. */
export const LAYERS = ["overlay", "backdrop"] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * Scene layouts: `sing` frames the song video top left and leaves the bottom right to her;
 * `karaoke` is the karaoke room's scene (docs/design/karaoke.md §7.1): the page's own pieces sit
 * where they do while a round is on the stream, the round's stage takes the left, the board the right.
 */
export const LAYOUTS = ["default", "sing", "karaoke"] as const;
export type Layout = (typeof LAYOUTS)[number];

/** What the stream shows above the karaoke lyrics (`karaoke_ruby`): nothing, the reading, romaji. */
export const KARAOKE_RUBY: readonly ReadingMode[] = ["off", "reading", "roman"];

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
  /** `demo=karaoke` (or `karaoke_demo=1`): the scripted feed is a karaoke room's loop. */
  karaokeDemo: boolean;
  /** Readings above the karaoke lyrics on stream (`karaoke_ruby`); off unless asked. */
  karaokeRuby: ReadingMode;
  layer: Layer;
  layout: Layout;
  /**
   * `danmaku_band=0.04-0.30`: the danmaku lanes' top and bottom as fractions of the frame height,
   * for pictures where the layout's band does not suit; null = the layout's own band.
   */
  danmakuBand: DanmakuBand | null;
}

export interface DanmakuBand {
  /** 0..1 of the frame height. */
  top: number;
  bottom: number;
}

/** `top-bottom` in fractions of the frame height, top above bottom; else null. */
export function parseBand(raw: string | null): DanmakuBand | null {
  const m = raw?.trim().match(/^(\d*\.?\d+)\s*-\s*(\d*\.?\d+)$/);
  if (!m) return null;
  const top = Number(m[1]);
  const bottom = Number(m[2]);
  // At least a few percent high, or no lane fits.
  return top >= 0 && bottom <= 1 && bottom - top >= 0.02 ? { top, bottom } : null;
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
  const karaokeDemo = q.get("demo")?.trim().toLowerCase() === "karaoke" || flag(q.get("karaoke_demo"));
  // The demo shows its readings unless told otherwise; a real stream shows none unless asked.
  const ruby = q.get("karaoke_ruby");
  return {
    ws: ws && /^wss?:\/\//i.test(ws) ? ws : defaultWsUrl(loc),
    show,
    cps: num(q.get("cps"), DEFAULT_CPS, 2, 200),
    scale: num(q.get("scale"), 1, 0.4, 3),
    debug: flag(q.get("debug")),
    demo: karaokeDemo || flag(q.get("demo")),
    karaokeDemo,
    karaokeRuby: ruby === null && karaokeDemo ? "reading" : pick(ruby, KARAOKE_RUBY),
    layer: pick(q.get("layer"), LAYERS),
    layout: pick(q.get("layout"), LAYOUTS),
    danmakuBand: parseBand(q.get("danmaku_band")),
  };
}
