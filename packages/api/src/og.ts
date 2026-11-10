// Link previews: the picture a member card unfurls with (`GET /og/card/{serial}.png`), the site's
// own (`GET /og/default.png`), and the rewrite that puts each page's tags into the HTML.
//
// The card is the panel's own drawing (`@miyoria/card-face`) rendered to a PNG with resvg, so no
// browser is needed. Pictures come from the panel's folder (her poses) and Discord's CDN (their
// avatar), through sharp, which reads the formats resvg does not. A rendered image is kept per
// serial and version of the card's data, so a card that changes (a new frame, a voiding) is drawn
// again, and the page's tags carry that version in the image URL so a cache upstream lets go too.
//
// Only what the public card page already shows is drawn. A malformed, unknown, voided or
// unreadable serial gets the site's picture.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderCardSvg } from "@miyoria/card-face/render";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { publicCard } from "./card.js";
import {
  CARD_IMAGE_WIDTH,
  cardMeta,
  injectMeta,
  OG_HEIGHT,
  OG_WIDTH,
  originOf,
  pageMeta,
} from "./meta.js";
import { clientKey, tooMany } from "./public.js";
import { param, type Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";
import type { IssuedCard } from "./types.js";

const log = getLogger("api.og");

/** Bump to draw every cached image again after the layout changes. */
const RENDER_VERSION = "2";
const COLORS = { primary: "#f29dc4", secondary: "#7355e8" };
const CACHED_IMAGES = 64;
const AVATAR_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_AVATAR_BYTES = 2_000_000;
const PNG = "image/png";
const FONT_FAMILY = "Microsoft JhengHei";

/** What a card's picture depends on: its data and this layout. */
export function cardVersion(card: IssuedCard): string {
  return createHash("sha1")
    .update(RENDER_VERSION)
    .update(JSON.stringify(card))
    .digest("hex")
    .slice(0, 10);
}

/** Where a card's preview picture is, with the version that busts caches when the card changes. */
export function cardImagePath(card: IssuedCard): string {
  return `/og/card/${encodeURIComponent(card.serial)}.png?v=${cardVersion(card)}`;
}

// ---- pictures -------------------------------------------------------------------------------

const toDataUrl = (type: string, bytes: Uint8Array): string =>
  `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

const arts = new Map<string, string | null>();

/**
 * Her picture as a data URL, `width` wide: a JPEG on black for the card (whose top is black), or a
 * PNG that keeps its clear background with `clear`. `null` without the panel folder or the file.
 */
async function poseArt(
  dir: string | null,
  pose: string,
  width = 900,
  clear = false,
): Promise<string | null> {
  const name = pose.replace(/[^a-z0-9-]/g, "");
  if (dir === null || name === "") return null;
  const key = `${dir}|${name}|${width}|${clear}`;
  if (arts.has(key)) return arts.get(key) ?? null;
  let art: string | null = null;
  try {
    const file = await readFile(join(dir, `card-${name}.local.webp`));
    const sized = sharp(file).resize({ width });
    art = clear
      ? toDataUrl(PNG, await sized.png().toBuffer())
      : toDataUrl("image/jpeg", await sized.jpeg({ quality: 88 }).toBuffer());
  } catch {
    // No renders on this machine: the card is drawn without her.
  }
  arts.set(key, art);
  return art;
}

/** Their avatar as a small PNG data URL; `null` when it is not Discord's or cannot be had. */
async function avatarArt(url: string | null): Promise<string | null> {
  if (url === null) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !AVATAR_HOSTS.has(u.hostname)) return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null;
    const png = await sharp(bytes).resize(72, 72, { fit: "cover" }).png().toBuffer();
    return toDataUrl(PNG, png);
  } catch (error) {
    log.debug({ error: errorMessage(error) }, "cannot fetch an avatar for a preview");
    return null;
  }
}

// ---- drawing --------------------------------------------------------------------------------

/** The SVG as a PNG of the given width, on a background, or clear when it is null. */
async function toPng(svg: string, width: number, background: string | null): Promise<Buffer> {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    ...(background === null ? {} : { background }),
    font: { loadSystemFonts: true, defaultFontFamily: FONT_FAMILY },
  });
  return resvg.render().asPng();
}
/**
 * The card as the whole picture, at its own 630×880 ratio and clear around its rounded corners.
 * `og:image:width` and `height` say the same size (`CARD_IMAGE_WIDTH`, `CARD_IMAGE_HEIGHT`).
 */
export async function renderCardImage(card: IssuedCard, panelDir: string | null): Promise<Buffer> {
  const [art, avatar] = await Promise.all([
    poseArt(panelDir, card.pose, CARD_IMAGE_WIDTH),
    avatarArt(card.avatar_url),
  ]);
  const svg = renderCardSvg({
    card,
    art,
    avatar,
    colors: COLORS,
    verifyUrl: `https://miyoria.invalid/card/${card.serial}`,
  });
  return toPng(svg, CARD_IMAGE_WIDTH, null);
}

