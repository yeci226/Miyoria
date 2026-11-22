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
import { CARD_FONT_FAMILY, cardFontOptions } from "@miyoria/card-face/fonts";
import { renderCardSvg } from "@miyoria/card-face/render";
import type { IssuedCard } from "@miyoria/contracts/api";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { CharacterKey, DEFAULT_CHARACTER } from "@miyoria/types";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { publicCard } from "./card.js";
import { type CardArt, cardArt } from "./card-art.js";
import { ApiError } from "./errors.js";
import { worldOf } from "./landing.js";
import {
  CARD_IMAGE_WIDTH,
  cardMeta,
  injectMeta,
  OG_HEIGHT,
  OG_WIDTH,
  originOf,
  type PageMeta,
  pageMeta,
} from "./meta.js";
import { tooMany } from "./public.js";
import { param, type Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";

const log = getLogger("api.og");

/** Bump to draw every cached image again after the layout changes. */
const RENDER_VERSION = "3";
const COLORS = { primary: "#f29dc4", secondary: "#7355e8" };
const CACHED_IMAGES = 64;
const AVATAR_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_AVATAR_BYTES = 2_000_000;
const PNG = "image/png";
/** The bundled font (`@miyoria/card-face/fonts`): no machine's own fonts are used. */
const FONT_FAMILY = CARD_FONT_FAMILY;

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

/** A card's picture (`cardArt`) as a JPEG data URL, `CARD_IMAGE_WIDTH` wide on black like the card's top. */
async function artUrl(art: CardArt | null): Promise<string | null> {
  if (art === null) return null;
  try {
    const jpeg = await sharp(art.bytes)
      .resize({ width: CARD_IMAGE_WIDTH })
      .flatten({ background: "#000000" })
      .jpeg({ quality: 88 })
      .toBuffer();
    return toDataUrl("image/jpeg", jpeg);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot use a card picture");
    return null;
  }
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
    font: cardFontOptions(),
  });
  return resvg.render().asPng();
}
/**
 * The card as the whole picture, at its own 630×880 ratio and clear around its rounded corners.
 * `og:image:width` and `height` say the same size (`CARD_IMAGE_WIDTH`, `CARD_IMAGE_HEIGHT`).
 */
export async function renderCardImage(card: IssuedCard, picture: CardArt | null): Promise<Buffer> {
  const [art, avatar] = await Promise.all([artUrl(picture), avatarArt(card.avatar_url)]);
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
const LATIN = CARD_FONT_FAMILY;
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

const escapeXml = (t: string): string =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Who the site is named after: the running profile's character (Miyoria without one). */
function herOf(state: ApiState) {
  return state.optional(CharacterKey) ?? DEFAULT_CHARACTER;
}

/** The panel's 暮色 gradient, for a machine without her pictures. */
const DUSK = `<defs><linearGradient id="og-dusk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1b33"/><stop offset="0.55" stop-color="#2a2140"/><stop offset="1" stop-color="#3a2438"/></linearGradient></defs>
<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#og-dusk)"/>`;

/** Her name on the site's picture: its size, and where it may reach (the glass, with a margin). */
const NAME_SIZE = 128;
const NAME_MIN_SIZE = 56;
const NAME_LEFT = 70;
const NAME_RIGHT = GLASS_W - 36;

/** How wide `name` draws at `size` in the bundled font (resvg's own measure of the text). */
function nameWidth(name: string, size: number): number {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}"><text x="0" y="${size}" font-family="${LATIN}" font-size="${size}" font-weight="600" letter-spacing="-3" fill="#000">${escapeXml(name)}</text></svg>`;
  const box = new Resvg(svg, { font: cardFontOptions() }).getBBox();
  return box ? box.x + box.width : 0;
}

/**
 * Her name as it fits on the glass: at full size when it fits (Miyoria does, so her picture is
 * as it always was), else smaller down to `NAME_MIN_SIZE`, and past that cut with 「…」.
 */