// The site's picture is her in front of frosted glass, and the glass is made of her own picture: the
// panel's backdrop is game art, fine on the owner's screen but not in a preview anyone can fetch.
// resvg has no `backdrop-filter`, so the frost is made with sharp: her picture spread over the whole
// preview and blurred is the light behind, blurred more where the glass is. The glass is flush with
// the left edge like the panel's frame (`apps/panel/DESIGN.md`, `.glass-dock`), and she stands over
// its edge so it reads as glass and not as a box.

const BASE = "#0b0d12";
const TEXT = "#f1f0f4";
const MUTED = "#dedce4";
const LATIN = "Segoe UI";
/** What shows where her picture is clear: a night blue near her hair, so the glass has light to frost. */
const NIGHT = "#161c3a";
/** Where the glass ends. */
const GLASS_W = 664;

/** Her picture over the whole preview, blurred by `sigma` and dimmed; `null` without it. */
async function hazeArt(
  dir: string | null,
  pose: string,
  sigma: number,
  bright: number,
): Promise<string | null> {
  if (dir === null) return null;
  try {
    const file = await readFile(join(dir, `card-${pose}.local.webp`));
    const jpeg = await sharp(file)
      .resize({ width: 1800 })
      .extract({ left: 40, top: 200, width: OG_WIDTH, height: OG_HEIGHT })
      .flatten({ background: NIGHT })
      .blur(sigma)
      .modulate({ brightness: bright, saturation: 1.25 })
      .jpeg({ quality: 88 })
      .toBuffer();
    return toDataUrl("image/jpeg", jpeg);
  } catch {
    return null;
  }
}

/** The panel's 暮色 gradient, for a machine without her pictures. */
const DUSK = `<defs><linearGradient id="og-dusk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1b33"/><stop offset="0.55" stop-color="#2a2140"/><stop offset="1" stop-color="#3a2438"/></linearGradient></defs>
<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#og-dusk)"/>`;

/** The site's own picture: her name on the glass, and her standing over its edge. */
export async function renderDefaultImage(panelDir: string | null): Promise<Buffer> {
  const pose = "smile";
  const [art, back, frost] = await Promise.all([
    poseArt(panelDir, pose, 760, true),
    hazeArt(panelDir, pose, 30, 0.52),
    hazeArt(panelDir, pose, 70, 0.5),
  ]);
  const W = OG_WIDTH;
  const H = OG_HEIGHT;
  const artW = 760;
  const artX = W - artW + 70;
  const artY = 18;
  const x = 76;
  const glass = `<defs><clipPath id="og-glass"><rect width="${GLASS_W}" height="${H}"/></clipPath>
<linearGradient id="og-wash" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#090a10" stop-opacity="0.5"/><stop offset="1" stop-color="#090a10" stop-opacity="0.22"/></linearGradient>
<linearGradient id="og-lip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.09"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.03"/></linearGradient></defs>
<g clip-path="url(#og-glass)">
${frost ? `<image href="${frost}" width="${W}" height="${H}"/>` : ""}
<rect width="${GLASS_W}" height="${H}" fill="url(#og-wash)"/>
<rect width="${GLASS_W}" height="${H}" fill="url(#og-lip)"/>
</g>
<rect x="${GLASS_W - 1}" width="1" height="${H}" fill="#ffffff" fill-opacity="0.22"/>`;
  const her = art
    ? `<image href="${art}" x="${artX}" y="${artY}" width="${artW}" height="${(artW * 4) / 3}"/>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${BASE}"/>
${back ? `<image href="${back}" width="${W}" height="${H}"/>` : DUSK}
${glass}
${her}
<g transform="translate(${x - 4} 70) scale(2.25)" fill="none">
<path d="M15.5 3.5a8 8 0 1 0 5 14.2A6.5 6.5 0 0 1 15.5 3.5Z" fill="${COLORS.primary}"/>
</g>
<text x="${x - 6}" y="388" font-family="${LATIN}" font-size="128" font-weight="600" letter-spacing="-3" fill="${TEXT}">Miyoria</text>
<text x="${x}" y="452" font-family="${FONT_FAMILY}" font-size="34" fill="${MUTED}">住在 Discord 和直播裡的 AI VTuber</text>
<rect x="${x}" y="514" width="40" height="3" rx="1.5" fill="${COLORS.primary}"/>
<text x="${x + 56}" y="524" font-family="${FONT_FAMILY}" font-size="24" fill="${MUTED}" fill-opacity="0.8">聊天・唱歌・直播</text>
</svg>`;
  return toPng(svg, W, BASE);
}

// ---- cache ----------------------------------------------------------------------------------

/** Renders kept by serial and version; the least recently used go first. */
class ImageCache {
  readonly #items = new Map<string, Buffer>();

  get(key: string): Buffer | undefined {
    const hit = this.#items.get(key);
    if (hit) {
      this.#items.delete(key);
      this.#items.set(key, hit);
    }
    return hit;
  }

  set(key: string, png: Buffer): void {
    this.#items.delete(key);
    this.#items.set(key, png);
    while (this.#items.size > CACHED_IMAGES) {
      const oldest = this.#items.keys().next().value;
      if (oldest === undefined) break;
      this.#items.delete(oldest);
    }
  }
}

const caches = new WeakMap<ApiState, ImageCache>();
function cacheOf(state: ApiState): ImageCache {
  let cache = caches.get(state);
  if (!cache) {
    cache = new ImageCache();
    caches.set(state, cache);
  }
  return cache;
}

/** Draws one image at a time: a crawler asking for many must not take the CPU the stage needs. */
const drawing = new WeakMap<ApiState, Promise<unknown>>();
function oneAtATime<T>(state: ApiState, run: () => Promise<T>): Promise<T> {
  const before = drawing.get(state) ?? Promise.resolve();
  const next = before.then(run, run);
  drawing.set(
    state,
    next.catch(() => undefined),
  );
  return next;
}

const SITE_CACHE = "public, max-age=3600";
const SHORT_CACHE = "public, max-age=300";
const VERSIONED_CACHE = "public, max-age=86400, immutable";

function image(png: Buffer, cacheControl: string): Response {
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      "content-type": PNG,
      "content-length": String(png.length),
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    },
  });
}

async function defaultImage(state: ApiState, cacheControl = SITE_CACHE): Promise<Response> {
  const cache = cacheOf(state);
  const key = `default:${RENDER_VERSION}`;
  let png = cache.get(key);
  if (!png) {
    png = await oneAtATime(state, () => renderDefaultImage(state.panelDir));
    cache.set(key, png);
  }
  return image(png, cacheControl);
}

async function cardImage(state: ApiState, c: ApiContext): Promise<Response> {
  const file = param(c, "file");
  const serial = file.endsWith(".png") ? file.slice(0, -4) : "";
  const card = await publicCard(state, serial);
  if (card === null) return defaultImage(state, SHORT_CACHE);
  const version = cardVersion(card);
  const cache = cacheOf(state);
  const key = `${card.serial}:${version}`;
  let png = cache.get(key);
  if (!png) {
    const wait = state.publicSide.admitCardCheck(clientKey(c));
    if (wait !== null) return tooMany(wait);
    try {
      png = await oneAtATime(state, () => renderCardImage(card, state.panelDir));
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot draw a card preview");
      return defaultImage(state, "no-store");
    }
    cache.set(key, png);
  }
  const asked = new URL(c.req.url).searchParams.get("v");
  return image(png, asked === version ? VERSIONED_CACHE : SHORT_CACHE);
}

/** `GET /og/default.png` and `GET /og/card/{serial}.png`: open to anyone, like the page they preview. */
export function ogRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  return [
    { method: "GET", path: "/og/default.png", public: true, handler: () => defaultImage(state) },
    { method: "GET", path: "/og/card/:file", public: true, handler: (c) => cardImage(state, c) },
  ];
}

// ---- the HTML -------------------------------------------------------------------------------

/** The serial in a `/card/<serial>` page path, or `null`. */
function cardSerialIn(path: string): string | null {
  const m = /^\/card\/([^/?#]+)\/?$/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] ?? "");
  } catch {
    return null;
  }
}

/** The panel's `index.html` for `request`, with the tags of the page it asks for. */
export async function rewriteHtml(
  state: ApiState,
  html: string,
  request: Request,
): Promise<string> {
  const path = new URL(request.url).pathname;
  const origin = originOf(request);
  const serial = cardSerialIn(path);
  if (serial !== null && state.publicSide.config.enabled) {
    const card = await publicCard(state, serial);
    if (card) return injectMeta(html, cardMeta(card, origin, `${origin}${cardImagePath(card)}`));
  }
  return injectMeta(html, pageMeta(path, origin));
}