export function fitName(name: string): { text: string; size: number } {
  const room = NAME_RIGHT - NAME_LEFT;
  const full = nameWidth(name, NAME_SIZE);
  if (full <= room) return { text: name, size: NAME_SIZE };
  const size = Math.max(NAME_MIN_SIZE, Math.floor((NAME_SIZE * room) / full));
  if (nameWidth(name, size) <= room) return { text: name, size };
  const chars = [...name];
  for (let n = chars.length - 1; n > 0; n -= 1) {
    const text = `${chars.slice(0, n).join("").trimEnd()}…`;
    if (nameWidth(text, size) <= room) return { text, size };
  }
  return { text: "…", size };
}

/** The site's own picture: her name on the glass, and her standing over its edge. */
export async function renderDefaultImage(
  panelDir: string | null,
  name: string = DEFAULT_CHARACTER.name,
): Promise<Buffer> {
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
  const fitted = fitName(name);
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
<text x="${NAME_LEFT}" y="388" font-family="${LATIN}" font-size="${fitted.size}" font-weight="600" letter-spacing="-3" fill="${TEXT}">${escapeXml(fitted.text)}</text>
<text x="${x}" y="452" font-family="${FONT_FAMILY}" font-size="34" fill="${MUTED}">住在 Discord 和直播裡的 AI VTuber</text>
<rect x="${x}" y="514" width="40" height="3" rx="1.5" fill="${COLORS.primary}"/>
<text x="${x + 56}" y="524" font-family="${FONT_FAMILY}" font-size="24" fill="${MUTED}" fill-opacity="0.8">聊天・唱歌・直播</text>
</svg>`;
  return toPng(svg, W, BASE);
}

// ---- cache ----------------------------------------------------------------------------------

/** Renders kept by serial and version; the least recently used go first. */
class ImageCache<T> {
  readonly #items = new Map<string, T>();

  get(key: string): T | undefined {
    const hit = this.#items.get(key);
    if (hit !== undefined) {
      this.#items.delete(key);
      this.#items.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: T): void {
    this.#items.delete(key);
    this.#items.set(key, value);
    while (this.#items.size > CACHED_IMAGES) {
      const oldest = this.#items.keys().next().value;
      if (oldest === undefined) break;
      this.#items.delete(oldest);
    }
  }

  /** Drops every entry whose key starts with `prefix`; how many. */
  forget(prefix: string): number {
    let n = 0;
    for (const key of [...this.#items.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.#items.delete(key);
      n += 1;
    }
    return n;
  }
}

const caches = new WeakMap<ApiState, ImageCache<Buffer>>();
function cacheOf(state: ApiState): ImageCache<Buffer> {
  let cache = caches.get(state);
  if (!cache) {
    cache = new ImageCache();
    caches.set(state, cache);
  }
  return cache;
}

/**
 * Drops the pictures of the whole card `serial` kept so far (its words changed after it was
 * issued: her line on a keepsake). The next one is drawn from the card as it is now; her picture
 * on it (`cardArt`) does not depend on the words and stays.
 */
export function forgetCardImages(state: ApiState, serial: string): number {
  return cacheOf(state).forget(`${serial}:`);
}

/** Rendered pictures (`cardArt`, only the ones that never change) by serial. */
const artCaches = new WeakMap<ApiState, ImageCache<CardArt>>();
function artCacheOf(state: ApiState): ImageCache<CardArt> {
  let cache = artCaches.get(state);
  if (!cache) {
    cache = new ImageCache();
    artCaches.set(state, cache);
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
  const name = herOf(state).name;
  const key = `default:${RENDER_VERSION}:${name}`;
  let png = cache.get(key);
  if (!png) {
    png = await oneAtATime(state, () => renderDefaultImage(state.panelDir, name));
    cache.set(key, png);
  }
  return image(png, cacheControl);
}

/** The picture of a card (`cardArt`), a rendered one kept: it never changes, the fixed one may. */
async function artOf(state: ApiState, card: IssuedCard): Promise<CardArt | null> {
  const cache = artCacheOf(state);
  const kept = cache.get(card.serial);
  if (kept) return kept;
  const art = await cardArt(state, card);
  if (art?.live) cache.set(card.serial, art);
  return art;
}

/**
 * The card as the whole picture (`renderCardImage`): the link preview's, and the one `/me card`
 * attaches. Kept per serial and version of the card's data, drawn one at a time. Not rate limited:
 * a route asks `admitCardCheck` first when it is open to anyone.
 */
export async function cardPng(state: ApiState, card: IssuedCard): Promise<Buffer> {
  const cache = cacheOf(state);
  const key = `${card.serial}:${cardVersion(card)}`;
  let png = cache.get(key);
  if (!png) {
    png = await oneAtATime(state, async () => renderCardImage(card, await artOf(state, card)));
    cache.set(key, png);
  }
  return png;
}

async function cardImage(state: ApiState, c: ApiContext): Promise<Response> {
  const file = param(c, "file");
  const serial = file.endsWith(".png") ? file.slice(0, -4) : "";
  const card = await publicCard(state, serial);
  if (card === null) return defaultImage(state, SHORT_CACHE);
  const version = cardVersion(card);
  if (!cacheOf(state).get(`${card.serial}:${version}`)) {
    const wait = state.publicSide.admitCardCheck(state.publicSide.client(c));
    if (wait !== null) return tooMany(wait);
  }
  let png: Buffer;
  try {
    png = await cardPng(state, card);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot draw a card preview");
    return defaultImage(state, "no-store");
  }
  const asked = new URL(c.req.url).searchParams.get("v");
  return image(png, asked === version ? VERSIONED_CACHE : SHORT_CACHE);
}

const NO_ART = "這張卡不存在或已經作廢";

/**
 * `GET /api/public/card-art/{serial}.png`: the picture on a card without its frame and words, what
 * the member page and the check page draw it with. The card must be one the public check shows
 * (and the preview draws): an unknown, malformed or voided one is a 404. Her rendered picture never
 * changes, so it is kept long; the fixed portrait it stands in for may give way to it, so it is not.
 */
async function artImage(state: ApiState, c: ApiContext): Promise<Response> {
  const file = param(c, "file");
  const serial = file.endsWith(".png") ? file.slice(0, -4) : "";
  const missing = () => new ApiError(404, NO_ART, { "cache-control": "no-store" }).toResponse();
  const card = await publicCard(state, serial);
  if (card === null) return missing();
  let art = artCacheOf(state).get(card.serial) ?? null;
  if (art === null) {
    const wait = state.publicSide.admitCardCheck(state.publicSide.client(c));
    if (wait !== null) return tooMany(wait);
    try {
      art = await oneAtATime(state, () => artOf(state, card));
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot find a card's picture");
      return missing();
    }
  }
  if (art === null) return missing();
  return new Response(new Uint8Array(art.bytes), {
    status: 200,
    headers: {
      "content-type": art.type,
      "content-length": String(art.bytes.length),
      "cache-control": art.live ? VERSIONED_CACHE : SHORT_CACHE,
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * `GET /og/default.png`, `GET /og/card/{serial}.png` and `GET /api/public/card-art/{serial}.png`:
 * open to anyone, like the page they preview.
 */
export function ogRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  return [
    { method: "GET", path: "/og/default.png", public: true, handler: () => defaultImage(state) },
    { method: "GET", path: "/og/card/:file", public: true, handler: (c) => cardImage(state, c) },
    {
      method: "GET",
      path: "/api/public/card-art/:file",
      public: true,
      handler: (c) => artImage(state, c),
    },
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
  const world = worldOf(state);
  const withWorld = (meta: PageMeta): PageMeta => (world === null ? meta : { ...meta, world });
  if (serial !== null && state.publicSide.config.enabled) {
    const card = await publicCard(state, serial);
    if (card) {
      return injectMeta(
        html,
        withWorld(cardMeta(card, origin, `${origin}${cardImagePath(card)}`, herOf(state))),
      );
    }
  }
  return injectMeta(html, withWorld(pageMeta(path, origin, herOf(state))));
}
